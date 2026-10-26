import { t } from '@/core/i18n';
import { logNet } from '@/core/netlog';
import type { AnnotateBody, StreamKind } from '@/core/types';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  SPEAKING_POLL_MS,
  type SpeakingDetector,
} from '@/media/speaking';
import { ShareAnnotator } from '@/ui/annotate';
import { AutoplayGate } from '@/ui/autoplay';
import { type FaceEntry, FacePipView, isFacePipSupported } from '@/ui/face-pip';
import { createFocusButton, type LayoutPanel, MediaLayout } from '@/ui/media-layout';
import { CAM_ASPECT, type LayoutMode } from '@/ui/panels';
import { createVolumeControl, PeerGainRoutes } from '@/ui/peer-gain';
import { clampGain, PEER_GAIN_DEFAULT } from '@/ui/peer-volume';
import { loadProfileImage } from '@/ui/profile-image';
import { ScreenZoom } from '@/ui/screen-zoom';
import {
  classifyStall,
  INITIAL_STALL_STATE,
  STALL_ATTACH_GRACE_MS,
  type StallReason,
  type StallState,
  stallLabelKey,
  updateStallState,
} from '@/ui/video-stall';
import type { PlayerState } from '@/world/player';

type RemoteTile = {
  container: HTMLDivElement;
  video: HTMLVideoElement;
  placeholder: HTMLDivElement;
  // The camera-off circle: the peer's profile picture, or their initials.
  avatarEl: HTMLSpanElement;
  // The one-line note under the initials when the tile has no video (#312).
  reason: HTMLSpanElement;
  label: HTMLSpanElement;
  camStreamId?: string;
  hasCam: boolean;
  // Playback gain for this person's voice, for this conversation only: the tile
  // goes when the conversation does, and the volume goes with it.
  gain: number;
  // Stall tracking for the live camera (#312): performance.now() of the last
  // rendered frame (+grace right after attach), whether the receive track is
  // muted (no RTP), when we last requested another SFU layer, the overlay's
  // hysteresis state (reason on show + how long frames have been back), and
  // the watcher's abort handle.
  lastFrameAt: number;
  trackMuted: boolean;
  layerSwitchAt: number | null;
  stallState: StallState;
  // The reason currently rendered, so applyStall stays a no-op per tick.
  shownStall: StallReason | null;
  frameWatch?: AbortController;
};

// requestVideoFrameCallback is not in lib.dom for every TS target; the view
// feature-detects it and falls back to the track's mute events alone.
type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
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
  // Viewer-side zoom/pan controller (only active while maximized). Torn down
  // with the stage.
  zoom: ScreenZoom;
  // Pointer / pen overlay shared with everyone watching this share.
  annot: ShareAnnotator;
  // Removes the stage's click handler when the stage is destroyed (it
  // captures `this`/userId, so it must be detached explicitly rather than
  // relying on the element being GC'd).
  cleanup: () => void;
};

// Mic-with-strike glyph shown (red, via CSS) next to a name while that person is
// muted. Matches the toolbar mic icon.
const MIC_OFF_SVG =
  '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" />' +
  '<path d="M6 11a6 6 0 0 0 12 0" /><line x1="12" y1="17" x2="12" y2="21" />' +
  '<line x1="8" y1="21" x2="16" y2="21" /><line x1="4" y1="20" x2="20" y2="4" /></svg>';

