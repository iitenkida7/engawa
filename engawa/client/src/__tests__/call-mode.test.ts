import { beforeEach, describe, expect, it } from 'bun:test';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  MEETING_FILMSTRIP_2COL_MIN_W,
  MEETING_FILMSTRIP_MIN_W,
  MEETING_FILMSTRIP_TILE_W,
  PANEL_BOTTOM_RESERVED,
} from '@/ui/panels';
import { RemoteMediaView } from '@/ui/remote-media';
import type { PlayerState } from '@/world/player';

// hasMediaWindows() drives the roster's call mode (collapse the list while the
// call tiles are up). The App polls it every frame, so it counts the members
// directly instead of building the panel list — these tests pin it to the set
// of windows the layout actually places (one .panel each).

const MY_ID = 'me';

function mountDom() {
  document.body.innerHTML = `
    <div id="app">
      <div id="remote-videos"></div>
      <button id="filmstrip-toggle" type="button" style="display: none"></button>
      <div id="filmstrip-resizer" style="display: none"></div>
      <button id="meeting-minimize" type="button" style="display: none"></button>
      <div id="self-preview" class="panel hidden">
        <div class="panel-header"><span class="label" id="self-preview-label"></span></div>
        <div class="panel-body"><video id="self-video"></video><div class="no-video" id="self-no-video"><span class="no-video-initials" id="self-no-video-initials"></span><span class="no-video-name" id="self-no-video-name"></span></div></div>
      </div>
    </div>`;
}

function player(userId: string, name: string): PlayerState {
  return { userId, name, initials: () => name.slice(0, 2).toUpperCase() } as unknown as PlayerState;
}

const players = new Map<string, PlayerState>();
const media = { micOn: true, camStream: null as MediaStream | null };

function setup() {
  mountDom();
  players.clear();
  players.set(MY_ID, player(MY_ID, 'Me'));
  media.camStream = null;
  const view = new RemoteMediaView({
    players,
    media: media as unknown as MediaManager,
    recorder: {
      recording: false,
      addAudioStream: () => {},
      removeAudioStream: () => {},
    } as unknown as RecorderManager,
    getMyId: () => MY_ID,
    onAutoplayBlocked: () => {},
    onAutoplayUnlocked: () => {},
  });
  view.refreshSelfPreview();
  return view;
}

function addCam(view: RemoteMediaView, userId: string) {
  players.set(userId, player(userId, userId));
  view.attachRemoteStream(userId, new MediaStream(), 'cam');
}

// The windows the layout lays out, as the DOM sees them.
const panelCount = () =>
  [...document.querySelectorAll<HTMLElement>('.panel')].filter(
    (p) => !p.classList.contains('hidden'),
  ).length;

describe('RemoteMediaView.hasMediaWindows', () => {
  let view: RemoteMediaView;

  beforeEach(() => {
    view = setup();
  });

  it('is false with nothing on screen', () => {
    expect(view.hasMediaWindows()).toBe(false);
    expect(panelCount()).toBe(0);
  });

  it('follows a remote camera tile appearing and going away', () => {
    addCam(view, 'a');
    expect(view.hasMediaWindows()).toBe(true);
    expect(panelCount()).toBe(1);
    view.removePeer('a');
    expect(view.hasMediaWindows()).toBe(false);
    expect(panelCount()).toBe(0);
  });

  it('follows a screenshare appearing and going away', () => {
    view.showScreenshare('c', new MediaStream());
    expect(view.hasMediaWindows()).toBe(true);
    view.removeScreenshare('c');
    expect(view.hasMediaWindows()).toBe(false);
  });

  it('counts our own preview, so turning on just our camera is a call', () => {
    media.camStream = new MediaStream();
    view.refreshSelfPreview();
    expect(view.hasMediaWindows()).toBe(true);
    expect(panelCount()).toBe(1);
    media.camStream = null;
    view.refreshSelfPreview();
    expect(view.hasMediaWindows()).toBe(false);
  });

  it('stays true while any one window remains', () => {
    addCam(view, 'a');
    view.showScreenshare('c', new MediaStream());
    view.removePeer('a');
    expect(view.hasMediaWindows()).toBe(true);
    view.removeScreenshare('c');
    expect(view.hasMediaWindows()).toBe(false);
  });
});

