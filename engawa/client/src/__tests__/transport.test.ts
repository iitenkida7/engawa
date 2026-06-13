import { describe, expect, it } from 'bun:test';
import { TransportCoordinator } from '@/core/transport';
import type { ClientMessage } from '@/core/types';
import type { MediaManager } from '@/media/media';
import type { SfuEvents, SfuManager } from '@/rtc/sfu';
import type { WebRtcManager } from '@/rtc/webrtc';

// Minimal fakes for the two transports: just the surface the coordinator
// drives, recording calls so tests can assert the orchestration order.
function make(media: Partial<MediaManager> = {}) {
  const log: string[] = [];
  const sent: ClientMessage[] = [];
  const rtcPeers = new Set<string>();
  let fellBack = 0;
  let sfuEvents: SfuEvents | null = null;

  const fakeRtc = {
    hasPeer: (id: string) => rtcPeers.has(id),
    peerIds: () => [...rtcPeers],
    get peerCount() {
      return rtcPeers.size;
    },
    createPeer: async (id: string, initiator: boolean) => {
      rtcPeers.add(id);
      log.push(`rtc.create:${id}:${initiator}`);
    },
    closePeer: (id: string) => {
      rtcPeers.delete(id);
      log.push(`rtc.close:${id}`);
    },
    closeAll: () => {
      rtcPeers.clear();
      log.push('rtc.closeAll');
    },
    signal: (id: string) => log.push(`rtc.signal:${id}`),
    applyRemoteStreamMeta: (id: string) => log.push(`rtc.meta:${id}`),
    addLocalStream: (_s: MediaStream, kind: string) => log.push(`rtc.addLocal:${kind}`),
    setCamEncoding: () => {},
    setScreenEncoding: () => {},
    collectStats: async () => [],
  } as unknown as WebRtcManager;

  const fakeSfu = {
    addLocalStream: (_s: MediaStream, kind: string) => log.push(`sfu.addLocal:${kind}`),
    removePeer: (id: string) => log.push(`sfu.removePeer:${id}`),
    setPeerTracks: (id: string) => log.push(`sfu.setPeerTracks:${id}`),
    setPreferredLayer: () => {},
    closeAll: () => log.push('sfu.closeAll'),
    collectStats: async () => [],
  } as unknown as SfuManager;

  const transport = new TransportCoordinator(
    {
      media: { micStream: null, camStream: null, screenStream: null, ...media } as MediaManager,
      getMyId: () => 'me',
      send: (m) => sent.push(m),
      onRemoteStream: () => {},
      onRemoteStreamRemoved: () => {},
      onPeerClosed: () => {},
      getCameraTileWidth: () => null,
      onFellBack: () => {
        fellBack++;
      },
    },
    {
      rtc: () => fakeRtc,
      sfu: (events) => {
        sfuEvents = events;
        return fakeSfu;
      },
    },
  );

  return {
    transport,
    log,
    sent,
    rtcPeers,
    get fellBack() {
      return fellBack;
    },
    get sfuEvents() {
      return sfuEvents!;
    },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 1));

describe('TransportCoordinator — mesh reconciliation', () => {
  it('opens a peer to every member except self, with deterministic initiator election', async () => {
    const t = make();
    t.transport.applyGroupUpdate('mesh', ['me', 'a', 'z']);
    await flush();
    expect(t.transport.method).toBe('mesh');
    // isInitiator(myId, peerId) = myId < peerId: 'me' < 'z' but 'me' > 'a'.
    expect(t.log).toContain('rtc.create:a:false');
    expect(t.log).toContain('rtc.create:z:true');
    expect(t.transport.groupPeers()).toEqual(new Set(['a', 'z']));
  });

  it('closes peers that left the group and opens peers that joined', async () => {
    const t = make();
    t.transport.applyGroupUpdate('mesh', ['me', 'a']);
    await flush();
    t.transport.applyGroupUpdate('mesh', ['me', 'z']);
    await flush();
    expect(t.log).toContain('rtc.close:a');
    expect(t.log).toContain('rtc.create:z:true');
  });
});

describe('TransportCoordinator — mesh ↔ SFU switching', () => {
  it('mesh → SFU tears the mesh down and publishes the live local streams', async () => {
    const mic = {} as MediaStream;
    const t = make({ micStream: mic });
    t.transport.applyGroupUpdate('mesh', ['me', 'a']);
    await flush();
    t.transport.applyGroupUpdate('sfu', ['me', 'a', 'b']);
    expect(t.transport.method).toBe('sfu');
    expect(t.log).toContain('rtc.closeAll');
    expect(t.log).toContain('sfu.addLocal:mic');
    expect(t.transport.groupPeers()).toEqual(new Set(['me', 'a', 'b']));
  });

  it('SFU → mesh closes the SFU transport and rebuilds the mesh', async () => {
    const t = make();
    t.transport.applyGroupUpdate('sfu', ['me', 'a']);
    t.transport.applyGroupUpdate('mesh', ['me', 'a']);
    await flush();
    expect(t.log).toContain('sfu.closeAll');
    expect(t.log).toContain('rtc.create:a:false');
    expect(t.transport.method).toBe('mesh');
  });

  it('drops directory peers that left the SFU group', () => {
    const t = make();
    t.transport.applyGroupUpdate('sfu', ['me', 'a', 'b']);
    t.transport.setPeerTracks('b', 'sess-b', []);
    t.transport.applyGroupUpdate('sfu', ['me', 'a']);
    expect(t.log).toContain('sfu.removePeer:b');
  });

  it('falls back to mesh with the former members when the SFU fails', async () => {
    const t = make();
    t.transport.applyGroupUpdate('sfu', ['me', 'a']);
    t.sfuEvents.onFailed();
    await flush();
    expect(t.fellBack).toBe(1);
    expect(t.transport.method).toBe('mesh');
    expect(t.log).toContain('rtc.create:a:false');
  });
});

describe('TransportCoordinator — signaling guard', () => {
  it('drops a stray signal from a non-member with no existing peer', async () => {
    const t = make();
    await t.transport.handleSignal('stranger', { sdp: 'x' });
    expect(t.log).not.toContain('rtc.signal:stranger');
  });

  it('creates a non-initiator peer for a mesh member signaling first', async () => {
    const t = make();
    t.transport.applyGroupUpdate('mesh', ['me', 'a']);
    await flush();
    t.rtcPeers.delete('a'); // simulate: their offer arrives before our createPeer
    await t.transport.handleSignal('a', { sdp: 'offer' });
    expect(t.log).toContain('rtc.create:a:false');
    expect(t.log).toContain('rtc.signal:a');
  });
});

describe('TransportCoordinator — media sink routing', () => {
  it('routes local stream publishes to the active transport', () => {
    const t = make();
    const stream = {} as MediaStream;
    t.transport.addLocalStream(stream, 'cam');
    expect(t.log).toContain('rtc.addLocal:cam');
    t.transport.applyGroupUpdate('sfu', ['me']);
    t.transport.addLocalStream(stream, 'screen');
    expect(t.log).toContain('sfu.addLocal:screen');
  });

  it('onPeerLeft cleans the peer out of both transports', () => {
    const t = make();
    t.transport.onPeerLeft('a');
    expect(t.log).toContain('rtc.close:a');
    expect(t.log).toContain('sfu.removePeer:a');
  });
});
