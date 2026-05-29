import { CanvasRenderer } from './canvas';
import { InputManager } from './input';
import { MediaManager } from './media';
import { NetworkClient } from './network';
import { PlayerState } from './player';
import { SoundManager } from './sounds';
import { canOccupy, findWalkableSpawn } from './tilemap';
import { isInitiator, isWithinConnectRadius, shouldConnect, shouldDisconnect } from './proximity';
import type { Point } from './proximity';
import { findPath } from './pathfind';
import {
  CLICK_MOVE_ARRIVE_THRESHOLD,
  CLICK_MOVE_MULTIPLIER,
  CONNECT_RADIUS,
  DISCONNECT_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSITION_SEND_INTERVAL_MS,
  type PlayerStatus,
  type ServerMessage,
  type StreamKind,
} from './types';
import { RecorderManager } from './recorder';
import { WebRtcManager } from './webrtc';
import { bringToFront, makeDraggable } from './draggable';
import { bindCamAspect, setupPanelModes } from './panel';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  type SpeakingDetector,
} from './speaking';
import { RemoteParticipants } from './remote';

export class App {
  private canvas: HTMLCanvasElement;
  private renderer: CanvasRenderer;
  private input: InputManager;
  private net: NetworkClient;
  private media: MediaManager;
  private rtc: WebRtcManager;

  private myId: string = '';
  private me: PlayerState | null = null;
  private players = new Map<string, PlayerState>();

  private lastSent = 0;
  private lastSentX = 0;
  private lastSentY = 0;

  // Click-to-move: remaining waypoint tile-centers and the current index.
  private movePath: Point[] | null = null;
  private moveIndex = 0;

  private remoteVideosEl: HTMLDivElement;
  // Remote camera tiles, mic audio elements and speaking detectors, managed as
  // one cohesive unit keyed by user id.
  private participants!: RemoteParticipants;

  private screenshareStageEl: HTMLDivElement;
  private screenshareVideoEl: HTMLVideoElement;
  private screenshareLabelEl: HTMLSpanElement;
  private currentScreenshareUserId: string | null = null;

  // Speaking detection for the local user (remote ones live in participants).
  private localSpeakingDetector: SpeakingDetector | null = null;

  private selfPreviewEl: HTMLDivElement;
  private selfPreviewHeaderEl: HTMLDivElement;
  private selfPreviewLabelEl: HTMLSpanElement;
  private selfVideoEl: HTMLVideoElement;

  private hudName: HTMLElement;
  private hudCount: HTMLElement;
  private btnMic: HTMLButtonElement;
  private btnCam: HTMLButtonElement;
  private btnScreen: HTMLButtonElement;
  private btnRec: HTMLButtonElement;
  private btnStatus: HTMLButtonElement;
  private recorder: RecorderManager;
  private sounds = new SoundManager();
  // Track which peers were in proximity last frame (for chime on enter/leave)
  private inProximity = new Set<string>();
  private myStatus: PlayerStatus = 'online';

