import { getLang, type Lang, setLang, t } from '@/core/i18n';
import { REACTION_EMOJIS, type StreamKind } from '@/core/types';
import type { SceneCompositor } from '@/media/compositor';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  BG_PRESETS,
  fileToDownscaledDataUrl,
  parseVbgChoice,
  serializeVbgChoice,
  VBG_BLUR,
  VBG_CUSTOM,
  VBG_IMAGE_STORAGE_KEY,
  VBG_OFF,
  VBG_STORAGE_KEY,
} from '@/media/vbg';
import type { Toasts } from '@/ui/notify';
import type { LayoutMode } from '@/ui/panels';
import type { RemoteMediaView } from '@/ui/remote-media';
import type { PlayerState } from '@/world/player';

// The slice of the media transport the toolbar drives: publishing and
// unpublishing local tracks. The App passes a router that forwards to whichever
// transport (mesh WebRtcManager or SFU SfuManager) is active, so the toolbar
// stays transport-agnostic.
export interface MediaSink {
  addLocalStream(stream: MediaStream, kind: StreamKind): void;
  removeLocalStream(stream: MediaStream): void;
  // Swap the track behind an already-published stream in place (device switch /
  // background toggle) without a remove+add, which blacks the remote out (#148).
  replaceLocalStream(oldStream: MediaStream, newStream: MediaStream, kind: StreamKind): void;
}

// Owns the bottom toolbar, trimmed to the core call controls: mic, cam, screen
// share, record, and a "⋯" overflow menu for low-frequency actions
// (window-layout modes + the RTC debug console toggle). Device selection and
// virtual-background live in the cam caret menu; status and chat moved to the
// roster panel (issue #99). Each button also owns the media orchestration behind
// it (enable the device, wire it into WebRTC, update the screenshare stage).
// Player-state changes that must reach the rest of the app (status broadcast,
// screenshare flag) are handed back through callbacks so the toolbar never
// reaches across subsystems itself — likewise the debug console is toggled via
// callbacks, not a direct reference.
export class ToolbarController {
  private media: MediaManager;
  private rtc: MediaSink;
  private recorder: RecorderManager;
  private compositor: SceneCompositor;
  private view: RemoteMediaView;
  private toasts: Toasts;
  private broadcastStatus: () => void;
  private getMe: () => PlayerState | null;
  private onReaction: (emoji: string) => void;
  private onOpenAvatar: () => void;
  private toggleDebug: () => void;
  private isDebugOpen: () => boolean;

  private btnMic: HTMLButtonElement;
  private btnCam: HTMLButtonElement;
  private btnScreen: HTMLButtonElement;
  private btnRec: HTMLButtonElement;
  private btnReaction: HTMLButtonElement;
  private reactionMenu: HTMLDivElement;
  private btnMore: HTMLButtonElement;
  private moreMenu: HTMLDivElement;
  private bgFileInput: HTMLInputElement;

  constructor(opts: {
    media: MediaManager;
    rtc: MediaSink;
    recorder: RecorderManager;
    compositor: SceneCompositor;
    view: RemoteMediaView;
    toasts: Toasts;
    broadcastStatus: () => void;
    getMe: () => PlayerState | null;
    onReaction: (emoji: string) => void;
    onOpenAvatar: () => void;
    toggleDebug: () => void;
    isDebugOpen: () => boolean;
  }) {
    this.media = opts.media;
    this.rtc = opts.rtc;
    this.recorder = opts.recorder;
    this.compositor = opts.compositor;
    this.view = opts.view;
    this.toasts = opts.toasts;
    this.broadcastStatus = opts.broadcastStatus;
    this.getMe = opts.getMe;
    this.onReaction = opts.onReaction;
    this.onOpenAvatar = opts.onOpenAvatar;
    this.toggleDebug = opts.toggleDebug;
    this.isDebugOpen = opts.isDebugOpen;

    this.btnMic = document.getElementById('btn-mic') as HTMLButtonElement;
    this.btnCam = document.getElementById('btn-cam') as HTMLButtonElement;
    this.btnScreen = document.getElementById('btn-screen') as HTMLButtonElement;
    this.btnRec = document.getElementById('btn-rec') as HTMLButtonElement;
    this.btnReaction = document.getElementById('btn-reaction') as HTMLButtonElement;
    this.reactionMenu = document.getElementById('reaction-menu') as HTMLDivElement;
    this.btnMore = document.getElementById('btn-more') as HTMLButtonElement;
    this.moreMenu = document.getElementById('more-menu') as HTMLDivElement;
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
    this.setupLayoutControls();
  }

