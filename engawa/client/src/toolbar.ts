import type { MediaManager } from './media';
import type { PlayerState } from './player';
import type { RecorderManager } from './recorder';
import type { RemoteMediaView } from './remote-media';
import { SceneCompositor } from './compositor';
import type { PlayerStatus, StreamKind } from './types';
import {
  BG_PRESETS,
  VBG_OFF,
  VBG_BLUR,
  VBG_CUSTOM,
  VBG_STORAGE_KEY,
  VBG_IMAGE_STORAGE_KEY,
  parseVbgChoice,
  serializeVbgChoice,
  choiceLabel,
  fileToDownscaledDataUrl,
} from './vbg';

// The slice of the media transport the toolbar drives: publishing and
// unpublishing local tracks. The App passes a router that forwards to whichever
// transport (mesh WebRtcManager or SFU SfuManager) is active, so the toolbar
// stays transport-agnostic.
export interface MediaSink {
  addLocalStream(stream: MediaStream, kind: StreamKind): void;
  removeLocalStream(stream: MediaStream): void;
}

// Owns the bottom toolbar: the mic/cam/screen/record buttons, the device and
// status dropdown menus, and the media orchestration behind each button (enable
// the device, wire it into WebRTC, update the speaking detector / screenshare
// stage). Player-state changes that must reach the rest of the app (status
// broadcast, screenshare flag) are handed back through callbacks so the toolbar
// never reaches across subsystems itself.
export class ToolbarController {
  private media: MediaManager;
  private rtc: MediaSink;
  private recorder: RecorderManager;
  private compositor: SceneCompositor;
  private view: RemoteMediaView;
  private broadcastStatus: () => void;
  private getMe: () => PlayerState | null;
  private getStatus: () => PlayerStatus;
  private onSetStatus: (status: PlayerStatus) => void;

  private btnMic: HTMLButtonElement;
  private btnCam: HTMLButtonElement;
  private btnBg: HTMLButtonElement;
  private btnScreen: HTMLButtonElement;
  private btnRec: HTMLButtonElement;
  private btnArrangeSmart: HTMLButtonElement;
  private btnArrangeGrid: HTMLButtonElement;
  private btnStatus: HTMLButtonElement;
  private bgFileInput: HTMLInputElement;

  // Selectable statuses, in menu order, with their toolbar labels.
  private readonly statusOrder: PlayerStatus[] = ['online', 'busy', 'away', 'meeting', 'break'];
  private readonly statusLabels: Record<PlayerStatus, string> = {
    online: '🟢 オンライン', busy: '🔴 取り込み中', away: '🟡 離席中', meeting: '🤝 商談中', break: '☕ 休憩中',
  };

  constructor(opts: {
    media: MediaManager;
    rtc: MediaSink;
    recorder: RecorderManager;
    compositor: SceneCompositor;
    view: RemoteMediaView;
    broadcastStatus: () => void;
    getMe: () => PlayerState | null;
    getStatus: () => PlayerStatus;
    onSetStatus: (status: PlayerStatus) => void;
  }) {
    this.media = opts.media;
    this.rtc = opts.rtc;
    this.recorder = opts.recorder;
    this.compositor = opts.compositor;
    this.view = opts.view;
    this.broadcastStatus = opts.broadcastStatus;
    this.getMe = opts.getMe;
    this.getStatus = opts.getStatus;
    this.onSetStatus = opts.onSetStatus;

    this.btnMic = document.getElementById('btn-mic') as HTMLButtonElement;
    this.btnCam = document.getElementById('btn-cam') as HTMLButtonElement;
    this.btnBg = document.getElementById('btn-bg') as HTMLButtonElement;
    this.btnScreen = document.getElementById('btn-screen') as HTMLButtonElement;
    this.btnRec = document.getElementById('btn-rec') as HTMLButtonElement;
    this.btnArrangeSmart = document.getElementById('btn-arrange-smart') as HTMLButtonElement;
    this.btnArrangeGrid = document.getElementById('btn-arrange-grid') as HTMLButtonElement;
    this.btnStatus = document.getElementById('btn-status') as HTMLButtonElement;
    this.bgFileInput = document.getElementById('bg-file') as HTMLInputElement;

    // OS/browser "stop sharing" routes through the same teardown as the button.
    this.media.onScreenEnded((old) => this.afterScreenStopped(old));

    this.loadBgSettings();
    this.setup();
    this.refresh();
  }

