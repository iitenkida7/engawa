import { CanvasRenderer } from './canvas';
import { InputManager } from './input';
import { MediaManager } from './media';
import { NetworkClient } from './network';
import { PlayerState } from './player';
import { SoundManager } from './sounds';
import { canOccupy, findWalkableSpawn } from './tilemap';
import { isInitiator, isWithinConnectRadius, shouldConnect, shouldDisconnect } from './proximity';
import {
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

type RemoteTile = {
  container: HTMLDivElement;
  video: HTMLVideoElement;
  placeholder: HTMLDivElement;
  label: HTMLSpanElement;
  camStreamId?: string;
  hasCam: boolean;
  // Removes the drag listeners when the tile is destroyed.
  cleanupDrag: () => void;
};

type RemoteAudio = {
  audio: HTMLAudioElement;
  streamId: string;
};

// ---- Speaking detection via AnalyserNode ----
const SPEAKING_THRESHOLD = 15; // RMS amplitude (0-255 scale) to count as "speaking"
const SPEAKING_SMOOTHING = 0.85; // FFT smoothing

type SpeakingDetector = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  source: MediaStreamAudioSourceNode;
  buf: Uint8Array<ArrayBuffer>;
};

function createSpeakingDetector(stream: MediaStream): SpeakingDetector | null {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return null;
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = SPEAKING_SMOOTHING;
  const source = ctx.createMediaStreamSource(stream);
  source.connect(analyser);
  // Don't connect to destination — we only analyse, not play.
  return { ctx, analyser, source, buf: new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer> };
}

function isSpeaking(det: SpeakingDetector): boolean {
  det.analyser.getByteFrequencyData(det.buf);
  let sum = 0;
  for (let i = 0; i < det.buf.length; i++) sum += det.buf[i];
  return sum / det.buf.length > SPEAKING_THRESHOLD;
}

function destroySpeakingDetector(det: SpeakingDetector) {
  det.source.disconnect();
  void det.ctx.close();
}

type PanelMode = 'pip' | 'side' | 'full';

// The pip/side/full toggle shown in every panel header. Markup matches the
// static .stage-controls block in index.html so CSS is shared.
function createModeControls(): HTMLDivElement {
  const controls = document.createElement('div');
  controls.className = 'stage-controls';
  const modes: Array<[PanelMode, string, string]> = [
    ['pip', '🪟', '小窓'],
    ['side', '◧', 'サイドパネル'],
    ['full', '⬜', '全画面'],
  ];
  for (const [mode, icon, title] of modes) {
    const btn = document.createElement('button');
    btn.dataset.mode = mode;
    btn.title = title;
    btn.textContent = icon;
    if (mode === 'pip') btn.classList.add('active');
    controls.appendChild(btn);
  }
  return controls;
}

// Wires the mode buttons inside a panel's header. Switching mode toggles the
// mode-* class and clears any inline drag/resize styles so the CSS mode rules
// take over. `onPip` lets a panel restore its own floating placement (e.g. the
// stacked camera tiles); `onActivate` fires on every switch (e.g. raise z).
function setupPanelModes(
  el: HTMLElement,
  opts: { onPip?: () => void; onActivate?: () => void } = {},
) {
  const setMode = (mode: PanelMode) => {
    el.classList.remove('mode-pip', 'mode-side', 'mode-full');
    el.classList.add(`mode-${mode}`);
    el.style.left = '';
    el.style.top = '';
    el.style.right = '';
    el.style.bottom = '';
    el.style.width = '';
    el.style.height = '';
    if (mode === 'pip') opts.onPip?.();
    opts.onActivate?.();
    el.querySelectorAll('.stage-controls button').forEach((b) =>
      b.classList.toggle('active', (b as HTMLElement).dataset.mode === mode),
    );
  };

  const controls = el.querySelector('.stage-controls');
  // Don't let a click/drag on the buttons start a header drag.
  controls?.addEventListener('mousedown', (e) => e.stopPropagation());
  el.querySelectorAll<HTMLButtonElement>('.stage-controls button').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      setMode(btn.dataset.mode as PanelMode);
    });
  });
}

export class Game {
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

  private remoteVideosEl: HTMLDivElement;
  private remoteTiles = new Map<string, RemoteTile>();
  // Mic audio is attached to dedicated <audio> elements so it plays even when
  // the user has no cam (no video tile yet). userId → audio element.
  private remoteAudios = new Map<string, RemoteAudio>();

  private screenshareStageEl: HTMLDivElement;
  private screenshareVideoEl: HTMLVideoElement;
  private screenshareLabelEl: HTMLSpanElement;
  private currentScreenshareUserId: string | null = null;

