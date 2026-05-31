import { CanvasRenderer } from './canvas';
import { InputManager } from './input';
import { MediaManager } from './media';
import { NetworkClient } from './network';
import { PlayerState } from './player';
import { SoundManager } from './sounds';
import { canOccupy, findWalkableSpawn, zoneAt } from './tilemap';
import { isInitiator } from './proximity';
import type { Point } from './proximity';
import { findPath } from './pathfind';
import { computeCamEncoding, computeScreenEncoding, computePreferredRid, isHeldSpeaking } from './cam-bitrate';
import type { RtcConn } from './rtcstats';
import { DebugConsole } from './debug-console';
import {
  CLICK_MOVE_ARRIVE_THRESHOLD,
  CLICK_MOVE_MULTIPLIER,
  COLLISION_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSITION_SEND_INTERVAL_MS,
  type GroupMethod,
  type PlayerStatus,
  type ServerMessage,
} from './types';
import { RecorderManager } from './recorder';
import { SceneCompositor } from './compositor';
import { WebRtcManager } from './webrtc';
import { SfuManager } from './sfu';
import { RemoteMediaView } from './remote-media';
import { RosterPanel } from './roster';
import { ToolbarController, type MediaSink } from './toolbar';
import { ReloadBanner, evaluateBoot } from './reload';
import { ChatPanel } from './chat';
import { Toasts } from './notify';
import { BACKGROUND_TICK_INTERVAL_MS, computeFrameDt, shouldConfirmUnload } from './lifecycle';
import BackgroundTicker from './background-ticker?worker';

// A knock can't be re-sent to the same person until this elapses; it also
// covers the pending window, so you can't spam someone while waiting for a
// reply. The no-answer timeout matches it: once it fires the cooldown is up too.
const KNOCK_COOLDOWN_MS = 20000;

// Top-level orchestrator: owns the game loop (movement, position sync, proximity
// calls), routes server messages, and wires the subsystems together. The DOM /
// media panels live in RemoteMediaView and the toolbar in ToolbarController;
// this class only coordinates them and holds the authoritative player map.
export class App {
  private canvas: HTMLCanvasElement;
  private renderer: CanvasRenderer;
  private input: InputManager;
  private net: NetworkClient;
  private media: MediaManager;
  private rtc: WebRtcManager;
  private sfu: SfuManager;
  private mediaSink: MediaSink;
  private recorder: RecorderManager;
  private compositor: SceneCompositor;
  private view: RemoteMediaView;
  private toolbar: ToolbarController;
  private roster: RosterPanel;
  private chat: ChatPanel;
  private debug: DebugConsole;
  private toasts = new Toasts();
  private sounds = new SoundManager();

  // Knock state (knocker side): target userId → no-answer timeout handle, and
  // target userId → performance.now() until which a re-knock is suppressed.
  private pendingKnocks = new Map<string, ReturnType<typeof setTimeout>>();
  private knockCooldownUntil = new Map<string, number>();

  private myId: string = '';
  private me: PlayerState | null = null;
  private players = new Map<string, PlayerState>();

  private lastSent = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentVx = 0;
  private lastSentVy = 0;

  // Click-to-move: remaining waypoint tile-centers and the current index.
  private movePath: Point[] | null = null;
  private moveIndex = 0;

  // The roster row the user last clicked: that avatar gets a highlight ring on
  // the map. Cleared when the player leaves or the same row is clicked again.
  private focusedId: string | null = null;

  // Track which peers were in proximity last frame (for chime on enter/leave)
  private inProximity = new Set<string>();
  private myStatus: PlayerStatus = 'online';

  // Server-driven transport for our current proximity group. 'mesh' uses the
  // per-peer WebRtcManager; 'sfu' routes everything through Cloudflare Realtime
  // via SfuManager. Per group the switch is a one-way latch (issues #77/#78):
  // outdoor clusters promote at 5 and never demote until the group disperses;
  // meeting rooms start as SFU. Membership for BOTH methods comes from the
  // server's group-update (the connected component), so a mesh client meshes
  // with every group member — not just peers inside its own radius.
  private currentMethod: GroupMethod = 'mesh';
  // Other members of our current mesh group (excludes self). Empty when SFU.
  private meshMembers = new Set<string>();
  private sfuMembers = new Set<string>();
  // Group peers whose track directory we've handed to SfuManager, so we can drop
  // them when they leave the group.
  private knownSfuPeers = new Set<string>();
  private sfuEnabled = false;

