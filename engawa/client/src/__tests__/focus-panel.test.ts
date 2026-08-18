import { beforeEach, describe, expect, it } from 'bun:test';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import { PANEL_BOTTOM_RESERVED, PANEL_GAP, PANEL_MARGIN } from '@/ui/panels';
import { RemoteMediaView } from '@/ui/remote-media';
import type { PlayerState } from '@/world/player';

// Maximizing a single media window (⤢): the chosen panel fills the usable area
// and every other window is hidden. These drive the real DOM the view builds,
// since the interesting part is the wiring (delegated clicks, Esc, self-heal),
// not the geometry — that is covered by computeFocusLayout in panels.test.ts.

const MY_ID = 'me';

// The static markup RemoteMediaView expects to find at construction.
function mountDom() {
  document.body.innerHTML = `
    <div id="app">
      <div id="remote-videos"></div>
      <div id="self-preview" class="panel hidden">
        <div class="panel-header"><span class="label" id="self-preview-label"></span></div>
        <div class="panel-body"><video id="self-video"></video></div>
      </div>
    </div>`;
}

function player(userId: string, name: string): PlayerState {
  return { userId, name, initials: () => name.slice(0, 2).toUpperCase() } as unknown as PlayerState;
}

function setup() {
  mountDom();
  const players = new Map<string, PlayerState>();
  players.set(MY_ID, player(MY_ID, 'Me'));
  const view = new RemoteMediaView({
    players,
    media: { micOn: true, camStream: new MediaStream() } as unknown as MediaManager,
    recorder: {
      recording: false,
      addAudioStream: () => {},
      removeAudioStream: () => {},
    } as unknown as RecorderManager,
    getMyId: () => MY_ID,
  });
  // Local camera on, so the self preview joins the layout like any other window.
  view.refreshSelfPreview();
  return { view, players };
}

// Adds a camera tile for a peer. An empty stream is enough: the view only
// attaches it to the <video> and remembers its id.
function addCam(view: RemoteMediaView, players: Map<string, PlayerState>, userId: string) {
  players.set(userId, player(userId, userId));
  view.attachRemoteStream(userId, new MediaStream(), 'cam');
}

const panels = () => [...document.querySelectorAll<HTMLElement>('.panel')];
const visible = () => panels().filter((p) => !p.classList.contains('focus-hidden'));
const panelOf = (key: string) =>
  document.querySelector<HTMLElement>(`.panel[data-focus-key="${key}"]`)!;
const focusBtn = (key: string) =>
  panelOf(key).querySelector<HTMLButtonElement>('.panel-focus-btn')!;
const click = (el: HTMLElement) => el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
const pressEsc = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