// Your own tile must show (camera on or off) whenever you're in a call or a
// meeting, so everyone — yourself included — is visible regardless of camera
// state (#263). Only when genuinely alone with the camera off does it hide.
describe('self tile visibility while the camera is off', () => {
  let view: RemoteMediaView;
  const selfHidden = () => document.getElementById('self-preview')!.classList.contains('hidden');
  const placeholderShown = () =>
    (document.getElementById('self-no-video') as HTMLElement).style.display !== 'none';

  beforeEach(() => {
    view = setup();
  });

  it('is hidden when alone with the camera off', () => {
    expect(selfHidden()).toBe(true);
  });

  it('shows a camera-off placeholder once in a meeting zone', () => {
    view.setMeetingMode(true);
    expect(selfHidden()).toBe(false);
    expect(placeholderShown()).toBe(true);
    view.setMeetingMode(false);
    expect(selfHidden()).toBe(true);
  });

  it('shows yourself alongside someone you walk up to (and hides again when they leave)', () => {
    players.set('a', player('a', 'A'));
    view.setConversationMembers(['a']);
    expect(selfHidden()).toBe(false);
    expect(placeholderShown()).toBe(true);
    view.setConversationMembers([]);
    expect(selfHidden()).toBe(true);
  });

  it('keeps a solo camera-on preview small in the corner, not filling the grid', () => {
    media.camStream = new MediaStream();
    view.refreshSelfPreview();
    const self = document.getElementById('self-preview') as HTMLElement;
    expect(selfHidden()).toBe(false);
    // No inline geometry from the auto-layout → it falls back to the small
    // bottom-right CSS default instead of being blown up to fill the viewport.
    expect(self.style.width).toBe('');
    expect(self.style.left).toBe('auto');
  });
});

// The immersive view is all black, so it must offer a way back to the map; the
// top-left minimize toggle drops to floating tiles (map reachable) while staying
// in the meeting, and resets on leaving the room.
describe('meeting minimize / restore', () => {
  let view: RemoteMediaView;
  const immersive = () => document.getElementById('app')!.classList.contains('meeting');
  const minimizeBtn = () => document.getElementById('meeting-minimize') as HTMLElement;
  const btnShown = () => minimizeBtn().style.display !== 'none';

  beforeEach(() => {
    view = setup();
    view.setMeetingMode(true);
  });

  it('shows the minimize toggle and goes immersive on entering a meeting', () => {
    expect(immersive()).toBe(true);
    expect(btnShown()).toBe(true);
  });

  it('minimizing drops to floating tiles but keeps the toggle to go back', () => {
    minimizeBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(immersive()).toBe(false);
    expect(btnShown()).toBe(true);
    // Back to immersive.
    minimizeBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(immersive()).toBe(true);
  });

  it('lays the tiles out in the right-hand sidebar when minimized', () => {
    addCam(view, 'a');
    minimizeBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const tile = document.querySelector<HTMLElement>('.panel[data-focus-key="cam:a"]')!;
    // Pinned to the right column (its left edge is past the viewport midpoint),
    // so the map stays visible on the left.
    expect(Number.parseFloat(tile.style.left)).toBeGreaterThan(window.innerWidth / 2);
  });

  it('caps the minimized sidebar at 5 tiles with a chevron, expandable to all', () => {
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) addCam(view, id);
    minimizeBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const laidOut = () =>
      [...document.querySelectorAll<HTMLElement>('.panel')].filter(
        (p) => !p.classList.contains('layout-hidden') && !p.classList.contains('hidden'),
      ).length;
    const chevron = document.getElementById('filmstrip-toggle') as HTMLElement;
    // 7 windows (6 cams + self) → only 5 shown, chevron offers the rest.
    expect(laidOut()).toBe(5);
    expect(chevron.style.display).not.toBe('none');
    // Expanding shows everyone.
    chevron.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(laidOut()).toBe(7);
  });

  it('resets minimize state and hides the toggle when leaving the room', () => {
    minimizeBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    view.setMeetingMode(false);
    expect(btnShown()).toBe(false);
    // Re-entering starts immersive again, not stuck minimized.
    view.setMeetingMode(true);
    expect(immersive()).toBe(true);
  });
});

