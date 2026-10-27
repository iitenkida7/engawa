import { t } from '@/core/i18n';
import {
  applyPanelGeometry,
  clampFilmstripWidth,
  clampMeetingSplit,
  computeFilmstripColumns,
  computeFocusLayout,
  computeGridLayout,
  computeMeetingGallery,
  computeMeetingPresentation,
  computeMinimizedSidebar,
  computePresentationLayout,
  computeSidebarLayout,
  type LayoutItem,
  type LayoutMode,
  MEETING_FILMSTRIP_MAX_VISIBLE_ROWS,
  MEETING_FILMSTRIP_SEP,
  MEETING_FILMSTRIP_TILE_W,
  MEETING_SPLIT_DEFAULT,
  MINIMIZED_SIDEBAR_MAX_VISIBLE,
  meetingFilmstripColWidth,
  minimizedSidebarWidth,
  PANEL_BOTTOM_RESERVED,
  type PanelGeometry,
} from '@/ui/panels';

// A laid-out window: the element to move, its layout item, and a key that
// identifies it across re-flows ('cam:<id>' / 'screen:<id>' / 'self').
export type LayoutPanel = { el: HTMLElement; item: LayoutItem; key: string };

// Meeting order: screenshares first (the featured one leads), then YOUR camera,
// then everyone else. collectPanels() lists your own tile last, so its cell used
// to slide around as people joined and left — in the gallery it kept moving down
// and across the grid, in the filmstrip it fell off the bottom of a big meeting.
// Putting it right after the shares gives it one fixed slot (gallery: top-left;
// presentation: top of the rail) and keeps it inside the visible set.
export function pinSelfFirst<T extends { key: string; item: { aspectLocked: boolean } }>(
  panels: T[],
): T[] {
  const shares = panels.filter((p) => !p.item.aspectLocked);
  const cams = panels.filter((p) => p.item.aspectLocked);
  const self = cams.filter((p) => p.key === 'self');
  const others = cams.filter((p) => p.key !== 'self');
  return [...shares, ...self, ...others];
}

// Chevron used by the filmstrip show-more button; rotated 180° (via the
// `.expanded` class) for the fold-back direction, so up and down are the exact
// same shape mirrored — not two differently-drawn text glyphs.
const CHEVRON_SVG = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 8l5 5 5-5" /></svg>';

// Icons for the meeting minimize/restore toggle: a windowed-screen glyph for
// "show the map" and outward corners for "back to the full-screen meeting".
const MAP_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18" /></svg>';
const EXPAND_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5" /><path d="M20 9V4h-5" /><path d="M4 15v5h5" /><path d="M20 15v5h-5" /></svg>';

// The maximize (⤢) button that sits at the right end of every panel header.
// Clicks are caught by one delegated handler on #app, so the button carries no
// listener of its own and needs no cleanup when its panel is removed.
export function createFocusButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'panel-focus-btn';
  btn.type = 'button';
  btn.textContent = '⤢';
  btn.title = t('media.focus');
  return btn;
}

// Arranges the media windows RemoteMediaView owns: the layout modes, the
// maximized window, and the immersive meeting view with its filmstrip, pinned
// split and seam handles. It never creates or removes panels — it asks for the
// current set via `collectPanels` on every reflow and only positions them.
export class MediaLayout {
  private collectPanels: () => LayoutPanel[];
  // Runs at the top of every reflow, whoever triggered it (the face window
  // re-syncs there, issue #318).
  private beforeReflow: () => void;

  // The active window-layout mode. 'sidebar' (default) stacks cameras in a
  // compact side column so approaching someone doesn't slam two full-screen
  // previews up; a screenshare auto-switches to 'presentation' and reverts to
  // 'sidebar' when the last share stops (issue #175). Every mode auto-arranges
  // and re-flows on viewport/membership/screenshare changes — no manual placement.
  private layoutMode: LayoutMode = 'sidebar';
  // Fired whenever layoutMode changes (toolbar selection OR the screenshare
  // auto-switch) so the toolbar can re-highlight the active layout button.
  private onLayoutModeChange: ((mode: LayoutMode) => void) | null = null;
  // Fired from reflow with the current count of laid-out windows, so the
  // toolbar can hide the grid/sidebar toggle when there is nothing to arrange
  // (no camera tiles, screenshares or self-preview) — the toggle only does
  // anything with ≥1 window, so showing it while idle just reads as "broken".
  private onPanelsChange: ((count: number) => void) | null = null;

