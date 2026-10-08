import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { resetIceCache } from '@/rtc/ice';
import { SfuManager } from '@/rtc/sfu';
import { SFU_API_TIMEOUT_MS } from '@/rtc/sfu-logic';

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
  closed = false;
  constructor() {
    createdPcs.push(this);
  }
  // Like the browser, a closed PC rejects further negotiation (InvalidStateError).
  private assertOpen() {
    if (this.closed) throw new Error('InvalidStateError: RTCPeerConnection is closed');
  }
  addEventListener() {}
  addTransceiver() {
    this.assertOpen();
    this.transceiverCount++;
    const sender = makeFakeSender();
    this.lastSender = sender;
    return { mid: '0', sender };
  }
  async createOffer() {
    this.assertOpen();
    return { type: 'offer', sdp: 'v=0\r\n' };
  }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.assertOpen();
  }
  async getStats() {
    return new Map();
  }
  getTransceivers() {
    return [] as unknown[];
  }
  close() {
    this.closed = true;
  }
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
      // requires it (a missing mid / per-track errorCode rejects the pull).
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

describe('SfuManager control-plane retry (issue #186)', () => {
  it('retries a transient network failure instead of failing the op', async () => {
    let calls = 0;
    fetchMock = mock(async (url: string) => {
      const u = String(url);
      if (u.includes('/sessions/new')) {
        calls++;
        if (calls === 1) throw new Error('connection reset');
        return jsonRes({ sessionId: 'sess-1' });
      }
      if (u.includes('/tracks/new')) {
        return jsonRes({
          sessionDescription: { type: 'answer', sdp: 'v=0\r\n' },
          tracks: [{ mid: '0' }],
        });
      }
      return jsonRes({});
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);
    const published = waitPublish();
    sfu.addLocalStream(makeStream('mic'), 'mic');
    await published;

    expect(calls).toBe(2);
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('does not retry a non-transient 4xx — the op fails and onFailed fires', async () => {
    let sessionCalls = 0;
    fetchMock = mock(async (url: string) => {
      const u = String(url);
      if (u.includes('/sessions/new')) {
        sessionCalls++;
        return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
      }
      return jsonRes({});
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { events } = makeEvents();
    const sfu = new SfuManager(events);
    sfu.addLocalStream(makeStream('mic'), 'mic');
    // Let the op chain settle (no retry sleeps for a 400).
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    expect(sessionCalls).toBe(1);
    expect(events.onFailed).toHaveBeenCalledTimes(1);
  });
});

describe('SfuManager peer session change re-pull (issue #186)', () => {
  it('drops and re-pulls a peer whose announced sessionId changed', async () => {
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    sfu.setPeerTracks('peer-1', 'sess-A', [{ kind: 'cam', trackName: 'cam' }]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const pullsAfterFirst = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/tracks/new'),
    ).length;
    expect(pullsAfterFirst).toBe(1);

    // Same kinds, new session (the peer rebuilt its SFU transport): the stale
    // pull must be closed and a fresh pull issued against the new session.
    sfu.setPeerTracks('peer-1', 'sess-B', [{ kind: 'cam', trackName: 'cam' }]);
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    const pulls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/tracks/new')).length;
    const closes = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/tracks/close'),
    ).length;
    expect(pulls).toBe(2);
    expect(closes).toBe(1);
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('does not re-pull when the sessionId is unchanged', async () => {
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    sfu.setPeerTracks('peer-1', 'sess-A', [{ kind: 'cam', trackName: 'cam' }]);
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    sfu.setPeerTracks('peer-1', 'sess-A', [{ kind: 'cam', trackName: 'cam' }]);
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));

    const pulls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/tracks/new')).length;
    expect(pulls).toBe(1);
  });
});

describe('SfuManager video-pull pause (issue #188)', () => {
  it('pausing drops pulled video, keeps mic, and blocks new video pulls', async () => {
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    sfu.setPeerTracks('peer-1', 'sess-A', [
      { kind: 'mic', trackName: 'mic' },
      { kind: 'cam', trackName: 'cam' },
    ]);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    const pullsBefore = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/tracks/new'),
    ).length;
    expect(pullsBefore).toBe(2);

    sfu.setVideoPullPaused(true);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    const closes = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/tracks/close'),
    ).length;
    expect(closes).toBe(1); // the cam pull was closed, the mic kept

    // A directory update while paused must not pull video again.
    sfu.setPeerTracks('peer-1', 'sess-A', [
      { kind: 'mic', trackName: 'mic' },
      { kind: 'cam', trackName: 'cam' },
    ]);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    const pullsWhilePaused = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/tracks/new'),
    ).length;
    expect(pullsWhilePaused).toBe(2);

    // Resume + re-feed (the App re-feeds cached directories): video re-pulls.
    sfu.setVideoPullPaused(false);
    sfu.setPeerTracks('peer-1', 'sess-A', [
      { kind: 'mic', trackName: 'mic' },
      { kind: 'cam', trackName: 'cam' },
    ]);
    for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
    const pullsAfterResume = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('/tracks/new'),
    ).length;
    expect(pullsAfterResume).toBe(3);
    expect(events.onFailed).not.toHaveBeenCalled();
  });
});