  private setup() {
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
    this.bgFileInput.addEventListener('change', () => {
      const file = this.bgFileInput.files?.[0];
      // Reset so picking the same file again still fires 'change'.
      this.bgFileInput.value = '';
      if (file) void this.onBgFile(file);
    });
    this.btnScreen.addEventListener('click', () => this.toggleScreen());
    this.btnRec.addEventListener('click', () => this.toggleRecord());
    // One-shot batch arrange: tidy every open window. These only move/resize
    // panels — nothing is locked or persisted (windows stay draggable after).
    this.btnArrangeSmart.addEventListener('click', () => this.view.arrange('smart'));
    this.btnArrangeGrid.addEventListener('click', () => this.view.arrange('grid'));
  }

  refresh() {
    this.btnMic.classList.toggle('active', this.media.micOn);
    this.btnMic.textContent = this.media.micOn ? '🎤 マイク ON' : '🎤 マイク';
    this.btnCam.classList.toggle('active', this.media.camOn);
    this.btnCam.textContent = this.media.camOn ? '📷 カメラ ON' : '📷 カメラ';
    this.btnBg.classList.toggle('active', this.media.bgChoice !== VBG_OFF);
    this.btnBg.textContent = choiceLabel(this.media.bgChoice);
    this.btnScreen.classList.toggle('active', this.media.screenOn);
    this.btnScreen.textContent = this.media.screenOn ? '🖥 共有中' : '🖥 画面共有';
    this.btnRec.classList.toggle('recording', this.recorder.recording);
    this.btnRec.textContent = this.recorder.recording ? '⏹ 録画停止' : '⏺ 録画';
    this.btnStatus.textContent = this.statusLabels[this.getStatus()];
  }

  // ---- Mic/cam enable & disable flows (shared by toolbar and device switch) ----
  private async startMic() {
    try {
      const stream = await this.media.enableMic();
      this.rtc.addLocalStream(stream, 'mic');
      this.view.setLocalMicStream(stream);
    } catch (e) {
      alert('マイクを使えません: ' + (e as Error).message);
    }
  }
  private stopMic() {
    const old = this.media.disableMic();
    if (old) this.rtc.removeLocalStream(old);
    this.view.setLocalMicStream(null);
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

  private async toggleScreen() {
    if (this.media.screenOn) {
      const old = this.media.disableScreen();
      if (old) this.afterScreenStopped(old);
    } else {
      try {
        const stream = await this.media.enableScreen();
        this.rtc.addLocalStream(stream, 'screen');
        const me = this.getMe();
        if (me) me.isSharingScreen = true;
        this.view.showScreenshare(me?.userId ?? '', stream);
      } catch (e) {
        alert('画面共有を開始できません: ' + (e as Error).message);
      }
    }
  }

  // Teardown after the screen stream has stopped. Shared by the toolbar stop
  // button and the OS/browser "stop sharing" path (via media.onScreenEnded) so
  // the two can't diverge: remove the stream from every peer (which also sends
  // stream-meta 'removed' and triggers the remote 'ended'), drop the sharing
  // flag (canvas 🖥 label), and close the local screenshare stage. `old` is the
  // just-stopped stream. The generic media `emit()` already refreshed the
  // button label, so this only does the cross-subsystem cleanup.
  private afterScreenStopped(old: MediaStream) {
    this.rtc.removeLocalStream(old);
    const me = this.getMe();
    if (me) me.isSharingScreen = false;
    this.view.clearScreenshare();
  }

  private toggleRecord() {
    if (this.recorder.recording) {
      this.recorder.stop();
      this.compositor.stop();
    } else {
      // Collect all active audio streams (local mic + remote mics)
      const audioStreams: MediaStream[] = [];
      if (this.media.micStream) audioStreams.push(this.media.micStream);
      audioStreams.push(...this.view.getRemoteAudioStreams());
      // Video source: the whole scene (floor + all panels) composited live.
      const sceneStream = this.compositor.start();
      this.recorder.start(audioStreams, sceneStream);
      // If the browser rejected recording (unsupported), don't leave the
      // compositor running with nothing consuming it.
      if (!this.recorder.recording) this.compositor.stop();
    }
    this.refresh();
  }

  // ============= Device & status selection =============
  private setupDeviceMenus() {
    const micMenu = document.getElementById('mic-menu') as HTMLDivElement;
    const camMenu = document.getElementById('cam-menu') as HTMLDivElement;
    const bgMenu = document.getElementById('bg-menu') as HTMLDivElement;
    const statusMenu = document.getElementById('status-menu') as HTMLDivElement;
    const btnMicDevices = document.getElementById('btn-mic-devices') as HTMLButtonElement;
    const btnCamDevices = document.getElementById('btn-cam-devices') as HTMLButtonElement;

    const closeMenus = () => {
      micMenu.classList.add('hidden');
      camMenu.classList.add('hidden');
      bgMenu.classList.add('hidden');
      statusMenu.classList.add('hidden');
    };
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (!micMenu.contains(t) && t !== btnMicDevices &&
          !camMenu.contains(t) && t !== btnCamDevices &&
          !bgMenu.contains(t) && t !== this.btnBg &&
          !statusMenu.contains(t) && t !== this.btnStatus) {
        closeMenus();
      }
    });