// #288: in the meeting presentation layout (a featured share + the left camera
// filmstrip) the seam between them is a drag handle that changes the ratio.
describe('filmstrip / share seam resizer', () => {
  let view: RemoteMediaView;
  const resizer = () => document.getElementById('filmstrip-resizer') as HTMLElement;
  const shown = () => resizer().style.display !== 'none';
  const camTile = () => document.querySelector<HTMLElement>('.panel[data-focus-key="cam:a"]')!;
  const tileWidth = () => Number.parseFloat(camTile().style.width);
  const pointer = (type: string, clientX: number) =>
    resizer().dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientX }),
    );

  beforeEach(() => {
    view = setup();
    view.setMeetingMode(true);
    addCam(view, 'a');
  });

  it('is hidden in the gallery (no share) and shown once a share is featured', () => {
    expect(shown()).toBe(false);
    view.attachRemoteStream('b', new MediaStream(), 'screen');
    expect(shown()).toBe(true);
    // Sits on the seam: just right of the default-width column.
    expect(Number.parseFloat(resizer().style.left)).toBeGreaterThanOrEqual(
      MEETING_FILMSTRIP_TILE_W,
    );
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_TILE_W);
  });

  it('dragging the seam resizes the filmstrip tiles, clamped to the allowed range', () => {
    view.attachRemoteStream('b', new MediaStream(), 'screen');
    // A one-column rail (below the 2-column threshold) puts the whole width
    // into the tile.
    const oneCol = MEETING_FILMSTRIP_2COL_MIN_W - 50;
    pointer('pointerdown', MEETING_FILMSTRIP_TILE_W);
    pointer('pointermove', oneCol);
    expect(tileWidth()).toBe(oneCol);
    // Way past the cap → the rail clamps to half the viewport (the seam handle
    // sits at the rail edge; the tiles themselves may shrink to fit the rail
    // height). Way left → the minimum.
    pointer('pointermove', 100_000);
    const cap = Math.floor(window.innerWidth / 2);
    expect(Number.parseFloat(resizer().style.left)).toBeGreaterThanOrEqual(cap);
    expect(tileWidth()).toBeLessThanOrEqual(cap);
    pointer('pointermove', 1);
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_MIN_W);
    pointer('pointerup', 1);
    // After the drag ends, moves no longer resize.
    pointer('pointermove', oneCol);
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_MIN_W);
  });

  // #304: past the threshold the rail splits rather than growing one fat tile.
  it('splits the rail into two columns once dragged wide enough', () => {
    addCam(view, 'b');
    view.attachRemoteStream('c', new MediaStream(), 'screen');
    const tileB = () => document.querySelector<HTMLElement>('.panel[data-focus-key="cam:b"]')!;
    pointer('pointerdown', MEETING_FILMSTRIP_TILE_W);

    // Just under the threshold: one column, both tiles flush-left and full width.
    pointer('pointermove', MEETING_FILMSTRIP_2COL_MIN_W - 1);
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_2COL_MIN_W - 1);
    expect(Number.parseFloat(camTile().style.left)).toBe(0);
    expect(Number.parseFloat(tileB().style.left)).toBe(0);

    // At the threshold: two columns — half the width each, side by side.
    pointer('pointermove', MEETING_FILMSTRIP_2COL_MIN_W);
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_TILE_W);
    expect(Number.parseFloat(camTile().style.left)).toBe(0);
    expect(Number.parseFloat(tileB().style.left)).toBeGreaterThan(0);
    expect(Number.parseFloat(camTile().style.top)).toBe(Number.parseFloat(tileB().style.top));
    // The seam still parks at the far edge of the whole rail.
    expect(Number.parseFloat(resizer().style.left)).toBeGreaterThanOrEqual(
      MEETING_FILMSTRIP_2COL_MIN_W,
    );
    pointer('pointerup', MEETING_FILMSTRIP_2COL_MIN_W);
  });

  it('doubles the chevron threshold in two columns (5 rows = 10 faces)', () => {
    for (const id of ['b', 'c', 'd', 'e', 'f']) addCam(view, id);
    view.attachRemoteStream('share', new MediaStream(), 'screen');
    const laidOut = () =>
      [...document.querySelectorAll<HTMLElement>('.panel')].filter(
        (p) => !p.classList.contains('meeting-hidden') && !p.classList.contains('hidden'),
      ).length;
    const chevron = document.getElementById('filmstrip-toggle') as HTMLElement;
    // 6 cams + self + share = 8 windows → 7 in the rail, past the 5-row cap.
    expect(chevron.style.display).not.toBe('none');
    const oneColShown = laidOut();

    // Two columns fit 10, so all 7 show and the chevron goes away.
    pointer('pointerdown', MEETING_FILMSTRIP_TILE_W);
    pointer('pointermove', MEETING_FILMSTRIP_2COL_MIN_W);
    pointer('pointerup', MEETING_FILMSTRIP_2COL_MIN_W);
    expect(laidOut()).toBeGreaterThan(oneColShown);
    expect(chevron.style.display).toBe('none');
  });

  it('double-click snaps back to the default width; leaving the meeting resets it', () => {
    view.attachRemoteStream('b', new MediaStream(), 'screen');
    const oneCol = MEETING_FILMSTRIP_2COL_MIN_W - 50;
    pointer('pointerdown', MEETING_FILMSTRIP_TILE_W);
    pointer('pointermove', oneCol);
    pointer('pointerup', oneCol);
    expect(tileWidth()).toBe(oneCol);
    resizer().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_TILE_W);
    // Drag again, then leave + re-enter: not persisted across meetings.
    pointer('pointerdown', MEETING_FILMSTRIP_TILE_W);
    pointer('pointermove', oneCol);
    pointer('pointerup', oneCol);
    expect(tileWidth()).toBe(oneCol);
    view.setMeetingMode(false);
    expect(shown()).toBe(false);
    view.setMeetingMode(true);
    expect(tileWidth()).toBe(MEETING_FILMSTRIP_TILE_W);
  });
});