describe('SfuManager ops superseded by closeAll (issue #196)', () => {
  it('a rebuild mid-op neither trips onFailed nor lets the stale op touch the new transport', async () => {
    // Hold the first session/new so the publish op is mid-await when the App
    // rebuilds the transport (closeAll → re-publish, as in onSfuFailed).
    let releaseFirst!: () => void;
    let sessionCalls = 0;
    const bodies: string[] = [];
    fetchMock = mock(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (typeof init?.body === 'string') bodies.push(init.body);
      if (u.includes('/api/turn-credentials')) return jsonRes([]);
      if (u.includes('/sessions/new')) {
        sessionCalls++;
        if (sessionCalls === 1) {
          await new Promise<void>((r) => (releaseFirst = r));
          return jsonRes({ sessionId: 'sess-old' });
        }
        return jsonRes({ sessionId: 'sess-new' });
      }
      if (u.includes('/tracks/new')) {
        return jsonRes({
          sessionDescription: { type: 'answer', sdp: 'v=0\r\n' },
          tracks: [{ mid: '0' }],
        });
      }
      return jsonRes({});
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { events, waitPublish } = makeEvents();
    const sfu = new SfuManager(events);
    sfu.addLocalStream(makeStream('mic'), 'mic');
    // Queued behind the held op, before the rebuild: must not run afterwards.
    sfu.setPeerTracks('peer-1', 'their-old', [{ kind: 'cam', trackName: 'cam' }]);
    await settle();
    expect(sessionCalls).toBe(1);

    // Rebuild while the publish is mid-flight.
    sfu.closeAll();
    const published = waitPublish();
    sfu.addLocalStream(makeStream('mic'), 'mic');
    releaseFirst();
    await published;
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    // The stale op bailed quietly: no spurious failure (→ instant mesh fallback).
    expect(events.onFailed).not.toHaveBeenCalled();
    // Only the rebuilt session was announced; the stale one never leaked in.
    expect(events.onPublished).toHaveBeenCalledTimes(1);
    expect(events.onPublished).toHaveBeenLastCalledWith('sess-new', [
      { kind: 'mic', trackName: 'mic' },
    ]);
    // The pre-rebuild pull was skipped rather than replayed against the new PC.
    expect(bodies.some((b) => b.includes('their-old'))).toBe(false);
  });

  it('closeAll while the PC awaits ICE leaves no ghost PC behind', async () => {
    resetIceCache();
    let releaseIce!: () => void;
    fetchMock = mock(async (url: string) => {
      if (String(url).includes('/api/turn-credentials')) {
        await new Promise<void>((r) => (releaseIce = r));
        return jsonRes([]);
      }
      return jsonRes({ sessionId: 'sess-1' });
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const { events } = makeEvents();
    const sfu = new SfuManager(events);
    sfu.addLocalStream(makeStream('cam'), 'cam');
    await settle();

    // Group falls back to mesh while ensurePc is still fetching credentials.
    sfu.closeAll();
    releaseIce();
    for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));

    expect(createdPcs).toHaveLength(0);
    expect(sfu.active).toBe(false);
    expect(events.onFailed).not.toHaveBeenCalled();
  });
});

describe('SfuManager control-plane timeout (issue #194)', () => {
  it('aborts a request that never answers and retries instead of stalling the op chain', async () => {
    // Each attempt's deadline signal is handed to the test so it can fire the
    // timeout by hand instead of waiting SFU_API_TIMEOUT_MS in real time.
    const deadlines: { ms: number; ctl: AbortController }[] = [];
    const timeoutSpy = spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
      const ctl = new AbortController();
      deadlines.push({ ms, ctl });
      return ctl.signal;
    });
    try {
      let sessionCalls = 0;
      fetchMock = mock(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('/sessions/new')) {
          sessionCalls++;
          // First attempt hangs until its deadline fires (half-open TCP).
          if (sessionCalls === 1) {
            return new Promise<Response>((_res, rej) => {
              init?.signal?.addEventListener('abort', () =>
                rej(new DOMException('timed out', 'TimeoutError')),
              );
            });
          }
          return jsonRes({ sessionId: 'sess-1' });
        }
        if (u.includes('/tracks/new')) {
          return jsonRes({
            sessionDescription: { type: 'answer', sdp: 'v=0\r\n' },
            tracks: [{ mid: '0' }],
          });
        }
        return jsonRes({});
      });
      globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

      const { events, waitPublish } = makeEvents();
      const sfu = new SfuManager(events);
      const published = waitPublish();
      sfu.addLocalStream(makeStream('mic'), 'mic');
      await settle();

      // The hung request carries the control-plane deadline; firing it lets the
      // retry go through and the publish completes.
      expect(sessionCalls).toBe(1);
      const first = deadlines.find((d) => d.ms === SFU_API_TIMEOUT_MS);
      expect(first).toBeDefined();
      first!.ctl.abort();
      await published;

      expect(sessionCalls).toBe(2);
      expect(events.onFailed).not.toHaveBeenCalled();
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});