  // Speaker-aware send policy. `lastLoudAtMs` is the last frame our mic was loud
  // (drives the post-speech hold). The computed camera encoding / screen bitrate
  // are pushed to the WebRtcManager each frame, which no-ops when unchanged.
  private lastLoudAtMs: number | null = null;

  // The server's boot id from the first welcome. A different id on a later
  // welcome (after a reconnect) means the server restarted/redeployed — see the
  // welcome handler and reload.ts.
  private serverBootId: string | null = null;
  private reloadBanner = new ReloadBanner();

  // Throttle for SFU simulcast layer re-selection (see updateSfuLayers).
  private lastLayerUpdate = 0;

  // Background ticker: a Worker that keeps update() running while the tab is
  // hidden (requestAnimationFrame is paused there). Created in start(); the
  // visible/hidden handover lives in the loop and onWorkerTick.
  private bgTicker: Worker | null = null;
  // Guards beforeunload/visibilitychange registration so an auth-error retry
  // (start() called again) doesn't stack duplicate window listeners.
  private lifecycleReady = false;

  constructor(opts: { canvas: HTMLCanvasElement }) {
    this.canvas = opts.canvas;
    this.renderer = new CanvasRenderer(this.canvas);
    this.input = new InputManager();
    this.media = new MediaManager();
    this.recorder = new RecorderManager();
    this.compositor = new SceneCompositor(this.canvas);

    this.view = new RemoteMediaView({
      players: this.players,
      media: this.media,
      recorder: this.recorder,
      getMyId: () => this.myId,
    });

    this.net = new NetworkClient({
      onMessage: (m) => this.onServerMessage(m),
      onOpen: () => this.onOpen(),
      onClose: () => this.onClose(),
    });

    this.rtc = new WebRtcManager(this.media, {
      onSignal: (toUserId, data) => {
        this.net.send({ type: 'signal', to: toUserId, data });
      },
      onStreamMeta: (toUserId, streamId, kind) => {
        this.net.send({ type: 'stream-meta', to: toUserId, streamId, kind });
      },
      onRemoteStream: (userId, stream, kind) => this.view.attachRemoteStream(userId, stream, kind),
      onRemoteStreamRemoved: (userId, streamId) => this.view.detachRemoteStream(userId, streamId),
      onPeerClosed: (userId) => this.view.removePeer(userId),
    });

    // SFU transport. Shares the same remote-media event surface as the mesh, so
    // tiles / recording need no changes. onPublished announces our published
    // track directory to the server for relay; onFailed degrades to mesh.
    this.sfu = new SfuManager({
      onRemoteStream: (userId, stream, kind) => this.view.attachRemoteStream(userId, stream, kind),
      onRemoteStreamRemoved: (userId, streamId) => this.view.detachRemoteStream(userId, streamId),
      onPeerClosed: (userId) => this.view.removePeer(userId),
      onPublished: (sessionId, tracks) => this.net.send({ type: 'sfu-publish', sessionId, tracks }),
      onFailed: () => this.onSfuFailed(),
    });

    // Routes the toolbar's publish/unpublish to whichever transport is active.
    this.mediaSink = {
      addLocalStream: (stream, kind) =>
        (this.currentMethod === 'sfu' ? this.sfu : this.rtc).addLocalStream(stream, kind),
      removeLocalStream: (stream) =>
        (this.currentMethod === 'sfu' ? this.sfu : this.rtc).removeLocalStream(stream),
    };

    this.toolbar = new ToolbarController({
      media: this.media,
      rtc: this.mediaSink,
      recorder: this.recorder,
      compositor: this.compositor,
      view: this.view,
      broadcastStatus: () => this.broadcastStatus(),
      getMe: () => this.me,
    });

    this.roster = new RosterPanel({
      players: this.players,
      getMyId: () => this.myId,
      onFocus: (userId) => this.focusPlayer(userId),
      onGoTo: (userId) => this.goToPlayer(userId),
      onKnock: (userId) => this.knock(userId),
      getStatus: () => this.myStatus,
      onSetStatus: (status) => this.setStatus(status),
    });

    this.chat = new ChatPanel({
      onSend: (text) => this.net.send({ type: 'chat', text }),
    });

    // Debug console (toolbar 🐛): polls the active transport's getStats while
    // open and lists each connection's send/recv rates. resolveName turns a peer
    // id into the roster name; '' (unknown) lets the console fall back to the id.
    this.debug = new DebugConsole({
      collect: () => this.collectRtcStats(),
      resolveName: (id) => this.players.get(id)?.name ?? '',
    });

    // Media changes refresh both the toolbar buttons and the self preview;
    // recorder changes only touch the toolbar.
    this.media.on(() => {
      this.toolbar.refresh();
      this.view.refreshSelfPreview();
    });
    this.recorder.on(() => this.toolbar.refresh());
    this.view.refreshSelfPreview();

    // Double-click the map to walk to that point (A* around walls, boosted speed).
    this.canvas.addEventListener('dblclick', (e) => this.onCanvasDblClick(e));

    this.setupZoomControls();
  }

