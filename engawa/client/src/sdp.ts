// Aggressive low-latency Opus tuning applied during offer/answer.
//
// Per-codec fmtp parameters (RFC 7587):
//   minptime=10
//     Floor for packetization. Default in Chrome is also 10ms but we set it
//     explicitly so a peer that asked for 20ms doesn't pull us up.
//   useinbandfec=1
//     In-band FEC: each Opus frame carries redundant data for the previous
//     frame. Single-packet loss is recovered without retransmission. Costs
//     ~one frame of decode latency on lost packets (~10ms at ptime=10), but
//     prevents audible dropouts over Wi-Fi / consumer ISPs.
//   usedtx=0
//     Disables discontinuous transmission (silence suppression). DTX causes
//     a few-frame restart blip at the start of speech, so we keep it off.
//   stereo=0 / sprop-stereo=0
//     Mono. Stereo doubles bandwidth without helping voice intelligibility.
//
// Media-level SDP attributes (RFC 4566, separate from fmtp):
//   a=ptime:10        target packet duration
//   a=maxptime:10     hard cap on packet duration
//
// Together these cap audio framing at 10ms (default is 20ms), halving the
// packetization buffer.
const OPUS_LOW_LATENCY_FMTP = [
  'minptime=10',
  'useinbandfec=1',
  'usedtx=0',
  'stereo=0',
  'sprop-stereo=0',
].join(';');

const PTIME_MS = 10;

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
