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
export const PLAYOUT_DELAY_HINT_S = 0.1; // 100ms (seconds)
export const JITTER_BUFFER_TARGET_MS = 100;

// Pin one receiver's playout/jitter buffer to the low-latency floor. Both
// properties are non-standard (Chrome) and silently absent elsewhere, so each
// assignment is guarded. Used per-receiver by the SFU 'track' handler and over
// every receiver by the mesh (tuneReceivers below).
export function tuneReceiver(receiver: RTCRtpReceiver) {
  try {
    (receiver as unknown as { playoutDelayHint: number }).playoutDelayHint = PLAYOUT_DELAY_HINT_S;
  } catch {
    /* unsupported */
  }
  try {
    (receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget =
      JITTER_BUFFER_TARGET_MS;
  } catch {
    /* unsupported */
  }
}

// Apply the receiver floor to every receiver on a PC (mesh: one PC per peer).
export function tuneReceivers(pc: RTCPeerConnection) {
  for (const r of pc.getReceivers()) tuneReceiver(r);
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
