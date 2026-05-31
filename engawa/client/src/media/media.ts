import {
  VirtualBackground,
  imagePainter,
  loadImage,
  isProcessingChoice,
  VBG_OFF,
  VBG_BLUR,
  VBG_CUSTOM,
  BG_PRESETS,
  type BgSpec,
} from '@/media/vbg';

type MediaListener = () => void;

export class MediaManager {
  micStream: MediaStream | null = null;
  camStream: MediaStream | null = null;
  screenStream: MediaStream | null = null;
  // Currently selected input devices (null = browser default).
  selectedMicId: string | null = null;
  selectedCamId: string | null = null;
  // Virtual background: the active choice ('off'/'blur'/preset id/'custom') and
  // the user-uploaded image (dataURL + decoded element) for the 'custom' choice.
  bgChoice: string = VBG_OFF;
  customBgDataUrl: string | null = null;
  private customImg: HTMLImageElement | null = null;
  // While a background is active, camStream is the processed (canvas) stream and
  // these hold the underlying capture + processor for teardown.
  private vbg: VirtualBackground | null = null;
  private rawCam: MediaStream | null = null;
  private listeners = new Set<MediaListener>();
  // Notified when the screen share ends on its own (OS/browser "stop sharing"),
  // with the just-stopped stream. Lets the owner run the same teardown as the
  // toolbar stop button instead of only the generic `emit()` listeners.
  private screenEndedHandler: ((old: MediaStream) => void) | null = null;

  on(fn: MediaListener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit() {
    for (const fn of this.listeners) fn();
  }

  // Register the handler for an externally-ended screen share (see above).
  onScreenEnded(handler: (old: MediaStream) => void) {
    this.screenEndedHandler = handler;
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

  // Enumerate available audio/video input devices. Labels are only populated
  // after the user has granted permission for that kind of device at least
  // once, so callers should refresh the list after enabling mic/cam.
  async listMics(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }
  async listCams(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  }

  async enableMic() {
    if (this.micStream) return this.micStream;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        // Hint to the audio capture stack to keep its buffer short.
        // Chrome respects this; Firefox/Safari currently ignore it but it
        // does no harm.
        latency: { ideal: 0.01 },
        ...(this.selectedMicId ? { deviceId: { exact: this.selectedMicId } } : {}),
      } as MediaTrackConstraints,
    });
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
    const raw = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 320 },
        height: { ideal: 240 },
        // Higher fps target keeps per-frame interval short → less wait.
        frameRate: { ideal: 30, max: 30 },
        ...(this.selectedCamId ? { deviceId: { exact: this.selectedCamId } } : {}),
      },
    });
    for (const t of raw.getVideoTracks()) {
      // Tell encoders to optimize for motion (low-latency over crisp text).
      t.contentHint = 'motion';
    }

    // Background off → use the raw stream directly (zero added cost).
    if (!isProcessingChoice(this.bgChoice)) {
      this.camStream = raw;
      this.emit();
      return raw;
    }

    // Background on → process through VirtualBackground; on any failure
    // (model/WASM unavailable, no WebGL) fall back to the raw camera so the
    // camera still works.
    if (this.bgChoice === VBG_CUSTOM) await this.ensureCustomImg();
    try {
      const vbg = new VirtualBackground(raw, this.buildBgSpec());
      const processed = await vbg.start();
      this.vbg = vbg;
      this.rawCam = raw;
      this.camStream = processed;
    } catch (e) {
      console.warn('virtual background unavailable, using raw camera', e);
      this.vbg = null;
      this.rawCam = null;
      this.camStream = raw;
    }
    this.emit();
    return this.camStream;
  }
  disableCam() {
    const old = this.camStream;
    if (this.vbg) {
      this.vbg.stop();
      this.vbg = null;
    }
    if (this.rawCam) {
      for (const t of this.rawCam.getTracks()) t.stop();
      this.rawCam = null;
    }
    if (old) {
      for (const t of old.getTracks()) t.stop();
      this.camStream = null;
      this.emit();
    }
    return old;
  }

  // ---- Virtual background ----
  // True while a processor is actively running (i.e. a live background can be
  // updated without re-acquiring the camera).
  get bgActive() {
    return !!this.vbg;
  }

  setBgChoice(choice: string) {
    this.bgChoice = choice;
  }

  // Store the uploaded image (dataURL) and decode it for painting. Pass null to
  // clear. Awaitable so callers can guarantee it's ready before applying.
  async setCustomBgImage(dataUrl: string | null) {
    this.customBgDataUrl = dataUrl;
    this.customImg = null;
    if (dataUrl) this.customImg = await loadImage(dataUrl);
  }

  private async ensureCustomImg() {
    if (this.customBgDataUrl && !this.customImg) {
      try {
        this.customImg = await loadImage(this.customBgDataUrl);
      } catch {
        this.customImg = null;
      }
    }
  }

  private buildBgSpec(): BgSpec {
    if (this.bgChoice === VBG_BLUR) return { kind: 'blur' };
    const preset = BG_PRESETS.find((p) => p.id === this.bgChoice);
    if (preset) return { kind: 'image', paint: preset.paint };
    if (this.bgChoice === VBG_CUSTOM && this.customImg) {
      return { kind: 'image', paint: imagePainter(this.customImg) };
    }
    return { kind: 'blur' }; // safe fallback (e.g. custom chosen but no image)
  }

  // Update the running background in place (no track swap). Caller is
  // responsible for re-acquiring the camera when crossing the on/off boundary.
  updateBackground() {
    if (this.vbg) this.vbg.setSpec(this.buildBgSpec());
  }

  async enableScreen() {
    if (this.screenStream) return this.screenStream;
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: false,
    });
    const track = stream.getVideoTracks()[0];
    if (track) {
      // Tell encoders to optimize for crisp text/UI rather than low bitrate.
      track.contentHint = 'detail';
      // OS/browser "stop sharing": stop the stream, then notify so the owner
      // can run the full teardown (remove from peers, clear the stage, drop the
      // sharing flag) — the same path as the toolbar stop button. track.stop()
      // does not re-fire 'ended', so this can't loop.
      track.addEventListener('ended', () => {
        const old = this.disableScreen();
        if (old) this.screenEndedHandler?.(old);
      });
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
