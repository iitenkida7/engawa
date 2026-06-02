import type { StreamKind } from '@/core/types';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  type SpeakingDetector,
} from '@/media/speaking';
import { bringToFront, makeDraggable } from '@/ui/draggable';
import {
  applyPanelGeometry,
  bindCamAspect,
  computeGridLayout,
  computePresentationLayout,
  computeSidebarLayout,
  createModeControls,
  type LayoutItem,
  type LayoutMode,
  readCamAspect,
  setupPanelModes,
} from '@/ui/panels';
import type { PlayerState } from '@/world/player';

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

type Screenshare = {
  container: HTMLDivElement;
  video: HTMLVideoElement;
  label: HTMLSpanElement;
  streamId: string;
  // Removes the drag listeners AND the stage's dblclick handler when the stage
  // is destroyed (the dblclick handler captures `this`/userId, so it must be
  // detached explicitly rather than relying on the element being GC'd).
  cleanup: () => void;
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
  // Screenshare stages live as siblings of #remote-videos (directly under #app),
  // not inside it, so their z-index stacks the same way the old static stage did
  // (above the self preview) rather than being capped by #remote-videos' context.
  private stageLayerEl: HTMLElement;
  private remoteTiles = new Map<string, RemoteTile>();
  // Mic audio is attached to dedicated <audio> elements so it plays even when
  // the user has no cam (no video tile yet). userId → audio element.
  private remoteAudios = new Map<string, RemoteAudio>();

  // Each sharing user gets their own draggable stage panel, keyed by userId.
  // Map insertion order is share order (oldest first). `mainScreenshareUserId`
  // is the featured share — it gets the large main area in the smart layout and
  // a "main" accent; the rest stay small. It defaults to the oldest share and is
  // re-picked when that share stops (next-oldest) or swapped by double-click.
  private screenshares = new Map<string, Screenshare>();
  private mainScreenshareUserId: string | null = null;

  private selfPreviewEl: HTMLDivElement;
  private selfPreviewHeaderEl: HTMLDivElement;
  private selfPreviewLabelEl: HTMLSpanElement;
  private selfVideoEl: HTMLVideoElement;

  // Speaking detection
  private localSpeakingDetector: SpeakingDetector | null = null;
  private remoteSpeakingDetectors = new Map<string, SpeakingDetector>();

  // The active window-layout mode. 'free' (default) leaves every window where
  // the user put it; the others auto-arrange and re-flow on viewport/membership/
  // screenshare changes. Grabbing a window (drag or a per-panel preset) drops
  // back to 'free' so manual placement always wins.
  private layoutMode: LayoutMode = 'free';

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
    this.stageLayerEl = this.remoteVideosEl.parentElement as HTMLElement;
    this.selfPreviewEl = document.getElementById('self-preview') as HTMLDivElement;
    this.selfPreviewHeaderEl = document.getElementById('self-preview-header') as HTMLDivElement;
    this.selfPreviewLabelEl = document.getElementById('self-preview-label') as HTMLSpanElement;
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;

    this.setupSelfPreview();
    // Re-flow the active layout when the viewport changes. In 'free' mode this
    // is a no-op (draggable.ts owns clamping); in an auto mode it keeps the
    // arrangement fitting the new size.
    window.addEventListener('resize', () => this.reflowLayout());
  }

  // Make the self-preview draggable/resizable by its header. The CSS keeps its
  // initial bottom-right placement; the first drag (or a window resize) converts
  // it to left/top.
  private setupSelfPreview() {
    makeDraggable(this.selfPreviewEl, {
      handle: this.selfPreviewHeaderEl,
      onStart: () => this.grabPanel(this.selfPreviewEl),
    });
    setupPanelModes(this.selfPreviewEl, {
      aspectLocked: true,
      onActivate: () => this.grabPanel(this.selfPreviewEl),
    });
    bindCamAspect(this.selfPreviewEl, this.selfVideoEl);
  }

  // Brings a panel to front and drops out of any auto-layout mode. A drag or a
  // per-panel preset is explicit manual placement, so it always wins over
  // auto-arrange: future reflows (resize/join/leave) leave the windows alone
  // until the user re-selects a layout mode.
  private grabPanel(el: HTMLElement) {
    bringToFront(el);
    this.layoutMode = 'free';
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
      this.reflowLayout();
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
    this.reflowLayout();
  }

  detachRemoteStream(userId: string, streamId: string) {
    const audio = this.remoteAudios.get(userId);
    if (audio && audio.streamId === streamId) {
      try {
        audio.audio.srcObject = null;
      } catch {
        /* noop */
      }
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
      try {
        tile.video.srcObject = null;
      } catch {
        /* noop */
      }
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
    const ss = this.screenshares.get(userId);
    if (ss && ss.streamId === streamId) {
      this.removeScreenshare(userId);
      const p = this.players.get(userId);
      if (p) p.isSharingScreen = false;
    }
    this.reflowLayout();
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
      onStart: () => this.grabPanel(container),
    });
    setupPanelModes(container, {
      aspectLocked: true,
      onActivate: () => this.grabPanel(container),
    });
    return { container, video, placeholder, label, hasCam: false, cleanupDrag };
  }

  // Tears down every DOM artifact for a peer (tile, audio, speaking detector).
  removePeer(userId: string) {
    const t = this.remoteTiles.get(userId);
    if (t) {
      t.cleanupDrag();
      try {
        t.video.srcObject = null;
      } catch {
        /* noop */
      }
      t.container.remove();
      this.remoteTiles.delete(userId);
    }
    const a = this.remoteAudios.get(userId);
    if (a) {
      try {
        a.audio.srcObject = null;
      } catch {
        /* noop */
      }
      a.audio.remove();
      this.remoteAudios.delete(userId);
    }
    const det = this.remoteSpeakingDetectors.get(userId);
    if (det) {
      destroySpeakingDetector(det);
      this.remoteSpeakingDetectors.delete(userId);
    }
    this.removeScreenshare(userId);
    this.reflowLayout();
  }

  // ============= Screenshare stages (one per sharing user) =============
  // Attaches/updates a user's screenshare. The first sharer becomes the "main"
  // featured stage (large, accented); later sharers open as smaller windows so
  // they don't cover the main one. Re-called for the same user it just swaps the
  // stream (e.g. device change) without moving the window.
  showScreenshare(userId: string, stream: MediaStream) {
    let ss = this.screenshares.get(userId);
    if (!ss) {
      const isMain = this.mainScreenshareUserId === null;
      ss = this.createScreenshareStage(userId, isMain);
      this.screenshares.set(userId, ss);
      if (isMain) this.mainScreenshareUserId = userId;
    }
    ss.streamId = stream.id;
    ss.video.srcObject = stream;
    ss.video.play().catch(() => {
      /* autoplay may be blocked */
    });
    const isSelf = userId === this.getMyId();
    const p = this.players.get(userId);
    ss.label.textContent = isSelf ? 'あなたの画面' : `${p?.name || userId.slice(0, 6)} の画面`;
    this.reflowLayout();
  }

  // Removes a user's screenshare stage (no-op if they aren't sharing). When the
  // main share stops, the next-oldest share is promoted into the vacated spot so
  // the large window doesn't blink empty.
  removeScreenshare(userId: string) {
    const ss = this.screenshares.get(userId);
    if (!ss) return;
    const wasMain = this.mainScreenshareUserId === userId;
    const vacated = wasMain ? this.snapshotGeometry(ss.container) : null;
    ss.cleanup();
    try {
      ss.video.srcObject = null;
    } catch {
      /* noop */
    }
    ss.container.remove();
    this.screenshares.delete(userId);
    if (!wasMain) {
      this.reflowLayout();
      return;
    }
    // Promote the next-oldest remaining share (Map keeps insertion order).
    const nextId = this.screenshares.keys().next().value ?? null;
    this.mainScreenshareUserId = nextId;
    if (nextId) {
      const next = this.screenshares.get(nextId)!;
      next.container.classList.add('main');
      applyPanelGeometry(next.container, vacated!);
      bringToFront(next.container);
    }
    this.reflowLayout();
  }

  // Makes a non-main share the main one by swapping window geometry with the
  // current main (double-click). The large spot stays put; only who occupies it
  // changes. Future smart-arrange then features the new main.
  private promoteScreenshare(userId: string) {
    const mainId = this.mainScreenshareUserId;
    if (!mainId || mainId === userId) return;
    const next = this.screenshares.get(userId);
    const prev = this.screenshares.get(mainId);
    if (!next || !prev) return;
    const prevGeo = this.snapshotGeometry(prev.container);
    const nextGeo = this.snapshotGeometry(next.container);
    applyPanelGeometry(next.container, prevGeo);
    applyPanelGeometry(prev.container, nextGeo);
    prev.container.classList.remove('main');
    next.container.classList.add('main');
    this.mainScreenshareUserId = userId;
    bringToFront(next.container);
  }

  // Reads an element's current on-screen rect as an explicit geometry, so it can
  // be re-applied as inline styles (used when swapping/inheriting the main spot).
  private snapshotGeometry(el: HTMLElement): {
    left: number;
    top: number;
    width: number;
    height: number;
  } {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }

  // Builds a draggable screenshare stage panel (free aspect, letterboxed video).
  // `isMain` keeps the CSS default placement + the "main" accent; later shares
  // open smaller and offset so they don't cover the main one.
  private createScreenshareStage(userId: string, isMain: boolean): Screenshare {
    const container = document.createElement('div');
    container.className = isMain ? 'panel screenshare-stage main' : 'panel screenshare-stage';
    container.dataset.userId = userId;

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.title = 'ダブルクリックでメイン表示に切り替え';
    const label = document.createElement('span');
    label.className = 'label';
    header.appendChild(label);
    header.appendChild(createModeControls());
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    container.appendChild(body);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    body.appendChild(video);

    if (!isMain) {
      // Open later shares smaller and offset from the top so they don't land on
      // top of the main stage; users can drag/arrange afterwards.
      const n = this.screenshares.size;
      container.style.left = `${360 + n * 28}px`;
      container.style.top = `${24 + n * 28}px`;
      container.style.width = '300px';
      container.style.height = '190px';
    }

    this.stageLayerEl.appendChild(container);
    const cleanupDrag = makeDraggable(container, {
      handle: header,
      onStart: () => this.grabPanel(container),
    });
    setupPanelModes(container, { onActivate: () => this.grabPanel(container) });
    // Double-click anywhere on the stage (except the preset buttons) promotes it.
    const onDblClick = (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.stage-controls')) return;
      this.promoteScreenshare(userId);
    };
    container.addEventListener('dblclick', onDblClick);
    const cleanup = () => {
      cleanupDrag();
      container.removeEventListener('dblclick', onDblClick);
    };
    return { container, video, label, streamId: '', cleanup };
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
      try {
        this.selfVideoEl.srcObject = null;
      } catch {
        /* noop */
      }
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

  // ============= Layout modes (auto-arrange) =============
  // The active layout mode. The toolbar reads this to mark the current mode in
  // its menu.
  getLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  // Switches the window-layout mode and immediately re-flows. 'free' just stops
  // auto-arranging (windows stay where they are); the others tile every window
  // to fit the viewport. Unlike the old one-shot arrange, the chosen mode sticks
  // and re-flows on viewport/membership/screenshare changes until the user
  // grabs a window (drag/preset → back to 'free').
  setLayoutMode(mode: LayoutMode) {
    this.layoutMode = mode;
    this.reflowLayout();
  }

  // Re-lays every visible window according to the active mode. No-op in 'free'.
  // Called on viewport resize and whenever the set of windows changes (peer
  // join/leave, screenshare start/stop) so the arrangement stays tidy.
  private reflowLayout() {
    if (this.layoutMode === 'free') return;
    const panels = this.collectPanels();
    if (panels.length === 0) return;
    const items = panels.map((p) => p.item);
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const geos =
      this.layoutMode === 'presentation'
        ? computePresentationLayout(items, vw, vh)
        : this.layoutMode === 'sidebar'
          ? computeSidebarLayout(items, vw, vh)
          : computeGridLayout(items, vw, vh);
    panels.forEach((p, i) => {
      applyPanelGeometry(p.el, geos[i]);
    });
  }

  // Collects visible panels with the element to move and its layout item, in a
  // stable order: the main screenshare first (so the presentation layout
  // features it), then the other screenshares, then camera/mic tiles, then the
  // self preview.
  private collectPanels(): Array<{ el: HTMLElement; item: LayoutItem }> {
    const panels: Array<{ el: HTMLElement; item: LayoutItem }> = [];
    for (const userId of this.orderedScreenshareIds()) {
      const ss = this.screenshares.get(userId)!;
      panels.push({ el: ss.container, item: { aspectLocked: false, aspect: 16 / 9 } });
    }
    for (const tile of this.remoteTiles.values()) {
      panels.push({
        el: tile.container,
        item: { aspectLocked: true, aspect: readCamAspect(tile.container) },
      });
    }
    if (!this.selfPreviewEl.classList.contains('hidden')) {
      panels.push({
        el: this.selfPreviewEl,
        item: { aspectLocked: true, aspect: readCamAspect(this.selfPreviewEl) },
      });
    }
    return panels;
  }

  // Screenshare userIds in layout order: the main share first, then the rest in
  // share order. Drives both arrange() and the recording compositor.
  private orderedScreenshareIds(): string[] {
    const ids = [...this.screenshares.keys()];
    const mainId = this.mainScreenshareUserId;
    if (mainId && this.screenshares.has(mainId)) {
      return [mainId, ...ids.filter((id) => id !== mainId)];
    }
    return ids;
  }

  // The rendered width (CSS px) of a remote user's camera tile, or null when
  // they have no camera tile. Drives SFU simulcast layer selection (issue #78):
  // small tiles request the half layer to save downlink.
  cameraTileWidth(userId: string): number | null {
    const tile = this.remoteTiles.get(userId);
    if (!tile?.hasCam) return null;
    return tile.container.clientWidth || null;
  }
}
