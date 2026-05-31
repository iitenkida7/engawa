// Low-latency Opus tuning applied during offer/answer.
//
// Per-codec fmtp parameters (RFC 7587):
//   minptime=10
//     The RFC floor we advertise for inbound frames (Chrome's default too). It
//     is effectively inert here: a=maxptime:20 (below) already bounds inbound
//     framing to 20ms. We leave it at the standard 10ms rather than tightening
//     it — keeps interop simple and does not affect the 20ms/LBRR intent.
//   useinbandfec=1
//     In-band FEC: each Opus frame carries redundant data for the previous
//     frame so single-packet loss is recovered without retransmission. Chrome
//     only inserts the cheap LBRR redundancy for 20ms frames — at 10ms it would
//     instead duplicate a full secondary frame (much higher overhead), so this
//     pairs specifically with ptime=20 below.
//   usedtx=0
//     Disables discontinuous transmission (silence suppression). DTX causes
//     a few-frame restart blip at the start of speech, so we keep it off.
//   stereo=0 / sprop-stereo=0
//     Mono. Stereo doubles bandwidth without helping voice intelligibility.
//
// Media-level SDP attributes (RFC 4566, separate from fmtp):
//   a=ptime:20        target packet duration
//   a=maxptime:20     hard cap on packet duration
//
// 20ms is the WebRTC default and the sweet spot: 10ms framing has worse coding
// efficiency, doubles the packet rate / header overhead, and (above) defeats
// Opus LBRR FEC. The ~10ms of extra packetization latency vs 10ms framing is
// negligible against the receiver jitter buffer and network RTT.
const OPUS_LOW_LATENCY_FMTP = [
  'minptime=10',
  'useinbandfec=1',
  'usedtx=0',
  'stereo=0',
  'sprop-stereo=0',
].join(';');

const PTIME_MS = 20;

// Preferred video codec. VP9 gives roughly −30% bitrate vs VP8 at equal
// quality; in the P2P mesh each camera/screen stream is encoded and sent per
// peer, so a lower per-stream bitrate directly relieves the per-peer uplink.
const PREFERRED_VIDEO_CODEC = 'VP9';

// Reorders the payload-type list of every `m=video` section so the preferred
// codec's payload types come first; the answerer picks the first codec it also
// supports. We only *reorder* — every codec the browser offered stays present —
// so a peer without VP9 (or a failed negotiation) gracefully falls back to the
// next codec without breaking the connection. Pure + idempotent, and composes
// with the Opus pass over disjoint sections (this touches m=video, the
// low-latency pass touches m=audio).
export function transformSdpPreferVideoCodec(
  sdp: string,
  codec: string = PREFERRED_VIDEO_CODEC,
): string {
  const lines = sdp.split(/\r?\n/);

  // Payload types whose rtpmap names the preferred codec (case-insensitive,
  // e.g. `a=rtpmap:98 VP9/90000`). There can be several (different profiles).
  const preferredPts = new Set<string>();
  const rtpmapRe = new RegExp(`^a=rtpmap:(\\d+)\\s+${codec}/`, 'i');
  for (const line of lines) {
    const m = line.match(rtpmapRe);
    if (m) preferredPts.add(m[1]);
  }
  // Codec not offered (e.g. older browser) → leave the SDP untouched.
  if (preferredPts.size === 0) return sdp;

  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('m=video ')) continue;
    // m=video <port> <proto> <pt1> <pt2> …  — keep the first three fields fixed
    // and move the preferred payload types to the front of the pt list.
    const parts = lines[i].split(' ');
    const header = parts.slice(0, 3);
    const pts = parts.slice(3);
    const preferred = pts.filter((pt) => preferredPts.has(pt));
    if (preferred.length === 0) continue;
    const rest = pts.filter((pt) => !preferredPts.has(pt));
    lines[i] = [...header, ...preferred, ...rest].join(' ');
  }

  return lines.join('\r\n');
}

// Single entry point applied to every offer/answer: low-latency Opus tuning for
// audio + VP9-preferred ordering for video. Two independent pure passes over
// disjoint m-sections, so their order does not matter.
export function transformSdp(sdp: string): string {
  return transformSdpPreferVideoCodec(transformSdpForLowLatency(sdp));
}

export function transformSdpForLowLatency(sdp: string): string {
  const lines = sdp.split(/\r?\n/);

  // Locate Opus payload types so we know which fmtp lines to touch.
  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = line.match(/^a=rtpmap:(\d+)\s+opus\//i);
    if (m) opusPts.add(m[1]);
  }
  if (opusPts.size === 0) return sdp;

  // Replace (or insert) fmtp lines for Opus payload types.
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^a=fmtp:(\d+)\s+(.*)$/);
    if (m && opusPts.has(m[1])) {
      lines[i] = `a=fmtp:${m[1]} ${OPUS_LOW_LATENCY_FMTP}`;
    }
  }
  for (const pt of opusPts) {
    if (!lines.some((l) => l.startsWith(`a=fmtp:${pt} `))) {
      const rtpmapIdx = lines.findIndex((l) => l.startsWith(`a=rtpmap:${pt} `));
      if (rtpmapIdx >= 0) {
        lines.splice(rtpmapIdx + 1, 0, `a=fmtp:${pt} ${OPUS_LOW_LATENCY_FMTP}`);
      }
    }
  }

  // Walk m-sections; for each `m=audio …` carrying Opus, drop any existing
  // ptime/maxptime lines and insert ours just before the next m-section.
  const out: string[] = [];
  let sectionStart = -1;
  let sectionIsOpusAudio = false;
  const flushSection = (endExclusive: number) => {
    if (sectionStart < 0 || !sectionIsOpusAudio) return;
    // strip existing ptime/maxptime in [sectionStart, endExclusive)
    for (let k = endExclusive - 1; k > sectionStart; k--) {
      if (/^a=(ptime|maxptime):/.test(out[k])) out.splice(k, 1);
    }
    // Insert ours right after the m= line.
    out.splice(sectionStart + 1, 0, `a=ptime:${PTIME_MS}`, `a=maxptime:${PTIME_MS}`);
  };

  for (const line of lines) {
    if (line.startsWith('m=')) {
      flushSection(out.length);
      sectionStart = out.length;
      sectionIsOpusAudio =
        line.startsWith('m=audio ') &&
        [...opusPts].some((pt) => line.split(' ').includes(pt));
    }
    out.push(line);
  }
  flushSection(out.length);

  return out.join('\r\n');
}
