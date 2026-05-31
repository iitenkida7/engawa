import { describe, expect, it } from 'bun:test';
import {
  describeStream,
  diffRtcStats,
  summarizeRtcStats,
  type RtcSnapshot,
} from '@/rtc/rtcstats';

describe('summarizeRtcStats', () => {
  it('extracts outbound, inbound, remote-inbound, codecs and RTT, ignoring unknown types', () => {
    const snap = summarizeRtcStats([
      { type: 'codec', id: 'c-vid', mimeType: 'video/VP8' },
      { type: 'codec', id: 'c-aud', mimeType: 'audio/opus' },
      {
        type: 'outbound-rtp',
        timestamp: 200,
        ssrc: 1,
        kind: 'video',
        bytesSent: 5000,
        packetsSent: 40,
        framesEncoded: 30,
        totalEncodeTime: 0.1,
        qualityLimitationReason: 'cpu',
        frameWidth: 320,
        frameHeight: 240,
        codecId: 'c-vid',
      },
      {
        type: 'inbound-rtp',
        timestamp: 190,
        ssrc: 2,
        kind: 'audio',
        trackIdentifier: 'trk-a',
        bytesReceived: 8000,
        packetsReceived: 100,
        packetsLost: 2,
        jitter: 0.02,
        codecId: 'c-aud',
      },
      {
        type: 'remote-inbound-rtp',
        timestamp: 150,
        ssrc: 1,
        kind: 'video',
        packetsLost: 3,
        jitter: 0.01,
      },
      { type: 'candidate-pair', timestamp: 180, currentRoundTripTime: 0.05, nominated: true },
    ]);

    expect(snap.tMs).toBe(200); // max timestamp
    expect(snap.outbound[0]).toMatchObject({
      ssrc: 1,
      kind: 'video',
      bytesSent: 5000,
      qualityLimitationReason: 'cpu',
      frameWidth: 320,
      frameHeight: 240,
      codec: 'VP8', // resolved from codecId regardless of stat order
    });
    expect(snap.inbound[0]).toMatchObject({
      ssrc: 2,
      kind: 'audio',
      trackId: 'trk-a',
      bytesReceived: 8000,
      packetsReceived: 100,
      packetsLost: 2,
      jitter: 0.02,
      codec: 'opus',
    });
    expect(snap.remoteInbound[0]).toMatchObject({ ssrc: 1, packetsLost: 3, jitter: 0.01 });
    expect(snap.rttMs).toBe(50); // 0.05s → 50ms
  });

  it('prefers a nominated candidate-pair RTT over a non-nominated one', () => {
    const snap = summarizeRtcStats([
      { type: 'candidate-pair', timestamp: 10, currentRoundTripTime: 0.2 }, // fallback
      { type: 'candidate-pair', timestamp: 10, currentRoundTripTime: 0.03, nominated: true },
    ]);
    expect(snap.rttMs).toBe(30);
  });

  it('falls back to a non-nominated RTT when none is nominated', () => {
    const snap = summarizeRtcStats([
      { type: 'candidate-pair', timestamp: 10, currentRoundTripTime: 0.2 },
    ]);
    expect(snap.rttMs).toBe(200);
  });

  it('tolerates missing optional fields', () => {
    const snap = summarizeRtcStats([
      { type: 'outbound-rtp', timestamp: 5, ssrc: 7, kind: 'audio' },
    ]);
    expect(snap.outbound[0]).toMatchObject({ ssrc: 7, bytesSent: 0, packetsSent: 0 });
    expect(snap.outbound[0].framesEncoded).toBeUndefined();
    expect(snap.outbound[0].codec).toBeUndefined();
    expect(snap.inbound).toHaveLength(0);
    expect(snap.rttMs).toBeUndefined();
  });
});

// Minimal snapshot factory so each diff test only specifies what it exercises.
const snap = (o: Partial<RtcSnapshot> & { tMs: number }): RtcSnapshot => ({
  outbound: [],
  inbound: [],
  remoteInbound: [],
  ...o,
});

