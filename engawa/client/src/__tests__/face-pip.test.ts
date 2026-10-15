import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import {
  computeFacePipWindowSize,
  FACE_PIP_GAP,
  FACE_PIP_PAD,
  FACE_PIP_TILE_H,
  FACE_PIP_TILE_W,
  type FaceEntry,
  FacePipView,
  isFacePipSupported,
  parseFacePipSetting,
} from '@/ui/face-pip';
import { RemoteMediaView } from '@/ui/remote-media';
import type { PlayerState } from '@/world/player';

// The always-on-top face window while screen sharing (issue #318).

describe('parseFacePipSetting', () => {
  it('defaults to on, only an explicit "0" disables it', () => {
    expect(parseFacePipSetting(null)).toBe(true);
    expect(parseFacePipSetting('1')).toBe(true);
    expect(parseFacePipSetting('garbage')).toBe(true);
    expect(parseFacePipSetting('0')).toBe(false);
  });
});

describe('isFacePipSupported', () => {
  it('is true only when the Document PiP API exists on the window', () => {
    expect(isFacePipSupported({})).toBe(false);
    expect(isFacePipSupported({ documentPictureInPicture: {} })).toBe(true);
    expect(isFacePipSupported({ documentPictureInPicture: undefined })).toBe(false);
  });
});

describe('computeFacePipWindowSize', () => {
  const one = FACE_PIP_TILE_W + 2 * FACE_PIP_PAD;
  const oneRow = FACE_PIP_TILE_H + 2 * FACE_PIP_PAD;

  it('sizes a single tile (and the empty window) to one tile', () => {
    expect(computeFacePipWindowSize(1)).toEqual({ width: one, height: oneRow });
    expect(computeFacePipWindowSize(0)).toEqual({ width: one, height: oneRow });
  });

  it('lays tiles across up to three columns, then wraps to a second row', () => {
    const three = 3 * FACE_PIP_TILE_W + 2 * FACE_PIP_GAP + 2 * FACE_PIP_PAD;
    expect(computeFacePipWindowSize(2)).toEqual({
      width: 2 * FACE_PIP_TILE_W + FACE_PIP_GAP + 2 * FACE_PIP_PAD,
      height: oneRow,
    });
    expect(computeFacePipWindowSize(3)).toEqual({ width: three, height: oneRow });
    expect(computeFacePipWindowSize(4)).toEqual({
      width: three,
      height: 2 * FACE_PIP_TILE_H + FACE_PIP_GAP + 2 * FACE_PIP_PAD,
    });
  });
});

// A stand-in for documentPictureInPicture that hands out a window backed by a
// fresh <div> of the main document (happy-dom cannot open a real one). Enough
// to check what the view puts in it and how it reacts to the window closing.
type FakePip = {
  requestWindow: (opts?: { width?: number; height?: number }) => Promise<Window>;
  opened: Array<{ width?: number; height?: number }>;
  root: HTMLDivElement;
  closed: number;
  firePagehide: () => void;
};

function installFakePip(opts: { refuse?: boolean } = {}): FakePip {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const listeners: Array<() => void> = [];
  const fake: FakePip = {
    opened: [],
    root,
    closed: 0,
    firePagehide: () => {
      for (const l of listeners) l();
    },
    requestWindow: async (o) => {
      if (opts.refuse) throw new DOMException('no activation', 'NotAllowedError');
      fake.opened.push(o ?? {});
      const win = {
        document: {
          createElement: (tag: string) => document.createElement(tag),
          head: { appendChild: (el: Node) => root.appendChild(el) },
          body: { append: (...els: Node[]) => root.append(...els) },
        },
        addEventListener: (type: string, cb: () => void) => {
          if (type === 'pagehide') listeners.push(cb);
        },
        close: () => {
          fake.closed++;
        },
      };
      return win as unknown as Window;
    },
  };
  Object.defineProperty(window, 'documentPictureInPicture', {
    value: fake,
    configurable: true,
    writable: true,
  });
  return fake;
}

function uninstallFakePip() {
  delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture;
}

function entry(userId: string, over: Partial<FaceEntry> = {}): FaceEntry {
  return {
    userId,
    name: userId,
    initials: userId.slice(0, 2).toUpperCase(),
    stream: null,
    muted: false,
    speaking: false,
    ...over,
  };
}

