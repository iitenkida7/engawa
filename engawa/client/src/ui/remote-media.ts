import { t } from '@/core/i18n';
import type { StreamKind } from '@/core/types';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  type SpeakingDetector,
} from '@/media/speaking';
import {
  applyPanelGeometry,
  bindCamAspect,
  computeGridLayout,
  computePresentationLayout,
  computeSidebarLayout,
  type LayoutItem,
  type LayoutMode,
  readCamAspect,
} from '@/ui/panels';
import type { PlayerState } from '@/world/player';

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

type Screenshare = {
  container: HTMLDivElement;
  video: HTMLVideoElement;
  label: HTMLSpanElement;
  streamId: string;
  // Removes the stage's dblclick handler when the stage is destroyed (it
  // captures `this`/userId, so it must be detached explicitly rather than
  // relying on the element being GC'd).
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

  // Each sharing user gets their own stage panel, keyed by userId. Map insertion
  // order is share order (oldest first). `mainScreenshareUserId` is the featured
  // share — it gets the large main area in the presentation layout and a "main"
  // accent; the rest ride the filmstrip. It defaults to the oldest share and is
  // re-picked when that share stops (next-oldest) or re-designated by double-click.
  private screenshares = new Map<string, Screenshare>();
  private mainScreenshareUserId: string | null = null;

  private selfPreviewEl: HTMLDivElement;
  private selfPreviewLabelEl: HTMLSpanElement;
  private selfVideoEl: HTMLVideoElement;

  // Speaking detection
  private localSpeakingDetector: SpeakingDetector | null = null;
  private remoteSpeakingDetectors = new Map<string, SpeakingDetector>();

  // The active window-layout mode. 'grid' (default) tiles every window evenly;
  // a screenshare auto-switches to 'presentation' and reverts to 'grid' when the
  // last share stops (issue #175). Every mode auto-arranges and re-flows on
  // viewport/membership/screenshare changes — there is no manual placement.
  private layoutMode: LayoutMode = 'grid';
  // Fired whenever layoutMode changes (toolbar selection OR the screenshare
  // auto-switch) so the toolbar can re-highlight the active layout button.
  private onLayoutModeChange: ((mode: LayoutMode) => void) | null = null;

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
    this.selfPreviewLabelEl = document.getElementById('self-preview-label') as HTMLSpanElement;
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;

    // Lock the self-preview window to the live camera's aspect ratio; its
    // position/size come from reflowLayout (it joins the grid like any tile).
    bindCamAspect(this.selfPreviewEl, this.selfVideoEl);
    // Re-flow the active layout when the viewport changes so the fixed
    // arrangement keeps fitting the new size (issue #175).
    window.addEventListener('resize', () => this.reflowLayout());
  }

  // Sets the label shown under the self preview (the local user's name).
  setSelfName(name: string) {
    this.selfPreviewLabelEl.textContent = name || t('common.you');
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
      // Reset a possibly-latched speaking ring (peer muted while flagged loud).
      this.clearSpeaking(userId);
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
    } else if (entry.streamId !== stream.id) {
      // Re-attaching a different stream (e.g. after an SFU→mesh switch): drop the
      // old stream id from the recording mix before swapping, so its source node
      // doesn't linger connected to the mix.
      this.recorder.removeAudioStream(entry.streamId);
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
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    container.appendChild(body);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.display = 'none';
    body.appendChild(video);
    // Lock the window to this camera's aspect ratio.
    bindCamAspect(container, video);

    const placeholder = document.createElement('div');
    placeholder.className = 'no-video';
    placeholder.innerHTML = `<span class="no-video-initials">${initials}</span><span class="no-video-name">${name}</span>`;
    body.appendChild(placeholder);

    // Position/size come from reflowLayout (called by the caller right after);
    // the tile just needs to be in the DOM to be laid out.
    this.remoteVideosEl.appendChild(container);
    return { container, video, placeholder, label, hasCam: false };
  }

  // Tears down every DOM artifact for a peer (tile, audio, speaking detector).
  removePeer(userId: string) {
    const t = this.remoteTiles.get(userId);
    if (t) {
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
      // Drop this peer's mic from the recording mix. removePeer is the common
      // path (proximity walk-away, mesh→SFU switch, abrupt disconnect) and, unlike
      // detachRemoteStream, previously never told the recorder — so the source
      // node stayed connected to the mix and kept the detached stream referenced
      // until the recording stopped.
      this.recorder.removeAudioStream(a.streamId);
      this.remoteAudios.delete(userId);
    }
    const det = this.remoteSpeakingDetectors.get(userId);
    if (det) {
      destroySpeakingDetector(det);
      this.remoteSpeakingDetectors.delete(userId);
    }
    // Clear a possibly-stuck speaking flag/ring: a peer cut off mid-speech (they
    // walk out of range → removePeer, but stay in the players map) would otherwise
    // keep a lit ring on the map/roster forever.
    this.clearSpeaking(userId);
    this.removeScreenshare(userId);
    this.reflowLayout();
  }

  // Reset a peer's (or self's) speaking flag and tile ring. Used wherever a mic
  // detaches so updateSpeaking — which only iterates LIVE detectors — can't leave
  // the last 'speaking' state latched on.
  private clearSpeaking(userId: string) {
    const p = this.players.get(userId);
    if (p) p.isSpeaking = false;
    this.remoteTiles.get(userId)?.container.classList.remove('speaking');
  }

  // ============= Screenshare stages (one per sharing user) =============
  // Attaches/updates a user's screenshare. The first sharer becomes the "main"
  // featured stage (large, accented); later sharers ride the filmstrip. A new
  // share auto-switches to the presentation (speaker) view. Re-called for the
  // same user it just swaps the stream (e.g. device change).
  showScreenshare(userId: string, stream: MediaStream) {
    let ss = this.screenshares.get(userId);
    if (!ss) {
      const isMain = this.mainScreenshareUserId === null;
      ss = this.createScreenshareStage(userId, isMain);
      this.screenshares.set(userId, ss);
      if (isMain) this.mainScreenshareUserId = userId;
      // A new share flips to the speaker view, overriding any manual grid/sidebar
      // choice (issue #175). The trailing reflowLayout() renders it.
      this.setLayoutModeSilently('presentation');
    }
    ss.streamId = stream.id;
    ss.video.srcObject = stream;
    ss.video.play().catch(() => {
      /* autoplay may be blocked */
    });
    const isSelf = userId === this.getMyId();
    const p = this.players.get(userId);
    ss.label.textContent = isSelf
      ? t('media.yourScreen')
      : t('media.screenOf', { name: p?.name || userId.slice(0, 6) });
    this.reflowLayout();
  }

  // Removes a user's screenshare stage (no-op if they aren't sharing). When the
  // main share stops, the next-oldest share is promoted to main. When the last
  // share stops, the layout reverts to the grid (issue #175).
  removeScreenshare(userId: string) {
    const ss = this.screenshares.get(userId);
    if (!ss) return;
    const wasMain = this.mainScreenshareUserId === userId;
    ss.cleanup();
    try {
      ss.video.srcObject = null;
    } catch {
      /* noop */
    }
    ss.container.remove();
    this.screenshares.delete(userId);
    if (wasMain) {
      // Promote the next-oldest remaining share (Map keeps insertion order).
      const nextId = this.screenshares.keys().next().value ?? null;
      this.mainScreenshareUserId = nextId;
      if (nextId) this.screenshares.get(nextId)!.container.classList.add('main');
    }
    // Last share gone → back to the grid (never remembers a manual choice).
    if (this.screenshares.size === 0) this.setLayoutModeSilently('grid');
    this.reflowLayout();
  }

  // Makes a non-main share the featured (main) one by double-click: re-designate
  // the main and let reflowLayout give it the large area. Positions aren't
  // swapped — the auto-arrange handles placement (issue #175).
  private promoteScreenshare(userId: string) {
    const mainId = this.mainScreenshareUserId;
    if (!mainId || mainId === userId) return;
    const next = this.screenshares.get(userId);
    const prev = this.screenshares.get(mainId);
    if (!next || !prev) return;
    prev.container.classList.remove('main');
    next.container.classList.add('main');
    this.mainScreenshareUserId = userId;
    this.reflowLayout();
  }

  // Builds a screenshare stage panel (free aspect, letterboxed video). `isMain`
  // gets the "main" accent + the large area; position/size come from
  // reflowLayout. Double-click re-designates which share is main.
  private createScreenshareStage(userId: string, isMain: boolean): Screenshare {
    const container = document.createElement('div');
    container.className = isMain ? 'panel screenshare-stage main' : 'panel screenshare-stage';
    container.dataset.userId = userId;

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.title = t('media.dblClickMain');
    const label = document.createElement('span');
    label.className = 'label';
    header.appendChild(label);
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    container.appendChild(body);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    body.appendChild(video);

    this.stageLayerEl.appendChild(container);
    // Double-click anywhere on the stage makes it the featured (main) share.
    const onDblClick = () => this.promoteScreenshare(userId);
    container.addEventListener('dblclick', onDblClick);
    const cleanup = () => container.removeEventListener('dblclick', onDblClick);
    return { container, video, label, streamId: '', cleanup };
  }

  // ============= Self preview =============
  refreshSelfPreview() {
    this.selfPreviewEl.classList.toggle('muted', !this.media.micOn);
    const stream = this.media.camStream;
    const wasHidden = this.selfPreviewEl.classList.contains('hidden');
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
    // The self preview joins/leaves the auto-layout as it shows/hides, so
    // re-flow whenever its visibility flips (issue #175).
    if (wasHidden !== this.selfPreviewEl.classList.contains('hidden')) this.reflowLayout();
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

  // Registers a callback fired whenever the layout mode changes (used by the
  // toolbar to keep its active-mode highlight in sync).
  setOnLayoutModeChange(cb: (mode: LayoutMode) => void) {
    this.onLayoutModeChange = cb;
  }

  // Switches the window-layout mode (toolbar grid/sidebar buttons) and re-flows.
  // The chosen mode sticks and re-flows on viewport/membership/screenshare
  // changes; a screenshare then temporarily forces the presentation view.
  setLayoutMode(mode: LayoutMode) {
    if (this.layoutMode !== mode) {
      this.layoutMode = mode;
      this.onLayoutModeChange?.(mode);
    }
    this.reflowLayout();
  }

  // Sets the mode + notifies the toolbar highlight, WITHOUT re-flowing — used by
  // the screenshare auto-switch, whose caller re-flows once afterwards.
  private setLayoutModeSilently(mode: LayoutMode) {
    if (this.layoutMode === mode) return;
    this.layoutMode = mode;
    this.onLayoutModeChange?.(mode);
  }

  // Re-lays every visible window according to the active mode. Called on
  // viewport resize and whenever the set of windows changes (peer join/leave,
  // screenshare start/stop) so the fixed arrangement stays tidy.
  private reflowLayout() {
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
  // share order. Drives both reflowLayout() and the recording compositor.
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