    this.btnBg.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = bgMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        this.populateBgMenu(bgMenu);
        bgMenu.classList.remove('hidden');
      }
    });

    this.btnStatus.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = statusMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        this.populateStatusMenu(statusMenu);
        statusMenu.classList.remove('hidden');
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

  // Fills the status dropdown, marking the current status, mirroring the
  // device-menu styling so the toolbar menus look and behave the same.
  private populateStatusMenu(menu: HTMLDivElement) {
    menu.replaceChildren();
    const current = this.getStatus();
    for (const status of this.statusOrder) {
      const item = document.createElement('button');
      item.className = 'device-item';
      const isSelected = status === current;
      if (isSelected) item.classList.add('selected');
      item.textContent = (isSelected ? '✓ ' : '') + this.statusLabels[status];
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        this.onSetStatus(status);
      });
      menu.appendChild(item);
    }
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

  // ============= Virtual background =============
  // Builds the background dropdown: off / blur / built-in presets / the stored
  // custom image (if any) / an "upload" entry that opens the file picker.
  private populateBgMenu(menu: HTMLDivElement) {
    menu.replaceChildren();
    const current = this.media.bgChoice;
    const addItem = (label: string, onPick: () => void, selectedId?: string) => {
      const item = document.createElement('button');
      item.className = 'device-item';
      const isSelected = selectedId !== undefined && selectedId === current;
      if (isSelected) item.classList.add('selected');
      item.textContent = (isSelected ? '✓ ' : '') + label;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        onPick();
      });
      menu.appendChild(item);
    };

    addItem('🚫 オフ', () => void this.setBackground(VBG_OFF), VBG_OFF);
    addItem('🌫 ぼかし', () => void this.setBackground(VBG_BLUR), VBG_BLUR);
    for (const preset of BG_PRESETS) {
      addItem(preset.label, () => void this.setBackground(preset.id), preset.id);
    }
    if (this.media.customBgDataUrl) {
      addItem('🖼 カスタム画像', () => void this.setBackground(VBG_CUSTOM), VBG_CUSTOM);
    }
    addItem('📁 画像をアップロード…', () => this.bgFileInput.click());
  }

  private async setBackground(choice: string) {
    const wasProcessing = this.media.bgChoice !== VBG_OFF;
    this.media.setBgChoice(choice);
    this.persistBgSettings();
    this.refresh();
    if (!this.media.camOn) return;

    const nowProcessing = choice !== VBG_OFF;
    // Switching among blur/preset/custom while a processor is already running:
    // update in place, keeping the same RTC track (no renegotiation, no
    // status re-broadcast).
    if (wasProcessing && nowProcessing && this.media.bgActive) {
      this.media.updateBackground();
      return;
    }
    // Crossing the on/off boundary swaps the camera track, so re-acquire just
    // like a device switch.
    this.stopCam();
    await this.startCam();
    this.broadcastStatus();
  }

  private async onBgFile(file: File) {
    try {
      const dataUrl = await fileToDownscaledDataUrl(file);
      await this.media.setCustomBgImage(dataUrl);
      this.persistBgSettings();
      await this.setBackground(VBG_CUSTOM);
    } catch (e) {
      alert('画像を読み込めません: ' + (e as Error).message);
    }
  }

  // Restore the persisted background choice + custom image on startup. Applied
  // lazily: it takes effect the next time the camera is enabled.
  private loadBgSettings() {
    const storedImage = localStorage.getItem(VBG_IMAGE_STORAGE_KEY);
    if (storedImage) void this.media.setCustomBgImage(storedImage);
    const choice = parseVbgChoice(localStorage.getItem(VBG_STORAGE_KEY), !!storedImage);
    this.media.setBgChoice(choice);
  }

  private persistBgSettings() {
    localStorage.setItem(VBG_STORAGE_KEY, serializeVbgChoice(this.media.bgChoice));
    if (this.media.customBgDataUrl) {
      localStorage.setItem(VBG_IMAGE_STORAGE_KEY, this.media.customBgDataUrl);
    } else {
      localStorage.removeItem(VBG_IMAGE_STORAGE_KEY);
    }
  }
}
