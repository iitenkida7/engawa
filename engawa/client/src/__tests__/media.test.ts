import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MediaManager } from '../media';

// Fake MediaStreamTrack that records stop() and supports an 'ended' listener.
function makeTrack(kind: 'audio' | 'video') {
  const listeners: Record<string, ((e: any) => void)[]> = {};
  return {
    kind,
    stop: mock(),
    contentHint: '',
    addEventListener: mock((type: string, fn: (e: any) => void) => {
      (listeners[type] ??= []).push(fn);
    }),
    fireEnded: () => {
      for (const fn of listeners['ended'] ?? []) fn(undefined);
    },
  };
}

// Fake MediaStream wrapping a set of tracks.
function makeStream(tracks: ReturnType<typeof makeTrack>[]) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  };
}

let getUserMedia: ReturnType<typeof mock>;
let getDisplayMedia: ReturnType<typeof mock>;

// bun:test has no vi.stubGlobal; happy-dom provides `navigator`, so we define
// a fake `mediaDevices` on it and capture the original descriptor to restore.
let hadMediaDevices = false;
let originalMediaDevices: PropertyDescriptor | undefined;

beforeEach(() => {
  getUserMedia = mock();
  getDisplayMedia = mock();
  originalMediaDevices = Object.getOwnPropertyDescriptor(
    globalThis.navigator,
    'mediaDevices',
  );
  hadMediaDevices = originalMediaDevices !== undefined;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia, getDisplayMedia },
    configurable: true,
  });
});

afterEach(() => {
  if (hadMediaDevices && originalMediaDevices) {
    Object.defineProperty(globalThis.navigator, 'mediaDevices', originalMediaDevices);
  } else {
    delete (globalThis.navigator as any).mediaDevices;
  }
});

describe('MediaManager mic', () => {
  it('acquires and retains the mic stream, flipping micOn', async () => {
    const track = makeTrack('audio');
    const stream = makeStream([track]);
    getUserMedia.mockResolvedValue(stream);

    const m = new MediaManager();
    expect(m.micOn).toBe(false);
    const got = await m.enableMic();

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(getUserMedia.mock.calls[0][0]).toHaveProperty('audio');
    expect(got).toBe(stream);
    expect(m.micStream).toBe(stream);
    expect(m.micOn).toBe(true);
  });

  it('does not re-acquire when already enabled', async () => {
    const stream = makeStream([makeTrack('audio')]);
    getUserMedia.mockResolvedValue(stream);
    const m = new MediaManager();
    await m.enableMic();
    await m.enableMic();
    expect(getUserMedia).toHaveBeenCalledTimes(1);
  });

  it('stops every track and clears state on disable', async () => {
    const track = makeTrack('audio');
    getUserMedia.mockResolvedValue(makeStream([track]));
    const m = new MediaManager();
    await m.enableMic();
    m.disableMic();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(m.micStream).toBeNull();
    expect(m.micOn).toBe(false);
  });

  it('propagates getUserMedia rejection', async () => {
    getUserMedia.mockRejectedValue(new Error('denied'));
    const m = new MediaManager();
    await expect(m.enableMic()).rejects.toThrow('denied');
    expect(m.micOn).toBe(false);
  });

  it('notifies listeners on enable and disable', async () => {
    getUserMedia.mockResolvedValue(makeStream([makeTrack('audio')]));
    const m = new MediaManager();
    const fn = mock();
    m.on(fn);
    await m.enableMic();
    m.disableMic();
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

describe('MediaManager cam', () => {
  it('acquires the cam stream and tags video tracks with motion hint', async () => {
    const track = makeTrack('video');
    getUserMedia.mockResolvedValue(makeStream([track]));
    const m = new MediaManager();
    await m.enableCam();
    expect(getUserMedia.mock.calls[0][0]).toHaveProperty('video');
    expect(track.contentHint).toBe('motion');
    expect(m.camOn).toBe(true);
  });

  it('stops tracks on disable', async () => {
    const track = makeTrack('video');
    getUserMedia.mockResolvedValue(makeStream([track]));
    const m = new MediaManager();
    await m.enableCam();
    m.disableCam();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(m.camOn).toBe(false);
  });
});

describe('MediaManager screen', () => {
  it('acquires via getDisplayMedia and sets the detail hint', async () => {
    const track = makeTrack('video');
    getDisplayMedia.mockResolvedValue(makeStream([track]));
    const m = new MediaManager();
    await m.enableScreen();
    expect(getDisplayMedia).toHaveBeenCalledTimes(1);
    expect(track.contentHint).toBe('detail');
    expect(m.screenOn).toBe(true);
  });

  it('auto-disables when the track emits "ended" (browser stop-sharing)', async () => {
    const track = makeTrack('video');
    getDisplayMedia.mockResolvedValue(makeStream([track]));
    const m = new MediaManager();
    await m.enableScreen();
    expect(m.screenOn).toBe(true);
    track.fireEnded();
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(m.screenOn).toBe(false);
  });

  it('propagates getDisplayMedia rejection', async () => {
    getDisplayMedia.mockRejectedValue(new Error('cancelled'));
    const m = new MediaManager();
    await expect(m.enableScreen()).rejects.toThrow('cancelled');
    expect(m.screenOn).toBe(false);
  });
});
