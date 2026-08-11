import BackgroundTicker from '@/core/background-ticker?worker';
import { t } from '@/core/i18n';
import { BACKGROUND_TICK_INTERVAL_MS, computeFrameDt, shouldConfirmUnload } from '@/core/lifecycle';
import { setMediaToken } from '@/core/media-auth';
import { logNet, QUALITY_SAMPLE_INTERVAL_MS } from '@/core/netlog';
import { NetworkClient } from '@/core/network';
import type { Point } from '@/core/proximity';
import { isInitiator } from '@/core/proximity';
import {
  computePeerRetryDelay,
  computeReconnectDelay,
  PEER_CONNECT_STALL_MS,
  PEER_DISCONNECTED_TIMEOUT_MS,
  RECONNECT_MAX_MS,
  RECONNECT_STEADY_AFTER_ATTEMPTS,
} from '@/core/reconnect';
import { evaluateBoot, ReloadBanner } from '@/core/reload';
import {
  CLICK_MOVE_ARRIVE_THRESHOLD,
  CLICK_MOVE_MULTIPLIER,
  COLLISION_RADIUS,
  type GroupMethod,
  MAP_HEIGHT,
  MAP_WIDTH,
  type Outfit,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  type Player,
  type PlayerStatus,
  POSITION_SEND_INTERVAL_MS,
  REACTION_DEBOUNCE_MS,
  REACTION_EMOJIS,
  type ServerMessage,
  type SfuTrack,
} from '@/core/types';
import { SceneCompositor } from '@/media/compositor';
import { MediaManager } from '@/media/media';
import { RecorderManager } from '@/media/recorder';
import {
  computeCamEncoding,
  computePreferredRid,
  computeScreenEncoding,
  isHeldSpeaking,
  SFU_CAM_HALF_RID,
} from '@/rtc/cam-bitrate';
import {
  applyNetTierToCam,
  applyNetTierToScreen,
  classifySample,
  INITIAL_TIER_STATE,
  type NetTier,
  type TierState,
  updateTierState,
} from '@/rtc/netquality';
import { type RtcConn, summarizeConnQuality } from '@/rtc/rtcstats';
import { setPreferRedAudio } from '@/rtc/sdp';
import { SfuManager } from '@/rtc/sfu';
import { partitionMembers, SFU_REBUILD_MIN_INTERVAL_MS } from '@/rtc/sfu-logic';
import { computeJitterTargetMs } from '@/rtc/tune';
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
import { findPath } from '@/world/pathfind';
import { PlayerState } from '@/world/player';
import { canOccupy, findWalkableSpawn, zoneAt } from '@/world/tilemap';

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
  // Status one-liner and return time (#85). `myUntil` is an absolute epoch ms
  // (null = none); `myUntilMin` is the chosen preset in minutes, kept so the
  // status menu can re-highlight it. A timer auto-returns to online at `myUntil`.
  private myNote = '';
  private myUntil: number | null = null;
  private myUntilMin: number | null = null;
  private untilTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Last announced track directory per group peer (issue #186). The server only
  // relays directories on group changes / publishes, so a transport rebuild
  // re-feeds them from this cache instead of waiting for a topology change.
  private sfuDirectory = new Map<string, { sessionId: string; tracks: SfuTrack[] }>();
  // When the last SFU transport rebuild ran (see onSfuFailed).
  private lastSfuRebuildAt = 0;

  // Speaker-aware send policy. `lastLoudAtMs` is the last frame our mic was loud
  // (drives the post-speech hold). The computed camera encoding / screen bitrate
  // are pushed to the WebRtcManager each frame, which no-ops when unchanged.
  private lastLoudAtMs: number | null = null;

  // The server's boot id from the first welcome. A different id on a later
  // welcome (after a reconnect) means the server restarted/redeployed — see the
  // welcome handler and reload.ts.
  private serverBootId: string | null = null;
  private reloadBanner = new ReloadBanner();

  // Session-resume token from the last welcome (issue #187). Sent with the next
  // join; within the server's grace window the reconnect keeps our userId,
  // position and group, so calls survive a signaling blip. Memory-only — a page
  // reload starts fresh on purpose.
  private myResumeToken: string | null = null;

  // Throttle for SFU simulcast layer re-selection (see updateSfuLayers).
  private lastLayerUpdate = 0;

  // Call-quality sampling (issue #182): every QUALITY_SAMPLE_INTERVAL_MS the
  // active transport's stats are folded into one QualitySample and appended to
  // the connection log. The sample also drives the bandwidth adaptation (#185):
  // `netTierState` is the hysteresis state machine over classified samples, and
  // `autoCamOff` marks a camera we paused at tier 3 (auto-resumed on recovery;
  // any manual camera toggle clears the flag so the user always wins).
  private lastQualitySampleAt = 0;
  private netTierState: TierState = INITIAL_TIER_STATE;
  private autoCamOff = false;
  // Receive-side degradation (#188): `manualAudioOnly` is the user's ⋯-menu
  // toggle (stops our own cam/screen and, on SFU, pauses video pulls);
  // `autoRecvAudioOnly` is the tier-3 automatic variant, cleared on recovery.
  private manualAudioOnly = false;
  private autoRecvAudioOnly = false;

  // Mesh-peer recovery state (issue #184), all keyed by peer userId and driven
  // from tickPeerRecovery in the game loop:
  //  - peerRetryAt: performance.now deadline of the pending rebuild.
  //  - peerRetryAttempts: consecutive failures, for the backoff (reset on connect).
  //  - peerStallAt: deadline by which a created peer must reach 'connect'.
  //  - peerDisconnectedSince: when iceConnectionState went 'disconnected'.
  //  - rtcRestartHandledAt: debounce for inbound rtc-restart nudges.
  private peerRetryAt = new Map<string, number>();
  private peerRetryAttempts = new Map<string, number>();
  private peerStallAt = new Map<string, number>();
  private peerDisconnectedSince = new Map<string, number>();
  private rtcRestartHandledAt = new Map<string, number>();

  // Background ticker: a Worker that keeps update() running while the tab is
  // hidden (requestAnimationFrame is paused there). Created in start(); the
  // visible/hidden handover lives in the loop and onWorkerTick.
  private bgTicker: Worker | null = null;
  // Guards beforeunload/visibilitychange registration so an auth-error retry
  // (start() called again) doesn't stack duplicate window listeners.
  private lifecycleReady = false;
  // Guards the rAF loop so an auth-error retry (start() called again) doesn't
  // stack a second requestAnimationFrame chain that double-drives step()/render.
  private loopStarted = false;
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
    // pending backoff) rather than waiting on the retry deadline. A half-open
    // socket (isConnected() still true) is caught by the heartbeat within its
    // pong timeout — the loop resumes with the tab.
    if (!document.hidden && !this.authFailed && !this.net.isConnected()) {
      this.manualReconnect();
    }
  };
  // The OS reported connectivity is back: reconnect a dropped socket right away
  // (the backoff may still be waiting out a long delay), or probe a socket that
  // looks open — if the outage killed it, the missing pong force-closes it and
  // the normal reconnect path takes over (issue #183).
  private onOnline = () => {
    logNet('net-online');
    if (this.authFailed) return;
    if (!this.net.isConnected()) this.manualReconnect();
    else this.net.pingNow();
  };
  // The OS reported connectivity is gone. The socket is dead either way; tear it
  // down now so the reconnect loop (and its toast) starts immediately instead of
  // waiting for the heartbeat to time out.
  private onOffline = () => {
    logNet('net-offline');
    this.net.forceClose();
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
      onPeerClosed: (userId) => {
        this.view.removePeer(userId);
        // A peer that died while still in our group gets rebuilt (issue #184);
        // one that left the group has its recovery state dropped.
        this.schedulePeerRecovery(userId);
      },
      onPeerConnected: (userId) => {
        // Fully up: recovery bookkeeping resets so the next failure starts a
        // fresh backoff, and the stall/disconnected watchdogs disarm.
        this.peerRetryAttempts.delete(userId);
        this.peerRetryAt.delete(userId);
        this.peerStallAt.delete(userId);
        this.peerDisconnectedSince.delete(userId);
      },
      onPeerIceState: (userId, state) => {
        // Track sustained 'disconnected' (see tickPeerRecovery). 'failed'/'closed'
        // need no handling here — simple-peer destroys the pair, which lands in
        // onPeerClosed above.
        if (state === 'disconnected') {
          if (!this.peerDisconnectedSince.has(userId)) {
            this.peerDisconnectedSince.set(userId, performance.now());
          }
        } else if (state === 'connected' || state === 'completed') {
          this.peerDisconnectedSince.delete(userId);
        }
      },
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
      broadcastStatus: () => this.broadcastStatus(),
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
      // A manual camera toggle overrides the tier-3 auto-pause (#185): the user
      // turning the camera on (or off) while paused takes it out of automation.
      onUserCamToggle: () => {
        this.autoCamOff = false;
      },
      // Audio-only mode (#188), owned here since it spans send + receive.
      isAudioOnly: () => this.manualAudioOnly,
      onToggleAudioOnly: () => {
        void this.setAudioOnlyMode(!this.manualAudioOnly);
      },
    });

    this.roster = new RosterPanel({
      players: this.players,
      getMyId: () => this.myId,
      onFocus: (userId) => this.focusPlayer(userId),
      onGoTo: (userId) => this.goToPlayer(userId),
      onKnock: (userId) => this.knocks.request(userId),
      getStatus: () => this.myStatus,
      getNote: () => this.myNote,
      getUntilMin: () => this.myUntilMin,
      onSetStatus: (status, note, untilMin) => this.setStatus(status, note, untilMin),
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

  private handleCanvasDblClick(e: MouseEvent) {
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

  private joinedName = '';
  private joinedPassword = '';

  start(name: string, password: string) {
    this.joinedName = name;
    this.joinedPassword = password;
    this.net.connect();
    // Guard like startBackgroundTicker/setupLifecycle: an auth-error retry calls
    // start() again on the same App, and a second rAF chain would double-drive
    // the loop for the rest of the session.
    if (!this.loopStarted) {
      this.loopStarted = true;
      requestAnimationFrame(this.loop);
    }
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
  // moment the user returns to a tab that was backgrounded long enough to drop
  // it — or the moment the OS reports the network came back (issue #183).
  private setupLifecycle() {
    if (this.lifecycleReady) return;
    this.lifecycleReady = true;
    window.addEventListener('beforeunload', this.onBeforeUnload);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
  }

  // Reconcile the players map against a resumed welcome's list (issue #187):
  // peers who left during the outage get the full player-left teardown, new
  // ones are added, and survivors snap to their server-side position. Self and
  // the live transports are untouched — that is the point of resuming.
  private reconcilePlayers(list: Player[]) {
    const present = new Set(list.map((p) => p.userId));
    for (const id of [...this.players.keys()]) {
      if (id === this.myId || present.has(id)) continue;
      this.players.delete(id);
      if (this.focusedId === id) this.focusedId = null;
      this.knocks.onPlayerLeft(id);
      this.meshMembers.delete(id);
      this.sfuMembers.delete(id);
      this.sfuDirectory.delete(id);
      this.rtc.closePeer(id);
      this.sfu.removePeer(id);
      this.knownSfuPeers.delete(id);
      this.view.removePeer(id);
    }
    for (const p of list) {
      if (p.userId === this.myId) continue;
      const outfit = normalizeOutfit(p.outfit, OUTFIT_COUNTS);
      const existing = this.players.get(p.userId);
      if (existing) {
        existing.setTarget(p.x, p.y, 0, 0);
        existing.outfit = outfit;
      } else {
        this.players.set(p.userId, new PlayerState({ ...p, outfit }, false));
      }
    }
  }

  // Drop every bit of state tied to the previous WS session. The server mints a
  // NEW userId per connection, so a same-boot reconnect (network blip, or return
  // from a long-backgrounded tab) would otherwise leave a ghost of our old self
  // and any peer that left during the outage in the players map — plus stale mesh
  // peers, SFU tracks, and a self-screenshare stage keyed by the dead id. Called
  // on every non-resumed welcome; a no-op on the first join since everything is
  // already empty (so there's no first/reconnect branch to keep).
  private resetSessionState() {
    for (const id of [...this.players.keys()]) {
      this.knocks.onPlayerLeft(id);
      this.view.removePeer(id);
    }
    this.players.clear();
    this.me = null;
    // Membership is cleared BEFORE the transports close: onPeerClosed consults
    // meshMembers to decide whether a closing peer should be rebuilt (#184), and
    // a session reset must not schedule rebuilds of the peers it is dropping.
    this.meshMembers.clear();
    this.sfuMembers.clear();
    this.clearPeerRecovery();
    this.rtc.closeAll();
    this.sfu.closeAll();
    this.knownSfuPeers.clear();
    this.sfuDirectory.clear();
    this.inProximity.clear();
    this.currentMethod = 'mesh';
    this.focusedId = null;
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
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
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

  // Fold the current connections' stats into one QualitySample (worst-case
  // health, total rates), log it, and advance the network tier (#185). No
  // connections → nothing to measure; the tier resets so the next call starts
  // clean instead of inheriting a stale downgrade.
  private async sampleQuality() {
    const { method, conns } = await this.collectRtcStats();
    if (conns.length === 0) {
      this.netTierState = INITIAL_TIER_STATE;
      return;
    }
    const q = summarizeConnQuality(conns);
    logNet('quality', { method, ...q });

    const prevTier = this.netTierState.tier;
    this.netTierState = updateTierState(this.netTierState, classifySample(q));
    const tier = this.netTierState.tier;
    if (tier !== prevTier) {
      logNet('net-tier', { from: prevTier, to: tier });
      // Sustained loss → prefer redundant audio (Opus RED) on every SDP
      // negotiated from now on: new peers, recovery rebuilds, renegotiations.
      setPreferRedAudio(tier >= 2);
    }

    // Receive side (#188): widen the jitter buffer to ride out measured jitter
    // (and shrink it back for latency when the link calms).
    const transport = this.currentMethod === 'sfu' ? this.sfu : this.rtc;
    transport.applyReceiverJitterTarget(computeJitterTargetMs(q.recvJitterMs));

    // Quality dots: per-peer for tiles (a conn maps 1:1 to a peer on both
    // transports; SFU synthetic entries aren't players so they no-op), the
    // overall tier for the self preview.
    for (const conn of conns) {
      if (!this.players.has(conn.id)) continue;
      this.view.setTileQuality(conn.id, classifySample(summarizeConnQuality([conn])));
    }
    this.view.setSelfQuality(tier);

    await this.applyAutoCamPolicy(tier);
    this.applyAutoRecvPolicy(tier);
  }

  // Tier 3 on the SFU: stop pulling video so the whole downlink serves audio;
  // resume at tier ≤1. The mesh path has no per-kind receive control without a
  // renegotiation, so its receive side relies on senders degrading (#185).
  private applyAutoRecvPolicy(tier: NetTier) {
    if (tier === 3 && this.currentMethod === 'sfu' && !this.autoRecvAudioOnly) {
      this.autoRecvAudioOnly = true;
      logNet('net-recv-audio-only', { on: true });
      if (!this.manualAudioOnly) this.toasts.info(t('app.netRecvAudioOnly'));
      this.updateVideoPullPause();
    } else if (this.autoRecvAudioOnly && tier <= 1) {
      this.autoRecvAudioOnly = false;
      logNet('net-recv-audio-only', { on: false });
      if (!this.manualAudioOnly) this.toasts.info(t('app.netRecvVideoRestore'));
      this.updateVideoPullPause();
    }
  }

  // Push the effective video-pull pause (manual OR automatic) to the SFU; on
  // resume, re-feed the cached directories so the dropped video is re-pulled
  // (the server only re-relays them on topology changes).
  private updateVideoPullPause() {
    const paused = this.manualAudioOnly || this.autoRecvAudioOnly;
    this.sfu.setVideoPullPaused(paused);
    if (paused || this.currentMethod !== 'sfu') return;
    for (const [id, dir] of this.sfuDirectory) {
      if (id === this.myId || !this.sfuMembers.has(id)) continue;
      this.knownSfuPeers.add(id);
      this.sfu.setPeerTracks(id, dir.sessionId, dir.tracks);
    }
  }

  // The ⋯-menu audio-only toggle (#188): entering stops our camera and screen
  // share through the regular toolbar flows and pauses SFU video pulls; leaving
  // resumes receiving but deliberately does NOT re-enable the camera — the user
  // decides what to re-share.
  private async setAudioOnlyMode(on: boolean) {
    if (this.manualAudioOnly === on) return;
    this.manualAudioOnly = on;
    logNet('audio-only-mode', { on });
    if (on) {
      this.autoCamOff = false; // manual mode supersedes the automation
      await this.toolbar.setCamEnabled(false);
      this.toolbar.stopScreenShare();
      this.toasts.info(t('app.audioOnlyOn'));
    } else {
      this.toasts.info(t('app.audioOnlyOff'));
    }
    this.updateVideoPullPause();
  }

  // Tier 3 means voice is at risk: pause the camera through the same toolbar
  // path as a manual click (peers' tiles clear properly, status broadcasts),
  // and auto-resume once the network has climbed back to tier ≤1. A manual
  // camera toggle clears `autoCamOff` (see onUserCamToggle) so the automation
  // never fights the user.
  private async applyAutoCamPolicy(tier: NetTier) {
    if (tier === 3 && this.media.camOn && !this.autoCamOff) {
      this.autoCamOff = true;
      logNet('net-auto-cam-off');
      this.toasts.info(t('app.netCamOff'));
      await this.toolbar.setCamEnabled(false);
    } else if (this.autoCamOff && tier <= 1 && !this.manualAudioOnly) {
      this.autoCamOff = false;
      logNet('net-auto-cam-restore');
      this.toasts.info(t('app.netCamRestore'));
      await this.toolbar.setCamEnabled(true);
    }
  }

  private onOpen() {
    // Connected: the backoff resets and any "connection lost" toast clears. If
    // auth then fails the auth-error handler re-shows the join overlay.
    this.reconnectAttempt = 0;
    this.reconnectAt = null;
    this.connToastSteady = false;
    this.dismissConnToast?.();
    this.dismissConnToast = null;
    // Single space now — no workspace is selected or sent (the server defaults it).
    this.net.send({
      type: 'join',
      name: this.joinedName,
      outfit: this.editor.getOutfit(),
      ...(this.joinedPassword ? { password: this.joinedPassword } : {}),
      ...(this.myResumeToken ? { resumeToken: this.myResumeToken } : {}),
    });
  }

  // The character maker was confirmed in-room: update our own avatar and relay
  // the new outfit to the workspace so peers re-render it (the server forwards
  // it without storing — invariant #2; on reconnect the join re-sends it).
  private onOutfitApplied(outfit: Outfit) {
    if (this.me) this.me.outfit = outfit;
    this.net.send({ type: 'outfit-update', outfit });
  }

  private authFailed = false;

  // Reconnect state (issues #126/#183). `reconnectAttempt` counts consecutive
  // failures (reset on a successful open); `reconnectAt` is the performance.now
  // deadline of the pending retry — checked from the game loop (tickNetwork)
  // instead of a setTimeout, because hidden tabs throttle timers to ≥1/min while
  // the loop keeps running off the background Worker. `dismissConnToast` closes
  // the active "connection lost" toast; `connToastSteady` marks that it has been
  // escalated to the stronger "can't connect" one.
  private reconnectAttempt = 0;
  private reconnectAt: number | null = null;
  private dismissConnToast: (() => void) | null = null;
  private connToastSteady = false;

  private onClose() {
    if (this.authFailed) {
      this.authFailed = false;
      return;
    }
    this.scheduleReconnect();
  }

  // Schedule the next reconnect: exponential backoff + jitter while the ceiling
  // is being reached, then a steady RECONNECT_MAX_MS cadence forever (issue
  // #183 — an unattended office tab must survive long outages; the escalated
  // toast offers a manual immediate retry, but auto-retrying never stops).
  private scheduleReconnect() {
    // A retry is already pending: 'error' and 'close' can both fire, so don't
    // stack deadlines.
    if (this.reconnectAt != null) return;
    const steady = this.reconnectAttempt >= RECONNECT_STEADY_AFTER_ATTEMPTS;
    const delay = steady ? RECONNECT_MAX_MS : computeReconnectDelay(this.reconnectAttempt);
    this.reconnectAttempt++;
    logNet('ws-retry-scheduled', { attempt: this.reconnectAttempt, delayMs: delay, steady });
    console.warn(
      `[ws] connection closed; retrying in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    if (steady && !this.connToastSteady) {
      // Escalate once: the quick blip turned into a real outage.
      this.connToastSteady = true;
      this.dismissConnToast?.();
      this.dismissConnToast = this.toasts.action(
        t('app.cantConnect'),
        [{ label: t('app.reconnect'), primary: true, onClick: () => this.manualReconnect() }],
        0,
      );
    } else if (!this.dismissConnToast) {
      // Show the (persistent) reconnecting notice once; later attempts reuse it.
      this.dismissConnToast = this.toasts.action(t('app.reconnecting'), [], 0);
    }
    this.reconnectAt = performance.now() + delay;
  }

  // Heartbeat + retry-deadline pump, run every simulation step (rAF while
  // visible, the background Worker while hidden). beat() detects half-open
  // sockets and hung handshakes (issue #183); the deadline check replaces the
  // old throttling-prone setTimeout retry.
  private tickNetwork(now: number) {
    this.net.beat(now);
    if (this.reconnectAt != null && now >= this.reconnectAt) {
      this.reconnectAt = null;
      this.net.connect();
    }
    this.tickPeerRecovery(now);
  }

  // ─── Mesh-peer recovery (issue #184) ──────────────────────────────────────
  // A mesh pair that dies mid-call (ICE failure after a Wi-Fi roam, TURN
  // allocation expiry, …) never comes back on its own: the server re-sends
  // group-update only on topology changes, and simple-peer does not resend
  // offers. So the App rebuilds dead pairs itself, with a per-peer backoff.

  // Create one mesh peer and arm the stall watchdog: if it never reaches
  // 'connect' the recovery loop tears it down and retries. All mesh createPeer
  // call sites (group reconcile, recovery, restart nudges) go through here.
  private createMeshPeer(userId: string, initiator: boolean) {
    this.peerStallAt.set(userId, performance.now() + PEER_CONNECT_STALL_MS);
    void this.rtc.createPeer(userId, initiator);
  }

  // A peer closed. If it should still be in our call, schedule a rebuild with
  // backoff; otherwise clear its recovery state. Deliberate closes (group
  // reconcile, mesh→SFU, session reset) pass the guards because membership is
  // updated *before* the close in those paths.
  private schedulePeerRecovery(userId: string) {
    this.peerStallAt.delete(userId);
    this.peerDisconnectedSince.delete(userId);
    if (this.currentMethod !== 'mesh' || !this.meshMembers.has(userId)) {
      this.peerRetryAt.delete(userId);
      this.peerRetryAttempts.delete(userId);
      return;
    }
    if (this.peerRetryAt.has(userId)) return;
    const attempt = (this.peerRetryAttempts.get(userId) ?? 0) + 1;
    this.peerRetryAttempts.set(userId, attempt);
    const delay = computePeerRetryDelay(attempt);
    logNet('mesh-retry-scheduled', { peer: userId, attempt, delayMs: delay });
    this.peerRetryAt.set(userId, performance.now() + delay);
  }

  // The recovery pump, run every simulation step: fires due rebuilds, tears
  // down peers stuck in 'disconnected' or stalled short of 'connect'. Teardowns
  // land back in schedulePeerRecovery via onPeerClosed, bumping the backoff.
  private tickPeerRecovery(now: number) {
    for (const [userId, at] of this.peerRetryAt) {
      if (now < at) continue;
      this.peerRetryAt.delete(userId);
      if (this.currentMethod !== 'mesh' || !this.meshMembers.has(userId)) continue;
      if (this.rtc.hasPeer(userId)) continue;
      const initiator = isInitiator(this.myId, userId);
      logNet('mesh-retry', { peer: userId, initiator });
      this.createMeshPeer(userId, initiator);
      // Only the elected initiator can send the fresh offer; the other side
      // nudges it (rtc-restart) in case it hasn't noticed the pair is dead.
      if (!initiator) this.net.send({ type: 'rtc-restart', to: userId });
    }
    for (const [userId, since] of this.peerDisconnectedSince) {
      if (now - since < PEER_DISCONNECTED_TIMEOUT_MS) continue;
      this.peerDisconnectedSince.delete(userId);
      logNet('mesh-disconnected-timeout', { peer: userId });
      this.rtc.closePeer(userId);
    }
    for (const [userId, at] of this.peerStallAt) {
      if (now < at) continue;
      this.peerStallAt.delete(userId);
      if (!this.rtc.hasPeer(userId) || this.rtc.isPeerReady(userId)) continue;
      logNet('mesh-connect-stall', { peer: userId });
      this.rtc.closePeer(userId);
    }
  }

  // Drop every per-peer recovery record for peers outside `keep` (or all).
  private clearPeerRecovery(keep?: Set<string>) {
    for (const map of [
      this.peerRetryAt,
      this.peerRetryAttempts,
      this.peerStallAt,
      this.peerDisconnectedSince,
      this.rtcRestartHandledAt,
    ]) {
      for (const id of [...map.keys()]) {
        if (!keep?.has(id)) map.delete(id);
      }
    }
  }

  // User asked to retry (manual button), returned to a backgrounded tab whose
  // socket dropped, or the OS reported the network came back: clear any pending
  // backoff, reset the counter, and reconnect now.
  private manualReconnect() {
    logNet('ws-manual-reconnect');
    this.dismissConnToast?.();
    this.dismissConnToast = null;
    this.connToastSteady = false;
    this.reconnectAttempt = 0;
    this.reconnectAt = null;
    this.net.connect();
  }

  private onServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'auth-error': {
        logNet('auth-error');
        this.authFailed = true;
        // Re-show the join overlay; main.ts returns to the password gate (auth
        // errors only happen when a password is required and wrong).
        document.getElementById('join-overlay')?.classList.remove('hidden');
        window.dispatchEvent(new CustomEvent('engawa-auth-error'));
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
        const resumed = msg.resumed === true && this.me !== null && msg.self.userId === this.myId;
        logNet('welcome', { bootChanged: boot.reload, resumed });
        if (boot.reload) {
          this.reloadBanner.show();
          break;
        }
        // Fresh tokens either way: the media token authenticates the RTC HTTP
        // endpoints; the resume token arms the NEXT reconnect (issue #187).
        this.myResumeToken = msg.resumeToken ?? null;
        setMediaToken(msg.token);
        if (resumed) {
          // Soft path (issue #187): the server kept our identity, so the live
          // mesh/SFU transports, our position and the group state all stay.
          // Only the players map needs reconciling — peers may have moved,
          // joined or left while our socket was down.
          this.reconcilePlayers(msg.players);
          // Re-announce status: peers kept our avatar, but anything broadcast
          // during the outage (mute toggles, notes) was lost on their side.
          this.broadcastStatus();
          break;
        }
        // Clear any prior-session state before adopting the new one, so a same-boot
        // reconnect (new userId) doesn't leave ghosts of our old self / stale peers.
        this.resetSessionState();
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
        this.broadcastStatus();
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
        // They are gone for good — drop group membership first so the peer
        // close below doesn't schedule a rebuild (#184; the follow-up
        // group-update confirms the membership).
        this.meshMembers.delete(msg.userId);
        this.sfuMembers.delete(msg.userId);
        this.sfuDirectory.delete(msg.userId);
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
      case 'rtc-restart': {
        // A group peer detected our pair is dead and asks us — their elected
        // initiator — to rebuild it with a fresh offer (issue #184). Debounced:
        // their retry loop may nudge several times while we renegotiate.
        if (this.currentMethod !== 'mesh' || !this.meshMembers.has(msg.from)) break;
        const now = performance.now();
        const last = this.rtcRestartHandledAt.get(msg.from);
        if (last != null && now - last < 3000) break;
        this.rtcRestartHandledAt.set(msg.from, now);
        logNet('rtc-restart-received', { peer: msg.from });
        this.rtc.closePeer(msg.from);
        this.createMeshPeer(msg.from, true);
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
        // Cache the directory regardless of transport: a later SFU rebuild
        // re-feeds it (issue #186), and the server only re-sends on changes.
        this.sfuDirectory.set(msg.userId, { sessionId: msg.sessionId, tracks: msg.tracks });
        // Ignore unless we're actually on SFU. setPeerTracks calls reopen(), which
        // would resurrect a ghost SFU PeerConnection while we run mesh — the server
        // keeps relaying these after a unilateral mesh fallback because it still
        // believes the group is SFU-latched (invariant #2, it can't know we fell
        // back).
        if (this.currentMethod !== 'sfu') break;
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
    //
    // sfuMembers is included so the SFU→mesh fallback works from the healthy side:
    // when a peer's SFU connection fails it meshes directly to us, but we are still
    // on SFU (meshMembers empty). Accepting their offer because they're in our
    // sfuMembers lets the call survive. During normal SFU operation members never
    // send mesh signals, so this only ever admits a genuine fallback offer.
    if (!this.rtc.hasPeer(from) && !this.meshMembers.has(from) && !this.sfuMembers.has(from)) {
      return;
    }
    // If we have no peer for this user, create as non-initiator. Arm the same
    // connect-stall watchdog as the outbound paths (#184).
    if (!this.rtc.hasPeer(from)) {
      this.peerStallAt.set(from, performance.now() + PEER_CONNECT_STALL_MS);
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
    this.tickNetwork(nowMs);
    this.update(dt);
    if (render) {
      const dest = this.movePath ? this.movePath[this.movePath.length - 1] : null;
      // Show the media-reach ring only while we're actually publishing something.
      const mediaActive = this.media.micOn || this.media.camOn || this.media.screenOn;
      this.renderer.render(this.me, this.players.values(), dest, this.focusedId, mediaActive);
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
      // Face the way we're moving so our own avatar's sprite turns (remote
      // players turn via setTarget). Idle keeps the last facing.
      this.me.updateFacing(selfVx, selfVy);
      // Moving re-centers the camera on self, so a map drag-pan is undone the
      // moment the player acts (walk / click-to-move).
      if (selfVx !== 0 || selfVy !== 0) this.renderer.recenter();
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

    // Call-quality sampling for the connection log (issue #182). Runs from the
    // loop (rAF or the background Worker), so it stays alive in hidden tabs.
    if (now - this.lastQualitySampleAt > QUALITY_SAMPLE_INTERVAL_MS) {
      this.lastQualitySampleAt = now;
      void this.sampleQuality();
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
    // The peer-count/speaker ceilings, further shrunk by the network tier
    // (#185) — under congestion video yields so voice keeps its headroom.
    const tier = this.netTierState.tier;
    this.rtc.setCamEncoding(applyNetTierToCam(computeCamEncoding(peerCount, speaking), tier));
    this.rtc.setScreenEncoding(applyNetTierToScreen(computeScreenEncoding(peerCount), tier));
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

  private broadcastStatus() {
    if (!this.me) return;
    this.me.status = this.myStatus;
    this.me.note = this.myNote;
    this.me.until = this.myUntil;
    this.me.isMuted = !this.media.micOn;
    this.me.isVideoOn = this.media.camOn;
    this.net.send({
      type: 'status',
      status: this.myStatus,
      isMuted: !this.media.micOn,
      isVideoOn: this.media.camOn,
      note: this.myNote,
      until: this.myUntil,
    });
  }

  // Set status plus optional one-liner and return time (#85). `untilMin` is a
  // preset in minutes (null = no time); it's resolved to an absolute epoch ms so
  // every peer shows the same clock target. A timer flips us back to online when
  // the time arrives. No-ops only when status, note, and time all match.
  private setStatus(status: PlayerStatus, note = '', untilMin: number | null = null) {
    const until = untilMin == null ? null : Date.now() + untilMin * 60_000;
    if (this.myStatus === status && this.myNote === note && this.myUntilMin === untilMin) return;
    this.myStatus = status;
    this.myNote = note;
    this.myUntil = until;
    this.myUntilMin = untilMin;
    this.broadcastStatus();
    this.roster.refreshStatus();
    this.scheduleAutoReturn();
  }

  // (Re)arm the auto-return-to-online timer for the current `myUntil`. Cleared
  // and reset on every status change; on fire it broadcasts online with no note.
  private scheduleAutoReturn() {
    if (this.untilTimer != null) {
      clearTimeout(this.untilTimer);
      this.untilTimer = null;
    }
    if (this.myUntil == null) return;
    const delay = Math.max(0, this.myUntil - Date.now());
    this.untilTimer = setTimeout(() => {
      this.untilTimer = null;
      this.setStatus('online');
    }, delay);
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
      this.clearPeerRecovery();
      if (wasMesh) {
        // mesh → SFU: drop every mesh peer, then publish our live streams to the
        // SFU. Remote media comes back via sfu-peer-tracks → pull. (meshMembers
        // was cleared above, so the recovery loop won't rebuild them — #184.)
        this.rtc.closeAll();
        this.publishLocalToSfu();
      }
      // Forget directory peers no longer in the group.
      const { toClose } = partitionMembers(this.knownSfuPeers, this.sfuMembers);
      for (const id of toClose) {
        this.sfu.removePeer(id);
        this.knownSfuPeers.delete(id);
        this.sfuDirectory.delete(id);
      }
    } else {
      // Always tear the SFU transport down when running mesh — even mesh→mesh — so
      // a ghost PC that a stray sfu-peer-tracks might have resurrected can't linger
      // pulling media next to the mesh path. closeAll is idempotent and cheap, and
      // group-updates only arrive on real topology changes (not every move).
      this.sfu.closeAll();
      this.knownSfuPeers.clear();
      this.sfuDirectory.clear();
      this.currentMethod = 'mesh';
      this.sfuMembers.clear();
      // Reconcile mesh peers against the group: close peers no longer in it,
      // open one to every member we are not yet connected to. createPeer bundles
      // our live streams automatically; initiator election keeps it to one offer.
      // meshMembers is updated BEFORE the closes so onPeerClosed (#184) can tell
      // "left the group" (drop recovery state) from "died mid-call" (rebuild).
      const next = new Set(members.filter((id) => id !== this.myId));
      this.meshMembers = next;
      this.clearPeerRecovery(next);
      const { toClose, toOpen } = partitionMembers(this.rtc.peerIds(), next);
      for (const id of toClose) this.rtc.closePeer(id);
      for (const id of toOpen) {
        this.createMeshPeer(id, isInitiator(this.myId, id));
      }
    }
  }

  private publishLocalToSfu() {
    if (this.media.micStream) this.sfu.addLocalStream(this.media.micStream, 'mic');
    if (this.media.camStream) this.sfu.addLocalStream(this.media.camStream, 'cam');
    if (this.media.screenStream) this.sfu.addLocalStream(this.media.screenStream, 'screen');
  }

  // The SFU transport failed (hard connection failure, or a control op that
  // exhausted its retries). First failure: rebuild the SFU session in place —
  // fresh PC, fresh Cloudflare session, re-publish our tracks, re-pull peers
  // from the cached directories — because a rebuild keeps the group on the
  // scalable path (issue #186; Cloudflare's renegotiate flow offers no
  // client-driven ICE restart, so a rebuild is the recovery primitive). A
  // second failure within SFU_REBUILD_MIN_INTERVAL_MS means the SFU path
  // really is unhealthy: degrade to mesh so the call survives.
  private onSfuFailed() {
    if (this.currentMethod !== 'sfu') {
      // Not on SFU, but a resurrected/ghost SFU transport may have failed. Ensure
      // it's torn down (idempotent) rather than left leaking, then bail.
      this.sfu.closeAll();
      return;
    }
    const now = performance.now();
    if (now - this.lastSfuRebuildAt > SFU_REBUILD_MIN_INTERVAL_MS) {
      this.lastSfuRebuildAt = now;
      logNet('sfu-rebuild');
      console.warn('[sfu] transport failed; rebuilding the SFU session');
      this.sfu.closeAll();
      this.knownSfuPeers.clear();
      this.publishLocalToSfu();
      for (const [id, dir] of this.sfuDirectory) {
        if (id === this.myId || !this.sfuMembers.has(id)) continue;
        this.knownSfuPeers.add(id);
        this.sfu.setPeerTracks(id, dir.sessionId, dir.tracks);
      }
      return;
    }
    logNet('sfu-fallback-mesh');
    console.warn('[sfu] connection failed; falling back to mesh');
    this.toasts.info(t('app.sfuFallback'));
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
      // A congested downlink (tier ≥2, #188) forces the half layer regardless
      // of tile size; otherwise the tile's rendered width picks it (#78).
      const rid = this.netTierState.tier >= 2 ? SFU_CAM_HALF_RID : computePreferredRid(width);
      this.sfu.setPreferredLayer(userId, 'cam', rid);
    }
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