describe('diffRtcStats — send streams', () => {
  // 1 second apart so per-second rates equal the raw deltas.
  const prev = snap({
    tMs: 1000,
    outbound: [
      { ssrc: 1, kind: 'video', bytesSent: 0, packetsSent: 0, framesEncoded: 0, totalEncodeTime: 0 },
    ],
    remoteInbound: [{ ssrc: 1, kind: 'video', packetsLost: 0 }],
  });
  const cur = snap({
    tMs: 2000,
    rttMs: 42.4,
    outbound: [
      {
        ssrc: 1,
        kind: 'video',
        bytesSent: 125_000, // *8/1000 = 1000 kbps over 1s
        packetsSent: 100,
        framesEncoded: 30,
        totalEncodeTime: 0.15, // 150ms / 30 frames = 5 ms/frame
        frameWidth: 320,
        frameHeight: 240,
        codec: 'VP8',
      },
    ],
    remoteInbound: [{ ssrc: 1, kind: 'video', packetsLost: 5 }],
  });

  it('computes kbps, fps, encode time, resolution, codec and send loss%', () => {
    const rates = diffRtcStats(prev, cur);
    expect(rates.dtMs).toBe(1000);
    expect(rates.rttMs).toBe(42.4);
    expect(rates.streams).toHaveLength(1);
    expect(rates.streams[0]).toMatchObject({
      dir: 'send',
      kind: 'video',
      kbps: 1000,
      fps: 30,
      encodeMsPerFrame: 5,
      resolution: '320x240',
      codec: 'VP8',
      packetLossPct: 5, // 5 lost / 100 sent
    });
  });

  it('matches senders by ssrc so a camera and a screen share stay distinct', () => {
    const p = snap({
      tMs: 0,
      outbound: [
        { ssrc: 1, kind: 'video', bytesSent: 0, packetsSent: 0 },
        { ssrc: 2, kind: 'video', bytesSent: 0, packetsSent: 0 },
      ],
    });
    const c = snap({
      tMs: 1000,
      outbound: [
        { ssrc: 1, kind: 'video', bytesSent: 12_500, packetsSent: 10 }, // 100 kbps (cam)
        { ssrc: 2, kind: 'video', bytesSent: 250_000, packetsSent: 200 }, // 2000 kbps (screen)
      ],
    });
    const rates = diffRtcStats(p, c);
    expect(rates.streams.find((s) => s.kbps === 100)).toBeDefined();
    expect(rates.streams.find((s) => s.kbps === 2000)).toBeDefined();
  });

  it('yields 0 kbps / undefined fps for a sender with no previous sample', () => {
    const c = snap({
      tMs: 1000,
      outbound: [{ ssrc: 9, kind: 'video', bytesSent: 99_999, packetsSent: 50, framesEncoded: 25 }],
    });
    const rates = diffRtcStats(prev, c);
    expect(rates.streams[0].kbps).toBe(0);
    expect(rates.streams[0].fps).toBeUndefined();
  });

  it('clamps to 0 (never negative) when counters regress, e.g. ssrc reuse', () => {
    const c = snap({
      tMs: 2000,
      outbound: [{ ssrc: 1, kind: 'video', bytesSent: 100, packetsSent: 1, framesEncoded: 2 }],
      remoteInbound: [{ ssrc: 1, kind: 'video', packetsLost: 0 }],
    });
    const rates = diffRtcStats(cur, c); // cur has much higher counters
    expect(rates.streams[0].kbps).toBe(0);
    expect(rates.streams[0].fps).toBe(0);
  });
});

describe('diffRtcStats — recv streams', () => {
  it('computes recv kbps, fps, jitter and loss% from inbound counters', () => {
    const prev = snap({
      tMs: 1000,
      inbound: [
        {
          ssrc: 5,
          kind: 'video',
          trackId: 'trk',
          bytesReceived: 0,
          packetsReceived: 0,
          packetsLost: 0,
          framesDecoded: 0,
        },
      ],
    });
    const cur = snap({
      tMs: 2000,
      inbound: [
        {
          ssrc: 5,
          kind: 'video',
          trackId: 'trk',
          bytesReceived: 125_000, // 1000 kbps
          packetsReceived: 95,
          packetsLost: 5, // 5 / (5 + 95) = 5%
          framesDecoded: 24,
          jitter: 0.03, // 30ms
          frameWidth: 640,
          frameHeight: 480,
          codec: 'VP8',
        },
      ],
    });
    const rates = diffRtcStats(prev, cur);
    expect(rates.streams).toHaveLength(1);
    expect(rates.streams[0]).toMatchObject({
      dir: 'recv',
      kind: 'video',
      trackId: 'trk',
      kbps: 1000,
      fps: 24,
      resolution: '640x480',
      codec: 'VP8',
      packetLossPct: 5,
      jitterMs: 30,
    });
  });
});

describe('describeStream', () => {
  it('renders the chips present, in order', () => {
    const chips = describeStream({
      dir: 'send',
      kind: 'video',
      ssrc: 1,
      kbps: 500,
      fps: 30,
      resolution: '320x240',
      codec: 'VP8',
      packetLossPct: 1.5,
      jitterMs: 12,
      encodeMsPerFrame: 5,
      qualityLimitationReason: 'cpu',
    });
    expect(chips).toEqual([
      '500 kbps',
      '30 fps',
      '320x240',
      'VP8',
      'loss 1.5%',
      'jitter 12ms',
      'enc 5ms',
      '制限:cpu',
    ]);
  });

  it('omits absent fields and a "none" quality-limitation reason', () => {
    const chips = describeStream({
      dir: 'recv',
      kind: 'audio',
      ssrc: 2,
      kbps: 40,
      qualityLimitationReason: 'none',
    });
    expect(chips).toEqual(['40 kbps']);
  });
});
