import type { MediaManager } from './media';
import type { WebRtcManager } from './webrtc';
import type { RecorderManager } from './recorder';
import type { RemoteParticipants } from './remote';
import type { PlayerStatus } from './types';
import { bringToFront, makeDraggable } from './draggable';
import { bindCamAspect, setupPanelModes } from './panel';
import {
  createSpeakingDetector,
  destroySpeakingDetector,
  isSpeaking,
  type SpeakingDetector,
} from './speaking';

type ToolbarDeps = {
  media: MediaManager;
  rtc: WebRtcManager;
  recorder: RecorderManager;
  participants: RemoteParticipants;
  // App mirrors these onto the local player and broadcasts them to peers.
  onLocalStatus: (status: PlayerStatus, isMuted: boolean, isVideoOn: boolean) => void;
  // App owns the screenshare stage; the toolbar only drives capture start/stop.
  onScreenShareStart: (stream: MediaStream) => void;
  onScreenShareStop: () => void;
};

// Owns the media toolbar (mic / cam / screen / record / status buttons), the
// mic & cam device picker menus, the local mic speaking detector and the
// self-preview window. App wires it to the shared media/rtc/recorder managers
// and reacts to status / screenshare changes through a few callbacks.
export class Toolbar {
  private media: MediaManager;
  private rtc: WebRtcManager;
  private recorder: RecorderManager;
  private participants: RemoteParticipants;
  private onLocalStatus: ToolbarDeps['onLocalStatus'];
  private onScreenShareStart: ToolbarDeps['onScreenShareStart'];
  private onScreenShareStop: ToolbarDeps['onScreenShareStop'];

  private btnMic: HTMLButtonElement;
  private btnCam: HTMLButtonElement;
  private btnScreen: HTMLButtonElement;
  private btnRec: HTMLButtonElement;
  private btnStatus: HTMLButtonElement;

  private selfPreviewEl: HTMLDivElement;
  private selfVideoEl: HTMLVideoElement;
  private selfPreviewLabelEl: HTMLSpanElement;

  private localSpeakingDetector: SpeakingDetector | null = null;
  private status: PlayerStatus = 'online';

  constructor(deps: ToolbarDeps) {
    this.media = deps.media;
    this.rtc = deps.rtc;
    this.recorder = deps.recorder;
    this.participants = deps.participants;
    this.onLocalStatus = deps.onLocalStatus;
    this.onScreenShareStart = deps.onScreenShareStart;
    this.onScreenShareStop = deps.onScreenShareStop;

    this.btnMic = document.getElementById('btn-mic') as HTMLButtonElement;
    this.btnCam = document.getElementById('btn-cam') as HTMLButtonElement;
    this.btnScreen = document.getElementById('btn-screen') as HTMLButtonElement;
    this.btnRec = document.getElementById('btn-rec') as HTMLButtonElement;
    this.btnStatus = document.getElementById('btn-status') as HTMLButtonElement;

    this.selfPreviewEl = document.getElementById('self-preview') as HTMLDivElement;
    this.selfVideoEl = document.getElementById('self-video') as HTMLVideoElement;
    this.selfPreviewLabelEl = document.getElementById('self-preview-label') as HTMLSpanElement;
    const selfHeader = document.getElementById('self-preview-header') as HTMLDivElement;

    this.media.on(() => this.refresh());
    this.recorder.on(() => this.refresh());
    this.wireButtons();
    this.setupDeviceMenus();

    // Make the self-preview draggable/resizable by its header. The CSS keeps
    // its initial bottom-right placement; the first drag (or a window resize)
    // converts it to left/top.
    makeDraggable(this.selfPreviewEl, {
      handle: selfHeader,
      onStart: () => bringToFront(this.selfPreviewEl),
    });
    setupPanelModes(this.selfPreviewEl, {
      aspectLocked: true,
      onActivate: () => bringToFront(this.selfPreviewEl),
    });
    bindCamAspect(this.selfPreviewEl, this.selfVideoEl);

    this.refresh();
  }

  // Set the name shown on the self-preview window (called once on join).
  setSelfName(name: string) {
    this.selfPreviewLabelEl.textContent = name || 'あなた';
  }