  // Wire the toolbar zoom controls to the renderer (a pure view concern App
  // owns). [🔍+] [🔍−] step the zoom; each refresh disables a button once it
  // hits its limit. Zoom is a light, instantly-reversible action, so
  // single-click is fine.
  private setupZoomControls() {
    const zoomIn = document.getElementById('btn-zoom-in') as HTMLButtonElement;
    const zoomOut = document.getElementById('btn-zoom-out') as HTMLButtonElement;
    const refresh = () => {
      zoomIn.disabled = !this.renderer.canZoomIn;
      zoomOut.disabled = !this.renderer.canZoomOut;
    };
    zoomIn.addEventListener('click', () => {
      this.renderer.zoomIn();
      refresh();
    });
    zoomOut.addEventListener('click', () => {
      this.renderer.zoomOut();
      refresh();
    });
    refresh();
  }

  private onCanvasDblClick(e: MouseEvent) {
    if (!this.me) return;
    e.preventDefault();
    const world = this.renderer.screenToWorld(e.clientX, e.clientY, this.me);
    // Snap a click on a wall/desk to the nearest walkable tile.
    const goal = findWalkableSpawn(world.x, world.y, PLAYER_RADIUS);
    const path = findPath({ x: this.me.x, y: this.me.y }, goal);
    if (path.length === 0) {
      this.movePath = null;
      return;
    }
    this.movePath = path;
    this.moveIndex = 0;
  }

  // Roster row click: toggle the highlight ring on that avatar. A light,
  // non-destructive action — it never moves self.
  private focusPlayer(userId: string) {
    this.focusedId = this.focusedId === userId ? null : userId;
  }

  // Roster "→" button: walk self over to a walkable tile next to that player
  // (reusing the click-to-move A*), so getting into call range is one click.
  private goToPlayer(userId: string) {
    if (!this.me) return;
    const target = this.players.get(userId);
    if (!target || target.isSelf) return;
    const goal = findWalkableSpawn(target.x, target.y, PLAYER_RADIUS);
    const path = findPath({ x: this.me.x, y: this.me.y }, goal);
    if (path.length === 0) {
      this.movePath = null;
      return;
    }
    this.movePath = path;
    this.moveIndex = 0;
    // Keep them highlighted while walking over so they're easy to spot.
    this.focusedId = userId;
  }

  // Roster "🔔" button: send a knock (call request) to that player. Throttled
  // per target (KNOCK_COOLDOWN_MS), which also blocks re-knocking while a reply
  // is still pending. A local no-answer timer fires if they never respond.
  private knock(userId: string) {
    const target = this.players.get(userId);
    if (!target || target.isSelf) return;
    const now = performance.now();
    if (now < (this.knockCooldownUntil.get(userId) ?? 0)) return;
    this.knockCooldownUntil.set(userId, now + KNOCK_COOLDOWN_MS);

    this.net.send({ type: 'knock', to: userId });
    this.toasts.info(`${target.name} さんにノックしました…`);

    const timer = setTimeout(() => {
      this.pendingKnocks.delete(userId);
      const p = this.players.get(userId);
      this.toasts.info(`${p?.name ?? '相手'} さんから返事がありませんでした`);
    }, KNOCK_COOLDOWN_MS);
    this.pendingKnocks.set(userId, timer);
  }

