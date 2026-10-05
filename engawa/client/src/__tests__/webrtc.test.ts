import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MediaManager } from '@/media/media';
import { resetIceCache } from '@/rtc/ice';

// Stand-in for simple-peer: records every construction so a test can tell
// whether WebRtcManager actually built a peer, and exposes destroy() so
// closePeer works on it. No real RTCPeerConnection is involved.
const createdPeers: FakePeer[] = [];

class FakePeer {
  destroyed = false;
  constructor() {
    createdPeers.push(this);
  }
  on() {}
  addStream() {}
  signal() {}
  destroy() {
    this.destroyed = true;
  }
}

mock.module('simple-peer', () => ({ default: FakePeer }));
const { WebRtcManager } = await import('@/rtc/webrtc');

// No local media: createPeer then needs nothing beyond the ICE fetch.
const media = { micStream: null, camStream: null, screenStream: null } as unknown as MediaManager;

function makeEvents() {
  return {
    onRemoteStream: mock(),
    onRemoteStreamRemoved: mock(),
    onSignal: mock(),
    onStreamMeta: mock(),
    onPeerClosed: mock(),
    onPeerConnected: mock(),
    onPeerIceState: mock(),
  };
}

// The ICE-credential fetch is the async gap createPeer awaits. Gate it so the
// test can close the peer while creation is still in flight, then release it.
let releaseIce: () => void;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  createdPeers.length = 0;
  resetIceCache();
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    () =>
      new Promise<Response>((resolve) => {
        releaseIce = () =>
          resolve({ ok: true, status: 200, json: async () => [] } as unknown as Response);
      }),
  ) as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('WebRtcManager cancels a peer closed mid-creation (issue #195)', () => {
  it('closePeer during the ICE fetch builds no peer', async () => {
    const events = makeEvents();
    const rtc = new WebRtcManager(media, events);

    const p = rtc.createPeer('bob', true);
    rtc.closePeer('bob');
    releaseIce();

    expect(await p).toBeNull();
    expect(createdPeers).toHaveLength(0);
    expect(rtc.hasPeer('bob')).toBe(false);
    expect(rtc.peerIds()).toEqual([]);
  });

  it('closeAll (mesh → SFU switch) cancels every in-flight creation', async () => {
    const rtc = new WebRtcManager(media, makeEvents());

    const pa = rtc.createPeer('alice', true);
    const pb = rtc.createPeer('bob', false);
    rtc.closeAll();
    releaseIce();

    expect(await pa).toBeNull();
    expect(await pb).toBeNull();
    expect(createdPeers).toHaveLength(0);
  });

  it('lists in-flight creations in peerIds so a group reconcile can close them', async () => {
    const rtc = new WebRtcManager(media, makeEvents());

    const p = rtc.createPeer('bob', true);
    expect(rtc.peerIds()).toEqual(['bob']);
    releaseIce();
    await p;
    expect(rtc.peerIds()).toEqual(['bob']);
    expect(createdPeers).toHaveLength(1);
  });

  it('drops a cancelled creation from peerIds so a rejoin mid-fetch reopens the peer', async () => {
    const rtc = new WebRtcManager(media, makeEvents());

    const first = rtc.createPeer('bob', true);
    rtc.closePeer('bob');
    // The cancelled attempt lingers in `creating` until the fetch settles. If
    // peerIds still listed it, the App's group reconcile would read bob as
    // already connected and never reopen him when he comes straight back.
    expect(rtc.peerIds()).toEqual([]);

    const second = rtc.createPeer('bob', true);
    expect(rtc.peerIds()).toEqual(['bob']);
    releaseIce();

    expect(await first).toBeNull();
    expect(await second).not.toBeNull();
    expect(createdPeers).toHaveLength(1);
    expect(rtc.hasPeer('bob')).toBe(true);
  });

  it('a createPeer after the cancel starts a fresh creation instead of reusing the cancelled one', async () => {
    const rtc = new WebRtcManager(media, makeEvents());

    const first = rtc.createPeer('bob', true);
    rtc.closePeer('bob');
    // Rejoined before the fetch finished: both attempts share the one fetch.
    const second = rtc.createPeer('bob', true);
    releaseIce();

    expect(await first).toBeNull();
    const entry = await second;
    expect(entry).not.toBeNull();
    expect(createdPeers).toHaveLength(1);
    expect(rtc.hasPeer('bob')).toBe(true);
  });

  it('concurrent creates for the same peer still share one creation', async () => {
    const rtc = new WebRtcManager(media, makeEvents());

    const a = rtc.createPeer('bob', true);
    const b = rtc.createPeer('bob', true);
    releaseIce();

    expect(await a).toBe(await b);
    expect(createdPeers).toHaveLength(1);
  });
});