// Fill a camera-off circle with the user's profile picture if they set one, else
// their initials. Built as DOM nodes (never innerHTML): names and data URLs are
// user-controlled, so they must never be parsed as markup.
function renderNoVideoAvatar(el: HTMLElement, avatarImage: string | null, initials: string) {
  if (avatarImage) {
    const img = el.querySelector('img') ?? document.createElement('img');
    if (img.getAttribute('src') !== avatarImage) img.src = avatarImage;
    img.alt = '';
    if (!img.parentElement) el.replaceChildren(img);
  } else if (el.querySelector('img') || el.textContent !== initials) {
    el.replaceChildren(document.createTextNode(initials));
  }
}

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
  private sendAnnotation: (m: AnnotateBody) => void;

  private remoteVideosEl: HTMLDivElement;
  // Screenshare stages live as siblings of #remote-videos (directly under #app),
  // not inside it, so their z-index stacks the same way the old static stage did
  // (above the self preview) rather than being capped by #remote-videos' context.
  private stageLayerEl: HTMLElement;
  private remoteTiles = new Map<string, RemoteTile>();
  // userIds in the current conversation group (excl. self); members without a cam
  // keep a placeholder tile so you can see who you're talking to.
  private conversationMembers = new Set<string>();
  // Mic audio is attached to dedicated <audio> elements so it plays even when
  // the user has no cam (no video tile yet). userId → audio element.
  private remoteAudios = new Map<string, RemoteAudio>();
  // performance.now() of the last speaking-detector read (see updateSpeaking).
  private lastSpeakingPollMs = 0;

  // Set by the App so the transcriber can follow remote mics as they come and
  // go (media/transcriber.ts taps one stream per speaker). A callback rather
  // than a reference keeps this view unaware of the subsystem, like the rest of
  // the Manager-callback wiring.
  private onRemoteAudio: ((userId: string, stream: MediaStream | null) => void) | null = null;

  // Per-person volume routing. The chosen gain lives on the tile (RemoteTile.gain),
  // so it lasts the conversation and no longer.
  private gainRoutes = new PeerGainRoutes();

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
  private selfNoVideoEl: HTMLDivElement;
  private selfNoVideoInitialsEl: HTMLSpanElement;
  private selfNoVideoNameEl: HTMLSpanElement;

  // Speaking detection
  private localSpeakingDetector: SpeakingDetector | null = null;
  private remoteSpeakingDetectors = new Map<string, SpeakingDetector>();

  // True while the SFU transport is being rebuilt (issue #254): remote panels
  // stay up, frozen, under a "reconnecting" overlay until the re-pull lands.
  private reconnecting = false;
  // True while we are not pulling remote video (tier 3 on a starved downlink,
  // #188): video-less tiles say so instead of looking like a camera-off (#312).
  private recvVideoPaused = false;

  // Layout modes, the maximized window and the immersive meeting view.
  private layout: MediaLayout;

  // Replays remote media the autoplay policy refused on the next user gesture
  // (issue #201); the App shows / hides the "enable audio" prompt.
  private autoplay: AutoplayGate;

  // Always-on-top mirror of the call tiles while the local user shares their
  // screen (issue #318). Opened / closed by the toolbar around the share; kept
  // in step here because every tile change already funnels through reflowLayout.
  private facePip = new FacePipView();

  constructor(opts: {
    players: Map<string, PlayerState>;
    media: MediaManager;
    recorder: RecorderManager;
    getMyId: () => string;
    // Remote playback was blocked by the autoplay policy; `unlock` replays it
    // and must be called from a user gesture (e.g. a prompt's button).
    onAutoplayBlocked: (unlock: () => void) => void;
    onAutoplayUnlocked: () => void;
    // Ship one pointer / pen message to the call (App adds the envelope).
    // Optional: without it marks stay local (tests that only lay out tiles).
    sendAnnotation?: (m: AnnotateBody) => void;
  }) {
    this.players = opts.players;
    this.media = opts.media;
    this.recorder = opts.recorder;
    this.getMyId = opts.getMyId;
    this.sendAnnotation = opts.sendAnnotation ?? (() => {});
    this.autoplay = new AutoplayGate({
      onBlocked: () => opts.onAutoplayBlocked(this.autoplay.unlock),
      onUnlocked: opts.onAutoplayUnlocked,
    });

    this.remoteVideosEl = document.getElementById('remote-videos') as HTMLDivElement;
    this.stageLayerEl = this.remoteVideosEl.parentElement as HTMLElement;
    this.layout = new MediaLayout({
      appEl: document.getElementById('app') as HTMLElement,
      stageLayerEl: this.stageLayerEl,
      collectPanels: () => this.collectPanels(),
      // Every tile add / remove / cam change lands in a reflow, so this is the
      // one place the face window needs to re-sync (issue #318).
      beforeReflow: () => {
        if (this.facePip.isOpen()) this.facePip.sync(this.faceEntries());
      },
    });
    this.selfPreviewEl = document.getElementById('self-preview') as HTMLDivElement;
    this.selfPreviewLabelEl = document.getElementById('self-preview-label') as HTMLSpanElement;
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;
    this.selfNoVideoEl = document.getElementById('self-no-video') as HTMLDivElement;
    this.selfNoVideoInitialsEl = document.getElementById(
      'self-no-video-initials',
    ) as HTMLSpanElement;
    this.selfNoVideoNameEl = document.getElementById('self-no-video-name') as HTMLSpanElement;

    // The self preview is static markup, so its maximize button is added here;
    // dynamic panels get theirs at creation.
    this.selfPreviewEl.dataset.focusKey = 'self';
    this.selfPreviewEl.querySelector('.panel-header')?.appendChild(createFocusButton());
  }

  // Sets the label shown under the self preview (the local user's name).
  setSelfName(name: string) {
    this.selfPreviewLabelEl.textContent = name || t('common.you');
  }

  // ============= Connection-quality dots (issue #188) =============
  // A small colored dot in the panel header, driven by the App's 5s quality
  // sampling: per-peer for remote tiles, the overall tier for the self preview.
  // `null` removes the dot (no data — e.g. the stats haven't warmed up yet).

  setTileQuality(userId: string, level: 0 | 1 | 2 | 3 | null) {
    const tile = this.remoteTiles.get(userId);
    if (tile) this.applyQualityDot(tile.label, level);
  }

  setSelfQuality(level: 0 | 1 | 2 | 3 | null) {
    this.applyQualityDot(this.selfPreviewLabelEl, level);
  }

  private applyQualityDot(labelEl: HTMLElement, level: 0 | 1 | 2 | 3 | null) {
    const header = labelEl.parentElement;
    if (!header) return;
    let dot = header.querySelector<HTMLSpanElement>('.quality-dot');
    if (level === null) {
      dot?.remove();
      return;
    }
    if (!dot) {
      dot = document.createElement('span');
      header.insertBefore(dot, labelEl);
    }
    dot.className = `quality-dot q${level}`;
    dot.title = t(`quality.q${level}`);
  }

  // Toggle the "reconnecting" overlay on every remote panel (tiles + remote
  // screenshare stages). New panels pick the flag up on creation.
  setReconnecting(on: boolean) {
    if (this.reconnecting === on) return;
    this.reconnecting = on;
    for (const tile of this.remoteTiles.values())
      tile.container.classList.toggle('reconnecting', on);
    const me = this.getMyId();
    for (const [userId, ss] of this.screenshares) {
      if (userId !== me) ss.container.classList.toggle('reconnecting', on);
    }
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
      if (!this.remoteTiles.has(userId)) this.createRemoteTile(userId);
      // Set up speaking detector for this remote user
      const oldDet = this.remoteSpeakingDetectors.get(userId);
      if (oldDet) destroySpeakingDetector(oldDet);
      const det = createSpeakingDetector(stream);
      if (det) this.remoteSpeakingDetectors.set(userId, det);
      this.reflowLayout();
      return;
    }
    // cam → tile with <video>
    const tile = this.remoteTiles.get(userId) ?? this.createRemoteTile(userId);
    tile.hasCam = true;
    tile.camStreamId = stream.id;
    tile.video.srcObject = stream;
    tile.video.style.display = '';
    tile.placeholder.style.display = 'none';
    this.autoplay.play(tile.video);
    this.watchVideoFrames(userId, tile, stream);
    const p = this.players.get(userId);
    tile.label.textContent = p?.name || userId.slice(0, 6);
    this.reflowLayout();
  }

  // ============= Video stall detection (issue #312) =============
  // Follow the live camera's frames and its track's mute state so tickStalls
  // can say WHY the tile is dark instead of leaving a silent black box.
  private watchVideoFrames(userId: string, tile: RemoteTile, stream: MediaStream) {
    tile.frameWatch?.abort();
    const watch = new AbortController();
    tile.frameWatch = watch;
    tile.layerSwitchAt = null;
    tile.stallState = INITIAL_STALL_STATE;
    const track = stream.getVideoTracks()[0];
    tile.trackMuted = track?.muted ?? false;
    if (track) {
      track.addEventListener('mute', () => this.setTrackMuted(userId, true), {
        signal: watch.signal,
      });
      track.addEventListener('unmute', () => this.setTrackMuted(userId, false), {
        signal: watch.signal,
      });
    }
    const video = tile.video as VideoWithFrameCallback;
    if (!video.requestVideoFrameCallback) {
      // No frame clock: only a muted track can flag a stall (see StallInput).
      tile.lastFrameAt = Number.POSITIVE_INFINITY;
      return;
    }
    tile.lastFrameAt = performance.now() + STALL_ATTACH_GRACE_MS;
    const onFrame = () => {
      if (watch.signal.aborted) return;
      tile.lastFrameAt = performance.now();
      handle = video.requestVideoFrameCallback!(onFrame);
    };
    let handle = video.requestVideoFrameCallback(onFrame);
    watch.signal.addEventListener('abort', () => video.cancelVideoFrameCallback?.(handle));
  }

  private setTrackMuted(userId: string, muted: boolean) {
    const tile = this.remoteTiles.get(userId);
    if (!tile) return;
    tile.trackMuted = muted;
    // A track that comes back is delivering again, whatever the frame clock
    // last saw.
    if (!muted && tile.lastFrameAt !== Number.POSITIVE_INFINITY) {
      tile.lastFrameAt = performance.now();
    }
  }

  private unwatchVideoFrames(userId: string, tile: RemoteTile) {
    tile.frameWatch?.abort();
    tile.frameWatch = undefined;
    tile.trackMuted = false;
    tile.layerSwitchAt = null;
    tile.stallState = INITIAL_STALL_STATE;
    this.applyStall(userId, tile, null);
  }

  // We asked the SFU for another simulcast layer of this camera: a stall in the
  // next few seconds is the keyframe wait, not a network problem.
  noteLayerSwitch(userId: string) {
    const tile = this.remoteTiles.get(userId);
    if (tile?.hasCam) tile.layerSwitchAt = performance.now();
  }

  // Called on a slow cadence from the App loop with our own network tier.
  tickStalls(now: number, myTier: number) {
    // Hidden tabs render no frames: keep the clocks fresh so coming back does
    // not flash a stall that never was.
    const hidden = document.hidden;
    for (const [userId, tile] of this.remoteTiles) {
      if (!tile.hasCam) continue;
      if (hidden) {
        if (tile.lastFrameAt !== Number.POSITIVE_INFINITY) tile.lastFrameAt = now;
        continue;
      }
      const stalledMs = tile.trackMuted ? Number.POSITIVE_INFINITY : now - tile.lastFrameAt;
      const candidate = classifyStall({
        stalledMs,
        sinceLayerSwitchMs: tile.layerSwitchAt === null ? null : now - tile.layerSwitchAt,
        myTier,
      });
      // Hysteresis lives in the fold, not in the tick: see updateStallState.
      tile.stallState = updateStallState(tile.stallState, candidate, now);
      this.applyStall(userId, tile, tile.stallState.reason);
    }
  }

  private applyStall(userId: string, tile: RemoteTile, reason: StallReason | null) {
    if (tile.shownStall === reason) return;
    tile.shownStall = reason;
    logNet('video-stall', { peer: userId, reason });
    const body = tile.placeholder.parentElement;
    if (body) body.dataset.stallLabel = reason ? t(stallLabelKey(reason)) : '';
    tile.container.classList.toggle('stalled', reason !== null);
  }

  // The reason on a video-less tile (#312): their camera was paused by their
  // network ladder, or we stopped pulling video to save our own bandwidth.
  // Blank when the camera is simply off.
  refreshTileReason(userId: string) {
    const tile = this.remoteTiles.get(userId);
    if (!tile) return;
    const p = this.players.get(userId);
    let text = '';
    if (p?.camAutoOff) text = t('media.peerCamAutoOff');
    else if (this.recvVideoPaused && p?.isVideoOn) text = t('media.recvVideoPaused');
    tile.reason.textContent = text;
  }

  // Whether we are (manually or automatically) not pulling remote video.
  setRecvVideoPaused(paused: boolean) {
    if (this.recvVideoPaused === paused) return;
    this.recvVideoPaused = paused;
    for (const userId of this.remoteTiles.keys()) this.refreshTileReason(userId);
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
      this.gainRoutes.drop(userId);
      this.remoteAudios.delete(userId);
      this.recorder.removeAudioStream(streamId);
      this.onRemoteAudio?.(userId, null);
      // Clean up speaking detector
      const det = this.remoteSpeakingDetectors.get(userId);
      if (det) {
        destroySpeakingDetector(det);
        this.remoteSpeakingDetectors.delete(userId);
      }
      // Reset a possibly-latched speaking ring (peer muted while flagged loud).
      this.clearSpeaking(userId);
      // If no cam either, remove the tile — unless they're still in the
      // conversation, where a placeholder tile is kept.
      const tile = this.remoteTiles.get(userId);
      if (tile && !tile.hasCam && !this.conversationMembers.has(userId)) {
        tile.container.remove();
        this.remoteTiles.delete(userId);
      }
    }
    const tile = this.remoteTiles.get(userId);
    if (tile && tile.camStreamId === streamId) {
      tile.hasCam = false;
      tile.camStreamId = undefined;
      this.unwatchVideoFrames(userId, tile);
      try {
        tile.video.srcObject = null;
      } catch {
        /* noop */
      }
      // Still has mic, or still in the conversation → keep a placeholder tile;
      // otherwise remove it.
      if (this.remoteAudios.has(userId) || this.conversationMembers.has(userId)) {
        tile.video.style.display = 'none';
        tile.placeholder.style.display = '';
        this.refreshTileReason(userId);
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

  // ---- Per-person volume ----

  // The gain chosen for this person in the conversation on screen (default 1).
  private gainFor(userId: string): number {
    return this.remoteTiles.get(userId)?.gain ?? PEER_GAIN_DEFAULT;
  }

  // Slider → remember for as long as the tile lives, and apply to the live voice.
  private setPeerGain(userId: string, gain: number) {
    const g = clampGain(gain);
    const tile = this.remoteTiles.get(userId);
    if (tile) tile.gain = g;
    this.applyPeerGain(userId, g);
  }

  private applyPeerGain(userId: string, gain: number = this.gainFor(userId)) {
    const entry = this.remoteAudios.get(userId);
    if (entry) this.gainRoutes.apply(userId, entry.audio, gain);
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
    this.autoplay.play(entry.audio);
    this.applyPeerGain(userId);
    // If recording is active, add this stream to the mix
    if (this.recorder.recording) {
      this.recorder.addAudioStream(stream);
    }
    this.onRemoteAudio?.(userId, stream);
  }

  // Ensure every member of the current conversation group has a tile — even with
  // their camera off — so you can see who you're talking to (issue: show camera
  // windows for everyone in a call). Camera-off members get the no-video
  // placeholder; a later cam stream fills it in. `members` excludes self. When the
  // group shrinks, placeholder-only tiles for people who left are removed (tiles
  // with a live cam/mic are left to the normal stream-detach cleanup).
  setConversationMembers(members: string[]) {
    const me = this.getMyId();
    const set = new Set(members.filter((id) => id !== me));
    this.conversationMembers = set;
    let changed = false;
    for (const id of set) {
      if (!this.players.has(id) || this.remoteTiles.has(id)) continue;
      this.createRemoteTile(id);
      changed = true;
    }
    for (const [id, tile] of this.remoteTiles) {
      if (set.has(id) || tile.hasCam || this.remoteAudios.has(id)) continue;
      tile.container.remove();
      this.remoteTiles.delete(id);
      changed = true;
    }
    // Being in / out of a conversation flips whether your own camera-off tile
    // shows (so you appear alongside the person you walked up to).
    this.refreshSelfPreview();
    if (changed) this.reflowLayout();
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
    container.dataset.focusKey = `cam:${userId}`;
    // Reflect the current mute state right away (a placeholder tile may be
    // created between status broadcasts, which only fire on change).
    if (p?.isMuted) container.classList.add('muted');
    if (p?.ptt) container.classList.add('ptt');
    if (this.reconnecting) container.classList.add('reconnecting');

    const header = document.createElement('div');
    header.className = 'panel-header';
    const left = document.createElement('span');
    left.className = 'header-left';
    const mic = document.createElement('span');
    mic.className = 'mic-indicator';
    mic.setAttribute('aria-hidden', 'true');
    mic.innerHTML = MIC_OFF_SVG;
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = name;
    // Push-to-talk badge: shown (by CSS) while the peer has PTT on and mic live.
    const ptt = document.createElement('span');
    ptt.className = 'ptt-indicator';
    ptt.textContent = '🎙';
    ptt.title = t('media.peerPtt');
    left.appendChild(mic);
    left.appendChild(ptt);
    left.appendChild(label);
    header.appendChild(left);
    header.appendChild(
      createVolumeControl(this.gainFor(userId), (g) => this.setPeerGain(userId, g)),
    );
    header.appendChild(createFocusButton());
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    body.dataset.reconnectingLabel = t('media.reconnecting');
    container.appendChild(body);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    video.style.display = 'none';
    body.appendChild(video);

    const placeholder = document.createElement('div');
    placeholder.className = 'no-video';
    const avatarEl = document.createElement('span');
    avatarEl.className = 'no-video-initials';
    renderNoVideoAvatar(avatarEl, p?.avatarImage ?? null, initials);
    const nameEl = document.createElement('span');
    nameEl.className = 'no-video-name';
    nameEl.textContent = name;
    const reason = document.createElement('span');
    reason.className = 'no-video-reason';
    placeholder.append(avatarEl, nameEl, reason);
    body.appendChild(placeholder);

    // Position/size come from reflowLayout (called by the caller right after);
    // the tile just needs to be in the DOM to be laid out. The tile registers
    // itself so the reason note can read the peer's state right away.
    this.remoteVideosEl.appendChild(container);
    const tile: RemoteTile = {
      container,
      video,
      placeholder,
      avatarEl,
      reason,
      label,
      hasCam: false,
      gain: PEER_GAIN_DEFAULT,
      lastFrameAt: Number.POSITIVE_INFINITY,
      trackMuted: false,
      layerSwitchAt: null,
      stallState: INITIAL_STALL_STATE,
      shownStall: null,
    };
    this.remoteTiles.set(userId, tile);
    this.refreshTileReason(userId);
    return tile;
  }

  // A peer changed (or cleared) their profile picture: repaint their camera-off
  // circle. No-op if they have no tile right now (it'll pick the image up from
  // the player state when a tile is next created).
  setPeerAvatarImage(userId: string, avatarImage: string | null) {
    const tile = this.remoteTiles.get(userId);
    if (!tile) return;
    const p = this.players.get(userId);
    const initials = p ? p.initials() : userId.slice(0, 2).toUpperCase();
    renderNoVideoAvatar(tile.avatarEl, avatarImage, initials);
  }

  // Tears down every DOM artifact for a peer (tile, audio, speaking detector).
  removePeer(userId: string) {
    const t = this.remoteTiles.get(userId);
    if (t) {
      t.frameWatch?.abort();
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
      this.gainRoutes.drop(userId);
      // Drop this peer's mic from the recording mix. removePeer is the common
      // path (proximity walk-away, mesh→SFU switch, abrupt disconnect) and, unlike
      // detachRemoteStream, previously never told the recorder — so the source
      // node stayed connected to the mix and kept the detached stream referenced
      // until the recording stopped.
      this.recorder.removeAudioStream(a.streamId);
      this.remoteAudios.delete(userId);
      this.onRemoteAudio?.(userId, null);
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
      // choice (issue #175). The trailing reflowLayout() renders it. A maximized
      // window is dropped for the same reason: otherwise the new stage would be
      // born hidden behind it, and a user who maximized something and then hit
      // 画面共有 would get no sign at all that they are now sharing.
      this.layout.setLayoutModeSilently('presentation');
      this.layout.dropFocus();
    }
    ss.streamId = stream.id;
    ss.video.srcObject = stream;
    this.autoplay.play(ss.video);
    const isSelf = userId === this.getMyId();
    const p = this.players.get(userId);
    ss.label.textContent = isSelf
      ? t('media.yourScreen')
      : t('media.screenOf', { name: p?.name || userId.slice(0, 6) });
    this.reflowLayout();
  }

  // Removes a user's screenshare stage (no-op if they aren't sharing). When the
  // main share stops, the next-oldest share is promoted to main. When the last
  // share stops, the layout reverts to the sidebar default (issue #175).
  // A call peer's pointer / stroke over a share. Ignored when we are not showing
  // that share (it may have just stopped, or belong to another call).
  receiveAnnotation(from: string, m: AnnotateBody) {
    this.screenshares.get(m.shareId)?.annot.receive(from, m);
  }

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
    // Last share gone → back to the sidebar default (never remembers a manual choice).
    if (this.screenshares.size === 0) this.layout.setLayoutModeSilently('sidebar');
    this.reflowLayout();
  }

  // Makes a non-main share the featured (main) one by click: re-designate
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
  // reflowLayout. Clicking a non-main share makes it the main one.
  private createScreenshareStage(userId: string, isMain: boolean): Screenshare {
    const container = document.createElement('div');
    container.className = isMain ? 'panel screenshare-stage main' : 'panel screenshare-stage';
    container.dataset.userId = userId;
    container.dataset.focusKey = `screen:${userId}`;
    if (this.reconnecting && userId !== this.getMyId()) container.classList.add('reconnecting');

    const header = document.createElement('div');
    header.className = 'panel-header';
    header.title = t('media.dblClickMain');
    const label = document.createElement('span');
    label.className = 'label';
    header.appendChild(label);
    header.appendChild(createFocusButton());
    container.appendChild(header);

    const body = document.createElement('div');
    body.className = 'panel-body';
    body.dataset.reconnectingLabel = t('media.reconnecting');
    container.appendChild(body);

    const video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    body.appendChild(video);

    this.stageLayerEl.appendChild(container);
    // A single click anywhere on the stage makes it the featured (main) share
    // (a double-click was too hidden) — except on the maximize button, which
    // has its own job and must not also swap which share is featured.
    const onClick = (e: Event) => {
      if ((e.target as HTMLElement | null)?.closest?.('.panel-focus-btn')) return;
      this.promoteScreenshare(userId);
    };
    container.addEventListener('click', onClick);
    // Viewer-side zoom (+/- and drag-pan), shown only while this stage is
    // maximized. Disposed with the stage (below).
    const zoom = new ScreenZoom(container, video);
    const annot = new ShareAnnotator({
      container,
      body,
      video,
      shareId: userId,
      selfId: () => this.getMyId(),
      peer: (id) => {
        const p = this.players.get(id);
        return { name: p?.name || id.slice(0, 6), color: p?.color || '#ff5a5f' };
      },
      send: (m) => this.sendAnnotation(m),
    });
    const cleanup = () => {
      container.removeEventListener('click', onClick);
      zoom.dispose();
      annot.dispose();
    };
    return { container, video, label, streamId: '', zoom, annot, cleanup };
  }

  // ============= Self preview =============
  refreshSelfPreview() {
    this.selfPreviewEl.classList.toggle('muted', !this.media.micOn);
    if (this.facePip.isOpen()) this.facePip.setMuted(this.getMyId(), !this.media.micOn);
    const stream = this.media.camStream;
    // The face window mirrors the self tile too, so a cam flip re-syncs it.
    const camChanged = this.selfVideoEl.srcObject !== stream;
    const wasHidden = this.selfPreviewEl.classList.contains('hidden');
    // Show your own tile whenever your camera is on OR you're in a call/meeting —
    // so everyone (yourself included) is visible regardless of camera state
    // (#263). Only hide it when you're genuinely alone with the camera off.
    const show = stream != null || this.layout.isMeetingMode() || this.conversationMembers.size > 0;
    if (stream) {
      if (this.selfVideoEl.srcObject !== stream) {
        this.selfVideoEl.srcObject = stream;
        this.selfVideoEl.play().catch(() => {
          /* autoplay should already be allowed after the join click */
        });
      }
      this.selfVideoEl.style.display = '';
      this.selfNoVideoEl.style.display = 'none';
    } else {
      // This runs every frame (via setConversationMembers), so each write is
      // guarded: re-setting srcObject or textContent dirties the DOM and costs a
      // style + layout pass even when nothing changed.
      if (this.selfVideoEl.srcObject !== null) {
        try {
          this.selfVideoEl.srcObject = null;
        } catch {
          /* noop */
        }
      }
      // Camera off: render the profile picture, or the initials (matching remote
      // tiles). loadProfileImage() is our own, authoritative even before the
      // server echoes it back.
      const me = this.players.get(this.getMyId());
      const name = me?.name || t('common.you');
      const initials = me ? me.initials() : name.slice(0, 2).toUpperCase();
      renderNoVideoAvatar(this.selfNoVideoInitialsEl, loadProfileImage(), initials);
      if (this.selfNoVideoNameEl.textContent !== name) this.selfNoVideoNameEl.textContent = name;
      this.selfVideoEl.style.display = 'none';
      this.selfNoVideoEl.style.display = show ? '' : 'none';
    }
    this.selfPreviewEl.classList.toggle('hidden', !show);
    // The self preview joins/leaves the auto-layout as it shows/hides, so
    // re-flow whenever its visibility flips (issue #175).
    if (wasHidden !== this.selfPreviewEl.classList.contains('hidden')) this.reflowLayout();
    else if (camChanged && this.facePip.isOpen()) this.facePip.sync(this.faceEntries());
  }

  // ============= Mute indicator =============
  setTileMuted(userId: string, muted: boolean) {
    const tile = this.remoteTiles.get(userId);
    if (tile) tile.container.classList.toggle('muted', muted);
    this.facePip.setMuted(userId, muted);
  }

  setTilePtt(userId: string, ptt: boolean) {
    this.remoteTiles.get(userId)?.container.classList.toggle('ptt', ptt);
  }

  // ============= Face window (issue #318) =============
  // The toolbar opens this right after a screen share starts (inside the same
  // user activation) and closes it when the share stops. Mirrors the remote
  // tiles plus the sharer's own — see ui/face-pip.ts for why it mirrors rather
  // than moves them.
  facePipSupported(): boolean {
    return isFacePipSupported();
  }

  facePipOpen(): boolean {
    return this.facePip.isOpen();
  }

  openFacePip(): Promise<boolean> {
    return this.facePip.open(this.faceEntries());
  }

  closeFacePip() {
    this.facePip.close();
  }

  // Snapshot of the sharer and every remote tile as the face window shows it.
  // The sharer always comes first (they asked to see themselves too, even with
  // the self preview hidden). Remote tiles are the source of truth (a cam-off
  // conversation member has a placeholder tile, a peer who left has none), so
  // the window always matches the main view.
  private faceEntries(): FaceEntry[] {
    const myId = this.getMyId();
    const me = this.players.get(myId);
    const myName = me?.name || t('common.you');
    const entries: FaceEntry[] = [
      {
        userId: myId,
        self: true,
        name: myName,
        initials: me ? me.initials() : myName.slice(0, 2).toUpperCase(),
        stream: this.media.camStream,
        muted: !this.media.micOn,
        speaking: me?.isSpeaking ?? false,
      },
    ];
    for (const [userId, tile] of this.remoteTiles) {
      const p = this.players.get(userId);
      const name = tile.label.textContent || userId.slice(0, 6);
      entries.push({
        userId,
        name,
        initials: p ? p.initials() : name.slice(0, 2).toUpperCase(),
        stream: tile.hasCam ? (tile.video.srcObject as MediaStream | null) : null,
        muted: tile.container.classList.contains('muted'),
        speaking: p?.isSpeaking ?? false,
      });
    }
    return entries;
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

  // Pumped every frame (reads throttled below): refreshes the speaking flag on the local and remote
  // players and toggles the "speaking" ring on each remote tile.
  updateSpeaking() {
    // Throttled to SPEAKING_POLL_MS, whatever rate the loop runs at.
    const now = performance.now();
    if (now - this.lastSpeakingPollMs < SPEAKING_POLL_MS) return;
    this.lastSpeakingPollMs = now;
    const me = this.players.get(this.getMyId());
    if (me && this.localSpeakingDetector) {
      me.isSpeaking = isSpeaking(this.localSpeakingDetector);
    }
    if (this.facePip.isOpen()) this.facePip.setSpeaking(this.getMyId(), me?.isSpeaking ?? false);
    for (const [userId, det] of this.remoteSpeakingDetectors) {
      const p = this.players.get(userId);
      if (p) p.isSpeaking = isSpeaking(det);
      const tile = this.remoteTiles.get(userId);
      if (tile) tile.container.classList.toggle('speaking', p?.isSpeaking ?? false);
      if (this.facePip.isOpen()) this.facePip.setSpeaking(userId, p?.isSpeaking ?? false);
    }
  }

  setOnRemoteAudio(fn: (userId: string, stream: MediaStream | null) => void) {
    this.onRemoteAudio = fn;
  }

  // The live remote mic streams with their owners, for transcribing each
  // speaker separately. The sibling below stays owner-less: the recording mixes
  // everyone into one track and has no use for the ids.
  getRemoteMicStreams(): { userId: string; stream: MediaStream }[] {
    const out: { userId: string; stream: MediaStream }[] = [];
    for (const [userId, entry] of this.remoteAudios) {
      const stream = entry.audio.srcObject as MediaStream | null;
      if (stream) out.push({ userId, stream });
    }
    return out;
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

  // True when any media window is on screen (a remote camera tile, a screenshare
  // stage, or the self preview) — the same set collectPanels() lays out. The App
  // polls this every frame to collapse the roster during a call, so it counts
  // the members directly instead of building the panel list (which reads
  // getComputedStyle per tile).
  hasMediaWindows(): boolean {
    return (
      this.screenshares.size > 0 ||
      this.remoteTiles.size > 0 ||
      !this.selfPreviewEl.classList.contains('hidden')
    );
  }

  // ============= Layout modes (auto-arrange) =============
  // The arrangement itself lives in MediaLayout (ui/media-layout.ts); this view
  // only supplies the panels and forwards the public API.

  getLayoutMode(): LayoutMode {
    return this.layout.getLayoutMode();
  }

  setOnLayoutModeChange(cb: (mode: LayoutMode) => void) {
    this.layout.setOnLayoutModeChange(cb);
  }

  setOnPanelsChange(cb: (count: number) => void) {
    this.layout.setOnPanelsChange(cb);
  }

  setLayoutMode(mode: LayoutMode) {
    this.layout.setLayoutMode(mode);
  }

  // Enters/leaves the immersive meeting layout (issue #263). The App calls this
  // every frame with whether the local user is standing in a meeting-room zone;
  // it no-ops when unchanged.
  setMeetingMode(on: boolean) {
    if (!this.layout.setMeetingMode(on)) return;
    // Entering/leaving a meeting flips whether your own camera-off tile shows.
    this.refreshSelfPreview();
    this.reflowLayout();
  }

  toggleMeetingView() {
    this.layout.toggleMeetingView();
  }

  private reflowLayout() {
    this.layout.reflow();
  }

  // Collects visible panels with the element to move and its layout item, in a
  // stable order: the main screenshare first (so the presentation layout
  // features it), then the other screenshares, then camera/mic tiles, then the
  // self preview.
  // `key` identifies a window across re-flows (the DOM elements are recreated as
  // peers come and go), so a maximized window survives unrelated layout changes.
  private collectPanels(): LayoutPanel[] {
    const panels: LayoutPanel[] = [];
    for (const userId of this.orderedScreenshareIds()) {
      const ss = this.screenshares.get(userId)!;
      panels.push({
        el: ss.container,
        item: { aspectLocked: false, aspect: 16 / 9 },
        key: `screen:${userId}`,
      });
    }
    for (const [userId, tile] of this.remoteTiles) {
      panels.push({
        el: tile.container,
        item: { aspectLocked: true, aspect: CAM_ASPECT },
        key: `cam:${userId}`,
      });
    }
    if (!this.selfPreviewEl.classList.contains('hidden')) {
      panels.push({
        el: this.selfPreviewEl,
        item: { aspectLocked: true, aspect: CAM_ASPECT },
        key: 'self',
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
    // Hidden behind a maximized window: nobody is watching it, so report the
    // smallest width and let the layer drop. It is hidden with visibility (the
    // recording needs it laid out), which keeps clientWidth at its pre-maximize
    // value — reporting that would keep pulling full-size video for a window
    // that is not on screen.
    if (tile.container.classList.contains('focus-hidden')) return 1;
    // A tile trimmed from a capped layout (meeting-hidden / layout-hidden) is
    // display:none and reads 0, which the layer picker treats as off screen
    // (issue #269).
    return tile.container.clientWidth;
  }
}
