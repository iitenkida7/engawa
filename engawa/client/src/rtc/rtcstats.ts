// getStats-based telemetry. There is no telemetry backend — this exists purely
// to give visibility while tuning the call (bitrate ceilings, jitter buffer,
// codec choice are otherwise set blind). webrtc.ts / sfu.ts poll
// RTCPeerConnection.getStats(); the App surfaces the per-second diff in the
// debug console modal (debug-console.ts), opened from the toolbar 🐛 button.
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
  // 'none' | 'cpu' | 'bandwidth' | 'other' — the single most useful signal:
  // is the encoder capped by CPU or by available bandwidth?
  qualityLimitationReason?: string;
  frameWidth?: number;
  frameHeight?: number;
  codec?: string; // resolved short name, e.g. 'VP8' / 'opus'
};

// A single receiver's cumulative counters at one poll (what we pull from a peer).
export type RtcInbound = {
  ssrc: number;
  kind: 'audio' | 'video';
  trackId?: string; // trackIdentifier — used to attribute SFU tracks to a peer
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  framesDecoded?: number;
  jitter?: number; // seconds
  frameWidth?: number;
  frameHeight?: number;
  codec?: string;
};

// The remote receiver's report back about one of our senders (send-side loss
// and jitter live here).
export type RtcRemoteInbound = {
  ssrc: number;
  kind: 'audio' | 'video';
  packetsLost: number;
  jitter?: number; // seconds
};

export type RtcSnapshot = {
  tMs: number; // representative timestamp (max across entries)
  rttMs?: number;
  // ICE candidate types of the nominated pair ('host'|'srflx'|'prflx'|'relay'),
  // used to tell a direct P2P path from a TURN relay — the latter adds a hop and
  // is the prime suspect when an internet call feels laggy (#146).
  localCandidateType?: string;
  remoteCandidateType?: string;
  outbound: RtcOutbound[];
  inbound: RtcInbound[];
  remoteInbound: RtcRemoteInbound[];
};

// We only read a handful of fields; accept any stat-shaped record so the pure
// functions stay testable with plain objects.
type StatLike = Record<string, unknown>;

