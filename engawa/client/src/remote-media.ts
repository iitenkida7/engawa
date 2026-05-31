import { bringToFront, makeDraggable } from './draggable';
import type { MediaManager } from './media';
import {
  applyPanelGeometry,
  bindCamAspect,
  computeGridLayout,
  computePresentationLayout,
  createModeControls,
  type LayoutItem,
  readCamAspect,
  setupPanelModes,
} from './panels';
import type { PlayerState } from './player';
import type { RecorderManager } from './recorder';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  type SpeakingDetector,
} from './speaking';
import type { StreamKind } from './types';

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

// Owns every media panel in the DOM: the floating remote camera tiles, the
// per-user mic <audio> elements, the screenshare stage, and the self preview.
// Also holds the speaking detectors (local mic + each remote mic) since their
// lifetime tracks the streams attached here; `updateSpeaking()` is pumped once
// per frame by the game loop.
//
// It reads and writes the shared `players` map directly (isSpeaking /
// isSharingScreen / names) — the App owns the map, this view owns the DOM that
// mirrors it.
export class RemoteMediaView {
  private players: Map<string, PlayerState>;
  private media: MediaManager;
  private recorder: RecorderManager;
  private getMyId: () => string;

  private remoteVideosEl: HTMLDivElement;
  private remoteTiles = new Map<string, RemoteTile>();
  // Mic audio is attached to dedicated <audio> elements so it plays even when
  // the user has no cam (no video tile yet). userId → audio element.
  private remoteAudios = new Map<string, RemoteAudio>();

  private screenshareStageEl: HTMLDivElement;
  private screenshareVideoEl: HTMLVideoElement;
  private screenshareLabelEl: HTMLSpanElement;
  private currentScreenshareUserId: string | null = null;

  private selfPreviewEl: HTMLDivElement;
  private selfPreviewHeaderEl: HTMLDivElement;
  private selfPreviewLabelEl: HTMLSpanElement;
  private selfVideoEl: HTMLVideoElement;

  // Speaking detection
  private localSpeakingDetector: SpeakingDetector | null = null;
  private remoteSpeakingDetectors = new Map<string, SpeakingDetector>();

  constructor(opts: {
    players: Map<string, PlayerState>;
    media: MediaManager;
    recorder: RecorderManager;
    getMyId: () => string;
  }) {
    this.players = opts.players;
    this.media = opts.media;
    this.recorder = opts.recorder;
    this.getMyId = opts.getMyId;

    this.remoteVideosEl = document.getElementById('remote-videos') as HTMLDivElement;
    this.screenshareStageEl = document.getElementById('screenshare-stage') as HTMLDivElement;
    this.screenshareVideoEl = document.getElementById('screenshare-video') as HTMLVideoElement;
    this.screenshareLabelEl = document.getElementById('screenshare-label') as HTMLSpanElement;
    this.selfPreviewEl = document.getElementById('self-preview') as HTMLDivElement;
    this.selfPreviewHeaderEl = document.getElementById('self-preview-header') as HTMLDivElement;
    this.selfPreviewLabelEl = document.getElementById('self-preview-label') as HTMLSpanElement;
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;

    this.setupSelfPreview();
    this.setupScreensharePanel();
  }

  // Make the self-preview draggable/resizable by its header. The CSS keeps its
  // initial bottom-right placement; the first drag (or a window resize) converts
  // it to left/top.
  private setupSelfPreview() {
    makeDraggable(this.selfPreviewEl, {
      handle: this.selfPreviewHeaderEl,
      onStart: () => bringToFront(this.selfPreviewEl),
    });
    setupPanelModes(this.selfPreviewEl, {
      aspectLocked: true,
      onActivate: () => bringToFront(this.selfPreviewEl),
    });
    bindCamAspect(this.selfPreviewEl, this.selfVideoEl);
  }

  // Screenshare stage: preset buttons (shared with tiles) + header drag.
  private setupScreensharePanel() {
    const stage = this.screenshareStageEl;
    const header = document.getElementById('stage-header')!;
    setupPanelModes(stage);
    makeDraggable(stage, { handle: header });
  }

  // Sets the label shown under the self preview (the local user's name).
  setSelfName(name: string) {
    this.selfPreviewLabelEl.textContent = name || 'あなた';
  }