  // Someone knocked us: offer an accept/decline toast. Accepting tells them OK
  // (their client then walks over); 「あとで」 declines politely.
  private onKnockReceived(fromUserId: string, name: string) {
    this.sounds.enter();
    this.toasts.action(
      `${name} さんが話したがっています`,
      [
        {
          label: '応じる',
          primary: true,
          onClick: () => this.net.send({ type: 'knock-reply', to: fromUserId, accept: true }),
        },
        {
          label: 'あとで',
          onClick: () => this.net.send({ type: 'knock-reply', to: fromUserId, accept: false }),
        },
      ],
      KNOCK_COOLDOWN_MS,
    );
  }

  // Reply to a knock we sent. On accept we walk over to them (reusing the
  // roster's go-to path); on decline we just say so quietly.
  private onKnockReply(fromUserId: string, name: string, accept: boolean) {
    this.clearPendingKnock(fromUserId);
    // Let the knocker try again right away once they've had a reply.
    this.knockCooldownUntil.delete(fromUserId);
    if (accept) {
      this.toasts.info(`${name} さんが応じました。近づきます`);
      this.goToPlayer(fromUserId);
    } else {
      this.toasts.info(`${name} さんは今は手が離せないようです`);
    }
  }

  private clearPendingKnock(userId: string) {
    const timer = this.pendingKnocks.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.pendingKnocks.delete(userId);
    }
  }

  private joinedName = '';
  private joinedPassword = '';

  start(name: string, password: string) {
    this.joinedName = name;
    this.joinedPassword = password;
    this.net.connect();
    requestAnimationFrame(this.loop);
    this.startBackgroundTicker();
    this.setupLifecycle();
  }

  // Keep the simulation alive in a hidden tab. While visible, requestAnimationFrame
  // drives update()+render(). When the tab is backgrounded the browser pauses rAF,
  // so a Worker timer (immune to background throttling) drives update() only — no
  // render, since nothing is on screen. document.hidden picks the single active
  // driver each tick, so the two never double-step.
  private startBackgroundTicker() {
    if (this.bgTicker) return;
    this.bgTicker = new BackgroundTicker();
    this.bgTicker.onmessage = () => {
      if (document.hidden) this.step(performance.now(), false);
    };
    this.bgTicker.postMessage({ intervalMs: BACKGROUND_TICK_INTERVAL_MS });
  }

  // Confirm an accidental close while in a workspace, and recover the socket the
  // moment the user returns to a tab that was backgrounded long enough to drop it.
  private setupLifecycle() {
    if (this.lifecycleReady) return;
    this.lifecycleReady = true;
    window.addEventListener('beforeunload', (e) => {
      if (!shouldConfirmUnload(this.me !== null)) return;
      // Setting returnValue is what triggers the browser's native confirm dialog;
      // the text is ignored by modern browsers but assignment is still required.
      e.preventDefault();
      e.returnValue = '';
    });
    document.addEventListener('visibilitychange', () => {
      // Bun keeps the socket alive with protocol pings, but a long background
      // stint can still drop it. On return, reconnect immediately rather than
      // waiting on the close-handler's 2s retry.
      if (!document.hidden && !this.authFailed && !this.net.isConnected()) {
        this.net.connect();
      }
    });
  }

  // Snapshot the active transport's per-connection getStats diff for the debug
  // console. Only the live path has peers: mesh has one PeerConnection per peer,
  // the SFU one PC split back into per-peer conns (see each collectStats).
  private collectRtcStats(): Promise<{ method: GroupMethod; conns: RtcConn[] }> {
    const conns =
      this.currentMethod === 'sfu' ? this.sfu.collectStats() : this.rtc.collectStats();
    return conns.then((c) => ({ method: this.currentMethod, conns: c }));
  }

  private onOpen() {
    const params = new URLSearchParams(window.location.search);
    const workspace = params.get('workspace') || 'default';
    this.net.send({
      type: 'join',
      name: this.joinedName,
      workspace,
      ...(this.joinedPassword ? { password: this.joinedPassword } : {}),
    });
  }

  private authFailed = false;

  private onClose() {
    if (this.authFailed) {
      this.authFailed = false;
      return;
    }
    console.warn('[ws] connection closed; will retry in 2s');
    setTimeout(() => this.net.connect(), 2000);
  }

  private onServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'auth-error': {
        this.authFailed = true;
        alert(msg.message || '認証に失敗しました');
        // Show join overlay again so user can retry
        document.getElementById('join-overlay')?.classList.remove('hidden');
        break;
      }
      case 'welcome': {
        // A changed boot id across reconnects means the server restarted or was
        // redeployed: its in-memory peer map was wiped, so handling this welcome
        // as usual would leave stale ghost avatars on other clients. Reload
        // instead — that resets everyone to a clean state and picks up the new
        // bundle (reload.ts explains the ghost mechanism).
        const boot = evaluateBoot(this.serverBootId, msg.bootId);
        this.serverBootId = boot.bootId;
        if (boot.reload) {
          this.reloadBanner.show();
          break;
        }
        this.sfuEnabled = msg.sfuEnabled;
        this.myId = msg.self.userId;
        const spawn = findWalkableSpawn(msg.self.x, msg.self.y, PLAYER_RADIUS);
        msg.self.x = spawn.x;
        msg.self.y = spawn.y;
        this.me = new PlayerState(msg.self, true);
        this.players.set(this.myId, this.me);
        for (const p of msg.players) {
          this.players.set(p.userId, new PlayerState(p, false));
        }
        this.view.setSelfName(this.joinedName);
        document.getElementById('toolbar')?.classList.remove('hidden');
        this.roster.show();
        this.roster.refreshStatus();
        this.broadcastStatus();
        break;
      }
      case 'player-joined': {
        if (msg.player.userId === this.myId) break;
        this.players.set(msg.player.userId, new PlayerState(msg.player, false));
        break;
      }
      case 'player-moved': {
        const p = this.players.get(msg.userId);
        if (p) p.setTarget(msg.x, msg.y, msg.vx, msg.vy);
        break;
      }
      case 'player-status': {
        const p = this.players.get(msg.userId);
        if (p) {
          p.status = msg.status;
          p.isMuted = msg.isMuted;
          p.isVideoOn = msg.isVideoOn;
          this.view.setTileMuted(msg.userId, msg.isMuted);
        }
        break;
      }
      case 'player-left': {
        this.players.delete(msg.userId);
        if (this.focusedId === msg.userId) this.focusedId = null;
        this.clearPendingKnock(msg.userId);
        this.knockCooldownUntil.delete(msg.userId);
        this.rtc.closePeer(msg.userId);
        this.sfu.removePeer(msg.userId);
        this.knownSfuPeers.delete(msg.userId);
        // removePeer also tears down their screenshare stage if any.
        this.view.removePeer(msg.userId);
        break;
      }
      case 'signal': {
        this.handleSignal(msg.from, msg.data);
        break;
      }
      case 'stream-meta': {
        this.rtc.applyRemoteStreamMeta(msg.from, msg.streamId, msg.kind);
        break;
      }
      case 'group-update': {
        this.applyGroupMethod(msg.method, msg.members);
        break;
      }
      case 'chat': {
        this.chat.addMessage({
          from: msg.from,
          name: msg.name,
          text: msg.text,
          isSelf: msg.from === this.myId,
        });
        break;
      }
      case 'knock': {
        this.onKnockReceived(msg.from, msg.name);
        break;
      }
      case 'knock-reply': {
        this.onKnockReply(msg.from, msg.name, msg.accept);
        break;
      }
      case 'sfu-peer-tracks': {
        this.knownSfuPeers.add(msg.userId);
        this.sfu.setPeerTracks(msg.userId, msg.sessionId, msg.tracks);
        break;
      }
    }
  }

  private async handleSignal(from: string, data: unknown) {
    // Mesh membership is server-authoritative. Drop a signal from someone who is
    // not in our mesh group when we have no peer for them yet. This guards two
    // cases: (a) a stray late signal would otherwise resurrect a peer we just
    // dropped at the group boundary (there is no per-frame proximity loop to tear
    // it down again); (b) while we are on SFU, meshMembers is empty, so we never
    // spin up a stray mesh peer for a group routed through the SFU. Existing peers
    // (hasPeer) always pass so ICE trickle keeps flowing.
    //
    // Ordering: the server emits a joiner's group-update before any initiator can
    // react to its own group-update and relay an offer, so the non-initiator has
    // the joiner in meshMembers by the time the offer arrives. If that invariant
    // ever broke, the offer would be dropped here (simple-peer does not resend)
    // and the pair would fail to connect.
    if (!this.rtc.hasPeer(from) && !this.meshMembers.has(from)) {
      return;
    }
    // If we have no peer for this user, create as non-initiator.
    if (!this.rtc.hasPeer(from)) {
      await this.rtc.createPeer(from, false);
    }
    this.rtc.signal(from, data);
  }

  private lastFrameMs = 0;

  // The rAF driver (visible tabs). Skips its own work while hidden — there the
  // Worker ticker drives step() instead — but always reschedules so the chain
  // resumes the instant the tab is shown again.
  private loop = (nowMs?: number) => {
    if (!document.hidden) this.step(nowMs ?? performance.now(), true);
    requestAnimationFrame(this.loop);
  };

  // One simulation step. `render` is false for background Worker ticks (nothing
  // is visible). dt is computed from lastFrameMs regardless of which driver
  // called us, so it stays continuous across a visible/hidden handover.
  private step(nowMs: number, render: boolean) {
    const dt = computeFrameDt(this.lastFrameMs, nowMs);
    this.lastFrameMs = nowMs;
    this.update(dt);
    if (render) {
      const dest = this.movePath ? this.movePath[this.movePath.length - 1] : null;
      this.renderer.render(this.me, this.players.values(), dest, this.focusedId);
    }
  }

  private update(dt: number) {
    // Move self by input (frame-rate independent: dt × speed-per-second)
    let selfVx = 0;
    let selfVy = 0;
    if (this.me) {
      const { dx, dy } = this.input.getDirection();
      if (dx !== 0 || dy !== 0) {
        // Manual keyboard input cancels click-to-move and takes over.
        this.movePath = null;
        selfVx = dx * PLAYER_SPEED;
        selfVy = dy * PLAYER_SPEED;
        this.applyVelocity(selfVx, selfVy, dt);
      } else if (this.movePath) {
        const v = this.followPath(dt);
        selfVx = v.vx;
        selfVy = v.vy;
      }
    }

    // Interpolate remote players (also frame-rate independent).
    for (const p of this.players.values()) {
      if (!p.isSelf) p.interpolate(dt);
    }

    // Periodic position broadcast. Also send when velocity changes (especially
    // when it transitions to 0) so the receiver stops extrapolating.
    const now = performance.now();
    if (this.me) {
      const velChanged = selfVx !== this.lastSentVx || selfVy !== this.lastSentVy;
      const posMoved =
        Math.abs(this.me.x - this.lastSentX) > 0.5 || Math.abs(this.me.y - this.lastSentY) > 0.5;
      const intervalElapsed = now - this.lastSent > POSITION_SEND_INTERVAL_MS;
      // Send immediately on velocity change (e.g. key released → stop signal);
      // otherwise send at the regular cadence while moving.
      if (velChanged || (intervalElapsed && posMoved)) {
        this.net.send({
          type: 'move',
          x: this.me.x,
          y: this.me.y,
          vx: selfVx,
          vy: selfVy,
          // Report our meeting-room zone so the server can group us (SFU vs mesh).
          zoneId: zoneAt(this.me.x, this.me.y)?.id ?? null,
        });
        this.lastSentX = this.me.x;
        this.lastSentY = this.me.y;
        this.lastSentVx = selfVx;
        this.lastSentVy = selfVy;
        this.lastSent = now;
      }
    }

    // Speaking detection (local + remote tiles) is owned by the media view.
    this.view.updateSpeaking();

    // Speaker-aware send policy: in big proximity groups, lower our own camera
    // (and screen) ceilings while we are not the (recent) speaker.
    this.updateSendPolicy(now);

    // SFU simulcast: re-pick each remote camera's layer by tile size (~1s cadence).
    if (now - this.lastLayerUpdate > 1000) {
      this.lastLayerUpdate = now;
      this.updateSfuLayers();
    }

    // Refresh the participant roster from the (now up-to-date) players map.
    this.roster.update(this.focusedId);

    // Chime sounds. Both mesh and SFU membership are decided by the server's
    // group-update (the connected component, meeting-room isolation included),
    // so the chime mirrors who we are *actually* in a call with — it can no
    // longer ring for someone the radius reaches but we never connect to.
    if (this.me) {
      const groupPeers = this.currentMethod === 'sfu' ? this.sfuMembers : this.meshMembers;
      const nowInProximity = new Set<string>();
      for (const id of groupPeers) {
        if (id === this.myId) continue;
        if (!this.players.has(id)) continue;
        nowInProximity.add(id);
        if (!this.inProximity.has(id)) {
          this.sounds.enter();
        }
      }
      for (const id of this.inProximity) {
        if (!nowInProximity.has(id)) {
          this.sounds.leave();
        }
      }
      this.inProximity = nowInProximity;
    }
  }

  // Speaker-aware send policy (issues #70, #74). Each frame we read our own live
  // speaking flag + connected peer count and compute the camera encoding and
  // screen-share ceiling. A post-speech hold (isHeldSpeaking) keeps the high
  // camera rate for a few seconds after we stop talking so the picture doesn't
  // pulse. The WebRtcManager setters no-op when the values are unchanged, so
  // calling every frame is cheap (a two-level policy → changes are infrequent).
  // Mic off → isSpeaking is false and lastLoudAtMs never advances, so we safely
  // count as a quiet peer.
  private updateSendPolicy(nowMs: number) {
    const me = this.me;
    if (!me) return;
    // SFU sends a single upstream regardless of headcount, so it skips the mesh
    // peer-count throttle entirely — SfuManager publishes a fixed simulcast
    // ladder (the quality floor) and the SFU / receiver pick the layer instead.
    if (this.currentMethod === 'sfu') return;
    if (me.isSpeaking) this.lastLoudAtMs = nowMs;
    const speaking = isHeldSpeaking(me.isSpeaking, this.lastLoudAtMs, nowMs);
    const peerCount = this.rtc.peerCount;
    this.rtc.setCamEncoding(computeCamEncoding(peerCount, speaking));
    this.rtc.setScreenEncoding(computeScreenEncoding(peerCount));
  }

  // Moves self by a velocity for one frame, sliding along walls (per-axis
  // canOccupy). Returns whether the position actually changed.
  private applyVelocity(vx: number, vy: number, dt: number): boolean {
    if (!this.me || (vx === 0 && vy === 0)) return false;
    const prevX = this.me.x;
    const prevY = this.me.y;
    const newX = clamp(this.me.x + vx * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
    const newY = clamp(this.me.y + vy * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);
    if (canOccupy(newX, this.me.y, COLLISION_RADIUS)) this.me.x = newX;
    if (canOccupy(this.me.x, newY, COLLISION_RADIUS)) this.me.y = newY;
    this.me.targetX = this.me.x;
    this.me.targetY = this.me.y;
    return this.me.x !== prevX || this.me.y !== prevY;
  }

  // Advances along the click-to-move waypoints at boosted speed. Returns the
  // velocity applied this frame (zero on arrival) so the caller can broadcast it.
  private followPath(dt: number): { vx: number; vy: number } {
    if (!this.me || !this.movePath) return { vx: 0, vy: 0 };
    const target = this.movePath[this.moveIndex];
    const ddx = target.x - this.me.x;
    const ddy = target.y - this.me.y;
    const dist = Math.hypot(ddx, ddy);
    if (dist <= CLICK_MOVE_ARRIVE_THRESHOLD) {
      this.moveIndex++;
      if (this.moveIndex >= this.movePath.length) this.movePath = null;
      return { vx: 0, vy: 0 };
    }
    // Cap the speed so a large frame step never overshoots the waypoint.
    const speed = Math.min(PLAYER_SPEED * CLICK_MOVE_MULTIPLIER, dist / dt);
    const vx = (ddx / dist) * speed;
    const vy = (ddy / dist) * speed;
    if (!this.applyVelocity(vx, vy, dt)) {
      // Unexpectedly blocked: abandon the route and stop.
      this.movePath = null;
      return { vx: 0, vy: 0 };
    }
    return { vx, vy };
  }

  private broadcastStatus() {
    if (!this.me) return;
    this.me.status = this.myStatus;
    this.me.isMuted = !this.media.micOn;
    this.me.isVideoOn = this.media.camOn;
    this.net.send({
      type: 'status',
      status: this.myStatus,
      isMuted: !this.media.micOn,
      isVideoOn: this.media.camOn,
    });
  }

  private setStatus(status: PlayerStatus) {
    if (this.myStatus === status) return;
    this.myStatus = status;
    this.broadcastStatus();
    this.roster.refreshStatus();
  }

  // Apply a server group-update: the server is the single source of truth for
  // who is in our call. 'sfu' is a one-way latch per group (only ever promotes;
  // the server never demotes mid-group). 'mesh' means we connect directly to
  // every listed member — the full connected component, so a latecomer joining
  // an existing cluster reaches everyone, not just whoever is closest.
  private applyGroupMethod(method: GroupMethod, members: string[]) {
    if (method === 'sfu') {
      const wasMesh = this.currentMethod !== 'sfu';
      this.currentMethod = 'sfu';
      this.sfuMembers = new Set(members);
      this.meshMembers.clear();
      if (wasMesh) {
        // mesh → SFU: drop every mesh peer, then publish our live streams to the
        // SFU. Remote media comes back via sfu-peer-tracks → pull.
        this.rtc.closeAll();
        this.publishLocalToSfu();
      }
      // Forget directory peers no longer in the group.
      for (const id of [...this.knownSfuPeers]) {
        if (!this.sfuMembers.has(id)) {
          this.sfu.removePeer(id);
          this.knownSfuPeers.delete(id);
        }
      }
    } else {
      if (this.currentMethod === 'sfu') {
        // SFU → mesh: the group dispersed/reformed. Tear the SFU transport down
        // before rebuilding the mesh below.
        this.sfu.closeAll();
        this.knownSfuPeers.clear();
      }
      this.currentMethod = 'mesh';
      this.sfuMembers.clear();
      // Reconcile mesh peers against the group: close peers no longer in it,
      // open one to every member we are not yet connected to. createPeer bundles
      // our live streams automatically; initiator election keeps it to one offer.
      const next = new Set(members.filter((id) => id !== this.myId));
      for (const id of this.rtc.peerIds()) {
        if (!next.has(id)) this.rtc.closePeer(id);
      }
      for (const id of next) {
        if (!this.rtc.hasPeer(id)) {
          void this.rtc.createPeer(id, isInitiator(this.myId, id));
        }
      }
      this.meshMembers = next;
    }
  }

  private publishLocalToSfu() {
    if (this.media.micStream) this.sfu.addLocalStream(this.media.micStream, 'mic');
    if (this.media.camStream) this.sfu.addLocalStream(this.media.camStream, 'cam');
    if (this.media.screenStream) this.sfu.addLocalStream(this.media.screenStream, 'screen');
  }

  // The SFU peer connection failed: degrade this group to mesh so the call
  // survives rather than dropping. We mesh directly with the group's members
  // (the same set the SFU was serving). (App-token-less environments never reach
  // SFU, so never get here.)
  private onSfuFailed() {
    if (this.currentMethod !== 'sfu') return;
    console.warn('[sfu] connection failed; falling back to mesh');
    // Reuse the mesh reconciliation (it tears the SFU transport down and opens a
    // peer to every former SFU member). Snapshot members first — it clears the set.
    //
    // Caveat: the server still considers this group SFU-latched, so if another
    // member later joins it will send method='sfu' again and we re-attempt SFU
    // (and may fail again). There is intentionally no "I fell back" message to the
    // server — signaling stays stateless (invariant #2) — so we accept this rare
    // re-try churn rather than add a control path for it.
    this.applyGroupMethod('mesh', [...this.sfuMembers]);
  }

  // Pick each SFU camera's simulcast layer by its rendered tile width (issue
  // #78): small thumbnails take the half layer to save downlink, the stage-sized
  // view takes full. setPreferredLayer no-ops when the rid is unchanged, so this
  // is cheap to call on a slow cadence from the loop.
  private updateSfuLayers() {
    if (this.currentMethod !== 'sfu') return;
    for (const userId of this.sfuMembers) {
      if (userId === this.myId) continue;
      const width = this.view.cameraTileWidth(userId);
      if (width == null) continue;
      this.sfu.setPreferredLayer(userId, 'cam', computePreferredRid(width));
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
