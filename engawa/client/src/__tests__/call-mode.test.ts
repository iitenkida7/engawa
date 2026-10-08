import { beforeEach, describe, expect, it } from 'bun:test';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
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

  it('resets minimize state and hides the toggle when leaving the room', () => {
    minimizeBtn().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    view.setMeetingMode(false);
    expect(btnShown()).toBe(false);
    // Re-entering starts immersive again, not stuck minimized.
    view.setMeetingMode(true);
    expect(immersive()).toBe(true);
  });
});