describe('maximizing a media window', () => {
  let view: RemoteMediaView;
  let players: Map<string, PlayerState>;

  beforeEach(() => {
    ({ view, players } = setup());
    addCam(view, players, 'a');
    addCam(view, players, 'b');
    view.showScreenshare('c', new MediaStream());
  });

  it('gives every window a maximize button and a stable key', () => {
    expect(
      panels()
        .map((p) => p.dataset.focusKey)
        .sort(),
    ).toEqual(['cam:a', 'cam:b', 'screen:c', 'self']);
    for (const p of panels()) expect(p.querySelector('.panel-focus-btn')).not.toBeNull();
  });

  it('hides every other window when one is maximized', () => {
    click(focusBtn('cam:a'));
    expect(visible().map((p) => p.dataset.focusKey)).toEqual(['cam:a']);
    expect(panelOf('cam:a').classList.contains('focused')).toBe(true);
  });

  it('lets the maximized window fill the usable area', () => {
    click(focusBtn('screen:c'));
    const el = panelOf('screen:c');
    // Free-aspect (screenshare) windows take the whole area minus the gap.
    expect(el.style.left).toBe(`${PANEL_MARGIN + PANEL_GAP / 2}px`);
    expect(el.style.width).toBe(`${window.innerWidth - PANEL_MARGIN * 2 - PANEL_GAP}px`);
    expect(el.style.height).toBe(
      `${window.innerHeight - PANEL_MARGIN - PANEL_BOTTOM_RESERVED - PANEL_GAP}px`,
    );
  });

  it('restores every window when the same button is clicked again', () => {
    click(focusBtn('cam:a'));
    click(focusBtn('cam:a'));
    expect(visible()).toHaveLength(4);
    expect(panels().some((p) => p.classList.contains('focused'))).toBe(false);
  });

  it('switches straight from one maximized window to another', () => {
    click(focusBtn('cam:a'));
    click(focusBtn('screen:c'));
    expect(visible().map((p) => p.dataset.focusKey)).toEqual(['screen:c']);
  });

  it('restores on Esc', () => {
    click(focusBtn('cam:b'));
    pressEsc();
    expect(visible()).toHaveLength(4);
  });

  it('ignores Esc while the user is typing', () => {
    click(focusBtn('cam:a'));
    const input = document.createElement('input');
    document.body.appendChild(input);
    // Esc in a text field cancels an IME conversion or clears the field; it must
    // not collapse the view mid-sentence.
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(visible().map((p) => p.dataset.focusKey)).toEqual(['cam:a']);
    pressEsc();
    expect(visible()).toHaveLength(4);
  });

  it('reports a minimal tile width for hidden windows so their SFU layer drops', () => {
    click(focusBtn('cam:b'));
    // Hidden with visibility, so clientWidth still holds the pre-maximize value;
    // the width reported to the SFU layer picker must not.
    expect(view.cameraTileWidth('a')).toBe(1);
    pressEsc();
    expect(view.cameraTileWidth('a')).not.toBe(1);
  });

  it('marks the maximized window button active and clears it again', () => {
    const btn = focusBtn('cam:a');
    expect(btn.classList.contains('active')).toBe(false);
    click(btn);
    expect(btn.classList.contains('active')).toBe(true);
    pressEsc();
    expect(btn.classList.contains('active')).toBe(false);
  });

  it('restores the layout when the maximized peer leaves', () => {
    click(focusBtn('cam:a'));
    view.removePeer('a');
    expect(panelOf('cam:a')).toBeNull();
    // The remaining windows come back instead of staying hidden behind a dead
    // focus, and a later window with a recycled key is not auto-maximized.
    expect(
      visible()
        .map((p) => p.dataset.focusKey)
        .sort(),
    ).toEqual(['cam:b', 'screen:c', 'self']);
    addCam(view, players, 'a');
    expect(visible()).toHaveLength(4);
  });

  it('restores the layout when the maximized share stops', () => {
    click(focusBtn('screen:c'));
    view.removeScreenshare('c');
    expect(
      visible()
        .map((p) => p.dataset.focusKey)
        .sort(),
    ).toEqual(['cam:a', 'cam:b', 'self']);
  });

  it('leaves the maximized view when a layout mode is picked', () => {
    click(focusBtn('cam:a'));
    view.setLayoutMode('sidebar');
    expect(visible()).toHaveLength(4);
  });

  it('does not let a double-click on ⤢ re-designate the main share', () => {
    view.showScreenshare('d', new MediaStream());
    const btn = focusBtn('screen:d');
    // Double-clicking the button toggles focus on then off — it must not also
    // reach the stage's dblclick handler and silently swap the featured share.
    click(btn);
    click(btn);
    btn.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(panelOf('screen:c').classList.contains('main')).toBe(true);
    expect(panelOf('screen:d').classList.contains('main')).toBe(false);
  });

  it('leaves the maximized view when a new share arrives', () => {
    click(focusBtn('cam:a'));
    view.showScreenshare('d', new MediaStream());
    // The new stage must not be born hidden: starting a share with no visible
    // change would leave the sharer with no sign that they are sharing.
    expect(visible()).toHaveLength(5);
    expect(panelOf('screen:d').classList.contains('focus-hidden')).toBe(false);
  });
});
