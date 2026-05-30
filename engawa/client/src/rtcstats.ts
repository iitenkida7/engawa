// getStats-based telemetry. There is no telemetry backend — this exists purely
// to give visibility while tuning the mesh (bitrate ceilings, jitter buffer,
// codec choice are otherwise set blind). webrtc.ts polls RTCPeerConnection
// .getStats(); the App logs the per-second diff to the console only when the
// page is opened with `?debug=rtc`, so normal sessions pay nothing.
//
// The field extraction (summarizeRtcStats) and the per-second diff
// (diffRtcStats) are pure so they can be unit-tested with plain stat objects,
// following the same "pure logic in its own module" pattern as proximity.ts /
// sdp.ts / cam-bitrate.ts.

// A single sender's cumulative counters at one poll.
export type RtcOutbound = {
  ssrc: number;
  kind: 'audio' | 'video';
  bytesSent: number;
  packetsSent: number;
  framesEncoded?: number;
  totalEncodeTime?: number; // seconds, cumulative
  // 'none' | 'cpu' | 'bandwidth' | 'other' — the single most useful mesh signal:
  // is the encoder capped by CPU or by available bandwidth?
  qualityLimitationReason?: string;
  frameWidth?: number;
  frameHeight?: number;
};

// The receiver's report back about one of our senders (loss/jitter live here).
export type RtcRemoteInbound = {
  ssrc: number;
  kind: 'audio' | 'video';
  packetsLost: number;
  jitter?: number; // seconds
};

export type RtcSnapshot = {
  tMs: number; // representative timestamp (max across entries)
  rttMs?: number;
  outbound: RtcOutbound[];
  remoteInbound: RtcRemoteInbound[];
};

// We only read a handful of fields; accept any stat-shaped record so the pure
// functions stay testable with plain objects.
type StatLike = Record<string, unknown>;

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}

// Pure: collapse a getStats report (any iterable of stat entries) into the
// counters we care about. Unknown/irrelevant entry types are ignored.
export function summarizeRtcStats(stats: Iterable<StatLike>): RtcSnapshot {
  const outbound: RtcOutbound[] = [];
  const remoteInbound: RtcRemoteInbound[] = [];
  let tMs = 0;
  let rttNominated: number | undefined;
  let rttFallback: number | undefined;

  for (const s of stats) {
    const ts = num(s.timestamp);
    if (ts !== undefined && ts > tMs) tMs = ts;

    switch (s.type) {
      case 'outbound-rtp':
        outbound.push({
          ssrc: num(s.ssrc) ?? 0,
          kind: s.kind === 'audio' ? 'audio' : 'video',
          bytesSent: num(s.bytesSent) ?? 0,
          packetsSent: num(s.packetsSent) ?? 0,
          framesEncoded: num(s.framesEncoded),
          totalEncodeTime: num(s.totalEncodeTime),
          qualityLimitationReason:
            typeof s.qualityLimitationReason === 'string' ? s.qualityLimitationReason : undefined,
          frameWidth: num(s.frameWidth),
          frameHeight: num(s.frameHeight),
        });
        break;
      case 'remote-inbound-rtp':
        remoteInbound.push({
          ssrc: num(s.ssrc) ?? 0,
          kind: s.kind === 'audio' ? 'audio' : 'video',
          packetsLost: num(s.packetsLost) ?? 0,
          jitter: num(s.jitter),
        });
        break;
      case 'candidate-pair': {
        const rtt = num(s.currentRoundTripTime);
        if (rtt !== undefined) {
          if (s.nominated) rttNominated = rtt * 1000;
          else if (rttFallback === undefined) rttFallback = rtt * 1000;
        }
        break;
      }
    }
  }

  return { tMs, rttMs: rttNominated ?? rttFallback, outbound, remoteInbound };
}