  constructor(opts: { canvas: HTMLCanvasElement }) {
    this.canvas = opts.canvas;
    this.renderer = new CanvasRenderer(this.canvas);
    this.input = new InputManager();
    this.media = new MediaManager();

    this.remoteVideosEl = document.getElementById('remote-videos') as HTMLDivElement;
    this.screenshareStageEl = document.getElementById('screenshare-stage') as HTMLDivElement;
    this.screenshareVideoEl = document.getElementById('screenshare-video') as HTMLVideoElement;
    this.screenshareLabelEl = document.getElementById('screenshare-label') as HTMLSpanElement;
    this.selfPreviewEl = document.getElementById('self-preview') as HTMLDivElement;
    this.selfPreviewHeaderEl = document.getElementById('self-preview-header') as HTMLDivElement;
    this.selfPreviewLabelEl = document.getElementById('self-preview-label') as HTMLSpanElement;
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;
    this.hudName = document.getElementById('hud-name')!;
    this.hudCount = document.getElementById('hud-count')!;
    this.btnMic = document.getElementById('btn-mic') as HTMLButtonElement;
    this.btnCam = document.getElementById('btn-cam') as HTMLButtonElement;
    this.btnScreen = document.getElementById('btn-screen') as HTMLButtonElement;
    this.btnRec = document.getElementById('btn-rec') as HTMLButtonElement;
    this.btnStatus = document.getElementById('btn-status') as HTMLButtonElement;
    this.recorder = new RecorderManager();
    this.participants = new RemoteParticipants({
      container: this.remoteVideosEl,
      recorder: this.recorder,
      info: (userId) => this.participantInfo(userId),
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
      onRemoteStream: (userId, stream, kind) => this.attachRemoteStream(userId, stream, kind),
      onRemoteStreamRemoved: (userId, streamId) => this.detachRemoteStream(userId, streamId),
      onPeerClosed: (userId) => this.participants.remove(userId),
    });

    this.media.on(() => this.refreshToolbar());
    this.setupToolbar();
    this.setupScreensharePanel();
    // Make the self-preview draggable/resizable by its header. The CSS keeps
    // its initial bottom-right placement; the first drag (or a window resize)
    // converts it to left/top.
    makeDraggable(this.selfPreviewEl, {
      handle: this.selfPreviewHeaderEl,
      onStart: () => bringToFront(this.selfPreviewEl),
    });
    setupPanelModes(this.selfPreviewEl, {
      aspectLocked: true,
      onActivate: () => bringToFront(this.selfPreviewEl),
    });
    bindCamAspect(this.selfPreviewEl, this.selfVideoEl);

    // Double-click the map to walk to that point (A* around walls, 2× speed).
    this.canvas.addEventListener('dblclick', (e) => this.onCanvasDblClick(e));
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

  private onClose() {
    if (this.authFailed) {
      this.authFailed = false;
      return;
    }
    console.warn('[ws] connection closed; will retry in 2s');
    setTimeout(() => this.net.connect(), 2000);
  }

  private authFailed = false;

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
        this.myId = msg.self.userId;
        const spawn = findWalkableSpawn(msg.self.x, msg.self.y, PLAYER_RADIUS);
        msg.self.x = spawn.x;
        msg.self.y = spawn.y;
        this.me = new PlayerState(msg.self, true);
        this.players.set(this.myId, this.me);
        for (const p of msg.players) {
          this.players.set(p.userId, new PlayerState(p, false));
        }
        this.hudName.textContent = this.joinedName;
        this.selfPreviewLabelEl.textContent = this.joinedName || 'あなた';
        this.hudCount.textContent = `${this.players.size} 人接続中`;
        document.getElementById('hud')?.classList.remove('hidden');
        document.getElementById('toolbar')?.classList.remove('hidden');
        this.broadcastStatus();
        break;
      }
      case 'player-joined': {
        if (msg.player.userId === this.myId) break;
        this.players.set(msg.player.userId, new PlayerState(msg.player, false));
        this.hudCount.textContent = `${this.players.size} 人接続中`;
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
          this.participants.setMuted(msg.userId, msg.isMuted);
        }
        break;
      }
      case 'player-left': {
        this.players.delete(msg.userId);
        this.rtc.closePeer(msg.userId);
        this.participants.remove(msg.userId);
        if (this.currentScreenshareUserId === msg.userId) {
          this.clearScreenshareStage();
        }
        this.hudCount.textContent = `${this.players.size} 人接続中`;
        break;
      }
      case 'signal': {
        this.handleSignal(msg.from, msg.data);
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
    this.renderer.render(this.me, this.players.values(), dest);
    requestAnimationFrame(this.loop);
  };

  private lastSentVx = 0;
  private lastSentVy = 0;

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

    // Speaking detection
    if (this.me && this.localSpeakingDetector) {
      this.me.isSpeaking = isSpeaking(this.localSpeakingDetector);
    }
    this.participants.updateSpeaking((userId, speaking) => {
      const p = this.players.get(userId);
      if (p) p.isSpeaking = speaking;
    });

    // Proximity check + chime sounds
    if (this.me) {
      const nowInProximity = new Set<string>();
      for (const p of this.players.values()) {
        if (p.isSelf) continue;
        const has = this.rtc.hasPeer(p.userId);
        if (shouldConnect(this.me, p, CONNECT_RADIUS, has)) {
          void this.rtc.createPeer(p.userId, isInitiator(this.myId, p.userId));
        } else if (shouldDisconnect(this.me, p, DISCONNECT_RADIUS, has)) {
          this.rtc.closePeer(p.userId);
        }
        if (isWithinConnectRadius(this.me, p, CONNECT_RADIUS)) {
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
    if (canOccupy(newX, this.me.y, PLAYER_RADIUS)) this.me.x = newX;
    if (canOccupy(this.me.x, newY, PLAYER_RADIUS)) this.me.y = newY;
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

  // ============= Media toolbar =============
  private setupToolbar() {
    this.btnMic.addEventListener('click', async () => {
      if (this.media.micOn) {
        this.stopMic();
      } else {
        await this.startMic();
      }
      this.broadcastStatus();
    });
    this.btnCam.addEventListener('click', async () => {
      if (this.media.camOn) {
        this.stopCam();
      } else {
        await this.startCam();
      }
      this.broadcastStatus();
    });
    this.setupDeviceMenus();
    this.btnScreen.addEventListener('click', async () => {
      if (this.media.screenOn) {
        const old = this.media.disableScreen();
        if (old) this.rtc.removeLocalStream(old);
        if (this.me) this.me.isSharingScreen = false;
        this.clearScreenshareStage();
      } else {
        try {
          const stream = await this.media.enableScreen();
          this.rtc.addLocalStream(stream, 'screen');
          if (this.me) this.me.isSharingScreen = true;
          this.showScreenshareStage(this.myId, stream);
        } catch (e) {
          alert('画面共有を開始できません: ' + (e as Error).message);
        }
      }
    });
    this.btnRec.addEventListener('click', () => {
      if (this.recorder.recording) {
        this.recorder.stop();
      } else {
        // Collect all active audio streams (local mic + remote mics)
        const audioStreams: MediaStream[] = [];
        if (this.media.micStream) audioStreams.push(this.media.micStream);
        audioStreams.push(...this.participants.audioStreams());
        // Use cam or screen as video source (prefer screen if active)
        const videoStream = this.media.screenStream ?? this.media.camStream ?? undefined;
        this.recorder.start(audioStreams, videoStream);
      }
      this.refreshToolbar();
    });
    this.recorder.on(() => this.refreshToolbar());
    this.btnStatus.addEventListener('click', () => {
      const cycle: PlayerStatus[] = ['online', 'busy', 'away'];
      const idx = cycle.indexOf(this.myStatus);
      this.myStatus = cycle[(idx + 1) % cycle.length];
      this.broadcastStatus();
      this.refreshToolbar();
    });
    this.refreshToolbar();
  }

  private refreshToolbar() {
    this.btnMic.classList.toggle('active', this.media.micOn);
    this.btnMic.textContent = this.media.micOn ? '🎤 マイク ON' : '🎤 マイク';
    this.btnCam.classList.toggle('active', this.media.camOn);
    this.btnCam.textContent = this.media.camOn ? '📷 カメラ ON' : '📷 カメラ';
    this.btnScreen.classList.toggle('active', this.media.screenOn);
    this.btnScreen.textContent = this.media.screenOn ? '🖥 共有中' : '🖥 画面共有';
    this.btnRec.classList.toggle('recording', this.recorder.recording);
    this.btnRec.textContent = this.recorder.recording ? '⏹ 録画停止' : '⏺ 録画';
    const statusLabel: Record<PlayerStatus, string> = { online: '🟢 オンライン', busy: '🔴 取り込み中', away: '🟡 離席中' };
    this.btnStatus.textContent = statusLabel[this.myStatus];
    this.refreshSelfPreview();
  }

  // ---- Mic/cam enable & disable flows (shared by toolbar and device switch) ----
  private async startMic() {
    try {
      const stream = await this.media.enableMic();
      this.rtc.addLocalStream(stream, 'mic');
      this.localSpeakingDetector = createSpeakingDetector(stream);
    } catch (e) {
      alert('マイクを使えません: ' + (e as Error).message);
    }
  }
  private stopMic() {
    const old = this.media.disableMic();
    if (old) this.rtc.removeLocalStream(old);
    if (this.localSpeakingDetector) {
      destroySpeakingDetector(this.localSpeakingDetector);
      this.localSpeakingDetector = null;
    }
    if (this.me) this.me.isSpeaking = false;
  }
  private async startCam() {
    try {
      const stream = await this.media.enableCam();
      this.rtc.addLocalStream(stream, 'cam');
    } catch (e) {
      alert('カメラを使えません: ' + (e as Error).message);
    }
  }
  private stopCam() {
    const old = this.media.disableCam();
    if (old) this.rtc.removeLocalStream(old);
  }

  // ============= Device selection =============
  private setupDeviceMenus() {
    const micMenu = document.getElementById('mic-menu') as HTMLDivElement;
    const camMenu = document.getElementById('cam-menu') as HTMLDivElement;
    const btnMicDevices = document.getElementById('btn-mic-devices') as HTMLButtonElement;
    const btnCamDevices = document.getElementById('btn-cam-devices') as HTMLButtonElement;

    const closeMenus = () => {
      micMenu.classList.add('hidden');
      camMenu.classList.add('hidden');
    };
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (!micMenu.contains(t) && t !== btnMicDevices &&
          !camMenu.contains(t) && t !== btnCamDevices) {
        closeMenus();
      }
    });

    btnMicDevices.addEventListener('click', async (e) => {
      e.stopPropagation();
      const open = micMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        await this.populateDeviceMenu(micMenu, await this.media.listMics(), this.media.selectedMicId,
          (id) => this.switchMic(id));
        micMenu.classList.remove('hidden');
      }
    });
    btnCamDevices.addEventListener('click', async (e) => {
      e.stopPropagation();
      const open = camMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        await this.populateDeviceMenu(camMenu, await this.media.listCams(), this.media.selectedCamId,
          (id) => this.switchCam(id));
        camMenu.classList.remove('hidden');
      }
    });
  }

  private async populateDeviceMenu(
    menu: HTMLDivElement,
    devices: MediaDeviceInfo[],
    selectedId: string | null,
    onPick: (deviceId: string) => void,
  ) {
    menu.replaceChildren();
    if (devices.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'device-empty';
      empty.textContent = 'デバイスが見つかりません';
      menu.appendChild(empty);
      return;
    }
    devices.forEach((d, i) => {
      const item = document.createElement('button');
      item.className = 'device-item';
      // The first listed device represents the browser default when nothing
      // has been explicitly selected.
      const isSelected = d.deviceId === selectedId || (!selectedId && i === 0);
      if (isSelected) item.classList.add('selected');
      item.textContent = (isSelected ? '✓ ' : '') + (d.label || `デバイス ${i + 1}`);
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        onPick(d.deviceId);
      });
      menu.appendChild(item);
    });
  }

  private async switchMic(deviceId: string) {
    if (this.media.selectedMicId === deviceId) return;
    this.media.selectedMicId = deviceId;
    if (!this.media.micOn) return;
    // Re-acquire from the new device, swapping the live RTC stream.
    this.stopMic();
    await this.startMic();
    this.broadcastStatus();
  }

  private async switchCam(deviceId: string) {
    if (this.media.selectedCamId === deviceId) return;
    this.media.selectedCamId = deviceId;
    if (!this.media.camOn) return;
    this.stopCam();
    await this.startCam();
    this.broadcastStatus();
  }

  private refreshSelfPreview() {
    const stream = this.media.camStream;
    if (stream) {
      if (this.selfVideoEl.srcObject !== stream) {
        this.selfVideoEl.srcObject = stream;
        this.selfVideoEl.play().catch(() => {
          /* autoplay should already be allowed after the join click */
        });
      }
      this.selfPreviewEl.classList.remove('hidden');
    } else {
      try { this.selfVideoEl.srcObject = null; } catch { /* noop */ }
      this.selfPreviewEl.classList.add('hidden');
    }
  }

  // ============= Remote streams =============
  // Screenshare goes to the shared stage; mic/cam are handled by the
  // RemoteParticipants manager (tile + audio + speaking detector per user).
  private attachRemoteStream(userId: string, stream: MediaStream, kind: StreamKind) {
    if (kind === 'screen') {
      this.showScreenshareStage(userId, stream);
      const p = this.players.get(userId);
      if (p) p.isSharingScreen = true;
      return;
    }
    if (kind === 'mic') {
      this.participants.attachMic(userId, stream);
    } else {
      this.participants.attachCam(userId, stream);
    }
  }

  private detachRemoteStream(userId: string, streamId: string) {
    this.participants.detach(userId, streamId);
    if (this.currentScreenshareUserId === userId &&
        (this.screenshareVideoEl.srcObject as MediaStream | null)?.id === streamId) {
      this.clearScreenshareStage();
      const p = this.players.get(userId);
      if (p) p.isSharingScreen = false;
    }
  }

  // Display name + avatar initials for a remote user, used by the tile manager.
  private participantInfo(userId: string): { name: string; initials: string } {
    const p = this.players.get(userId);
    const name = p?.name || userId.slice(0, 6);
    const initials = p ? p.initials() : name.slice(0, 2).toUpperCase();
    return { name, initials };
  }

  private showScreenshareStage(userId: string, stream: MediaStream) {
    this.currentScreenshareUserId = userId;
    this.screenshareVideoEl.srcObject = stream;
    this.screenshareVideoEl.play().catch(() => {
      /* autoplay may be blocked */
    });
    const isSelf = userId === this.myId;
    const p = this.players.get(userId);
    this.screenshareLabelEl.textContent = isSelf
      ? 'あなたの画面'
      : `${p?.name || userId.slice(0, 6)} の画面`;
    this.screenshareStageEl.classList.add('visible');
  }

  private clearScreenshareStage() {
    this.currentScreenshareUserId = null;
    try {
      this.screenshareVideoEl.srcObject = null;
    } catch {
      /* noop */
    }
    this.screenshareStageEl.classList.remove('visible');
    // Reset inline drag/resize styles so CSS mode defaults apply next time
    const el = this.screenshareStageEl;
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.width = '';
    el.style.height = '';
  }

  // ============= Screenshare panel: mode switch + drag =============
  private setupScreensharePanel() {
    const stage = this.screenshareStageEl;
    const header = document.getElementById('stage-header')!;

    // Preset buttons are shared with the camera tiles and self preview.
    setupPanelModes(stage);

    // Always draggable by its header; presets only set an initial layout.
    makeDraggable(stage, { handle: header });
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