function num(v: unknown): number | undefined {
  return typeof v === 'number' ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

// 'video/VP8' → 'VP8'. Pure helper for codec name display.
function shortCodec(mime: string | undefined): string | undefined {
  if (!mime) return undefined;
  const slash = mime.indexOf('/');
  return slash >= 0 ? mime.slice(slash + 1) : mime;
}

// Pure: collapse a getStats report (any iterable of stat entries) into the
// counters we care about. Unknown/irrelevant entry types are ignored. Codec
// names are resolved from the 'codec' entries referenced by codecId.
export function summarizeRtcStats(stats: Iterable<StatLike>): RtcSnapshot {
  const outbound: RtcOutbound[] = [];
  const inbound: RtcInbound[] = [];
  const remoteInbound: RtcRemoteInbound[] = [];
  // codec stat id → short codec name, plus the codecId each rtp entry references
  // (resolved after the loop since stat order is not guaranteed).
  const codecs = new Map<string, string>();
  const outCodecId: (string | undefined)[] = [];
  const inCodecId: (string | undefined)[] = [];
  let tMs = 0;
  let rttNominated: number | undefined;
  let rttFallback: number | undefined;
  // candidate stat id → candidateType, plus the nominated pair's local/remote
  // candidate ids (resolved after the loop, since stat order is not guaranteed).
  const candidateTypes = new Map<string, string>();
  let nominatedLocalId: string | undefined;
  let nominatedRemoteId: string | undefined;

  for (const s of stats) {
    const ts = num(s.timestamp);
    if (ts !== undefined && ts > tMs) tMs = ts;

    switch (s.type) {
      case 'codec': {
        const id = str(s.id);
        if (id) codecs.set(id, shortCodec(str(s.mimeType)) ?? '');
        break;
      }
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
        outCodecId.push(str(s.codecId));
        break;
      case 'inbound-rtp':
        inbound.push({
          ssrc: num(s.ssrc) ?? 0,
          kind: s.kind === 'audio' ? 'audio' : 'video',
          trackId: str(s.trackIdentifier),
          bytesReceived: num(s.bytesReceived) ?? 0,
          packetsReceived: num(s.packetsReceived) ?? 0,
          packetsLost: num(s.packetsLost) ?? 0,
          framesDecoded: num(s.framesDecoded),
          jitter: num(s.jitter),
          frameWidth: num(s.frameWidth),
          frameHeight: num(s.frameHeight),
        });
        inCodecId.push(str(s.codecId));
        break;
      case 'remote-inbound-rtp':
        remoteInbound.push({
          ssrc: num(s.ssrc) ?? 0,
          kind: s.kind === 'audio' ? 'audio' : 'video',
          packetsLost: num(s.packetsLost) ?? 0,
          jitter: num(s.jitter),
        });
        break;
      case 'local-candidate':
      case 'remote-candidate': {
        const id = str(s.id);
        const type = str(s.candidateType);
        if (id && type) candidateTypes.set(id, type);
        break;
      }
      case 'candidate-pair': {
        const rtt = num(s.currentRoundTripTime);
        if (rtt !== undefined) {
          if (s.nominated) rttNominated = rtt * 1000;
          else if (rttFallback === undefined) rttFallback = rtt * 1000;
        }
        if (s.nominated) {
          nominatedLocalId = str(s.localCandidateId);
          nominatedRemoteId = str(s.remoteCandidateId);
        }
        break;
      }
    }
  }

  outbound.forEach((o, i) => {
    const id = outCodecId[i];
    if (id) o.codec = codecs.get(id) || undefined;
  });
  inbound.forEach((o, i) => {
    const id = inCodecId[i];
    if (id) o.codec = codecs.get(id) || undefined;
  });

  return {
    tMs,
    rttMs: rttNominated ?? rttFallback,
    localCandidateType: nominatedLocalId ? candidateTypes.get(nominatedLocalId) : undefined,
    remoteCandidateType: nominatedRemoteId ? candidateTypes.get(nominatedRemoteId) : undefined,
    outbound,
    inbound,
    remoteInbound,
  };
}

// Pure: a short label for the transport path from the nominated pair's candidate
// types. Either end being a TURN relay means media takes an extra hop (higher
// latency) — flagged explicitly; anything else is a direct P2P path, tagged with
// the local candidate type (host = same LAN, srflx/prflx = NAT-traversed).
// Returns undefined until the pair is known (no candidate-pair stat yet).
export function describeTransport(
  localType: string | undefined,
  remoteType: string | undefined,
): string | undefined {
  if (!localType && !remoteType) return undefined;
  if (localType === 'relay' || remoteType === 'relay') return 'TURN中継';
  return `P2P(${localType ?? remoteType})`;
}

// One stream's human-friendly per-second rates, in either direction.
export type RtcStreamRate = {
  dir: 'send' | 'recv';
  kind: 'audio' | 'video';
  ssrc: number;
  trackId?: string; // recv only; lets the SFU attribute the stream to a peer
  kbps: number;
  fps?: number;
  resolution?: string; // e.g. "320x240"
  codec?: string;
  encodeMsPerFrame?: number; // send only
  qualityLimitationReason?: string; // send only
  packetLossPct?: number;
  jitterMs?: number;
};

export type RtcConnRates = {
  dtMs: number;
  rttMs?: number;
  transport?: string; // 'TURN中継' | 'P2P(...)' — see describeTransport
  streams: RtcStreamRate[];
};

// A logical connection's stats as shown in the debug console. For the mesh this
// is one peer (its own PC); for the SFU it is one remote peer's pulled tracks,
// plus a synthetic upstream entry for our own published tracks (labelled).
export type RtcConn = {
  id: string; // remote userId, or a sentinel for the SFU upstream/unknown
  label?: string; // overrides the resolved peer name (SFU synthetic entries)
  rttMs?: number;
  transport?: string; // 'TURN中継' | 'P2P(...)' — see describeTransport
  streams: RtcStreamRate[];
};

const round1 = (n: number) => Math.round(n * 10) / 10;

// Pure: turn two snapshots into per-second send/recv rates. Streams are matched
// across snapshots by ssrc (so a camera and a screen share, both kind 'video',
// stay distinct). Counters that only appear once yield 0/undefined. Counter
// deltas are clamped to >= 0: an ssrc reuse / ICE restart can match a fresh
// low-counter stream against an older snapshot, which would otherwise show a
// spurious negative rate for one tick.
export function diffRtcStats(prev: RtcSnapshot, cur: RtcSnapshot): RtcConnRates {
  const dtMs = Math.max(1, cur.tMs - prev.tMs);
  const dtS = dtMs / 1000;
  const streams: RtcStreamRate[] = [];

  for (const o of cur.outbound) {
    const p = prev.outbound.find((x) => x.ssrc === o.ssrc);
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
    // Send-side loss/jitter come from the receiver's report (remote-inbound-rtp).
    const ri = cur.remoteInbound.find((x) => x.ssrc === o.ssrc);
    const rip = ri ? prev.remoteInbound.find((x) => x.ssrc === o.ssrc) : undefined;
    let packetLossPct: number | undefined;
    if (ri && rip && p) {
      const lost = Math.max(0, ri.packetsLost - rip.packetsLost);
      const sent = Math.max(0, o.packetsSent - p.packetsSent);
      if (sent > 0) packetLossPct = round1((lost / sent) * 100);
    }
    streams.push({
      dir: 'send',
      kind: o.kind,
      ssrc: o.ssrc,
      kbps,
      fps,
      encodeMsPerFrame,
      qualityLimitationReason: o.qualityLimitationReason,
      resolution: o.frameWidth && o.frameHeight ? `${o.frameWidth}x${o.frameHeight}` : undefined,
      codec: o.codec,
      packetLossPct,
      jitterMs: ri?.jitter !== undefined ? round1(ri.jitter * 1000) : undefined,
    });
  }

  for (const o of cur.inbound) {
    const p = prev.inbound.find((x) => x.ssrc === o.ssrc);
    const kbps = p ? round1((Math.max(0, o.bytesReceived - p.bytesReceived) * 8) / dtS / 1000) : 0;
    let fps: number | undefined;
    if (p && o.framesDecoded !== undefined && p.framesDecoded !== undefined) {
      fps = round1(Math.max(0, o.framesDecoded - p.framesDecoded) / dtS);
    }
    // Receive-side loss: lost / (lost + received) over the interval.
    let packetLossPct: number | undefined;
    if (p) {
      const lost = Math.max(0, o.packetsLost - p.packetsLost);
      const recv = Math.max(0, o.packetsReceived - p.packetsReceived);
      if (lost + recv > 0) packetLossPct = round1((lost / (lost + recv)) * 100);
    }
    streams.push({
      dir: 'recv',
      kind: o.kind,
      ssrc: o.ssrc,
      trackId: o.trackId,
      kbps,
      fps,
      resolution: o.frameWidth && o.frameHeight ? `${o.frameWidth}x${o.frameHeight}` : undefined,
      codec: o.codec,
      packetLossPct,
      jitterMs: o.jitter !== undefined ? round1(o.jitter * 1000) : undefined,
    });
  }

  return {
    dtMs,
    rttMs: cur.rttMs !== undefined ? round1(cur.rttMs) : undefined,
    transport: describeTransport(cur.localCandidateType, cur.remoteCandidateType),
    streams,
  };
}

// Pure: the chips shown for one stream row in the debug console (kept here, and
// unit-tested, so the DOM in debug-console.ts stays a thin renderer).
export function describeStream(s: RtcStreamRate): string[] {
  const chips = [`${s.kbps} kbps`];
  if (s.fps !== undefined) chips.push(`${s.fps} fps`);
  if (s.resolution) chips.push(s.resolution);
  if (s.codec) chips.push(s.codec);
  if (s.packetLossPct !== undefined) chips.push(`loss ${s.packetLossPct}%`);
  if (s.jitterMs !== undefined) chips.push(`jitter ${s.jitterMs}ms`);
  if (s.encodeMsPerFrame !== undefined) chips.push(`enc ${s.encodeMsPerFrame}ms`);
  if (s.qualityLimitationReason && s.qualityLimitationReason !== 'none') {
    chips.push(`制限:${s.qualityLimitationReason}`);
  }
  return chips;
}
