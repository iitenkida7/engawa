import { getLang, type Lang, setLang, t } from '@/core/i18n';
import { REACTION_EMOJIS, type StreamKind } from '@/core/types';
import type { SceneCompositor } from '@/media/compositor';
import { type MediaManager, NOISE_STORAGE_KEY, parseNoiseSetting } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  BG_PRESETS,
  fileToDownscaledDataUrl,
  imagePresets,
  parseVbgChoice,
  serializeVbgChoice,
  VBG_BLUR,
  VBG_CUSTOM,
  VBG_IMAGE_STORAGE_KEY,
  VBG_OFF,
  VBG_STORAGE_KEY,
} from '@/media/vbg';
import {
  EXPERIMENTAL_STORAGE_KEY,
  isExperimentActive,
  parseExperimentalSetting,
} from '@/ui/experimental';
import { FACE_PIP_STORAGE_KEY, parseFacePipSetting } from '@/ui/face-pip';
import type { Toasts } from '@/ui/notify';
import type { LayoutMode } from '@/ui/panels';
import { PTT_STORAGE_KEY, parsePttSetting } from '@/ui/ptt';
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
  private onRecordingChange: (recording: boolean) => void;
  private onOpenAvatar: () => void;
  private onOpenShortcuts: () => void;
  private toggleDebug: () => void;
  private isDebugOpen: () => boolean;
  private onUserCamToggle: () => void;

  // Experimental features master switch (#323): persisted, off by default. The
  // per-feature toggles below only take effect while this is on.
  private experimentalEnabled = false;

  // Face window while sharing (issue #318): the persisted per-feature toggle
  // (default on, gated by experimentalEnabled), the once-per-session hint, and
  // the dismisser of the "open it" fallback toast.
  private facePipEnabled = true;
  private facePipHintShown = false;
  private facePipToastDismiss: (() => void) | null = null;

  // Push-to-talk: persisted toggle (default off) and whether the PTT key is
  // currently held.
  private pttEnabled = false;
  private pttHeld = false;

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
    // Fired after the user starts/stops their own recording, so the App can tell
    // the rest of the call (privacy notice). Passes the new recording state.
    onRecordingChange: (recording: boolean) => void;
    onOpenAvatar: () => void;
    onOpenShortcuts: () => void;
    toggleDebug: () => void;
    isDebugOpen: () => boolean;
    // Fired on a MANUAL camera-button toggle (not setCamEnabled), so the App's
    // bandwidth automation (#185) can stand down when the user takes over.
    onUserCamToggle: () => void;
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
    this.onRecordingChange = opts.onRecordingChange;
    this.onOpenAvatar = opts.onOpenAvatar;
    this.onOpenShortcuts = opts.onOpenShortcuts;
    this.toggleDebug = opts.toggleDebug;
    this.isDebugOpen = opts.isDebugOpen;
    this.onUserCamToggle = opts.onUserCamToggle;

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
    // A mic/cam that died on its own (unplugged, Bluetooth dropped — #200) gets
    // the same teardown as the OFF button, so neither we nor peers keep showing
    // a live-but-silent device, and the user learns why it switched off.
    this.media.onDeviceEnded((kind, old) => {
      if (kind === 'mic') this.afterMicStopped(old);
      else this.rtc.removeLocalStream(old);
      this.broadcastStatus();
      this.toasts.error(t(kind === 'mic' ? 'toolbar.micLost' : 'toolbar.camLost'));
    });

    this.loadBgSettings();
    this.loadNoiseSetting();
    this.loadExperimentalSetting();
    this.loadFacePipSetting();
    this.loadPttSetting();
    this.setup();
    this.refresh();
  }

  private setup() {
    this.btnMic.addEventListener('click', () => this.toggleMic());
    this.btnCam.addEventListener('click', () => this.toggleCam());
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

  // The four media toggles, public so the keyboard shortcuts (issue #297) run
  // exactly what the buttons run — one path, no drift between mouse and key.
  async toggleMic() {
    // Flip the icon the instant it's clicked: enableMic() awaits getUserMedia,
    // which can take a beat (permission prompt, device spin-up), and the real
    // refresh only fires on the media event afterwards. The optimistic toggle
    // below is reconciled to the true state by refresh() at the end, so a
    // failed/denied acquisition reverts the icon on its own.
    const target = !this.media.micOn;
    this.setMicVisual(target);
    if (target) {
      await this.startMic();
    } else {
      this.stopMic();
    }
    this.refresh();
    this.broadcastStatus();
  }

  async toggleCam() {
    this.onUserCamToggle();
    const target = !this.media.camOn;
    this.setCamVisual(target);
    if (target) {
      await this.startCam();
    } else {
      this.stopCam();
    }
    this.refresh();
    this.broadcastStatus();
  }

  // Paint the mic/cam button for a given on/off state without touching any
  // device — used for the optimistic flip on click (reconciled by refresh()).
  private setMicVisual(on: boolean) {
    this.btnMic.classList.toggle('on', on);
    this.btnMic.classList.toggle('off', !on);
  }
  private setCamVisual(on: boolean) {
    this.btnCam.classList.toggle('on', on);
    this.btnCam.classList.toggle('off', !on);
  }

  // Wire the icon-only layout-mode buttons (▦ グリッド / ▤ サイドバー). They live
  // directly on the toolbar as icons with titles. Clicking one switches the
  // view's layout mode; the active button is highlighted. A screenshare
  // temporarily forces the presentation view (neither button highlighted), and
  // reverts to grid when it stops, so we re-highlight on the view's change
  // callback too (issue #175).
  private setupLayoutControls() {
    const group = document.querySelector<HTMLElement>('.layout-group');
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
    // Only show the grid/sidebar toggle when there are windows to arrange; with
    // no camera/screenshare/self-preview the toggle does nothing, so hiding it
    // keeps the toolbar honest (issue: the toggle read as "broken" while idle).
    this.view.setOnPanelsChange((count) => {
      group?.classList.toggle('hidden', count === 0);
    });
  }

  refresh() {
    // Mic/cam are icon-only toggles: green when on, red + strike when off.
    this.setMicVisual(this.media.micOn);
    // Push-to-talk: a live mic that is waiting for the key reads as dimmed.
    this.btnMic.classList.toggle('ptt-idle', this.media.micOn && !this.media.micTransmitting);
    this.setCamVisual(this.media.camOn);
    // Screen share goes blue (.active) while sharing; record goes red (.recording)
    // and swaps its dot for a stop square. Both are icon-only.
    this.btnScreen.classList.toggle('active', this.media.screenOn);
    this.btnRec.classList.toggle('recording', this.recorder.recording);
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
    if (old) this.afterMicStopped(old);
    else this.view.setLocalMicStream(null);
  }
  // Teardown after the mic stream has stopped (OFF button or device loss).
  private afterMicStopped(old: MediaStream) {
    this.rtc.removeLocalStream(old);
    this.recorder.removeAudioStream(old.id);
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

  // Programmatic camera toggle for the App's bandwidth automation (#185): the
  // exact same flow as the button (peers' tiles clear via stream-meta, status
  // broadcasts), minus the manual-toggle notification.
  async setCamEnabled(on: boolean) {
    if (on === this.media.camOn) return;
    if (on) await this.startCam();
    else this.stopCam();
    this.broadcastStatus();
  }

  // Turn off every local media capture at once (mic, cam, screen). Used when
  // stepping away (#220), which disconnects all calls — same teardown as the
  // individual buttons, then one status broadcast reflects the all-off state.
  disableAllMedia() {
    if (this.media.micOn) this.stopMic();
    if (this.media.camOn) this.stopCam();
    this.stopScreenShare();
    this.broadcastStatus();
  }

  // Programmatic screen-share stop: same teardown as the button / the OS
  // "stop sharing" bar.
  stopScreenShare() {
    if (!this.media.screenOn) return;
    const old = this.media.disableScreen();
    if (old) this.afterScreenStopped(old);
  }

  async toggleScreen() {
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
        await this.maybeOpenFacePip();
      } catch (e) {
        this.toasts.error(t('toolbar.errScreen', { msg: (e as Error).message }));
      }
    }
  }

  // Face window (issue #318): after the share starts, mirror the remote tiles
  // into an always-on-top window so a single-display sharer still sees faces.
  // Ordered AFTER getDisplayMedia on purpose: requestWindow() consumes the
  // click's user activation while getDisplayMedia only checks it, so the other
  // order could break the share itself. The cost is that a slow pick in the
  // share dialog can outlive the activation — then the window can't open
  // silently and a toast offers a button (a fresh gesture) instead.
  private async maybeOpenFacePip() {
    if (!this.facePipActive() || !this.view.facePipSupported()) return;
    if (await this.view.openFacePip()) {
      this.showFacePipHint();
      return;
    }
    this.facePipToastDismiss?.();
    this.facePipToastDismiss = this.toasts.action(
      t('toolbar.facePipRetry'),
      [
        {
          label: t('toolbar.facePipOpen'),
          primary: true,
          onClick: () => {
            this.facePipToastDismiss = null;
            // The share may have ended while the toast sat there.
            if (!this.media.screenOn) return;
            void this.view.openFacePip().then((ok) => {
              if (ok) this.showFacePipHint();
            });
          },
        },
      ],
      0,
    );
  }

  // Entire-screen shares capture the face window too (Chrome has no exclusion),
  // so say so once per session when the window first opens.
  private showFacePipHint() {
    if (this.facePipHintShown) return;
    this.facePipHintShown = true;
    this.toasts.info(t('toolbar.facePipHint'), 7000);
  }

  // The face window is in effect only when experiments are on AND its own
  // toggle is on (#323).
  private facePipActive(): boolean {
    return isExperimentActive(this.experimentalEnabled, this.facePipEnabled);
  }

  // The "⋯" menu toggle. Takes effect immediately on a running share: enabling
  // opens the window (the menu click is a user activation), disabling closes it.
  private toggleFacePip() {
    this.facePipEnabled = !this.facePipEnabled;
    this.persistFacePipSetting();
    this.applyFacePipNow();
  }

  // The experimental master switch (#323). Flipping it applies every experiment
  // at once; today that is the face window, so a running share opens / closes
  // it right away (the menu click is a user activation for the open).
  private toggleExperimental() {
    this.experimentalEnabled = !this.experimentalEnabled;
    this.persistExperimentalSetting();
    this.applyFacePipNow();
  }

  pttActive(): boolean {
    return this.pttEnabled;
  }

  // Key down/up of the PTT key (called by the App's keyboard handlers). Does
  // nothing unless PTT is active; the mic must already be on — PTT gates a live
  // mic rather than turning it on.
  setPttHeld(held: boolean) {
    this.pttHeld = held;
    this.applyPtt();
  }

  // Sync the media gate with the settings and key state: open when PTT is off
  // (normal mic) or the key is held, closed otherwise.
  private applyPtt() {
    this.media.setMicTransmit(!this.pttActive() || this.pttHeld);
    this.refresh();
  }

  private togglePtt() {
    this.pttEnabled = !this.pttEnabled;
    this.persistPttSetting();
    this.applyPtt();
  }

  private loadPttSetting() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(PTT_STORAGE_KEY);
    } catch {
      /* ignore private-mode storage errors */
    }
    this.pttEnabled = parsePttSetting(stored);
    this.applyPtt();
  }

  private persistPttSetting() {
    try {
      localStorage.setItem(PTT_STORAGE_KEY, this.pttEnabled ? '1' : '0');
    } catch {
      /* ignore private-mode storage errors */
    }
  }

  private applyFacePipNow() {
    if (!this.media.screenOn) return;
    if (this.facePipActive()) void this.maybeOpenFacePip();
    else this.closeFacePip();
  }

  private loadExperimentalSetting() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(EXPERIMENTAL_STORAGE_KEY);
    } catch {
      /* ignore private-mode storage errors */
    }
    this.experimentalEnabled = parseExperimentalSetting(stored);
  }

  private persistExperimentalSetting() {
    try {
      localStorage.setItem(EXPERIMENTAL_STORAGE_KEY, this.experimentalEnabled ? '1' : '0');
    } catch {
      /* ignore private-mode storage errors */
    }
  }

  private closeFacePip() {
    this.view.closeFacePip();
    this.facePipToastDismiss?.();
    this.facePipToastDismiss = null;
  }

  private loadFacePipSetting() {
    let stored: string | null = null;
    try {
      stored = localStorage.getItem(FACE_PIP_STORAGE_KEY);
    } catch {
      /* ignore private-mode storage errors */
    }
    this.facePipEnabled = parseFacePipSetting(stored);
  }

  private persistFacePipSetting() {
    try {
      localStorage.setItem(FACE_PIP_STORAGE_KEY, this.facePipEnabled ? '1' : '0');
    } catch {
      /* ignore private-mode storage errors */
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
    this.closeFacePip();
  }

  toggleRecord() {
    const wasRecording = this.recorder.recording;
    if (wasRecording) {
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
    // Notify the call when our recording state actually changed (start succeeded
    // or we stopped), so others get the privacy notice.
    if (this.recorder.recording !== wasRecording) {
      this.onRecordingChange(this.recorder.recording);
      // The file only exists once ■ Stop is pressed (recording is in-browser),
      // so say so up front (#315). Kept up longer than a plain info toast.
      if (this.recorder.recording) this.toasts.info(t('rec.selfStartedHint'), 10000);
    }
    this.refresh();
  }

  // Show/clear the "someone else in the call is recording" badge on the record
  // button, with their names in the tooltip (privacy). Independent of our own
  // recording state, so the button can show both at once.
  setOthersRecording(names: string[]) {
    const on = names.length > 0;
    this.btnRec.classList.toggle('others-recording', on);
    // Swap the tooltip to who's recording while the badge shows; restore the plain
    // "録画" label when it clears.
    this.btnRec.dataset.tip = on
      ? t('rec.othersTip', { names: names.join(', ') })
      : t('toolbar.recTitle');
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
        await this.populateMicMenu(micMenu);
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

  // The mic caret menu: microphone device list, then a separated noise-
  // suppression toggle (issue #180). Noise suppression lives here since it's a
  // mic setting — its standalone toolbar button was removed. The toggle shows a
  // ✓ when on; the setting is persisted and defaults to on.
  private async populateMicMenu(menu: HTMLDivElement) {
    await this.populateDeviceMenu(
      menu,
      await this.media.listMics(),
      this.media.selectedMicId,
      (id) => this.switchMic(id),
    );

    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    menu.appendChild(sep);

    const on = this.media.noiseSuppression;
    const item = document.createElement('button');
    item.className = 'device-item';
    if (on) item.classList.add('selected');
    item.textContent = (on ? '✓ ' : '') + t('toolbar.noise');
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      void this.toggleNoise();
    });
    menu.appendChild(item);
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
    // Bundled image backgrounds (#233): auto-listed from assets/backgrounds/.
    for (const preset of imagePresets()) {
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
    addItem(t('toolbar.shortcuts'), () => this.onOpenShortcuts());
    // Push-to-talk: while ticked, a live mic only transmits while Space is held.
    addItem((this.pttEnabled ? '✓ ' : '') + t('toolbar.ptt'), () => this.togglePtt());
    addItem(this.isDebugOpen() ? t('toolbar.closeDebug') : t('toolbar.openDebug'), () =>
      this.toggleDebug(),
    );
    // Language switch (issue #172): label shows the language you'd switch TO;
    // setLang persists the choice and reloads.
    const other: Lang = getLang() === 'ja' ? 'en' : 'ja';
    addItem(other === 'ja' ? '🌐 日本語' : '🌐 English', () => setLang(other));

    // 🧪 Experimental features (#323), two levels: a master switch (off by
    // default) and, once it is ticked, the per-feature toggles beneath it. A
    // feature is active only when both are on. Each feature is listed only
    // where the browser supports it, so the menu never offers a switch that
    // does nothing.
    const sep = document.createElement('div');
    sep.className = 'menu-separator';
    menu.appendChild(sep);
    addItem((this.experimentalEnabled ? '✓ ' : '') + t('toolbar.experimental'), () =>
      this.toggleExperimental(),
    );
    if (this.experimentalEnabled) {
      // Face window while sharing (#318): Document PiP, Chrome / Edge desktop only.
      if (this.view.facePipSupported()) {
        addItem(`　${this.facePipEnabled ? '✓ ' : ''}${t('toolbar.facePip')}`, () =>
          this.toggleFacePip(),
        );
      }
    }
  }

  private async switchMic(deviceId: string) {
    if (this.media.selectedMicId === deviceId) return;
    this.media.setSelectedDevice('mic', deviceId);
    if (!this.media.micOn) return;
    await this.reacquire('mic');
    this.broadcastStatus();
  }

  private async switchCam(deviceId: string) {
    if (this.media.selectedCamId === deviceId) return;
    this.media.setSelectedDevice('cam', deviceId);
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
      await this.media.ensureBgImage();
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

  // ============= Noise suppression =============
  // Toggle mic noise suppression (from the mic caret menu), persist it, and — if
  // the mic is live — re-acquire it so the RNNoise processor is inserted/removed
  // in place (same path as a device switch: replaceTrack, no remote blackout,
  // #148). The menu is closed by the click, so no button/menu refresh is needed;
  // the ✓ re-renders next time the menu opens.
  private async toggleNoise() {
    this.media.setNoiseSuppression(!this.media.noiseSuppression);
    this.persistNoiseSetting();
    if (this.media.micOn) await this.reacquire('mic');
  }

  // Restore the persisted choice on startup. Applied lazily: it takes effect the
  // next time the mic is enabled.
  private loadNoiseSetting() {
    this.media.setNoiseSuppression(parseNoiseSetting(localStorage.getItem(NOISE_STORAGE_KEY)));
  }

  private persistNoiseSetting() {
    try {
      localStorage.setItem(NOISE_STORAGE_KEY, this.media.noiseSuppression ? '1' : '0');
    } catch {
      /* ignore private-mode storage errors */
    }
  }
}
