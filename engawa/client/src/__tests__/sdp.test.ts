import { describe, expect, it } from 'bun:test';
import { transformSdpForLowLatency } from '../sdp';

const EXPECTED_FMTP = 'minptime=10;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0';

// Build an SDP with CRLF line endings (real SDP uses \r\n).
function sdp(lines: string[]): string {
  return lines.join('\r\n');
}

describe('transformSdpForLowLatency', () => {
  it('returns sdp unchanged when no opus rtpmap is present', () => {
    const input = sdp([
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 0 8',
      'a=rtpmap:0 PCMU/8000',
      'a=rtpmap:8 PCMA/8000',
    ]);
    expect(transformSdpForLowLatency(input)).toBe(input);
  });

  it('replaces an existing opus fmtp line with the low-latency params', () => {
    const input = sdp([
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=1',
    ]);
    const out = transformSdpForLowLatency(input);
    expect(out).toContain(`a=fmtp:111 ${EXPECTED_FMTP}`);
    // The original fmtp value must be gone.
    expect(out).not.toContain('a=fmtp:111 minptime=10;useinbandfec=1\r');
    expect(out.match(/a=fmtp:111 /g)?.length).toBe(1);
  });

  it('inserts a fmtp line right after the rtpmap when none exists', () => {
    const input = sdp([
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=rtcp-fb:111 transport-cc',
    ]);
    const lines = transformSdpForLowLatency(input).split('\r\n');
    const rtpmapIdx = lines.indexOf('a=rtpmap:111 opus/48000/2');
    expect(lines[rtpmapIdx + 1]).toBe(`a=fmtp:111 ${EXPECTED_FMTP}`);
  });

  it('inserts ptime/maxptime right after the m=audio line', () => {
    const input = sdp([
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
    ]);
    const lines = transformSdpForLowLatency(input).split('\r\n');
    const mIdx = lines.findIndex((l) => l.startsWith('m=audio '));
    expect(lines[mIdx + 1]).toBe('a=ptime:10');
    expect(lines[mIdx + 2]).toBe('a=maxptime:10');
  });

  it('replaces pre-existing ptime/maxptime values', () => {
    const input = sdp([
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=ptime:20',
      'a=maxptime:40',
    ]);
    const out = transformSdpForLowLatency(input);
    expect(out).toContain('a=ptime:10');
    expect(out).toContain('a=maxptime:10');
    expect(out).not.toContain('a=ptime:20');
    expect(out).not.toContain('a=maxptime:40');
    // Exactly one of each.
    expect(out.match(/a=ptime:/g)?.length).toBe(1);
    expect(out.match(/a=maxptime:/g)?.length).toBe(1);
  });

  it('does not add ptime to a non-opus audio section', () => {
    const input = sdp([
      'm=audio 9 UDP/TLS/RTP/SAVPF 0',
      'a=rtpmap:0 PCMU/8000',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
    ]);
    const lines = transformSdpForLowLatency(input).split('\r\n');
    // First section (PCMU) should not have a ptime injected after its m= line.
    const firstM = lines.indexOf('m=audio 9 UDP/TLS/RTP/SAVPF 0');
    expect(lines[firstM + 1]).toBe('a=rtpmap:0 PCMU/8000');
    // Opus section should.
    const opusM = lines.indexOf('m=audio 9 UDP/TLS/RTP/SAVPF 111');
    expect(lines[opusM + 1]).toBe('a=ptime:10');
  });

  it('handles LF-only input', () => {
    const input = ['m=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2'].join('\n');
    const out = transformSdpForLowLatency(input);
    expect(out).toContain(`a=fmtp:111 ${EXPECTED_FMTP}`);
    expect(out).toContain('a=ptime:10');
  });

  it('is idempotent: applying twice yields the same result', () => {
    const input = sdp([
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10',
      'a=ptime:20',
    ]);
    const once = transformSdpForLowLatency(input);
    const twice = transformSdpForLowLatency(once);
    expect(twice).toBe(once);
  });
});