  // The maximized window's panel key ('cam:<id>' / 'screen:<id>' / 'self'), or
  // null when nothing is maximized. An override on top of layoutMode rather than
  // a mode of its own, so clearing it drops straight back to the active mode.
  private focusedKey: string | null = null;

  // Immersive meeting mode (issue #263): on only while the local user stands in a
  // zone — room, booth or café (the App drives it via setMeetingMode). When on, the media
  // windows fill the screen edge-to-edge over a black backdrop (Gather-style)
  // instead of floating over the 2D map. Orthogonal to layoutMode — it overrides
  // the arrangement while active and restores the floating layout when it clears.
  private meetingMode = false;
  // Whether the camera filmstrip (presentation mode) shows everyone or just the
  // collapsed set. Toggled by the ⬇️ button; reset when meeting mode ends.
  private filmstripExpanded = false;
  // Filmstrip column width (px) in presentation mode, dragged via the seam
  // handle (#288). Per-meeting only: not persisted, reset when the meeting ends.
  private filmstripWidth = MEETING_FILMSTRIP_TILE_W;
  // The window pinned under the featured share (presentation mode): clicking a
  // filmstrip tile moves it here, splitting the main area top (share) / bottom
  // (pinned). `meetingSplit` is the top pane's height fraction, dragged via the
  // horizontal seam. Both per-meeting only, reset when the meeting ends.
  private meetingPinnedKey: string | null = null;
  private meetingSplit = MEETING_SPLIT_DEFAULT;
  // Minimized: in a meeting zone but temporarily dropped back to floating tiles
  // so the map (and the way out of the room) is reachable. Reset on leaving.
  private meetingMinimized = false;
  // Whether the minimize/restore control is currently offered (i.e. we're in a
  // meeting). Gates the keyboard shortcut — see toggleMeetingView.
  private meetingControlsVisible = false;
  private appEl: HTMLElement;
  private filmstripToggleEl: HTMLButtonElement;
  private filmstripResizerEl: HTMLDivElement;
  private splitResizerEl: HTMLDivElement;
  private meetingMinimizeEl: HTMLButtonElement;