// Clicking a filmstrip tile in the meeting presentation layout pins it under the
// share: the main area splits top (share) / bottom (pinned), with a draggable
// horizontal seam between them.
describe('meeting split view (pin a filmstrip tile under the share)', () => {
  let view: RemoteMediaView;
  const panelOf = (key: string) =>
    document.querySelector<HTMLElement>(`.panel[data-focus-key="${key}"]`)!;
  const box = (key: string) => {
    const el = panelOf(key);
    return {
      x: Number.parseFloat(el.style.left),
      y: Number.parseFloat(el.style.top),
      w: Number.parseFloat(el.style.width),
      h: Number.parseFloat(el.style.height),
    };
  };
  const click = (el: HTMLElement, detail = 1) =>
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  const seam = () => document.getElementById('meeting-split-resizer') as HTMLElement;
  const seamShown = () => seam().style.display !== 'none';
  const pointer = (type: string, clientY: number) =>
    seam().dispatchEvent(
      new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, clientY }),
    );

  beforeEach(() => {
    view = setup();
    view.setMeetingMode(true);
    addCam(view, 'a');
    addCam(view, 'b');
    view.attachRemoteStream('s', new MediaStream(), 'screen');
  });

  it('starts unsplit: the share fills the main area, no seam', () => {
    expect(seamShown()).toBe(false);
    expect(box('cam:a').w).toBe(MEETING_FILMSTRIP_TILE_W);
  });

  it('clicking a filmstrip tile pins it below the share; clicking it again unpins', () => {
    const fullH = box('screen:s').h;
    click(panelOf('cam:a'));
    const top = box('screen:s');
    const bottom = box('cam:a');
    expect(top.h).toBeLessThan(fullH);
    expect(bottom.x).toBe(top.x);
    expect(bottom.w).toBe(top.w);
    expect(bottom.y).toBeGreaterThan(top.y + top.h - 1);
    expect(seamShown()).toBe(true);
    // The other camera stays in the rail.
    expect(box('cam:b').w).toBe(MEETING_FILMSTRIP_TILE_W);

    click(panelOf('cam:a'));
    expect(box('cam:a').w).toBe(MEETING_FILMSTRIP_TILE_W);
    expect(box('screen:s').h).toBe(fullH);
    expect(seamShown()).toBe(false);
  });

  it('clicking another filmstrip tile swaps the pinned one', () => {
    click(panelOf('cam:a'));
    click(panelOf('cam:b'));
    expect(box('cam:a').w).toBe(MEETING_FILMSTRIP_TILE_W);
    expect(box('cam:b').w).toBe(box('screen:s').w);
  });

  it('clicking the main share does nothing; the 2nd click of a double-click is ignored', () => {
    click(panelOf('screen:s'));
    expect(seamShown()).toBe(false);
    click(panelOf('cam:a'), 1);
    click(panelOf('cam:a'), 2);
    expect(seamShown()).toBe(true);
  });

  it('dragging the seam resizes top/bottom; double-click evens it out', () => {
    click(panelOf('cam:a'));
    const areaH = window.innerHeight - PANEL_BOTTOM_RESERVED;
    pointer('pointerdown', areaH / 2);
    pointer('pointermove', areaH * 0.7);
    pointer('pointerup', areaH * 0.7);
    const top = box('screen:s');
    const bottom = box('cam:a');
    expect(top.h / (top.h + bottom.h)).toBeCloseTo(0.7, 1);
    seam().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(Math.abs(box('screen:s').h - box('cam:a').h)).toBeLessThanOrEqual(1);
  });

  it('drops the pin when that window goes away or the meeting ends', () => {
    click(panelOf('cam:a'));
    view.setMeetingMode(false);
    view.setMeetingMode(true);
    expect(seamShown()).toBe(false);
    click(panelOf('cam:b'));
    view.removeScreenshare('s');
    view.attachRemoteStream('s', new MediaStream(), 'screen');
    expect(seamShown()).toBe(false);
  });
});
