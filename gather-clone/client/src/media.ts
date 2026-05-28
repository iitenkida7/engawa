type MediaListener = () => void;

export class MediaManager {
  micStream: MediaStream | null = null;
  camStream: MediaStream | null = null;
  screenStream: MediaStream | null = null;
  private listeners = new Set<MediaListener>();

  on(fn: MediaListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  get micOn() {
    return !!this.micStream;
  }
  get camOn() {
    return !!this.camStream;
  }
  get screenOn() {
    return !!this.screenStream;
  }

  async enableMic() {
    if (this.micStream) return this.micStream;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    this.micStream = stream;
    this.emit();
    return stream;
  }
  disableMic() {
    const old = this.micStream;
    if (old) {
      for (const t of old.getTracks()) t.stop();
      this.micStream = null;
      this.emit();
    }
    return old;
  }

  async enableCam() {
    if (this.camStream) return this.camStream;
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 320, height: 240 },
    });
    this.camStream = stream;
    this.emit();
    return stream;
  }
  disableCam() {
    const old = this.camStream;
    if (old) {
      for (const t of old.getTracks()) t.stop();
      this.camStream = null;
      this.emit();
    }
    return old;
  }

  async enableScreen() {
    if (this.screenStream) return this.screenStream;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (track) {
      // browser stop-sharing → propagate
      track.addEventListener('ended', () => this.disableScreen());
    }
    this.screenStream = stream;
    this.emit();
    return stream;
  }
  disableScreen() {
    const old = this.screenStream;
    if (old) {
      for (const t of old.getTracks()) t.stop();
      this.screenStream = null;
      this.emit();
    }
    return old;
  }
}
