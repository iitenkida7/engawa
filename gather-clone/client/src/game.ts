import { CanvasRenderer } from './canvas';
import { InputManager } from './input';
import { MediaManager } from './media';
import { NetworkClient } from './network';
import { PlayerState } from './player';
import { SoundManager } from './sounds';
import { canOccupy } from './tilemap';
import {
  CONNECT_RADIUS,
  DISCONNECT_RADIUS,
  MAP_HEIGHT,
  MAP_WIDTH,
  PLAYER_RADIUS,
  PLAYER_SPEED,
  POSITION_SEND_INTERVAL_MS,
  type ServerMessage,
  type StreamKind,
} from './types';
import { WebRtcManager } from './webrtc';

type RemoteTile = {
  container: HTMLDivElement;
  video: HTMLVideoElement;
  placeholder: HTMLDivElement;
  label: HTMLSpanElement;
  camStreamId?: string;
  hasCam: boolean;
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
  buf: Uint8Array;
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
  private selfVideoEl: HTMLVideoElement;

  private hudName: HTMLElement;
  private hudCount: HTMLElement;
  private btnMic: HTMLButtonElement;
  private btnCam: HTMLButtonElement;
  private btnScreen: HTMLButtonElement;

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
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;
    this.hudName = document.getElementById('hud-name')!;
    this.hudCount = document.getElementById('hud-count')!;
    this.btnMic = document.getElementById('btn-mic') as HTMLButtonElement;
    this.btnCam = document.getElementById('btn-cam') as HTMLButtonElement;
    this.btnScreen = document.getElementById('btn-screen') as HTMLButtonElement;

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
  }

  private joinedName = '';

  start(name: string) {
    this.joinedName = name;
    this.net.connect();
    requestAnimationFrame(this.loop);
  }

  private onOpen() {
    const params = new URLSearchParams(window.location.search);
    const workspace = params.get('workspace') || 'default';
    this.net.send({ type: 'join', name: this.joinedName, workspace });
  }

  private onClose() {
    console.warn('[ws] connection closed; will retry in 2s');
    setTimeout(() => this.net.connect(), 2000);
  }

  private onServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'welcome': {
        this.myId = msg.self.userId;
        this.me = new PlayerState(msg.self, true);
        this.players.set(this.myId, this.me);
        for (const p of msg.players) {
          this.players.set(p.userId, new PlayerState(p, false));
        }
        this.hudName.textContent = this.joinedName;
        this.hudCount.textContent = `${this.players.size} 人接続中`;
        document.getElementById('hud')?.classList.remove('hidden');
        document.getElementById('toolbar')?.classList.remove('hidden');
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

    // Proximity check
    if (this.me) {
      for (const p of this.players.values()) {
        if (p.isSelf) continue;
        const dist = Math.hypot(p.x - this.me.x, p.y - this.me.y);
        const has = this.rtc.hasPeer(p.userId);
        if (!has && dist <= CONNECT_RADIUS) {
          // Lower userId initiates to avoid double-init
          const initiator = this.myId < p.userId;
          void this.rtc.createPeer(p.userId, initiator);
        } else if (has && dist > DISCONNECT_RADIUS) {
          this.rtc.closePeer(p.userId);
        }
      }
    }
  }

  // ============= Media toolbar =============
  private setupToolbar() {
    this.btnMic.addEventListener('click', async () => {
      if (this.media.micOn) {
        const old = this.media.disableMic();
        if (old) this.rtc.removeLocalStream(old);
        if (this.localSpeakingDetector) {
          destroySpeakingDetector(this.localSpeakingDetector);
          this.localSpeakingDetector = null;
        }
        if (this.me) this.me.isSpeaking = false;
      } else {
        try {
          const stream = await this.media.enableMic();
          this.rtc.addLocalStream(stream, 'mic');
          this.localSpeakingDetector = createSpeakingDetector(stream);
        } catch (e) {
          alert('マイクを使えません: ' + (e as Error).message);
        }
      }
    });
    this.btnCam.addEventListener('click', async () => {
      if (this.media.camOn) {
        const old = this.media.disableCam();
        if (old) this.rtc.removeLocalStream(old);
      } else {
        try {
          const stream = await this.media.enableCam();
          this.rtc.addLocalStream(stream, 'cam');
        } catch (e) {
          alert('カメラを使えません: ' + (e as Error).message);
        }
      }
    });
    this.btnScreen.addEventListener('click', async () => {
      if (this.media.screenOn) {
        const old = this.media.disableScreen();
        if (old) this.rtc.removeLocalStream(old);
        if (this.me) this.me.isSharingScreen = false;
      } else {
        try {
          const stream = await this.media.enableScreen();
          this.rtc.addLocalStream(stream, 'screen');
          if (this.me) this.me.isSharingScreen = true;
        } catch (e) {
          alert('画面共有を開始できません: ' + (e as Error).message);
        }
      }
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
    this.refreshSelfPreview();
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
      // Clean up speaking detector
      const det = this.remoteSpeakingDetectors.get(userId);
      if (det) {
        destroySpeakingDetector(det);
        this.remoteSpeakingDetectors.delete(userId);
      }
      // If no cam either, remove the tile entirely
      const tile = this.remoteTiles.get(userId);
      if (tile && !tile.hasCam) {
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
  }

  private createRemoteTile(userId: string): RemoteTile {
    const container = document.createElement('div');
    container.className = 'remote-tile';
    container.dataset.userId = userId;

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    container.appendChild(video);

    const placeholder = document.createElement('div');
    placeholder.className = 'no-video';
    const p = this.players.get(userId);
    const name = p?.name || userId.slice(0, 6);
    const initials = p ? p.initials() : name.slice(0, 2).toUpperCase();
    placeholder.innerHTML = `<span class="no-video-initials">${initials}</span><span class="no-video-name">${name}</span>`;
    container.appendChild(placeholder);

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    container.appendChild(label);

    this.remoteVideosEl.appendChild(container);
    return { container, video, placeholder, label, hasCam: false };
  }

  private removeRemoteTile(userId: string) {
    const t = this.remoteTiles.get(userId);
    if (t) {
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
    const p = this.players.get(userId);
    this.screenshareLabelEl.textContent = `${p?.name || userId.slice(0, 6)} の画面`;
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
  }
}

function clamp(v: number, lo: number, hi: number) {
  return v < lo ? lo : v > hi ? hi : v;
}
