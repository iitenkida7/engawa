import { bringToFront, makeDraggable } from './draggable';
import { bindCamAspect, createModeControls, setupPanelModes } from './panel';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  type SpeakingDetector,
} from './speaking';
import type { RecorderManager } from './recorder';

// Display name + avatar initials for a remote user, resolved from the caller's
// player table at the moment a tile is built or relabelled.
export type ParticipantInfo = { name: string; initials: string };

// Everything tied to one remote user's presence in the UI: the draggable
// camera/placeholder tile, the off-screen <audio> playing their mic, and the
// AnalyserNode that drives the "speaking" highlight. A participant always owns
// a tile; the audio element, cam stream and detector are attached on demand.
type Participant = {
  userId: string;
  container: HTMLDivElement;
  video: HTMLVideoElement;
  placeholder: HTMLDivElement;
  label: HTMLSpanElement;
  // Removes the drag listeners when the tile is destroyed.
  cleanupDrag: () => void;
  hasCam: boolean;
  camStreamId?: string;
  // Mic audio lives on a dedicated <audio> element so it plays even when the
  // user has no cam (no video showing). Present only while a mic stream flows.
  audio?: HTMLAudioElement;
  audioStreamId?: string;
  detector: SpeakingDetector | null;
};

type Options = {
  // Container the tiles are appended into (#remote-videos).
  container: HTMLDivElement;
  // Recording mixer; remote mic streams are added/removed as they come and go.
  recorder: RecorderManager;
  // Resolves the current display name/initials for a user id.
  info: (userId: string) => ParticipantInfo;
};

// Owns the remote-participant tiles/audio/detectors as one cohesive unit, so
// the create/teardown logic lives in a single place instead of being spread
// across the App class.
export class RemoteParticipants {
  private participants = new Map<string, Participant>();
  private container: HTMLDivElement;
  private recorder: RecorderManager;
  private info: (userId: string) => ParticipantInfo;

  constructor(opts: Options) {
    this.container = opts.container;
    this.recorder = opts.recorder;
    this.info = opts.info;
  }

  // Attach (or swap) a remote mic stream: play it, feed the recorder mix if
  // recording, and (re)build the speaking detector.
  attachMic(userId: string, stream: MediaStream) {
    const p = this.ensure(userId);
    if (!p.audio) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      // off-screen but still in DOM so audio plays
      audio.style.display = 'none';
      document.body.appendChild(audio);
      p.audio = audio;
    }
    p.audioStreamId = stream.id;
    p.audio.srcObject = stream;
    p.audio.play().catch(() => {
      // autoplay blocked: will play on user gesture
    });
    // If recording is active, add this stream to the mix.
    if (this.recorder.recording) {
      this.recorder.addAudioStream(stream);
    }
    // Rebuild the speaking detector for the new stream.
    if (p.detector) destroySpeakingDetector(p.detector);
    p.detector = createSpeakingDetector(stream);
  }

  // Attach a remote cam stream: show it in the tile's <video> and relabel.
  attachCam(userId: string, stream: MediaStream) {
    const p = this.ensure(userId);
    p.hasCam = true;
    p.camStreamId = stream.id;
    p.video.srcObject = stream;
    p.video.style.display = '';
    p.placeholder.style.display = 'none';
    p.video.play().catch(() => {
      // autoplay blocked: will play on user gesture
    });
    p.label.textContent = this.info(userId).name;
  }

  // Detach a stream that stopped flowing. Removes the matching mic and/or cam
  // and, once the tile holds neither, tears the whole participant down.
  detach(userId: string, streamId: string) {
    const p = this.participants.get(userId);
    if (p && p.audio && p.audioStreamId === streamId) {
      try { p.audio.srcObject = null; } catch { /* noop */ }
      p.audio.remove();
      p.audio = undefined;
      p.audioStreamId = undefined;
      this.recorder.removeAudioStream(streamId);
      if (p.detector) {
        destroySpeakingDetector(p.detector);
        p.detector = null;
      }
      // If no cam either, remove the tile entirely.
      if (!p.hasCam) this.remove(userId);
    }
    // Re-fetch: the audio branch above may have removed the participant.
    const q = this.participants.get(userId);
    if (q && q.camStreamId === streamId) {
      q.hasCam = false;
      q.camStreamId = undefined;
      try { q.video.srcObject = null; } catch { /* noop */ }
      // If still has mic, show the placeholder; otherwise remove the tile.
      if (q.audio) {
        q.video.style.display = 'none';
        q.placeholder.style.display = '';
      } else {
        this.remove(userId);
      }
    }
  }

  // Fully tear down a participant (peer closed or player left).
  remove(userId: string) {
    const p = this.participants.get(userId);
    if (!p) return;
    p.cleanupDrag();
    try { p.video.srcObject = null; } catch { /* noop */ }
    p.container.remove();
    if (p.audio) {
      try { p.audio.srcObject = null; } catch { /* noop */ }
      p.audio.remove();
    }
    if (p.detector) destroySpeakingDetector(p.detector);
    this.participants.delete(userId);
  }

  // Toggle the mute indicator on a participant's tile (no-op if no tile).
  setMuted(userId: string, isMuted: boolean) {
    const p = this.participants.get(userId);
    if (p) p.container.classList.toggle('muted', isMuted);
  }

  // Run speaking detection for every participant: update the tile highlight and
  // report the result so the caller can mirror it onto its player state.
  updateSpeaking(onSpeaking: (userId: string, speaking: boolean) => void) {
    for (const p of this.participants.values()) {
      if (!p.detector) continue;
      const speaking = isSpeaking(p.detector);
      onSpeaking(p.userId, speaking);
      p.container.classList.toggle('speaking', speaking);
    }
  }

  // All live remote mic streams, for seeding the recorder mix on record-start.
  audioStreams(): MediaStream[] {
    const out: MediaStream[] = [];
    for (const p of this.participants.values()) {
      const s = p.audio?.srcObject as MediaStream | null | undefined;
      if (s) out.push(s);
    }
    return out;
  }

  private ensure(userId: string): Participant {
    const existing = this.participants.get(userId);
    if (existing) return existing;
    const p = this.createTile(userId);
    this.participants.set(userId, p);
    return p;
  }

  private createTile(userId: string): Participant {
    const { name, initials } = this.info(userId);

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
    // each new tile so they don't fully overlap.
    const index = this.participants.size;
    container.style.left = 'auto';
    container.style.right = `${12 + index * 16}px`;
    container.style.top = `${12 + index * 16}px`;

    this.container.appendChild(container);
    // Drag by the header only (matches the other panels).
    const cleanupDrag = makeDraggable(container, {
      handle: header,
      onStart: () => bringToFront(container),
    });
    setupPanelModes(container, {
      aspectLocked: true,
      onActivate: () => bringToFront(container),
    });

    return { userId, container, video, placeholder, label, cleanupDrag, hasCam: false, detector: null };
  }
}