describe('SfuManager rejected pull is isolated to that peer (issue #250)', () => {
  // Fire scheduled retries immediately so the backoff doesn't slow the test.
  let timeoutSpy: ReturnType<typeof spyOn>;
  let delays: number[];
  beforeEach(() => {
    delays = [];
    timeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: () => void,
      ms?: number,
    ) => {
      if (ms) delays.push(ms);
      queueMicrotask(fn);
      return 0;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => timeoutSpy.mockRestore());

  const flush = async () => {
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => queueMicrotask(r));
  };

  // tracks/new answers with a per-track error for the first `rejects` pulls.
  function rejectPulls(rejects: number) {
    let pulls = 0;
    fetchMock = mock(async (url: string) => {
      const u = String(url);
      if (u.includes('/api/turn-credentials')) return jsonRes([]);
      if (u.includes('/sessions/new')) return jsonRes({ sessionId: 'sess-1' });
      if (u.includes('/tracks/new')) {
        pulls++;
        if (pulls <= rejects) return jsonRes({ tracks: [{ errorCode: 'not_found' }] });
        return jsonRes({
          sessionDescription: { type: 'answer', sdp: 'v=0\r\n' },
          tracks: [{ mid: '0' }],
        });
      }
      return jsonRes({});
    });
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    return () => pulls;
  }

  it('retries a rejected pull with backoff instead of failing the transport', async () => {
    const pulls = rejectPulls(2);
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    sfu.setPeerTracks('peer-1', 'their-sess', [{ kind: 'cam', trackName: 'cam' }]);
    await flush();

    expect(pulls()).toBe(3);
    expect(delays).toEqual([1000, 2000]);
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('drops the retry once a newer directory for the peer arrives', async () => {
    const pulls = rejectPulls(1);
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    // Hold the retry so a fresh directory can land first.
    const pending: (() => void)[] = [];
    timeoutSpy.mockImplementation(((fn: () => void, ms?: number) => {
      if (ms) pending.push(fn);
      else queueMicrotask(fn);
      return 0;
    }) as unknown as typeof setTimeout);

    sfu.setPeerTracks('peer-1', 'old-sess', [{ kind: 'cam', trackName: 'cam' }]);
    await flush();
    expect(pending).toHaveLength(1);

    // The peer rebuilt: its new directory pulls from the new session.
    sfu.setPeerTracks('peer-1', 'new-sess', [{ kind: 'cam', trackName: 'cam' }]);
    await flush();
    expect(pulls()).toBe(2);

    // The stale retry fires but must not pull the old session again.
    pending[0]!();
    await flush();
    expect(pulls()).toBe(2);
    expect(events.onFailed).not.toHaveBeenCalled();
  });

  it('falls back to the failure path once retries are exhausted', async () => {
    const pulls = rejectPulls(Number.POSITIVE_INFINITY);
    const { events } = makeEvents();
    const sfu = new SfuManager(events);

    sfu.setPeerTracks('peer-1', 'their-sess', [{ kind: 'cam', trackName: 'cam' }]);
    await flush();

    expect(pulls()).toBe(4); // first try + 3 retries
    expect(events.onFailed).toHaveBeenCalledTimes(1);
  });
});
