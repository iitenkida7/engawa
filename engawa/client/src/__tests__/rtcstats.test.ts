import { describe, expect, it } from 'bun:test';
import {
  diffRtcStats,
  formatRtcRates,
  summarizeRtcStats,
  type RtcSnapshot,
} from '../rtcstats';

describe('summarizeRtcStats', () => {
  it('extracts outbound, remote-inbound and RTT, ignoring unknown types', () => {
    const snap = summarizeRtcStats([
      { type: 'codec', timestamp: 100, payloadType: 111 }, // ignored
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
    expect(snap.outbound).toHaveLength(1);
    expect(snap.outbound[0]).toMatchObject({
      ssrc: 1,
      kind: 'video',
      bytesSent: 5000,
      packetsSent: 40,
      qualityLimitationReason: 'cpu',
      frameWidth: 320,
      frameHeight: 240,
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
    expect(snap.rttMs).toBeUndefined();
  });
});

describe('diffRtcStats', () => {
  // 1 second apart so per-second rates equal the raw deltas.
  const prev: RtcSnapshot = {
    tMs: 1000,
    outbound: [
      { ssrc: 1, kind: 'video', bytesSent: 0, packetsSent: 0, framesEncoded: 0, totalEncodeTime: 0 },
    ],
    remoteInbound: [{ ssrc: 1, kind: 'video', packetsLost: 0 }],
  };
  const cur: RtcSnapshot = {
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
      },
    ],
    remoteInbound: [{ ssrc: 1, kind: 'video', packetsLost: 5 }],
  };

  it('computes kbps, fps, encode time, resolution and loss% over the interval', () => {
    const rates = diffRtcStats(prev, cur);
    expect(rates.dtMs).toBe(1000);
    expect(rates.rttMs).toBe(42.4);
    expect(rates.packetLossPct).toBe(5); // 5 lost / 100 sent
    expect(rates.outbound[0]).toMatchObject({
      kind: 'video',
      kbps: 1000,
      fps: 30,
      encodeMsPerFrame: 5,
      resolution: '320x240',
    });
  });

  it('matches senders by ssrc so a camera and a screen share stay distinct', () => {
    const p: RtcSnapshot = {
      tMs: 0,
      outbound: [
        { ssrc: 1, kind: 'video', bytesSent: 0, packetsSent: 0 },
        { ssrc: 2, kind: 'video', bytesSent: 0, packetsSent: 0 },
      ],
      remoteInbound: [],
    };
    const c: RtcSnapshot = {
      tMs: 1000,
      outbound: [
        { ssrc: 1, kind: 'video', bytesSent: 12_500, packetsSent: 10 }, // 100 kbps (cam)
        { ssrc: 2, kind: 'video', bytesSent: 250_000, packetsSent: 200 }, // 2000 kbps (screen)
      ],
      remoteInbound: [],
    };
    const rates = diffRtcStats(p, c);
    expect(rates.outbound.find((o) => o.kbps === 100)).toBeDefined();
    expect(rates.outbound.find((o) => o.kbps === 2000)).toBeDefined();
  });

  it('yields 0 kbps / undefined fps for a sender with no previous sample', () => {
    const c: RtcSnapshot = {
      tMs: 1000,
      outbound: [{ ssrc: 9, kind: 'video', bytesSent: 99_999, packetsSent: 50, framesEncoded: 25 }],
      remoteInbound: [],
    };
    const rates = diffRtcStats(prev, c);
    expect(rates.outbound[0].kbps).toBe(0);
    expect(rates.outbound[0].fps).toBeUndefined();
  });

  it('leaves loss% undefined when nothing was sent this interval', () => {
    const rates = diffRtcStats(prev, { ...prev, tMs: 2000 });
    expect(rates.packetLossPct).toBeUndefined();
  });

  it('clamps to 0 (never negative) when counters regress, e.g. ssrc reuse', () => {
    // Same ssrc but the new snapshot has *lower* cumulative counters than prev.
    const c: RtcSnapshot = {
      tMs: 2000,
      outbound: [
        { ssrc: 1, kind: 'video', bytesSent: 100, packetsSent: 1, framesEncoded: 2 },
      ],
      remoteInbound: [{ ssrc: 1, kind: 'video', packetsLost: 0 }],
    };
    const rates = diffRtcStats(cur, c); // cur has much higher counters
    expect(rates.outbound[0].kbps).toBe(0);
    expect(rates.outbound[0].fps).toBe(0);
  });
});

describe('formatRtcRates', () => {
  it('renders a compact line with rtt, loss and per-stream details', () => {
    const line = formatRtcRates('abcdef12-3456', {
      dtMs: 1000,
      rttMs: 42,
      packetLossPct: 1.5,
      outbound: [
        { kind: 'video', kbps: 500, fps: 30, resolution: '320x240', qualityLimitationReason: 'cpu' },
        { kind: 'audio', kbps: 40 },
      ],
    });
    expect(line).toContain('abcdef12'); // truncated id
    expect(line).toContain('rtt=42ms');
    expect(line).toContain('loss=1.5%');
    expect(line).toContain('video 500kbps');
    expect(line).toContain('320x240');
    expect(line).toContain('limit=cpu');
    expect(line).toContain('audio 40kbps');
  });

  it('omits a "none" quality-limitation reason', () => {
    const line = formatRtcRates('x', {
      dtMs: 1000,
      outbound: [{ kind: 'video', kbps: 100, qualityLimitationReason: 'none' }],
    });
    expect(line).not.toContain('limit=');
  });
});
