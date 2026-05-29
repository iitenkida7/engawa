// Client-side recording of all audio streams (local mic + remote mics)
// plus an optional video source (cam/screen).
//
// Prefers MP4 (supported on Safari, Chrome 128+), falls back to WebM.

type RecorderListener = () => void;

function pickMimeType(): string {
  for (const mime of [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4',
    'audio/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'audio/webm;codecs=opus',
    'audio/webm',
  ]) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

function fileExtension(mime: string): string {
  if (mime.startsWith('video/mp4') || mime.startsWith('audio/mp4')) return 'mp4';
  return 'webm';
}

export class RecorderManager {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mixCtx: AudioContext | null = null;
  private mixDest: MediaStreamAudioDestinationNode | null = null;
  private sources: Map<string, MediaStreamAudioSourceNode> = new Map();
  private combinedStream: MediaStream | null = null;
  private mimeType = '';

  private listeners = new Set<RecorderListener>();
  on(fn: RecorderListener) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private emit() { for (const fn of this.listeners) fn(); }

  get recording() { return this.recorder?.state === 'recording'; }

  get format() { return fileExtension(this.mimeType); }

  // Start recording. Pass all audio streams to mix, and an optional video
  // stream (cam or canvas capture) to include as the video track.
  start(
    audioStreams: MediaStream[],
    videoStream?: MediaStream,
  ) {
    if (this.recorder) return;

    this.mimeType = pickMimeType();
    if (!this.mimeType) {
      alert('このブラウザは録画に対応していません');
      return;
    }

    // Mix all audio into a single destination
    this.mixCtx = new AudioContext();
    this.mixDest = this.mixCtx.createMediaStreamDestination();

    for (const stream of audioStreams) {
      this.addAudioStream(stream);
    }

    // Build combined stream: mixed audio + optional video
    const tracks: MediaStreamTrack[] = [
      ...this.mixDest.stream.getAudioTracks(),
    ];
    if (videoStream) {
      for (const t of videoStream.getVideoTracks()) tracks.push(t);
    }

    this.combinedStream = new MediaStream(tracks);
    this.chunks = [];

    this.recorder = new MediaRecorder(this.combinedStream, {
      mimeType: this.mimeType,
    });
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.onstop = () => this.save();
    this.recorder.start(1000); // collect data every second
    this.emit();
  }

  // Add a new audio stream to the mix while recording (e.g. when a new
  // remote user connects mid-recording).
  addAudioStream(stream: MediaStream) {
    if (!this.mixCtx || !this.mixDest) return;
    if (this.sources.has(stream.id)) return;
    // A source node requires at least one audio track; a video-only stream
    // would otherwise throw.
    if (stream.getAudioTracks().length === 0) return;
    const src = this.mixCtx.createMediaStreamSource(stream);
    src.connect(this.mixDest);
    this.sources.set(stream.id, src);
  }

  // Remove an audio stream from the mix (e.g. remote user disconnected).
  removeAudioStream(streamId: string) {
    const src = this.sources.get(streamId);
    if (src) {
      src.disconnect();
      this.sources.delete(streamId);
    }
  }

  stop() {
    if (!this.recorder || this.recorder.state !== 'recording') return;
    this.recorder.stop();
    // Cleanup audio context
    for (const src of this.sources.values()) src.disconnect();
    this.sources.clear();
    if (this.mixCtx) {
      void this.mixCtx.close();
      this.mixCtx = null;
      this.mixDest = null;
    }
    this.combinedStream = null;
    this.recorder = null;
    this.emit();
  }

  private save() {
    if (this.chunks.length === 0) return;
    const blob = new Blob(this.chunks, { type: this.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `recording-${ts}.${fileExtension(this.mimeType)}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    this.chunks = [];
  }
}
