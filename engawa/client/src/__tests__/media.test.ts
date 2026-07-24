import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MediaManager, parseNoiseSetting } from '@/media/media';

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
      for (const fn of listeners.ended ?? []) fn(undefined);
    },
  };
}

// Fake MediaStream wrapping a set of tracks.
function makeStream(tracks: ReturnType<typeof makeTrack>[]) {
  return {
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
  } as unknown as MediaStream;
}

let getUserMedia: ReturnType<typeof mock>;
let getDisplayMedia: ReturnType<typeof mock>;
let enumerateDevices: ReturnType<typeof mock>;

// bun:test has no vi.stubGlobal; happy-dom provides `navigator`, so we define
// a fake `mediaDevices` on it and capture the original descriptor to restore.
let hadMediaDevices = false;
let originalMediaDevices: PropertyDescriptor | undefined;

beforeEach(() => {
  getUserMedia = mock();
  getDisplayMedia = mock();
  enumerateDevices = mock();
  originalMediaDevices = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  hadMediaDevices = originalMediaDevices !== undefined;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    value: { getUserMedia, getDisplayMedia, enumerateDevices },
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

  it('coalesces concurrent enable calls into one acquisition (in-flight guard)', async () => {
    const stream = makeStream([makeTrack('audio')]);
    // Defer resolution so both calls overlap while the acquisition is pending —
    // the window a double-click lands in (getUserMedia null until it resolves).
    let resolve!: (s: MediaStream) => void;
    getUserMedia.mockReturnValue(new Promise<MediaStream>((r) => (resolve = r)));
    const m = new MediaManager();

    const p1 = m.enableMic();
    const p2 = m.enableMic();
    resolve(stream);
    const [s1, s2] = await Promise.all([p1, p2]);

    expect(getUserMedia).toHaveBeenCalledTimes(1);
    expect(s1).toBe(stream);
    expect(s2).toBe(stream);
    // A later call after settling can acquire again if needed (guard cleared).
    getUserMedia.mockResolvedValue(stream);
    m.disableMic();
    await m.enableMic();
    expect(getUserMedia).toHaveBeenCalledTimes(2);
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

describe('MediaManager device selection', () => {
  const devices = [
    { kind: 'audioinput', deviceId: 'mic-a', label: 'Mic A' },
    { kind: 'audioinput', deviceId: 'mic-b', label: 'Mic B' },
    { kind: 'videoinput', deviceId: 'cam-a', label: 'Cam A' },
    { kind: 'audiooutput', deviceId: 'spk-a', label: 'Speaker A' },
  ];

  it('listMics returns only audio inputs', async () => {
    enumerateDevices.mockResolvedValue(devices);
    const m = new MediaManager();
    const mics = await m.listMics();
    expect(mics.map((d) => d.deviceId)).toEqual(['mic-a', 'mic-b']);
  });

  it('listCams returns only video inputs', async () => {
    enumerateDevices.mockResolvedValue(devices);
    const m = new MediaManager();
    const cams = await m.listCams();
    expect(cams.map((d) => d.deviceId)).toEqual(['cam-a']);
  });

  it('passes the selected mic deviceId as an exact constraint', async () => {
    getUserMedia.mockResolvedValue(makeStream([makeTrack('audio')]));
    const m = new MediaManager();
    m.selectedMicId = 'mic-b';
    await m.enableMic();
    const audio = getUserMedia.mock.calls[0][0].audio as any;
    expect(audio.deviceId).toEqual({ exact: 'mic-b' });
  });

  it('passes the selected cam deviceId as an exact constraint', async () => {
    getUserMedia.mockResolvedValue(makeStream([makeTrack('video')]));
    const m = new MediaManager();
    m.selectedCamId = 'cam-a';
    await m.enableCam();
    const video = getUserMedia.mock.calls[0][0].video as any;
    expect(video.deviceId).toEqual({ exact: 'cam-a' });
  });

  it('omits the deviceId constraint when no device is selected', async () => {
    getUserMedia.mockResolvedValue(makeStream([makeTrack('audio')]));
    const m = new MediaManager();
    await m.enableMic();
    const audio = getUserMedia.mock.calls[0][0].audio as any;
    expect(audio.deviceId).toBeUndefined();
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

  it('notifies the screen-ended handler with the stopped stream on "ended"', async () => {
    // The OS/browser "stop sharing" path must hand the owner the just-stopped
    // stream so it can run the full teardown (issue #55).
    const track = makeTrack('video');
    const stream = makeStream([track]);
    getDisplayMedia.mockResolvedValue(stream);
    const m = new MediaManager();
    const onEnded = mock();
    m.onScreenEnded(onEnded);
    await m.enableScreen();
    track.fireEnded();
    expect(onEnded).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledWith(stream);
    expect(m.screenOn).toBe(false);
  });

  it('propagates getDisplayMedia rejection', async () => {
    getDisplayMedia.mockRejectedValue(new Error('cancelled'));
    const m = new MediaManager();
    await expect(m.enableScreen()).rejects.toThrow('cancelled');
    expect(m.screenOn).toBe(false);
  });
});

describe('parseNoiseSetting', () => {
  it('defaults to on when nothing is stored', () => {
    expect(parseNoiseSetting(null)).toBe(true);
  });

  it('stays on for any value other than an explicit "0"', () => {
    expect(parseNoiseSetting('1')).toBe(true);
    expect(parseNoiseSetting('on')).toBe(true);
  });

  it('is off only for the explicit "0"', () => {
    expect(parseNoiseSetting('0')).toBe(false);
  });
});

describe('MediaManager noise suppression', () => {
  it('defaults noiseSuppression to on', () => {
    expect(new MediaManager().noiseSuppression).toBe(true);
  });

  it('setNoiseSuppression flips the flag', () => {
    const m = new MediaManager();
    m.setNoiseSuppression(false);
    expect(m.noiseSuppression).toBe(false);
  });

  it('falls back to the raw mic when Web Audio is unavailable (default on)', async () => {
    // happy-dom has no AudioContext, so enableMic skips the RNNoise path and
    // sends the raw capture even though suppression defaults to on.
    const stream = makeStream([makeTrack('audio')]);
    getUserMedia.mockResolvedValue(stream);
    const m = new MediaManager();
    expect(m.noiseSuppression).toBe(true);
    const got = await m.enableMic();
    expect(got).toBe(stream);
    expect(m.micStream).toBe(stream);
  });
});
