import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { SfuManager } from '@/rtc/sfu';

// A sender whose getParameters/setParameters round-trip so tuneSfuSender's
// priority / degradationPreference writes can be observed (issue #146). Each
// addTransceiver call returns a fresh one; the last is captured per test.
function makeFakeSender() {
  const params: {
    encodings: Record<string, unknown>[];
    degradationPreference?: string;
  } = { encodings: [{}] };
  const replaced: (MediaStreamTrack | null)[] = [];
  return {
    replaceTrack: async (t: MediaStreamTrack | null) => {
      replaced.push(t);
    },
    getParameters: () => params,
    setParameters: async (p: typeof params) => {
      params.encodings = p.encodings;
      params.degradationPreference = p.degradationPreference;
    },
    _params: () => params,
    _replaced: () => replaced,
  };
}

// Minimal RTCPeerConnection good enough to drive SfuManager.pushTrack to the
// point it announces a publish: the SFU logic only needs a mid, a sender, an
// SDP string, and the lifecycle/track listeners (which we ignore here).
const createdPcs: FakeRTCPeerConnection[] = [];

class FakeRTCPeerConnection {
  localDescription = { type: 'offer', sdp: 'v=0\r\n' };
  lastSender: ReturnType<typeof makeFakeSender> | null = null;
  transceiverCount = 0;
  constructor() {
    createdPcs.push(this);
  }
  addEventListener() {}
  addTransceiver() {
    this.transceiverCount++;
    const sender = makeFakeSender();
    this.lastSender = sender;
    return { mid: '0', sender };
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0\r\n' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {}
  async getStats() {
    return new Map();
  }
  getTransceivers() {
    return [] as unknown[];
  }
  close() {}
}

// Fake local stream carrying one track of the requested kind. `suffix`
// distinguishes two streams of the same kind (e.g. the before/after of a
// device switch or a screen re-share) by giving them distinct ids.
function makeStream(kind: 'mic' | 'cam' | 'screen', suffix = '') {
  const isAudio = kind === 'mic';
  const track = { kind: isAudio ? 'audio' : 'video', id: `trk-${kind}${suffix}` };
  return {
    id: `stream-${kind}${suffix}`,
    getAudioTracks: () => (isAudio ? [track] : []),
    getVideoTracks: () => (isAudio ? [] : [track]),
  } as unknown as MediaStream;
}

function jsonRes(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof mock>;
let originalFetch: typeof globalThis.fetch;
let originalRTC: typeof globalThis.RTCPeerConnection;

beforeEach(() => {
  fetchMock = mock(async (url: string) => {
    const u = String(url);
    if (u.includes('/api/turn-credentials')) return jsonRes([]);
    if (u.includes('/sessions/new')) return jsonRes({ sessionId: 'sess-1' });
    if (u.includes('/tracks/new')) {
      // Cloudflare always returns the assigned mid per track; pullTrack now
      // requires it (a missing mid / per-track errorCode is a hard failure).
      return jsonRes({
        sessionDescription: { type: 'answer', sdp: 'v=0\r\n' },
        tracks: [{ mid: '0' }],
      });
    }
    return jsonRes({});
  });
  createdPcs.length = 0;
  originalFetch = globalThis.fetch;
  originalRTC = globalThis.RTCPeerConnection;
  globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  globalThis.RTCPeerConnection =
    FakeRTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.RTCPeerConnection = originalRTC;
});

function makeEvents() {
  // onPublished resolves the latest waitPublish() promise so a test can await
  // the fire-and-forget enqueue chain settling.
  let resolvePublish: (() => void) | null = null;
  const onPublished = mock(() => {
    resolvePublish?.();
    resolvePublish = null;
  });
  return {
    events: {
      onRemoteStream: mock(),
      onRemoteStreamRemoved: mock(),
      onPeerClosed: mock(),
      onPublished,
      onFailed: mock(),
    },
    waitPublish: () => new Promise<void>((res) => (resolvePublish = res)),
  };
}

describe('SfuManager reopen after closeAll (issue #138)', () => {
  it('re-publishes after closeAll so re-entering an SFU group restores media', async () => {
    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);

    // First entry into the SFU group: publishing our camera reaches the control
    // plane and announces the track.
    let published = waitPublish();
    sfu.addLocalStream(makeStream('cam'), 'cam');
    await published;
    expect(events.onPublished).toHaveBeenCalledTimes(1);

    // Leaving the room (mesh fallback / group dispersal) tears the transport
    // down — this latches `closed`.
    sfu.closeAll();
    fetchMock.mockClear();

    // Re-entering the group republishes. Before the fix, the latched `closed`
    // made chainOp skip this op entirely: no session was recreated and no media
    // ever flowed again.
    published = waitPublish();
    sfu.addLocalStream(makeStream('cam'), 'cam');
    await published;

    expect(events.onPublished).toHaveBeenCalledTimes(2);
    // A fresh session was created over the proxy (proof the op was not skipped).
    const createdSession = fetchMock.mock.calls.some((c) => String(c[0]).includes('/sessions/new'));
    expect(createdSession).toBe(true);
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('pulls a peer track after closeAll so re-entry restores received media', async () => {
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    sfu.closeAll(); // simulate a prior teardown that latched `closed`
    fetchMock.mockClear();

    // A re-entered peer announces its tracks; we must actually pull them.
    sfu.setPeerTracks('peer-1', 'their-sess', [{ kind: 'cam', trackName: 'cam' }]);
    // Let the enqueue chain settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const pulled = fetchMock.mock.calls.some((c) => String(c[0]).includes('/tracks/new'));
    expect(pulled).toBe(true);
    expect(events.onFailed).not.toHaveBeenCalled();
  });
});

describe('SfuManager sender tuning (issue #146)', () => {
  it('gives the published mic top network priority', async () => {
    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);
    const published = waitPublish();
    sfu.addLocalStream(makeStream('mic'), 'mic');
    await published;
    const params = createdPcs[0].lastSender!._params();
    const enc = params.encodings[0] as { networkPriority?: string; priority?: string };
    expect(enc.networkPriority).toBe('high');
    expect(enc.priority).toBe('high');
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('sets a balanced degradation preference for the published camera', async () => {
    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);
    const published = waitPublish();
    sfu.addLocalStream(makeStream('cam'), 'cam');
    await published;
    const params = createdPcs[0].lastSender!._params();
    expect(params.degradationPreference).toBe('balanced');
    expect(events.onFailed).not.toHaveBeenCalled();
  });
});

describe('SfuManager replaceLocalStream device switch (issue #148)', () => {
  it('swaps the published track in place — no new transceiver, no duplicate publish', async () => {
    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);
    const published = waitPublish();
    const camA = makeStream('cam');
    sfu.addLocalStream(camA, 'cam');
    await published;
    const pc = createdPcs[0];
    expect(pc.transceiverCount).toBe(1);
    const sender = pc.lastSender!;
    fetchMock.mockClear();

    // Switch the camera device: replaceLocalStream must replaceTrack in place.
    const camB = makeStream('cam');
    sfu.replaceLocalStream(camA, camB, 'cam');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The new device's track was swapped onto the existing sender...
    expect(sender._replaced()).toContain(camB.getVideoTracks()[0]);
    // ...with no new transceiver and no second tracks/new POST. A repush would
    // duplicate the 'cam' trackName in the session and black the remote out.
    expect(pc.transceiverCount).toBe(1);
    const repushed = fetchMock.mock.calls.some((c) => String(c[0]).includes('/tracks/new'));
    expect(repushed).toBe(false);
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('publishes fresh when nothing of that kind is live yet', async () => {
    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);
    const published = waitPublish();
    const cam = makeStream('cam');
    sfu.replaceLocalStream(cam, cam, 'cam');
    await published;
    expect(events.onPublished).toHaveBeenCalledTimes(1);
    expect(createdPcs[0].transceiverCount).toBe(1);
  });
});

describe('SfuManager re-publish after unpublish (issue #150)', () => {
  it('reuses the transceiver on screen off → on instead of pushing a duplicate trackName', async () => {
    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);

    // Share the screen: one transceiver, one tracks/new push, announced.
    let published = waitPublish();
    const screenA = makeStream('screen', '-a');
    sfu.addLocalStream(screenA, 'screen');
    await published;
    const pc = createdPcs[0];
    expect(pc.transceiverCount).toBe(1);
    const sender = pc.lastSender!;

    // Stop sharing: halts the track (replaceTrack(null)) and drops it from the
    // announced directory, but keeps the transceiver for reuse.
    published = waitPublish();
    sfu.removeLocalStream(screenA);
    await published;
    expect(events.onPublished).toHaveBeenLastCalledWith('sess-1', []);
    expect(sender._replaced()).toContain(null);

    fetchMock.mockClear();

    // Share again: must resume the SAME transceiver via replaceTrack, NOT add a
    // second one or push a duplicate 'screen' (which left Cloudflare with two
    // 'screen' tracks and blacked the remote out — #150).
    published = waitPublish();
    const screenB = makeStream('screen', '-b');
    sfu.addLocalStream(screenB, 'screen');
    await published;

    expect(sender._replaced()).toContain(screenB.getVideoTracks()[0]);
    expect(pc.transceiverCount).toBe(1);
    const repushed = fetchMock.mock.calls.some((c) => String(c[0]).includes('/tracks/new'));
    expect(repushed).toBe(false);
    // 'screen' is back in the directory, so peers re-pull it.
    expect(events.onPublished).toHaveBeenLastCalledWith('sess-1', [
      { kind: 'screen', trackName: 'screen' },
    ]);
    expect(events.onFailed).not.toHaveBeenCalled();
  });
});

const settle = async () => {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
};

describe('SfuManager closeAll emits closure events (SFU→mesh ghost tiles)', () => {
  it('emits onPeerClosed for each pulled remote peer so the UI drops their tile', async () => {
    const { events } = makeEvents();
    const sfu = new SfuManager(events);
    sfu.setPeerTracks('peer-1', 'their-sess', [{ kind: 'cam', trackName: 'cam' }]);
    await settle();

    sfu.closeAll();
    expect(events.onPeerClosed).toHaveBeenCalledWith('peer-1');
  });
});

describe('SfuManager dropRemote closes the pulled track (downlink leak)', () => {
  it('sends tracks/close to Cloudflare when a peer stops publishing a track', async () => {
    const { events } = makeEvents();
    const sfu = new SfuManager(events);
    sfu.setPeerTracks('peer-1', 'their-sess', [{ kind: 'cam', trackName: 'cam' }]);
    await settle();
    fetchMock.mockClear();

    // The peer turns their camera off: reconcile drops it → dropRemote must ask
    // Cloudflare to stop delivering the pulled track, not just forget it locally.
    sfu.setPeerTracks('peer-1', 'their-sess', []);
    await settle();

    const closed = fetchMock.mock.calls.some((c) => String(c[0]).includes('/tracks/close'));
    expect(closed).toBe(true);
    expect(events.onFailed).not.toHaveBeenCalled();
  });
});