  constructor(opts: {
    appEl: HTMLElement;
    // Parent of every panel; hosts the delegated maximize / pin click handler.
    stageLayerEl: HTMLElement;
    collectPanels: () => LayoutPanel[];
    beforeReflow: () => void;
  }) {
    this.appEl = opts.appEl;
    this.collectPanels = opts.collectPanels;
    this.beforeReflow = opts.beforeReflow;
    this.filmstripToggleEl = document.getElementById('filmstrip-toggle') as HTMLButtonElement;
    this.filmstripToggleEl.innerHTML = CHEVRON_SVG;
    this.filmstripToggleEl.addEventListener('click', () => {
      this.filmstripExpanded = !this.filmstripExpanded;
      this.reflow();
    });
    this.filmstripResizerEl = document.getElementById('filmstrip-resizer') as HTMLDivElement;
    this.filmstripResizerEl.title = t('media.filmstripResize');
    this.bindFilmstripResizer();
    // Built here rather than in index.html: it only ever exists alongside the
    // meeting presentation layout this class owns.
    this.splitResizerEl = document.createElement('div');
    this.splitResizerEl.id = 'meeting-split-resizer';
    this.splitResizerEl.style.display = 'none';
    this.splitResizerEl.title = t('media.filmstripResize');
    this.appEl.appendChild(this.splitResizerEl);
    this.bindSplitResizer();
    this.meetingMinimizeEl = document.getElementById('meeting-minimize') as HTMLButtonElement;
    this.meetingMinimizeEl.addEventListener('click', () => this.toggleMeetingView());

    // One delegated click handler for every maximize button: panels come and go
    // constantly (peers, shares), and #app outlives all of them, so delegation
    // keeps this free of per-panel listener bookkeeping.
    // The same handler pins a meeting filmstrip tile under the share (or unpins
    // the pinned one) on a plain click. Only the first click of a double-click
    // counts, so double-clicking a share to make it main doesn't pin-then-unpin.
    opts.stageLayerEl.addEventListener('click', (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest?.('.panel-focus-btn');
      if (btn) {
        const key = btn.closest<HTMLElement>('.panel')?.dataset.focusKey;
        if (key) this.toggleFocus(key);
        return;
      }
      // The per-person volume control lives in the tile header: dragging its
      // slider ends in a click, which must not also pin / unpin the tile (that
      // resized the windows every time the volume was touched).
      if (target?.closest?.('.vol')) return;
      if (e.detail > 1) return;
      const panel = target?.closest?.<HTMLElement>(
        '.panel.meeting-pinnable, .panel.meeting-pinned',
      );
      const key = panel?.dataset.focusKey;
      if (key) this.togglePin(key);
    });
    // Esc is the universal way out of a maximized window — without it a user who
    // maximized the only window has no visible way back but the same button.
    // Skipped while typing: Esc cancels an IME conversion or clears a field, and
    // collapsing the view mid-sentence is not what the user asked for (same
    // guard as world/input.ts and App.handleReactionKey).
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !this.focusedKey || e.isComposing) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)
      ) {
        return;
      }
      // Claimed: one Esc un-maximizes; it must not also leave the meeting view
      // (the App's Esc-to-map shortcut runs after us on window and checks this).
      e.preventDefault();
      this.clearFocus();
    });
    // Re-flow the active layout when the viewport changes so the fixed
    // arrangement keeps fitting the new size (issue #175).
    window.addEventListener('resize', () => this.reflow());
  }

  // The active layout mode. The toolbar reads this to mark the current mode in
  // its menu.
  getLayoutMode(): LayoutMode {
    return this.layoutMode;
  }

  isMeetingMode(): boolean {
    return this.meetingMode;
  }

  // Registers a callback fired whenever the layout mode changes (used by the
  // toolbar to keep its active-mode highlight in sync).
  setOnLayoutModeChange(cb: (mode: LayoutMode) => void) {
    this.onLayoutModeChange = cb;
  }

  // Registers a callback fired from reflow with the current window count,
  // so the toolbar can show the layout toggle only when there is something to
  // arrange. Invoked immediately with the current count.
  setOnPanelsChange(cb: (count: number) => void) {
    this.onPanelsChange = cb;
    cb(this.collectPanels().length);
  }

  // Switches the window-layout mode (toolbar grid/sidebar buttons) and re-flows.
  // The chosen mode sticks and re-flows on viewport/membership/screenshare
  // changes; a screenshare then temporarily forces the presentation view.
  setLayoutMode(mode: LayoutMode) {
    // Picking a layout is an explicit "show me everything again", so it also
    // leaves the maximized view (which would otherwise hide the new layout).
    this.focusedKey = null;
    if (this.layoutMode !== mode) {
      this.layoutMode = mode;
      this.onLayoutModeChange?.(mode);
    }
    this.reflow();
  }

  // Flips the meeting flag WITHOUT re-flowing (the caller refreshes the self
  // preview, which depends on it, then re-flows). Leaving resets the filmstrip
  // to collapsed so the next meeting starts tidy. Returns whether it changed.
  setMeetingMode(on: boolean): boolean {
    if (this.meetingMode === on) return false;
    this.meetingMode = on;
    if (!on) {
      this.filmstripExpanded = false;
      this.meetingMinimized = false;
      this.filmstripWidth = MEETING_FILMSTRIP_TILE_W;
      this.meetingPinnedKey = null;
      this.meetingSplit = MEETING_SPLIT_DEFAULT;
    }
    return true;
  }

  // Sets the mode + notifies the toolbar highlight, WITHOUT re-flowing — used by
  // the screenshare auto-switch, whose caller re-flows once afterwards.
  setLayoutModeSilently(mode: LayoutMode) {
    if (this.layoutMode === mode) return;
    this.layoutMode = mode;
    this.onLayoutModeChange?.(mode);
  }

  // Drops the maximized window without re-flowing (the caller re-flows).
  dropFocus() {
    this.focusedKey = null;
  }

  // Re-lays every visible window according to the active mode. Called on
  // viewport resize and whenever the set of windows changes (peer join/leave,
  // screenshare start/stop) so the fixed arrangement stays tidy.
  reflow() {
    this.beforeReflow();
    const panels = this.collectPanels();
    // Drop a focus whose window is gone (peer left, camera off, share stopped)
    // so the layout can never be stranded on a panel that no longer exists.
    if (this.focusedKey && !panels.some((p) => p.key === this.focusedKey)) this.focusedKey = null;
    // Tell the toolbar how many windows there are (even when zero) so it can
    // show/hide the layout toggle as media comes and goes.
    this.onPanelsChange?.(panels.length);
    // Black immersive backdrop only while actually in a meeting WITH something to
    // show — never a blank black screen when alone with no media. Minimizing
    // keeps you in the meeting (media-wise) but drops to floating tiles so the
    // map is reachable; the minimize toggle shows whenever we're in a meeting.
    const inMeeting = this.meetingMode && panels.length > 0;
    const meetingActive = inMeeting && !this.meetingMinimized;
    this.appEl.classList.toggle('meeting', meetingActive);
    this.updateMeetingControls(inMeeting);
    if (!meetingActive) this.hideFilmstripToggle();
    // The seam handle only exists in the meeting presentation layout; every other
    // branch below hides it, and layoutMeeting re-shows it when it applies.
    this.hideFilmstripResizer();
    this.splitResizerEl.style.display = 'none';
    if (panels.length === 0) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    const focusIdx = this.focusedKey ? panels.findIndex((p) => p.key === this.focusedKey) : -1;
    if (focusIdx !== -1) {
      // Maximized: the chosen window takes the whole usable area (the toolbar
      // strip stays clear so there is always a way out) and the rest are hidden.
      panels.forEach((p, i) => {
        p.el.classList.toggle('focus-hidden', i !== focusIdx);
        p.el.classList.toggle('focused', i === focusIdx);
      });
      applyPanelGeometry(panels[focusIdx].el, computeFocusLayout(panels[focusIdx].item, vw, vh));
      this.syncFocusButtons(panels, focusIdx);
      return;
    }

    for (const p of panels) {
      p.el.classList.remove(
        'focus-hidden',
        'focused',
        'meeting-hidden',
        'layout-hidden',
        'meeting-pinnable',
        'meeting-pinned',
        'meeting-main',
      );
    }
    if (meetingActive) {
      this.layoutMeeting(panels, vw, vh);
      this.syncFocusButtons(panels, -1);
      return;
    }
    // Alone with just your own camera (no call, no meeting): keep it a small
    // corner preview so the map stays usable, instead of blowing it up to fill
    // the one-tile grid (which hid the map, trapping you watching yourself).
    if (panels.length === 1 && panels[0].key === 'self') {
      this.layoutSelfCorner(panels[0].el);
      this.syncFocusButtons(panels, -1);
      return;
    }
    // A minimized meeting shows the tiles in the right-hand sidebar column so the
    // map stays fully visible (you can see where to walk), capped at a readable
    // few with a chevron for the rest — regardless of the ordinary-call layout.
    if (inMeeting && this.meetingMinimized) {
      this.layoutMinimizedSidebar(panels, vw, vh);
      this.syncFocusButtons(panels, -1);
      return;
    }
    const items = panels.map((p) => p.item);
    const geos =
      this.layoutMode === 'presentation'
        ? computePresentationLayout(items, vw, vh)
        : this.layoutMode === 'sidebar'
          ? computeSidebarLayout(items, vw, vh)
          : computeGridLayout(items, vw, vh);
    panels.forEach((p, i) => {
      applyPanelGeometry(p.el, geos[i]);
    });
    this.syncFocusButtons(panels, -1);
  }

  // Right-hand sidebar for a minimized meeting: fixed-size tiles (the 6-person
  // size as the floor), at most MAX_VISIBLE shown with a chevron for the rest.
  // Expanding falls back to the normal divide-to-fit sidebar so everyone fits.
  private layoutMinimizedSidebar(panels: LayoutPanel[], vw: number, vh: number) {
    const needToggle = panels.length > MINIMIZED_SIDEBAR_MAX_VISIBLE;
    const visibleCount = this.filmstripExpanded
      ? panels.length
      : Math.min(MINIMIZED_SIDEBAR_MAX_VISIBLE, panels.length);
    const visible = panels.slice(0, visibleCount);
    for (const p of panels.slice(visibleCount)) p.el.classList.add('layout-hidden');
    const items = visible.map((p) => p.item);
    const geos = this.filmstripExpanded
      ? computeSidebarLayout(items, vw, vh)
      : computeMinimizedSidebar(items, vw, vh);
    visible.forEach((p, i) => {
      applyPanelGeometry(p.el, geos[i]);
    });
    if (needToggle) this.placeToggle(vw - minimizedSidebarWidth(vw) / 2, vh);
    else this.hideFilmstripToggle();
  }

  // Lays out the immersive meeting view (issue #263). With a screenshare: the
  // featured share fills the main area and the cameras ride a LEFT filmstrip,
  // collapsed to however many keep a readable height (⬇️ reveals the rest). With
  // no share: a full-bleed gallery grid of everyone.
  private layoutMeeting(unordered: LayoutPanel[], vw: number, vh: number) {
    const panels = pinSelfFirst(unordered);
    const mainIdx = panels.findIndex((p) => !p.item.aspectLocked);
    // A pin whose window is gone (peer left, share stopped, or it became the
    // main share) is dropped, so the split never lingers with an empty pane.
    const pinnedIdx = panels.findIndex((p, i) => i !== mainIdx && p.key === this.meetingPinnedKey);
    if (mainIdx === -1 || pinnedIdx === -1) this.meetingPinnedKey = null;
    if (mainIdx === -1) {
      // Gallery: no screenshare to feature — every window fills a grid cell.
      const geos = computeMeetingGallery(
        panels.map((p) => p.item),
        vw,
        vh,
      );
      panels.forEach((p, i) => {
        applyPanelGeometry(p.el, geos[i]);
      });
      this.hideFilmstripToggle();
      return;
    }
    // Presentation: main share + left filmstrip of everything else, trimmed to
    // the visible (collapsed/expanded) set so a big meeting doesn't stack 20
    // thumbnails down the edge.
    const stripIdxs = panels.map((_, i) => i).filter((i) => i !== mainIdx && i !== pinnedIdx);
    // Re-clamp every reflow so a viewport shrink pulls an over-wide rail back.
    // Done before the cap because the rail's width decides its column count,
    // and the cap is counted in rows (#304): five rows is ten faces in two.
    this.filmstripWidth = clampFilmstripWidth(this.filmstripWidth, vw);
    const cols = computeFilmstripColumns(this.filmstripWidth);
    const maxVisible = MEETING_FILMSTRIP_MAX_VISIBLE_ROWS * cols;
    const needToggle = stripIdxs.length > maxVisible;
    const visibleCount = this.filmstripExpanded
      ? stripIdxs.length
      : Math.min(maxVisible, stripIdxs.length);
    const visible = stripIdxs.slice(0, visibleCount);
    for (const i of stripIdxs.slice(visibleCount)) panels[i].el.classList.add('meeting-hidden');

    const pinned = pinnedIdx !== -1;
    const order = pinned ? [mainIdx, pinnedIdx, ...visible] : [mainIdx, ...visible];
    const geos = computeMeetingPresentation(
      order.map((i) => panels[i].item),
      vw,
      vh,
      this.filmstripWidth,
      pinned ? this.meetingSplit : null,
    );
    order.forEach((pi, k) => {
      applyPanelGeometry(panels[pi].el, geos[k]);
    });
    // Mark the featured share so the viewer-side zoom bar can show here too —
    // meeting mode has no ⤢ maximize, but the main share already fills the area
    // like a maximized view (screen-zoom.ts treats both as "big").
    panels[mainIdx].el.classList.add('meeting-main');
    for (const i of visible) panels[i].el.classList.add('meeting-pinnable');
    if (pinned) {
      panels[pinnedIdx].el.classList.add('meeting-pinned');
      this.placeSplitResizer(geos[0]);
    }

    const railW = meetingFilmstripColWidth(this.filmstripWidth);
    if (needToggle) this.placeToggle(railW / 2, vh);
    else this.hideFilmstripToggle();
    // Nothing to resize when the share is alone (no filmstrip rail).
    if (visible.length > 0) this.placeFilmstripResizer(railW, vh);
  }

  // Parks the drag handle on the seam between the filmstrip and the share (#288):
  // a thin full-height strip centered on the seam, above the tiles.
  private placeFilmstripResizer(railW: number, vh: number) {
    const el = this.filmstripResizerEl;
    el.style.display = 'block';
    el.style.left = `${Math.round(railW + MEETING_FILMSTRIP_SEP / 2)}px`;
    el.style.top = '0px';
    el.style.height = `${Math.max(1, vh - PANEL_BOTTOM_RESERVED)}px`;
  }

  // Display only: the `dragging` highlight is owned by the pointer handlers, since
  // every drag move re-flows (and so passes through here) mid-drag.
  private hideFilmstripResizer() {
    this.filmstripResizerEl.style.display = 'none';
  }

  // Drag the seam to change the filmstrip : share ratio (#288). Pointer capture
  // keeps the drag alive when the cursor outruns the thin handle; the width is
  // clamped per reflow. Double-click snaps back to the default width.
  private bindFilmstripResizer() {
    const el = this.filmstripResizerEl;
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      // (Feature-checked: the test DOM has PointerEvent but no capture API.)
      if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // The handle is centered on the seam, so the pointer x IS the rail width.
      this.filmstripWidth = clampFilmstripWidth(e.clientX, window.innerWidth);
      this.reflow();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => {
      this.filmstripWidth = MEETING_FILMSTRIP_TILE_W;
      this.reflow();
    });
  }

  // Pins a filmstrip window under the share, swaps the pin to another window,
  // or unpins (back to the filmstrip) when it is already the pinned one.
  private togglePin(key: string) {
    this.meetingPinnedKey = this.meetingPinnedKey === key ? null : key;
    this.reflow();
  }

  // Parks the horizontal drag handle on the seam under the share (top pane).
  private placeSplitResizer(top: PanelGeometry) {
    const el = this.splitResizerEl;
    el.style.display = 'block';
    el.style.left = `${top.left}px`;
    el.style.width = `${top.width}px`;
    el.style.top = `${Math.round(top.top + (top.height ?? 0) + MEETING_FILMSTRIP_SEP / 2)}px`;
  }

  // Drag the share / pinned seam to change the top : bottom ratio. Same
  // mechanics as the filmstrip seam; double-click snaps back to an even split.
  private bindSplitResizer() {
    const el = this.splitResizerEl;
    let dragging = false;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      if (typeof el.setPointerCapture === 'function') el.setPointerCapture(e.pointerId);
      el.classList.add('dragging');
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      // The meeting area starts at y=0, so the pointer y over its height IS the ratio.
      const areaH = Math.max(1, window.innerHeight - PANEL_BOTTOM_RESERVED);
      this.meetingSplit = clampMeetingSplit(e.clientY / areaH);
      this.reflow();
    });
    const end = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (typeof el.hasPointerCapture === 'function' && el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    el.addEventListener('dblclick', () => {
      this.meetingSplit = MEETING_SPLIT_DEFAULT;
      this.reflow();
    });
  }

  // Parks the show-more/less chevron, centered on `centerX` at the bottom of the
  // column (CSS translateX(-50%)): a large down chevron to reveal the rest, an up
  // chevron to fold back. Shared by the meeting filmstrip and the minimized
  // sidebar (which pass the left-column / right-column center respectively).
  private placeToggle(centerX: number, vh: number) {
    const btn = this.filmstripToggleEl;
    btn.style.display = 'flex';
    btn.style.left = `${Math.round(centerX)}px`;
    btn.style.top = `${vh - PANEL_BOTTOM_RESERVED - 46}px`;
    btn.classList.toggle('expanded', this.filmstripExpanded);
    btn.title = this.filmstripExpanded ? t('media.filmstripLess') : t('media.filmstripMore');
  }

  private hideFilmstripToggle() {
    this.filmstripToggleEl.style.display = 'none';
  }

  // Flip between the immersive meeting view and the map, driven by the top-left
  // button and by 'm' (issue #297). A no-op outside a meeting: the control is
  // hidden then, and flipping the flag anyway would leave the NEXT meeting
  // starting minimized (setMeetingMode only resets it on the way out).
  toggleMeetingView() {
    if (!this.meetingControlsVisible) return;
    this.meetingMinimized = !this.meetingMinimized;
    // Each view starts collapsed; don't carry the chevron state across.
    this.filmstripExpanded = false;
    this.reflow();
  }

  // Esc's one-way half of the toggle: leaves the immersive meeting view for the
  // map, and does nothing when already on the map or outside a meeting.
  showMapView() {
    if (this.meetingMinimized) return;
    this.toggleMeetingView();
  }

  // Shows the top-left minimize/restore toggle whenever we're in a meeting, and
  // labels it for the current state: "show map" (drop to floating tiles) while
  // immersive, "meeting view" (go back full-screen) while minimized.
  private updateMeetingControls(inMeeting: boolean) {
    const btn = this.meetingMinimizeEl;
    this.meetingControlsVisible = inMeeting;
    if (!inMeeting) {
      btn.style.display = 'none';
      return;
    }
    const icon = this.meetingMinimized ? EXPAND_ICON : MAP_ICON;
    const label = this.meetingMinimized ? t('media.backToMeeting') : t('media.showMap');
    btn.innerHTML = `${icon}<span>${label}</span>`;
    btn.title = label;
    btn.style.display = 'flex';
  }

  // Drops the self preview back to its small bottom-right CSS default by clearing
  // the inline geometry the auto-layout writes (used when it's the only window).
  private layoutSelfCorner(el: HTMLElement) {
    el.style.left = 'auto';
    el.style.top = 'auto';
    el.style.right = '';
    el.style.bottom = '';
    el.style.width = '';
    el.style.height = '';
  }

  // Marks the maximized window's button as active — the toolbar's "this is on"
  // accent, and the only affordance telling the user how to get back out. The
  // glyph stays ⤢: its mirrored twin ⤡ is another outward arrow, not a shrink.
  private syncFocusButtons(panels: Array<{ el: HTMLElement }>, focusIdx: number) {
    panels.forEach((p, i) => {
      const btn = p.el.querySelector<HTMLButtonElement>('.panel-focus-btn');
      if (!btn) return;
      const on = i === focusIdx;
      btn.classList.toggle('active', on);
      btn.title = on ? t('media.unfocus') : t('media.focus');
    });
  }

  // Maximizes a window, or restores the layout when it is already maximized.
  private toggleFocus(key: string) {
    this.focusedKey = this.focusedKey === key ? null : key;
    this.reflow();
  }

  // Leaves the maximized view and returns to the active layout mode.
  private clearFocus() {
    this.focusedKey = null;
    this.reflow();
  }
}