  // ============= Remote streams =============
  attachRemoteStream(userId: string, stream: MediaStream, kind: StreamKind) {
    if (kind === 'screen') {
      this.showScreenshare(userId, stream);
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

  detachRemoteStream(userId: string, streamId: string) {
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
      this.clearScreenshare();
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
    container.className = 'panel remote-tile';
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
    // Lock the floating window to this camera's aspect ratio.
    bindCamAspect(container, video);

    const placeholder = document.createElement('div');
    placeholder.className = 'no-video';
    placeholder.innerHTML = `<span class="no-video-initials">${initials}</span><span class="no-video-name">${name}</span>`;
    body.appendChild(placeholder);

    // Initial position: stack tiles down from the top-right corner, offsetting
    // each new tile so they don't fully overlap. The top-left is reserved for
    // the roster panel; tiles are draggable anywhere afterward.
    const index = this.remoteTiles.size;
    container.style.left = 'auto';
    container.style.right = `${12 + index * 16}px`;
    container.style.top = `${12 + index * 16}px`;

    this.remoteVideosEl.appendChild(container);
    // Drag by the header only (matches the other panels).
    const cleanupDrag = makeDraggable(container, {
      handle: header,
      onStart: () => bringToFront(container),
    });
    setupPanelModes(container, {
      aspectLocked: true,
      onActivate: () => bringToFront(container),
    });
    return { container, video, placeholder, label, hasCam: false, cleanupDrag };
  }

  // Tears down every DOM artifact for a peer (tile, audio, speaking detector).
  removePeer(userId: string) {
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

  // ============= Screenshare stage =============
  showScreenshare(userId: string, stream: MediaStream) {
    this.currentScreenshareUserId = userId;
    this.screenshareVideoEl.srcObject = stream;
    this.screenshareVideoEl.play().catch(() => {
      /* autoplay may be blocked */
    });
    const isSelf = userId === this.getMyId();
    const p = this.players.get(userId);
    this.screenshareLabelEl.textContent = isSelf
      ? 'あなたの画面'
      : `${p?.name || userId.slice(0, 6)} の画面`;
    this.screenshareStageEl.classList.add('visible');
  }

  clearScreenshare() {
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

  // True when the screenshare stage is currently showing this user's screen.
  isShowingScreenshareFor(userId: string): boolean {
    return this.currentScreenshareUserId === userId;
  }

  // ============= Self preview =============
  refreshSelfPreview() {
    this.selfPreviewEl.classList.toggle('muted', !this.media.micOn);
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

  // ============= Mute indicator =============
  setTileMuted(userId: string, muted: boolean) {
    const tile = this.remoteTiles.get(userId);
    if (tile) tile.container.classList.toggle('muted', muted);
  }

  // ============= Speaking detection =============
  // Swaps the local mic's speaking detector. Pass the live mic stream when the
  // mic turns on, or null when it turns off (which also clears the speaking
  // flag on the local player).
  setLocalMicStream(stream: MediaStream | null) {
    if (this.localSpeakingDetector) {
      destroySpeakingDetector(this.localSpeakingDetector);
      this.localSpeakingDetector = null;
    }
    if (stream) {
      this.localSpeakingDetector = createSpeakingDetector(stream);
    } else {
      const me = this.players.get(this.getMyId());
      if (me) me.isSpeaking = false;
    }
  }

  // Pumped once per frame: refreshes the speaking flag on the local and remote
  // players and toggles the "speaking" ring on each remote tile.
  updateSpeaking() {
    const me = this.players.get(this.getMyId());
    if (me && this.localSpeakingDetector) {
      me.isSpeaking = isSpeaking(this.localSpeakingDetector);
    }
    for (const [userId, det] of this.remoteSpeakingDetectors) {
      const p = this.players.get(userId);
      if (p) p.isSpeaking = isSpeaking(det);
      const tile = this.remoteTiles.get(userId);
      if (tile) tile.container.classList.toggle('speaking', p?.isSpeaking ?? false);
    }
  }

  // The live remote mic streams, for mixing into a recording.
  getRemoteAudioStreams(): MediaStream[] {
    const streams: MediaStream[] = [];
    for (const entry of this.remoteAudios.values()) {
      const stream = entry.audio.srcObject as MediaStream | null;
      if (stream) streams.push(stream);
    }
    return streams;
  }

  // ============= Batch arrange (one-shot "tidy all windows") =============
  // Re-lays every visible window in one shot: 'grid' tiles them evenly; 'smart'
  // uses a presentation layout when a screenshare is on stage, else a grid.
  // Like the header presets this only writes position/size — windows stay
  // freely draggable/resizable afterwards (nothing is locked or persisted).
  arrange(mode: 'smart' | 'grid') {
    const screenVisible = this.screenshareStageEl.classList.contains('visible');
    // Collect visible panels with the element to move and its layout item, in a
    // stable order: screenshare first, then camera/mic tiles, then self preview.
    const panels: Array<{ el: HTMLElement; item: LayoutItem }> = [];
    if (screenVisible) {
      panels.push({ el: this.screenshareStageEl, item: { aspectLocked: false, aspect: 16 / 9 } });
    }
    for (const tile of this.remoteTiles.values()) {
      panels.push({ el: tile.container, item: { aspectLocked: true, aspect: readCamAspect(tile.container) } });
    }
    if (!this.selfPreviewEl.classList.contains('hidden')) {
      panels.push({ el: this.selfPreviewEl, item: { aspectLocked: true, aspect: readCamAspect(this.selfPreviewEl) } });
    }
    if (panels.length === 0) return;

    const items = panels.map((p) => p.item);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const geos = mode === 'smart' && screenVisible
      ? computePresentationLayout(items, vw, vh)
      : computeGridLayout(items, vw, vh);
    panels.forEach((p, i) => applyPanelGeometry(p.el, geos[i]));
  }

  // The rendered width (CSS px) of a remote user's camera tile, or null when
  // they have no camera tile. Drives SFU simulcast layer selection (issue #78):
  // small tiles request the half layer to save downlink.
  cameraTileWidth(userId: string): number | null {
    const tile = this.remoteTiles.get(userId);
    if (!tile || !tile.hasCam) return null;
    return tile.container.clientWidth || null;
  }
}