export type RtcOutboundRate = {
  kind: 'audio' | 'video';
  kbps: number;
  fps?: number;
  encodeMsPerFrame?: number;
  qualityLimitationReason?: string;
  resolution?: string; // e.g. "320x240"
};

export type RtcRates = {
  dtMs: number;
  rttMs?: number;
  packetLossPct?: number; // aggregate over all senders this interval
  outbound: RtcOutboundRate[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

// Pure: turn two snapshots into human-friendly per-second rates. Senders are
// matched across snapshots by ssrc (so a camera and a screen share, both
// kind 'video', stay distinct). Counters that only appear once yield undefined.
export function diffRtcStats(prev: RtcSnapshot, cur: RtcSnapshot): RtcRates {
  const dtMs = Math.max(1, cur.tMs - prev.tMs);
  const dtS = dtMs / 1000;

  const outbound: RtcOutboundRate[] = cur.outbound.map((o) => {
    const p = prev.outbound.find((x) => x.ssrc === o.ssrc);
    // Clamp counter deltas to >= 0 (mirrors the loss aggregation below): an ssrc
    // reuse / ICE restart can match a fresh low-counter sender against an older
    // snapshot, which would otherwise show a spurious negative rate for one tick.
    const kbps = p ? round1((Math.max(0, o.bytesSent - p.bytesSent) * 8) / dtS / 1000) : 0;
    let fps: number | undefined;
    let encodeMsPerFrame: number | undefined;
    if (p && o.framesEncoded !== undefined && p.framesEncoded !== undefined) {
      const df = Math.max(0, o.framesEncoded - p.framesEncoded);
      fps = round1(df / dtS);
      if (df > 0 && o.totalEncodeTime !== undefined && p.totalEncodeTime !== undefined) {
        encodeMsPerFrame = round1(((o.totalEncodeTime - p.totalEncodeTime) * 1000) / df);
      }
    }
    return {
      kind: o.kind,
      kbps,
      fps,
      encodeMsPerFrame,
      qualityLimitationReason: o.qualityLimitationReason,
      resolution:
        o.frameWidth && o.frameHeight ? `${o.frameWidth}x${o.frameHeight}` : undefined,
    };
  });

  // Aggregate loss: receiver-reported lost packets over packets we sent.
  let lostDelta = 0;
  for (const ri of cur.remoteInbound) {
    const p = prev.remoteInbound.find((x) => x.ssrc === ri.ssrc);
    if (p) lostDelta += Math.max(0, ri.packetsLost - p.packetsLost);
  }
  let sentDelta = 0;
  for (const o of cur.outbound) {
    const p = prev.outbound.find((x) => x.ssrc === o.ssrc);
    if (p) sentDelta += Math.max(0, o.packetsSent - p.packetsSent);
  }
  const packetLossPct = sentDelta > 0 ? round1((lostDelta / sentDelta) * 100) : undefined;

  return {
    dtMs,
    rttMs: cur.rttMs !== undefined ? round1(cur.rttMs) : undefined,
    packetLossPct,
    outbound,
  };
}

// Pure: a compact one-line summary for console logging.
export function formatRtcRates(userId: string, rates: RtcRates): string {
  const head =
    `[rtcstats] ${userId.slice(0, 8)} rtt=${rates.rttMs ?? '?'}ms ` +
    `loss=${rates.packetLossPct ?? '?'}%`;
  const streams = rates.outbound
    .map((o) => {
      const parts = [`${o.kind} ${o.kbps}kbps`];
      if (o.fps !== undefined) parts.push(`${o.fps}fps`);
      if (o.resolution) parts.push(o.resolution);
      if (o.encodeMsPerFrame !== undefined) parts.push(`enc=${o.encodeMsPerFrame}ms`);
      if (o.qualityLimitationReason && o.qualityLimitationReason !== 'none') {
        parts.push(`limit=${o.qualityLimitationReason}`);
      }
      return parts.join(' ');
    })
    .join(' | ');
  return streams ? `${head} :: ${streams}` : head;
}