  // Wire the icon-only layout-mode buttons (🪟 自由 / ▦ グリッド / 🖥 プレゼン /
  // ▤ サイドバー). Like the zoom pill these live directly on the toolbar (labels
  // were too long for a button row, so they are icons with titles). Clicking one
  // switches the view's layout mode; the active button is highlighted. The view
  // also drops back to 'free' when the user drags a window, so we re-highlight on
  // its change callback too.
  private setupLayoutControls() {
    const buttons = Array.from(
      document.querySelectorAll<HTMLButtonElement>('.layout-group > button[data-mode]'),
    );
    const refresh = () => {
      const active = this.view.getLayoutMode();
      for (const btn of buttons) {
        btn.classList.toggle('active', btn.dataset.mode === active);
      }
    };
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        this.view.setLayoutMode(btn.dataset.mode as LayoutMode);
        refresh();
      });
    }
    this.view.setOnLayoutModeChange(refresh);
    refresh();
  }

  refresh() {
    this.btnMic.classList.toggle('active', this.media.micOn);
    this.btnMic.textContent = this.media.micOn ? t('toolbar.micOn') : t('toolbar.mic');
    this.btnCam.classList.toggle('active', this.media.camOn);
    this.btnCam.textContent = this.media.camOn ? t('toolbar.camOn') : t('toolbar.cam');
    this.btnScreen.classList.toggle('active', this.media.screenOn);
    this.btnScreen.textContent = this.media.screenOn ? t('toolbar.screenOn') : t('toolbar.screen');
    this.btnRec.classList.toggle('recording', this.recorder.recording);
    this.btnRec.textContent = this.recorder.recording ? t('toolbar.recOn') : t('toolbar.rec');
  }

  // ---- Mic/cam enable & disable flows (shared by toolbar and device switch) ----
  private async startMic() {
    try {
      const stream = await this.media.enableMic();
      this.rtc.addLocalStream(stream, 'mic');
      this.view.setLocalMicStream(stream);
      // Enabling the mic mid-recording must fold our own voice into the mix
      // (addAudioStream no-ops when not recording).
      this.recorder.addAudioStream(stream);
    } catch (e) {
      this.toasts.error(t('toolbar.errMic', { msg: (e as Error).message }));
    }
  }
  private stopMic() {
    const old = this.media.disableMic();
    if (old) {
      this.rtc.removeLocalStream(old);
      this.recorder.removeAudioStream(old.id);
    }
    this.view.setLocalMicStream(null);
  }
  private async startCam() {
    try {
      const stream = await this.media.enableCam();
      this.rtc.addLocalStream(stream, 'cam');
    } catch (e) {
      this.toasts.error(t('toolbar.errCam', { msg: (e as Error).message }));
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
        this.toasts.error(t('toolbar.errScreen', { msg: (e as Error).message }));
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
    this.view.removeScreenshare(me?.userId ?? '');
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

  // ============= Device menus + "more" overflow =============
  // Mic caret → device list. Cam caret → device list + virtual-background
  // section. "⋯" → window-layout modes + debug. All three share one outside-click
  // handler and a single closeMenus(), mirroring the old toolbar behaviour.
  private setupDeviceMenus() {
    const micMenu = document.getElementById('mic-menu') as HTMLDivElement;
    const camMenu = document.getElementById('cam-menu') as HTMLDivElement;
    const btnMicDevices = document.getElementById('btn-mic-devices') as HTMLButtonElement;
    const btnCamDevices = document.getElementById('btn-cam-devices') as HTMLButtonElement;

    const closeMenus = () => {
      micMenu.classList.add('hidden');
      camMenu.classList.add('hidden');
      this.reactionMenu.classList.add('hidden');
      this.moreMenu.classList.add('hidden');
    };
    // No stopPropagation on the toggles below: the click bubbles to document so
    // the roster's status menu (a separate outside-click handler) also closes,
    // and vice-versa — keeping the two menu groups mutually exclusive. Each
    // handler is guarded by "t !== its own button", so a toggle never closes
    // the menu it just opened.
    document.addEventListener('click', (e) => {
      const t = e.target as Node;
      if (
        !micMenu.contains(t) &&
        t !== btnMicDevices &&
        !camMenu.contains(t) &&
        t !== btnCamDevices &&
        !this.reactionMenu.contains(t) &&
        t !== this.btnReaction &&
        !this.moreMenu.contains(t) &&
        t !== this.btnMore
      ) {
        closeMenus();
      }
    });

    btnMicDevices.addEventListener('click', async () => {
      const open = micMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        await this.populateDeviceMenu(
          micMenu,
          await this.media.listMics(),
          this.media.selectedMicId,
          (id) => this.switchMic(id),
        );
        micMenu.classList.remove('hidden');
      }
    });
    btnCamDevices.addEventListener('click', async () => {
      const open = camMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        await this.populateCamMenu(camMenu);
        camMenu.classList.remove('hidden');
      }
    });

    this.btnReaction.addEventListener('click', () => {
      const open = this.reactionMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        this.populateReactionMenu(this.reactionMenu);
        this.reactionMenu.classList.remove('hidden');
      }
    });

    this.btnMore.addEventListener('click', () => {
      const open = this.moreMenu.classList.contains('hidden');
      closeMenus();
      if (open) {
        this.populateMoreMenu(this.moreMenu);
        this.moreMenu.classList.remove('hidden');
      }
    });
  }

  // The 😀 reaction menu: one button per whitelisted emoji. Clicking sends the
  // reaction (App debounces) and closes the menu. The number-key hint matches
  // the 1–6 shortcuts wired in App.
  private populateReactionMenu(menu: HTMLDivElement) {
    menu.replaceChildren();
    REACTION_EMOJIS.forEach((emoji, i) => {
      const item = document.createElement('button');
      item.className = 'reaction-item';
      item.title = t('toolbar.reaction', { n: i + 1 });
      item.textContent = emoji;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        this.onReaction(emoji);
      });
      menu.appendChild(item);
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
      empty.textContent = t('toolbar.noDevices');
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
      item.textContent = (isSelected ? '✓ ' : '') + (d.label || t('toolbar.device', { n: i + 1 }));
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        onPick(d.deviceId);
      });
      menu.appendChild(item);
    });
  }

  // The cam caret menu: camera device list, then a labelled virtual-background
  // section (off / blur / presets / custom / upload). Background lives here
  // since it's a camera setting — its standalone toolbar button was removed.
  private async populateCamMenu(menu: HTMLDivElement) {
    await this.populateDeviceMenu(
      menu,
      await this.media.listCams(),
      this.media.selectedCamId,
      (id) => this.switchCam(id),
    );

    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    menu.appendChild(sep);
    const label = document.createElement('div');
    label.className = 'menu-label';
    label.textContent = t('toolbar.bg');
    menu.appendChild(label);

    const current = this.media.bgChoice;
    const addBg = (text: string, onPick: () => void, selectedId?: string) => {
      const item = document.createElement('button');
      item.className = 'device-item';
      const isSelected = selectedId !== undefined && selectedId === current;
      if (isSelected) item.classList.add('selected');
      item.textContent = (isSelected ? '✓ ' : '') + text;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        onPick();
      });
      menu.appendChild(item);
    };

    addBg(t('toolbar.bgOff'), () => void this.setBackground(VBG_OFF), VBG_OFF);
    addBg(t('toolbar.bgBlur'), () => void this.setBackground(VBG_BLUR), VBG_BLUR);
    for (const preset of BG_PRESETS) {
      addBg(preset.label, () => void this.setBackground(preset.id), preset.id);
    }
    if (this.media.customBgDataUrl) {
      addBg(t('toolbar.bgCustom'), () => void this.setBackground(VBG_CUSTOM), VBG_CUSTOM);
    }
    addBg(t('toolbar.bgUpload'), () => this.bgFileInput.click());
  }

  // The "⋯" overflow menu: low-frequency actions. アバター編集（in-room の
  // キャラメイク再オープン）と、🐛 RTC デバッグコンソールのトグル（issue #113）。
  // Labels reflect current state since the menu re-populates on each open.
  // (Window-layout modes moved out to the always-visible icon pill on the
  // toolbar — see setupLayoutControls.)
  private populateMoreMenu(menu: HTMLDivElement) {
    menu.replaceChildren();
    const addItem = (text: string, onClick: () => void) => {
      const item = document.createElement('button');
      item.className = 'device-item';
      item.textContent = text;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.classList.add('hidden');
        onClick();
      });
      menu.appendChild(item);
    };
    addItem(t('toolbar.editAvatar'), () => this.onOpenAvatar());
    addItem(this.isDebugOpen() ? t('toolbar.closeDebug') : t('toolbar.openDebug'), () =>
      this.toggleDebug(),
    );
    // Language switch (issue #172): label shows the language you'd switch TO;
    // setLang persists the choice and reloads.
    const other: Lang = getLang() === 'ja' ? 'en' : 'ja';
    addItem(other === 'ja' ? '🌐 日本語' : '🌐 English', () => setLang(other));
  }

  private async switchMic(deviceId: string) {
    if (this.media.selectedMicId === deviceId) return;
    this.media.selectedMicId = deviceId;
    if (!this.media.micOn) return;
    await this.reacquire('mic');
    this.broadcastStatus();
  }

  private async switchCam(deviceId: string) {
    if (this.media.selectedCamId === deviceId) return;
    this.media.selectedCamId = deviceId;
    if (!this.media.camOn) return;
    await this.reacquire('cam');
    this.broadcastStatus();
  }

  // Re-acquire mic/cam from the currently-selected device (or the new background
  // mode) and swap the live RTC track in place via replaceLocalStream, rather
  // than removeLocalStream + addLocalStream. The remove+add path made the SFU
  // republish the same trackName on a new transceiver (peers pulled the stale,
  // black track) and the mesh renegotiate twice — both blacked the remote out
  // (#148). On acquisition failure we fall back to dropping the dead stream.
  private async reacquire(kind: 'mic' | 'cam') {
    const old = kind === 'mic' ? this.media.micStream : this.media.camStream;
    if (kind === 'mic') this.media.disableMic();
    else this.media.disableCam();
    try {
      const stream = kind === 'mic' ? await this.media.enableMic() : await this.media.enableCam();
      if (old) this.rtc.replaceLocalStream(old, stream, kind);
      else this.rtc.addLocalStream(stream, kind);
      if (kind === 'mic') {
        this.view.setLocalMicStream(stream);
        // Keep the recording mix on the new device: drop the old stream's source
        // (stopped by disableMic above, so it would otherwise sit silent in the
        // mix) and fold in the new one.
        if (old) this.recorder.removeAudioStream(old.id);
        this.recorder.addAudioStream(stream);
      }
    } catch (e) {
      if (old) this.rtc.removeLocalStream(old);
      if (kind === 'mic') this.view.setLocalMicStream(null);
      this.toasts.error(
        t(kind === 'mic' ? 'toolbar.errMic' : 'toolbar.errCam', { msg: (e as Error).message }),
      );
    }
  }

  // ============= Virtual background =============
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
    // like a device switch (replaceTrack in place — no remote blackout, #148).
    await this.reacquire('cam');
    this.broadcastStatus();
  }

  private async onBgFile(file: File) {
    try {
      const dataUrl = await fileToDownscaledDataUrl(file);
      await this.media.setCustomBgImage(dataUrl);
      this.persistBgSettings();
      await this.setBackground(VBG_CUSTOM);
    } catch (e) {
      this.toasts.error(t('toolbar.errImage', { msg: (e as Error).message }));
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
