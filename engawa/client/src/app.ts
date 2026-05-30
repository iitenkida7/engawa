import { CanvasRenderer } from './canvas';
import { InputManager } from './input';
import { MediaManager } from './media';
import { NetworkClient } from './network';
import { PlayerState } from './player';
import { SoundManager } from './sounds';
import { canOccupy, findWalkableSpawn, zoneAt } from './tilemap';
import { inCallRange, isInitiator, shouldConnect, shouldDisconnect } from './proximity';
import type { Point } from './proximity';
import { findPath } from './pathfind';
import {
  CLICK_MOVE_ARRIVE_THRESHOLD,
  CLICK_MOVE_MULTIPLIER,
  CONNECT_RADIUS,
  DISCONNECT_RADIUS,
  COLLISION_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSITION_SEND_INTERVAL_MS,
  type PlayerStatus,
  type ServerMessage,
} from './types';
import { RecorderManager } from './recorder';
import { SceneCompositor } from './compositor';
import { WebRtcManager } from './webrtc';
import { RemoteMediaView } from './remote-media';
import { RosterPanel } from './roster';
import { ToolbarController } from './toolbar';
import { ReloadBanner, evaluateBoot } from './reload';

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
  private recorder: RecorderManager;
  private compositor: SceneCompositor;
  private view: RemoteMediaView;
  private toolbar: ToolbarController;
  private roster: RosterPanel;
  private sounds = new SoundManager();

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

  // The server's boot id from the first welcome. A different id on a later
  // welcome (after a reconnect) means the server restarted/redeployed — see the
  // welcome handler and reload.ts.
  private serverBootId: string | null = null;
  private reloadBanner = new ReloadBanner();

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

    this.toolbar = new ToolbarController({
      media: this.media,
      rtc: this.rtc,
      recorder: this.recorder,
      compositor: this.compositor,
      view: this.view,
      broadcastStatus: () => this.broadcastStatus(),
      getMe: () => this.me,
      getStatus: () => this.myStatus,
      onSetStatus: (status) => this.setStatus(status),
    });

    this.roster = new RosterPanel({
      players: this.players,
      getMyId: () => this.myId,
      onFocus: (userId) => this.focusPlayer(userId),
      onGoTo: (userId) => this.goToPlayer(userId),
    });

    // Media changes refresh both the toolbar buttons and the self preview;
    // recorder changes only touch the toolbar.
    this.media.on(() => {
      this.toolbar.refresh();
      this.view.refreshSelfPreview();
    });
    this.recorder.on(() => this.toolbar.refresh());
    this.view.refreshSelfPreview();

    // Double-click the map to walk to that point (A* around walls, 2× speed).
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

  private joinedName = '';
  private joinedPassword = '';

  start(name: string, password: string) {
    this.joinedName = name;
    this.joinedPassword = password;
    this.net.connect();
    requestAnimationFrame(this.loop);
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
        this.rtc.closePeer(msg.userId);
        this.view.removePeer(msg.userId);
        if (this.view.isShowingScreenshareFor(msg.userId)) {
          this.view.clearScreenshare();
        }
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
    }
  }

  private async handleSignal(from: string, data: unknown) {
    // If we have no peer for this user, create as non-initiator
    if (!this.rtc.hasPeer(from)) {
      await this.rtc.createPeer(from, false);
    }
    this.rtc.signal(from, data);
  }

  private lastFrameMs = 0;

  private loop = (nowMs?: number) => {
    const t = nowMs ?? performance.now();
    const dt = this.lastFrameMs ? Math.min(0.1, (t - this.lastFrameMs) / 1000) : 1 / 60;
    this.lastFrameMs = t;
    this.update(dt);
    const dest = this.movePath ? this.movePath[this.movePath.length - 1] : null;
    this.renderer.render(this.me, this.players.values(), dest, this.focusedId);
    requestAnimationFrame(this.loop);
  };

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

    // Refresh the participant roster from the (now up-to-date) players map.
    this.roster.update(this.focusedId);

    // Proximity check + chime sounds
    if (this.me) {
      // Meeting rooms are isolated bubbles: inside a room, zone membership
      // decides the call (everyone in the same room, nobody outside); outside,
      // the usual proximity radius applies. Both ends compute zones from the
      // already-synced positions, so the decision stays symmetric.
      const myZoneId = zoneAt(this.me.x, this.me.y)?.id ?? null;
      const nowInProximity = new Set<string>();
      for (const p of this.players.values()) {
        if (p.isSelf) continue;
        const otherZoneId = zoneAt(p.x, p.y)?.id ?? null;
        const has = this.rtc.hasPeer(p.userId);
        if (shouldConnect(this.me, p, CONNECT_RADIUS, has, myZoneId, otherZoneId)) {
          void this.rtc.createPeer(p.userId, isInitiator(this.myId, p.userId));
        } else if (shouldDisconnect(this.me, p, DISCONNECT_RADIUS, has, myZoneId, otherZoneId)) {
          this.rtc.closePeer(p.userId);
        }
        if (inCallRange(this.me, p, CONNECT_RADIUS, myZoneId, otherZoneId)) {
          nowInProximity.add(p.userId);
          if (!this.inProximity.has(p.userId)) {
            this.sounds.enter();
          }
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

  // Advances along the click-to-move waypoints at 2× speed. Returns the
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
    this.toolbar.refresh();
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