  // Whether the local mic is currently above the speaking threshold. App polls
  // this each frame to drive the avatar's speaking highlight.
  localSpeaking(): boolean {
    return this.localSpeakingDetector ? isSpeaking(this.localSpeakingDetector) : false;
  }

  // Push the current mic/cam/status to peers (called on join and on changes).
  broadcastStatus() {
    this.onLocalStatus(this.status, !this.media.micOn, this.media.camOn);
  }

  private wireButtons() {
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
    this.btnScreen.addEventListener('click', async () => {
      if (this.media.screenOn) {
        const old = this.media.disableScreen();
        if (old) this.rtc.removeLocalStream(old);
        this.onScreenShareStop();
      } else {
        try {
          const stream = await this.media.enableScreen();
          this.rtc.addLocalStream(stream, 'screen');
          this.onScreenShareStart(stream);
        } catch (e) {
          alert('画面共有を開始できません: ' + (e as Error).message);
        }
      }
    });
    this.btnRec.addEventListener('click', () => {
      if (this.recorder.recording) {
        this.recorder.stop();
      } else {
        // Collect all active audio streams (local mic + remote mics)
        const audioStreams: MediaStream[] = [];
        if (this.media.micStream) audioStreams.push(this.media.micStream);
        audioStreams.push(...this.participants.audioStreams());
        // Use cam or screen as video source (prefer screen if active)
        const videoStream = this.media.screenStream ?? this.media.camStream ?? undefined;
        this.recorder.start(audioStreams, videoStream);
      }
      this.refresh();
    });
    this.btnStatus.addEventListener('click', () => {
      const cycle: PlayerStatus[] = ['online', 'busy', 'away'];
      const idx = cycle.indexOf(this.status);
      this.status = cycle[(idx + 1) % cycle.length];
      this.broadcastStatus();
      this.refresh();
    });
  }

  private refresh() {
    this.btnMic.classList.toggle('active', this.media.micOn);
    this.btnMic.textContent = this.media.micOn ? '🎤 マイク ON' : '🎤 マイク';
    this.btnCam.classList.toggle('active', this.media.camOn);
    this.btnCam.textContent = this.media.camOn ? '📷 カメラ ON' : '📷 カメラ';
    this.btnScreen.classList.toggle('active', this.media.screenOn);
    this.btnScreen.textContent = this.media.screenOn ? '🖥 共有中' : '🖥 画面共有';
    this.btnRec.classList.toggle('recording', this.recorder.recording);
    this.btnRec.textContent = this.recorder.recording ? '⏹ 録画停止' : '⏺ 録画';
    const statusLabel: Record<PlayerStatus, string> = { online: '🟢 オンライン', busy: '🔴 取り込み中', away: '🟡 離席中' };
    this.btnStatus.textContent = statusLabel[this.status];
    this.refreshSelfPreview();
  }

  // ---- Mic/cam enable & disable flows (shared by toolbar and device switch) ----
  private async startMic() {
    try {
      const stream = await this.media.enableMic();
      this.rtc.addLocalStream(stream, 'mic');
      this.localSpeakingDetector = createSpeakingDetector(stream);
    } catch (e) {
      alert('マイクを使えません: ' + (e as Error).message);
    }
  }
  private stopMic() {
    const old = this.media.disableMic();
    if (old) this.rtc.removeLocalStream(old);
    if (this.localSpeakingDetector) {
      destroySpeakingDetector(this.localSpeakingDetector);
      this.localSpeakingDetector = null;
    }
    // The local player's isSpeaking flag follows localSpeaking() each frame.
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

  // ============= Device selection =============
  private setupDeviceMenus() {
    const micMenu = document.getElementById('mic-menu') as HTMLDivElement;
    const camMenu = document.getElementById('cam-menu') as HTMLDivElement;
    const btnMicDevices = document.getElementById('btn-mic-devices') as HTMLButtonElement;
    const btnCamDevices = document.getElementById('btn-cam-devices') as HTMLButtonElement;

    const closeMenus = () => {
      micMenu.classList.add('hidden');
      camMenu.classList.add('hidden');
    };
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (!micMenu.contains(t) && t !== btnMicDevices &&
          !camMenu.contains(t) && t !== btnCamDevices) {
        closeMenus();
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
}
