// Why a remote camera tile went dark (issue #312). Pure: the RemoteMediaView
// tracks, per tile, when the last video frame rendered (requestVideoFrameCallback)
// and whether the receive track is muted (no RTP arriving), and folds that
// through classifyStall on a slow tick to pick the label shown over the tile.
//
// A stall has three plausible causes, and the user only needs to know which:
//  - we just asked the SFU for another simulcast layer and are waiting on its
//    keyframe (cosmetic, over in a moment);
//  - our own downlink is congested (the quality ladder already says so);
//  - otherwise the sender's side is the one not delivering.

export type StallReason = 'layer-switch' | 'my-network' | 'peer-network';

// No rendered frame for this long counts as a stall. Longer than a normal
// keyframe interval so a regular low-fps picture never trips it.
export const STALL_MS = 1500;
// A freshly attached stream may take a while to deliver its first frame (the
// pull round-trip, the keyframe request): don't call that a stall right away.
export const STALL_ATTACH_GRACE_MS = 3000;
// A stall starting within this long of a layer request is blamed on the switch.
export const LAYER_SWITCH_WINDOW_MS = 4000;

export type StallInput = {
  // Milliseconds since the last rendered frame; Infinity when the track is
  // muted (the browser saw no packets at all), -Infinity when frames cannot be
  // observed (no requestVideoFrameCallback) so only mute can flag a stall.
  stalledMs: number;
  // Milliseconds since we last changed the requested simulcast layer, or null
  // if we never did (mesh, or no change yet).
  sinceLayerSwitchMs: number | null;
  // Our own network tier (rtc/netquality): ≥2 means our downlink is suspect.
  myTier: number;
};

export function classifyStall(input: StallInput): StallReason | null {
  if (input.stalledMs < STALL_MS) return null;
  if (input.sinceLayerSwitchMs !== null && input.sinceLayerSwitchMs < LAYER_SWITCH_WINDOW_MS) {
    return 'layer-switch';
  }
  return input.myTier >= 2 ? 'my-network' : 'peer-network';
}

// The i18n key for a reason's overlay label.
export function stallLabelKey(reason: StallReason): string {
  return `media.stall.${reason}`;
}