  // Speaking detection
  private localSpeakingDetector: SpeakingDetector | null = null;
  private remoteSpeakingDetectors = new Map<string, SpeakingDetector>();

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
      onRemoteStream: (userId, stream, kind) => this.attachRemoteStream(userId, stream, kind),
      onRemoteStreamRemoved: (userId, streamId) => this.detachRemoteStream(userId, streamId),
      onPeerClosed: (userId) => this.removeRemoteTile(userId),
    });

    this.media.on(() => this.refreshToolbar());
    this.setupToolbar();
    this.setupScreensharePanel();
    // Make the self-preview draggable/resizable by its header (PiP mode only,
    // matching the other panels). The CSS keeps its initial bottom-right
    // placement; the first drag (or a window resize) converts it to left/top.
    makeDraggable(this.selfPreviewEl, {
      handle: this.selfPreviewHeaderEl,
      onStart: () => bringToFront(this.selfPreviewEl),
      canDrag: () => this.selfPreviewEl.classList.contains('mode-pip'),
    });
    setupPanelModes(this.selfPreviewEl, {
      onActivate: () => bringToFront(this.selfPreviewEl),
    });
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
          // Update tile mute indicator
          const tile = this.remoteTiles.get(msg.userId);
          if (tile) {
            tile.container.classList.toggle('muted', msg.isMuted);
          }
        }
        break;
      }
      case 'player-left': {
        this.players.delete(msg.userId);
        this.rtc.closePeer(msg.userId);
        this.removeRemoteTile(msg.userId);
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
    this.renderer.render(this.me, this.players.values());
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
      selfVx = dx * PLAYER_SPEED;
      selfVy = dy * PLAYER_SPEED;
      if (selfVx !== 0 || selfVy !== 0) {
        const newX = clamp(this.me.x + selfVx * dt, PLAYER_RADIUS, MAP_WIDTH - PLAYER_RADIUS);
        const newY = clamp(this.me.y + selfVy * dt, PLAYER_RADIUS, MAP_HEIGHT - PLAYER_RADIUS);
        // Try each axis independently so the player slides along walls
        if (canOccupy(newX, this.me.y, PLAYER_RADIUS)) this.me.x = newX;
        if (canOccupy(this.me.x, newY, PLAYER_RADIUS)) this.me.y = newY;
        this.me.targetX = this.me.x;
        this.me.targetY = this.me.y;
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
    for (const [userId, det] of this.remoteSpeakingDetectors) {
      const p = this.players.get(userId);
      if (p) p.isSpeaking = isSpeaking(det);
      // Update tile speaking indicator
      const tile = this.remoteTiles.get(userId);
      if (tile) tile.container.classList.toggle('speaking', p?.isSpeaking ?? false);
    }

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
        for (const entry of this.remoteAudios.values()) {
          const stream = entry.audio.srcObject as MediaStream | null;
          if (stream) audioStreams.push(stream);
        }
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

  // ============= Remote tiles =============
  private attachRemoteStream(userId: string, stream: MediaStream, kind: StreamKind) {
    if (kind === 'screen') {
      this.showScreenshareStage(userId, stream);
      const p = this.players.get(userId);
      if (p) p.isSharingScreen = true;
      return;
    }
    if (kind === 'mic') {
      this.attachRemoteMic(userId, stream);
      // Create a tile for mic-only users (no-video placeholder)
      if (!this.remoteTiles.has(userId)) {
        const tile = this.createRemoteTile(userId);
        this.remoteTiles.set(userId, tile);
      }
      // Set up speaking detector for this remote user
      const oldDet = this.remoteSpeakingDetectors.get(userId);
      if (oldDet) destroySpeakingDetector(oldDet);
      const det = createSpeakingDetector(stream);
      if (det) this.remoteSpeakingDetectors.set(userId, det);
      return;
    }
    // cam → tile with <video>
    let tile = this.remoteTiles.get(userId);
    if (!tile) {
      tile = this.createRemoteTile(userId);
      this.remoteTiles.set(userId, tile);
    }
    tile.hasCam = true;
    tile.camStreamId = stream.id;
    tile.video.srcObject = stream;
    tile.video.style.display = '';
    tile.placeholder.style.display = 'none';
    tile.video.play().catch(() => {
      // autoplay blocked: will play on user gesture
    });
    const p = this.players.get(userId);
    tile.label.textContent = p?.name || userId.slice(0, 6);
  }

  private detachRemoteStream(userId: string, streamId: string) {
    const audio = this.remoteAudios.get(userId);
    if (audio && audio.streamId === streamId) {
      try { audio.audio.srcObject = null; } catch { /* noop */ }
      audio.audio.remove();
      this.remoteAudios.delete(userId);
      this.recorder.removeAudioStream(streamId);
      // Clean up speaking detector
      const det = this.remoteSpeakingDetectors.get(userId);
      if (det) {
        destroySpeakingDetector(det);
        this.remoteSpeakingDetectors.delete(userId);
      }
      // If no cam either, remove the tile entirely
      const tile = this.remoteTiles.get(userId);
      if (tile && !tile.hasCam) {
        tile.cleanupDrag();
        tile.container.remove();
        this.remoteTiles.delete(userId);
      }
    }
    const tile = this.remoteTiles.get(userId);
    if (tile && tile.camStreamId === streamId) {
      tile.hasCam = false;
      tile.camStreamId = undefined;
      try { tile.video.srcObject = null; } catch { /* noop */ }
      // If still has mic, show placeholder; otherwise remove tile
      if (this.remoteAudios.has(userId)) {
        tile.video.style.display = 'none';
        tile.placeholder.style.display = '';
      } else {
        tile.cleanupDrag();
        tile.container.remove();
        this.remoteTiles.delete(userId);
      }
    }
    if (this.currentScreenshareUserId === userId &&
        (this.screenshareVideoEl.srcObject as MediaStream | null)?.id === streamId) {
      this.clearScreenshareStage();
      const p = this.players.get(userId);
      if (p) p.isSharingScreen = false;
    }
  }

  private attachRemoteMic(userId: string, stream: MediaStream) {
    let entry = this.remoteAudios.get(userId);
    if (!entry) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      // off-screen but still in DOM so audio plays
      audio.style.display = 'none';
      document.body.appendChild(audio);
      entry = { audio, streamId: stream.id };
      this.remoteAudios.set(userId, entry);
    }
    entry.streamId = stream.id;
    entry.audio.srcObject = stream;
    entry.audio.play().catch(() => {
      // autoplay blocked: will play on user gesture
    });
    // If recording is active, add this stream to the mix
    if (this.recorder.recording) {
      this.recorder.addAudioStream(stream);
    }
  }

  private createRemoteTile(userId: string): RemoteTile {
    const p = this.players.get(userId);
    const name = p?.name || userId.slice(0, 6);
    const initials = p ? p.initials() : name.slice(0, 2).toUpperCase();

    // Panel shell: header bar (grab handle + name) + body (video / no-video).
    // Shares the .panel / .panel-header / .panel-body chrome with the
    // screenshare stage and self preview.
    const container = document.createElement('div');
    container.className = 'panel remote-tile mode-pip';
    container.dataset.userId = userId;

    const header = document.createElement('div');
    header.className = 'panel-header';
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    header.appendChild(label);
    header.appendChild(createModeControls());
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    container.appendChild(body);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.display = 'none';
    body.appendChild(video);

    const placeholder = document.createElement('div');
    placeholder.className = 'no-video';
    placeholder.innerHTML = `<span class="no-video-initials">${initials}</span><span class="no-video-name">${name}</span>`;
    body.appendChild(placeholder);

    // Initial (PiP) position: stack tiles down from the top-right corner,
    // offsetting each new tile so they don't fully overlap. Returning to PiP
    // via the mode button restores this home slot.
    const index = this.remoteTiles.size;
    const applyHome = () => {
      container.style.left = 'auto';
      container.style.right = `${12 + index * 16}px`;
      container.style.top = `${12 + index * 16}px`;
      container.style.bottom = 'auto';
    };
    applyHome();

    this.remoteVideosEl.appendChild(container);
    // Drag by the header only, PiP mode only (matches the other panels).
    const cleanupDrag = makeDraggable(container, {
      handle: header,
      onStart: () => bringToFront(container),
      canDrag: () => container.classList.contains('mode-pip'),
    });
    setupPanelModes(container, {
      onPip: applyHome,
      onActivate: () => bringToFront(container),
    });
    return { container, video, placeholder, label, hasCam: false, cleanupDrag };
  }

  private removeRemoteTile(userId: string) {
    const t = this.remoteTiles.get(userId);
    if (t) {
      t.cleanupDrag();
      try { t.video.srcObject = null; } catch { /* noop */ }
      t.container.remove();
      this.remoteTiles.delete(userId);
    }
    const a = this.remoteAudios.get(userId);
    if (a) {
      try { a.audio.srcObject = null; } catch { /* noop */ }
      a.audio.remove();
      this.remoteAudios.delete(userId);
    }
    const det = this.remoteSpeakingDetectors.get(userId);
    if (det) {
      destroySpeakingDetector(det);
      this.remoteSpeakingDetectors.delete(userId);
    }
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

    // Mode switching is shared with the camera tiles and self preview.
    setupPanelModes(stage);

    // Drag (PiP mode only). Reuses the shared helper; the PiP-only constraint
    // and edge-anchor clearing are preserved by the canDrag guard and the
    // helper's left/top + right/bottom:auto behaviour.
    makeDraggable(stage, {
      handle: header,
      canDrag: () => stage.classList.contains('mode-pip'),
    });
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
