import BackgroundTicker from '@/core/background-ticker?worker';
import { ConnectionManager } from '@/core/connection';
import { BACKGROUND_TICK_INTERVAL_MS, computeFrameDt, shouldConfirmUnload } from '@/core/lifecycle';
import { MovementController } from '@/core/movement';
import { NetworkClient } from '@/core/network';
import { isInitiator } from '@/core/proximity';
import { evaluateBoot, ReloadBanner } from '@/core/reload';
import { StatusManager } from '@/core/status';
import {
  type GroupMethod,
  type Outfit,
  PLAYER_RADIUS,
  REACTION_DEBOUNCE_MS,
  REACTION_EMOJIS,
  type ServerMessage,
} from '@/core/types';
import { SceneCompositor } from '@/media/compositor';
import { MediaManager } from '@/media/media';
import { RecorderManager } from '@/media/recorder';
import {
  computeCamEncoding,
  computePreferredRid,
  computeScreenEncoding,
  isHeldSpeaking,
} from '@/rtc/cam-bitrate';
import type { RtcConn } from '@/rtc/rtcstats';
import { SfuManager } from '@/rtc/sfu';
import { partitionMembers } from '@/rtc/sfu-logic';
import { WebRtcManager } from '@/rtc/webrtc';
import type { AvatarEditor } from '@/ui/avatar-editor';
import { ChatPanel } from '@/ui/chat';
import { DebugConsole } from '@/ui/debug-console';
import { KnockController } from '@/ui/knock';
import { Toasts } from '@/ui/notify';
import { RemoteMediaView } from '@/ui/remote-media';
import { RosterPanel } from '@/ui/roster';
import { SoundManager } from '@/ui/sounds';
import { type MediaSink, ToolbarController } from '@/ui/toolbar';
import { CanvasRenderer } from '@/world/canvas';
import { OUTFIT_COUNTS } from '@/world/character';
import { InputManager } from '@/world/input';
import { normalizeOutfit } from '@/world/outfit';
import { PlayerState } from '@/world/player';
import { findWalkableSpawn } from '@/world/tilemap';

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
  private knocks: KnockController;
  private editor: AvatarEditor;

  private myId: string = '';
  private me: PlayerState | null = null;
  private players = new Map<string, PlayerState>();

  // Self-movement physics, click-to-move route, and the position-broadcast
  // throttle (core/movement.ts).
  private movement: MovementController;

  // The roster row the user last clicked: that avatar gets a highlight ring on
  // the map. Cleared when the player leaves or the same row is clicked again.
  private focusedId: string | null = null;

  // Track which peers were in proximity last frame (for chime on enter/leave)
  private inProximity = new Set<string>();
  // Own status / one-liner / return time + their broadcast (core/status.ts).
  private playerStatus: StatusManager;
  // Socket reconnect backoff + auth-failure handling (core/connection.ts).
  private conn: ConnectionManager;

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
  // Set by dispose() to stop the rAF loop from rescheduling itself.
  private disposed = false;

  // Global listeners are held as stable references so dispose() can detach them
  // (an inline arrow can't be removed). See issue #127.
  private onCanvasDblClick = (e: MouseEvent) => this.handleCanvasDblClick(e);
  private onReactionKey = (e: KeyboardEvent) => this.handleReactionKey(e);
  private onBeforeUnload = (e: BeforeUnloadEvent) => {
    if (!shouldConfirmUnload(this.me !== null)) return;
    // Setting returnValue is what triggers the browser's native confirm dialog;
    // the text is ignored by modern browsers but assignment is still required.
    e.preventDefault();
    e.returnValue = '';
  };
  private onVisibilityChange = () => {
    // Bun keeps the socket alive with protocol pings, but a long background
    // stint can still drop it. On return, reconnect immediately (clearing any
    // pending backoff) rather than waiting on the close-handler's retry timer.
    if (!document.hidden && !this.conn.authFailed && !this.net.isConnected()) {
      this.conn.manualReconnect();
    }
  };

  constructor(opts: { canvas: HTMLCanvasElement; editor: AvatarEditor }) {
    this.canvas = opts.canvas;
    this.editor = opts.editor;
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
      onClose: () => this.conn.onClose(),
    });

    this.conn = new ConnectionManager({
      connect: () => this.net.connect(),
      toasts: this.toasts,
    });

    this.movement = new MovementController({
      send: (msg) => this.net.send(msg),
    });

    // Status changes go out through the network; the roster re-highlights via
    // onChanged (this.roster is built below — the callback resolves lazily).
    this.playerStatus = new StatusManager({
      send: (msg) => this.net.send(msg),
      getMe: () => this.me,
      isMicOn: () => this.media.micOn,
      isCamOn: () => this.media.camOn,
      onChanged: () => this.roster.refreshStatus(),
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
      replaceLocalStream: (oldStream, newStream, kind) =>
        (this.currentMethod === 'sfu' ? this.sfu : this.rtc).replaceLocalStream(
          oldStream,
          newStream,
          kind,
        ),
    };

    this.toolbar = new ToolbarController({
      media: this.media,
      rtc: this.mediaSink,
      recorder: this.recorder,
      compositor: this.compositor,
      view: this.view,
      toasts: this.toasts,
      broadcastStatus: () => this.playerStatus.broadcast(),
      getMe: () => this.me,
      onReaction: (emoji) => this.sendReaction(emoji),
      // The 🧍 avatar editor and 🐛 debug console both live in the toolbar's "⋯"
      // menu now; reopening the character maker in-room relays the new outfit to
      // peers (see onOutfitApplied).
      onOpenAvatar: () => this.editor.open({ onApply: (o) => this.onOutfitApplied(o) }),
      // The 🐛 debug console lives in the toolbar's "⋯" menu (issue #113). These
      // resolve lazily on click, so referencing this.debug (built below) is fine.
      toggleDebug: () => this.debug.toggle(),
      isDebugOpen: () => this.debug.isOpen(),
    });

    this.roster = new RosterPanel({
      players: this.players,
      getMyId: () => this.myId,
      onFocus: (userId) => this.focusPlayer(userId),
      onGoTo: (userId) => this.goToPlayer(userId),
      onKnock: (userId) => this.knocks.request(userId),
      getStatus: () => this.playerStatus.status,
      getNote: () => this.playerStatus.note,
      getUntilMin: () => this.playerStatus.untilMin,
      onSetStatus: (status, note, untilMin) => this.playerStatus.set(status, note, untilMin),
    });

    this.chat = new ChatPanel({
      onSend: (text) => this.net.send({ type: 'chat', text }),
    });

    // Knock (call-request) feature: owns its own pending/cooldown state. App
    // forwards roster clicks and the knock/knock-reply server messages here.
    this.knocks = new KnockController({
      players: this.players,
      send: (msg) => this.net.send(msg),
      toasts: this.toasts,
      sounds: this.sounds,
      goTo: (userId) => this.goToPlayer(userId),
    });

    // Debug console (opened from the toolbar's "⋯" menu): polls the active
    // transport's getStats while open and lists each connection's send/recv
    // rates. resolveName turns a peer id into the roster name; '' (unknown) lets
    // the console fall back to the id.
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
    this.canvas.addEventListener('dblclick', this.onCanvasDblClick);

    // Number keys 1–6 fire the matching reaction (issue #23). Ignored while
    // typing in a field, and key-repeat is dropped so holding a key doesn't spam.
    window.addEventListener('keydown', this.onReactionKey);

    this.setupZoomControls();
  }

  // Map a 1–6 keypress to REACTION_EMOJIS and send it. The send-side debounce in
  // sendReaction guards against rapid presses.
  private handleReactionKey(e: KeyboardEvent) {
    if (e.repeat || !this.me) return;
    const t = e.target;
    if (
      t instanceof HTMLElement &&
      (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
    ) {
      return;
    }
    const idx = REACTION_EMOJIS.findIndex((_, i) => e.key === String(i + 1));
    if (idx < 0) return;
    this.sendReaction(REACTION_EMOJIS[idx]);
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

  private handleCanvasDblClick(e: MouseEvent) {
    if (!this.me) return;
    e.preventDefault();
    const world = this.renderer.screenToWorld(e.clientX, e.clientY, this.me);
    this.movement.setDestination(this.me, world.x, world.y);
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
    if (!this.movement.setDestination(this.me, target.x, target.y)) return;
    // Keep them highlighted while walking over so they're easy to spot.
    this.focusedId = userId;
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
    window.addEventListener('beforeunload', this.onBeforeUnload);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
  }

  // Symmetric teardown for the App's long-lived resources: stops the rAF loop,
  // terminates the background Worker, detaches the global window/document
  // listeners, and closes both media transports (which detach their own track
  // listeners). The SPA keeps a single App for the page lifetime so this is not
  // auto-invoked today, but it keeps create/destroy paired (issue #127).
  dispose() {
    this.disposed = true;
    this.bgTicker?.terminate();
    this.bgTicker = null;
    this.canvas.removeEventListener('dblclick', this.onCanvasDblClick);
    window.removeEventListener('keydown', this.onReactionKey);
    window.removeEventListener('beforeunload', this.onBeforeUnload);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.rtc.closeAll();
    this.sfu.closeAll();
  }

  // Snapshot the active transport's per-connection getStats diff for the debug
  // console. Only the live path has peers: mesh has one PeerConnection per peer,
  // the SFU one PC split back into per-peer conns (see each collectStats).
  private collectRtcStats(): Promise<{ method: GroupMethod; conns: RtcConn[] }> {
    const conns = this.currentMethod === 'sfu' ? this.sfu.collectStats() : this.rtc.collectStats();
    return conns.then((c) => ({ method: this.currentMethod, conns: c }));
  }

  private onOpen() {
    this.conn.onOpen();
    const params = new URLSearchParams(window.location.search);
    const workspace = params.get('workspace') || 'default';
    this.net.send({
      type: 'join',
      name: this.joinedName,
      workspace,
      outfit: this.editor.getOutfit(),
      ...(this.joinedPassword ? { password: this.joinedPassword } : {}),
    });
  }

  // The character maker was confirmed in-room: update our own avatar and relay
  // the new outfit to the workspace so peers re-render it (the server forwards
  // it without storing — invariant #2; on reconnect the join re-sends it).
  private onOutfitApplied(outfit: Outfit) {
    if (this.me) this.me.outfit = outfit;
    this.net.send({ type: 'outfit-update', outfit });
  }

  private onServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'auth-error': {
        this.conn.markAuthFailed();
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
        this.myId = msg.self.userId;
        const spawn = findWalkableSpawn(msg.self.x, msg.self.y, PLAYER_RADIUS);
        msg.self.x = spawn.x;
        msg.self.y = spawn.y;
        this.me = new PlayerState(msg.self, true);
        this.players.set(this.myId, this.me);
        for (const p of msg.players) {
          // Peer outfits arrive only server-bounded (0..63); re-clamp to our real
          // part counts so a stale/oversized index renders a real option, not an
          // empty layer.
          this.players.set(
            p.userId,
            new PlayerState({ ...p, outfit: normalizeOutfit(p.outfit, OUTFIT_COUNTS) }, false),
          );
        }
        this.view.setSelfName(this.joinedName);
        document.getElementById('toolbar')?.classList.remove('hidden');
        this.roster.show();
        this.roster.refreshStatus();
        this.playerStatus.broadcast();
        break;
      }
      case 'player-joined': {
        if (msg.player.userId === this.myId) break;
        const joined = { ...msg.player, outfit: normalizeOutfit(msg.player.outfit, OUTFIT_COUNTS) };
        this.players.set(msg.player.userId, new PlayerState(joined, false));
        break;
      }
      case 'player-moved': {
        const p = this.players.get(msg.userId);
        if (p) p.setTarget(msg.x, msg.y, msg.vx, msg.vy);
        break;
      }
      case 'outfit-update': {
        const p = this.players.get(msg.userId);
        // Re-clamp the peer's server-bounded indices to our real part counts.
        if (p) p.outfit = normalizeOutfit(msg.outfit, OUTFIT_COUNTS);
        break;
      }
      case 'player-status': {
        const p = this.players.get(msg.userId);
        if (p) {
          p.status = msg.status;
          p.note = msg.note ?? '';
          p.until = msg.until ?? null;
          p.isMuted = msg.isMuted;
          p.isVideoOn = msg.isVideoOn;
          this.view.setTileMuted(msg.userId, msg.isMuted);
        }
        break;
      }
      case 'player-left': {
        this.players.delete(msg.userId);
        if (this.focusedId === msg.userId) this.focusedId = null;
        this.knocks.onPlayerLeft(msg.userId);
        this.rtc.closePeer(msg.userId);
        this.sfu.removePeer(msg.userId);
        this.knownSfuPeers.delete(msg.userId);
        // removePeer also tears down their screenshare stage if any.
        this.view.removePeer(msg.userId);
        break;
      }
      case 'signal': {
        // Fire-and-forget: the message router is synchronous, and a failed
        // signal is non-fatal (that one peer just won't connect). void marks
        // the dropped promise as intentional.
        void this.handleSignal(msg.from, msg.data);
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
      case 'reaction': {
        // The server echoes our own reactions back too, so this covers both
        // peers' bubbles and our own (no separate local echo).
        this.renderer.addReaction(msg.userId, msg.emoji);
        break;
      }
      case 'knock': {
        this.knocks.received(msg.from, msg.name);
        break;
      }
      case 'knock-reply': {
        this.knocks.reply(msg.from, msg.name, msg.accept);
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
    if (this.disposed) return;
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
      this.renderer.render(
        this.me,
        this.players.values(),
        this.movement.destination,
        this.focusedId,
      );
    }
  }

  private update(dt: number) {
    // Move self by input / click-to-move (core/movement.ts owns the physics).
    let selfVx = 0;
    let selfVy = 0;
    if (this.me) {
      const v = this.movement.update(this.me, this.input.getDirection(), dt);
      selfVx = v.vx;
      selfVy = v.vy;
    }

    // Interpolate remote players (also frame-rate independent).
    for (const p of this.players.values()) {
      if (!p.isSelf) p.interpolate(dt);
    }

    // Broadcast our position (throttled; immediate on velocity change).
    const now = performance.now();
    if (this.me) this.movement.maybeSendPosition(this.me, selfVx, selfVy, now);

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

  // Last time we sent a reaction, for the debounce below.
  private lastReactionAt = 0;

  // Send an emoji reaction, debounced so mashing a button/key can't flood the
  // group. The server echoes it back, which is what pops our own bubble — so we
  // don't add it locally here (keeps one render path for ours and peers').
  private sendReaction(emoji: string) {
    if (!this.me) return;
    const now = performance.now();
    if (now - this.lastReactionAt < REACTION_DEBOUNCE_MS) return;
    this.lastReactionAt = now;
    this.net.send({ type: 'reaction', emoji });
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
      const { toClose } = partitionMembers(this.knownSfuPeers, this.sfuMembers);
      for (const id of toClose) {
        this.sfu.removePeer(id);
        this.knownSfuPeers.delete(id);
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
      const { toClose, toOpen } = partitionMembers(this.rtc.peerIds(), next);
      for (const id of toClose) this.rtc.closePeer(id);
      for (const id of toOpen) {
        void this.rtc.createPeer(id, isInitiator(this.myId, id));
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
    this.toasts.info('通話サーバーに接続できないため、P2P 接続に切り替えました。');
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