describe('FacePipView', () => {
  afterEach(() => {
    uninstallFakePip();
    document.body.innerHTML = '';
  });

  it('reports failure without the API or when the browser refuses', async () => {
    const view = new FacePipView();
    expect(await view.open([entry('a')])).toBe(false);
    expect(view.isOpen()).toBe(false);
    installFakePip({ refuse: true });
    expect(await view.open([entry('a')])).toBe(false);
    expect(view.isOpen()).toBe(false);
  });

  it('opens sized for the tile count and renders one tile per entry', async () => {
    const fake = installFakePip();
    const view = new FacePipView();
    expect(await view.open([entry('a'), entry('b', { muted: true })])).toBe(true);
    expect(view.isOpen()).toBe(true);
    expect(fake.opened[0]).toEqual(computeFacePipWindowSize(2));
    const tiles = fake.root.querySelectorAll('.tile');
    expect(tiles.length).toBe(2);
    expect(tiles[0].querySelector('.name')?.textContent).toBe('a');
    expect(tiles[1].classList.contains('muted')).toBe(true);
    // No camera → placeholder with initials.
    expect(tiles[0].classList.contains('nocam')).toBe(true);
    expect(tiles[0].querySelector('.ph span')?.textContent).toBe('A');
    expect(fake.root.querySelector<HTMLElement>('.empty')?.hidden).toBe(true);
  });

  it('syncs: adds, updates in place, removes, and shows the empty note', async () => {
    const fake = installFakePip();
    const view = new FacePipView();
    await view.open([entry('a')]);
    const first = fake.root.querySelector('.tile');
    const stream = new MediaStream();
    view.sync([entry('a', { name: 'Alice', stream }), entry('b')]);
    const tiles = fake.root.querySelectorAll('.tile');
    expect(tiles.length).toBe(2);
    // Same element, updated — not torn down and rebuilt.
    expect(tiles[0]).toBe(first as Element);
    expect(tiles[0].querySelector('.name')?.textContent).toBe('Alice');
    expect(tiles[0].classList.contains('nocam')).toBe(false);
    expect((tiles[0].querySelector('video') as HTMLVideoElement).srcObject).toBe(stream);

    view.setSpeaking('b', true);
    expect(tiles[1].classList.contains('speaking')).toBe(true);
    view.setMuted('b', true);
    expect(tiles[1].classList.contains('muted')).toBe(true);

    view.sync([]);
    expect(fake.root.querySelectorAll('.tile').length).toBe(0);
    expect(fake.root.querySelector<HTMLElement>('.empty')?.hidden).toBe(false);
  });

  it('close() closes the window once; a user-closed window is forgotten', async () => {
    const fake = installFakePip();
    const view = new FacePipView();
    await view.open([entry('a')]);
    view.close();
    expect(fake.closed).toBe(1);
    expect(view.isOpen()).toBe(false);
    view.close();
    expect(fake.closed).toBe(1);

    await view.open([entry('a')]);
    expect(view.isOpen()).toBe(true);
    fake.firePagehide();
    expect(view.isOpen()).toBe(false);
    // Nothing to close any more — the browser already did.
    view.close();
    expect(fake.closed).toBe(1);
  });
});

// Integration with RemoteMediaView: the window follows the real tiles.
describe('RemoteMediaView face window', () => {
  const MY_ID = 'me';

  function mountDom() {
    document.body.innerHTML = `
      <div id="app">
        <div id="remote-videos"></div>
        <button id="filmstrip-toggle" type="button"></button>
        <div id="filmstrip-resizer"></div>
        <button id="meeting-minimize" type="button"></button>
        <div id="self-preview" class="panel hidden">
          <div class="panel-header"><span class="label" id="self-preview-label"></span></div>
          <div class="panel-body"><video id="self-video"></video><div class="no-video" id="self-no-video"><span class="no-video-initials" id="self-no-video-initials"></span><span class="no-video-name" id="self-no-video-name"></span></div></div>
        </div>
      </div>`;
  }

  function player(userId: string, name: string): PlayerState {
    return {
      userId,
      name,
      isSpeaking: false,
      initials: () => name.slice(0, 2).toUpperCase(),
    } as unknown as PlayerState;
  }

  let view: RemoteMediaView;
  let players: Map<string, PlayerState>;
  let fake: FakePip;

  beforeEach(() => {
    mountDom();
    fake = installFakePip();
    players = new Map();
    players.set(MY_ID, player(MY_ID, 'Me'));
    view = new RemoteMediaView({
      players,
      media: { micOn: false, camStream: null } as unknown as MediaManager,
      recorder: {
        recording: false,
        addAudioStream: () => {},
        removeAudioStream: () => {},
      } as unknown as RecorderManager,
      getMyId: () => MY_ID,
      onAutoplayBlocked: () => {},
      onAutoplayUnlocked: () => {},
    });
  });

  afterEach(() => {
    uninstallFakePip();
    document.body.innerHTML = '';
  });

  it('mirrors existing tiles on open and tracks later tile changes', async () => {
    players.set('a', player('a', 'Alice'));
    const cam = new MediaStream();
    view.attachRemoteStream('a', cam, 'cam');
    expect(view.facePipSupported()).toBe(true);
    expect(await view.openFacePip()).toBe(true);
    expect(view.facePipOpen()).toBe(true);

    let tiles = fake.root.querySelectorAll('.tile');
    expect(tiles.length).toBe(1);
    expect(tiles[0].querySelector('.name')?.textContent).toBe('Alice');
    expect((tiles[0].querySelector('video') as HTMLVideoElement).srcObject).toBe(cam);

    // A cam-off conversation member gets a placeholder tile in both places.
    players.set('b', player('b', 'Bob'));
    view.setConversationMembers(['a', 'b']);
    tiles = fake.root.querySelectorAll('.tile');
    expect(tiles.length).toBe(2);
    expect(tiles[1].classList.contains('nocam')).toBe(true);

    view.setTileMuted('b', true);
    expect(tiles[1].classList.contains('muted')).toBe(true);

    // Leaving removes the mirror too.
    view.removePeer('a');
    view.setConversationMembers([]);
    expect(fake.root.querySelectorAll('.tile').length).toBe(0);

    view.closeFacePip();
    expect(view.facePipOpen()).toBe(false);
    expect(fake.closed).toBe(1);
  });
});
