// Shared WebRTC transport tuning used by BOTH paths (mesh: webrtc.ts, SFU:
// sfu.ts). These knobs are not pure logic, but keeping them in one place avoids
// the two transports drifting apart — the SFU path historically shipped without
// the receiver jitter-buffer floor and sender priority the mesh already had,
// which is exactly the kind of latency regression this module prevents (#146).

import type { StreamKind } from '@/core/types';

// Receiver playout/jitter buffer floor. Lower = less perceived lag, but small
// jitter bursts cause clicks. The low-latency recommendation is to start around
// 100–150ms; we use 100ms — well below Chrome's adaptive default but high
// enough to survive typical Wi-Fi / consumer ISP jitter without underrun clicks
// (50ms was too aggressive for that).
export const JITTER_BUFFER_TARGET_MS = 100;
// Ceiling for the ADAPTIVE target (issue #188): on a high-jitter link (busy
// Wi-Fi, mobile) a fixed 100ms floor turns straight into audio dropouts, so the
// App raises the target from measured receive jitter, up to this bound (any
// higher and the added mouth-to-ear delay wrecks conversation itself).
export const JITTER_BUFFER_TARGET_MAX_MS = 300;

// Pure (issue #188): the jitter-buffer target for a measured receive jitter.
// Roughly 2.5× headroom over the measured jitter, snapped to coarse steps so
// the buffer isn't re-targeted on every sample, and clamped to
// [JITTER_BUFFER_TARGET_MS, JITTER_BUFFER_TARGET_MAX_MS]. Unknown jitter (no
// audio flowing yet) keeps the low-latency floor.
export function computeJitterTargetMs(jitterMs: number | undefined): number {
  if (jitterMs === undefined || jitterMs < 40) return JITTER_BUFFER_TARGET_MS;
  if (jitterMs < 80) return 150;
  if (jitterMs < 120) return 220;
  return JITTER_BUFFER_TARGET_MAX_MS;
}

// Pin one receiver's playout/jitter buffer to the given target (default: the
// low-latency floor). Both properties are non-standard (Chrome) and silently
// absent elsewhere, so each assignment is guarded. Used per-receiver by the SFU
// 'track' handler and over every receiver by the mesh (tuneReceivers below).
export function tuneReceiver(receiver: RTCRtpReceiver, targetMs: number = JITTER_BUFFER_TARGET_MS) {
  try {
    (receiver as unknown as { playoutDelayHint: number }).playoutDelayHint = targetMs / 1000;
  } catch {
    /* unsupported */
  }
  try {
    (receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget = targetMs;
  } catch {
    /* unsupported */
  }
}

// Apply a receiver target to every receiver on a PC (mesh: one PC per peer).
export function tuneReceivers(pc: RTCPeerConnection, targetMs: number = JITTER_BUFFER_TARGET_MS) {
  for (const r of pc.getReceivers()) tuneReceiver(r, targetMs);
}

// Per-kind sender priority + congestion-degradation policy for the SFU upstream.
// The mesh sets these in webrtc.ts/tuneSenders alongside its dynamic bitrate
// ceilings; the SFU sets its bitrate ceilings via sendEncodings at addTransceiver
// time, so this only needs to layer on the priority/degradation half:
//   - mic: highest network priority so voice is never starved by video under
//     congestion (audio latency is what wrecks a conversation first).
//   - cam: 'balanced' — drop both resolution and framerate as needed.
//   - screen: 'maintain-resolution' — contentHint='detail' wants crisp text, so
//     under congestion shed framerate, not resolution.
// Seamless (no renegotiation), and every field is best-effort: a setParameters
// failure must not tear the SFU transport down, so the caller swallows errors.
export async function tuneSfuSender(sender: RTCRtpSender, kind: StreamKind) {
  const params = sender.getParameters();
  if (!params.encodings || params.encodings.length === 0) return;
  if (kind === 'mic') {
    const enc = params.encodings[0] as RTCRtpEncodingParameters & {
      networkPriority?: 'very-low' | 'low' | 'medium' | 'high';
      priority?: 'very-low' | 'low' | 'medium' | 'high';
    };
    enc.networkPriority = 'high';
    enc.priority = 'high';
  } else if (kind === 'cam') {
    params.degradationPreference = 'balanced';
  } else {
    params.degradationPreference = 'maintain-resolution';
  }
  await sender.setParameters(params);
}
