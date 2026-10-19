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
//
// classifyStall judges one tick; updateStallState folds those judgements into
// what is actually shown, with the hysteresis that keeps the overlay still.

export type StallReason = 'layer-switch' | 'my-network' | 'peer-network';

// No rendered frame for this long counts as a stall. Well past a normal
// keyframe interval (SFU camera layers all run at 15fps) so a brief hiccup in
// healthy video never trips it; a genuine outage is flagged sooner anyway,
// through the track's mute event.
export const STALL_MS = 3000;
// A freshly attached stream may take a while to deliver its first frame (the
// pull round-trip, the keyframe request): don't call that a stall right away.
export const STALL_ATTACH_GRACE_MS = 3000;
// A stall starting within this long of a layer request is blamed on the switch.
export const LAYER_SWITCH_WINDOW_MS = 4000;
// Frames must keep coming for this long before the label goes away. Without it
// a link that delivers one frame every couple of seconds blinks the overlay on
// and off (the stall threshold alone is one-sided).
export const STALL_CLEAR_MS = 1500;

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

export type StallState = {
  // The reason on show (null = no overlay).
  reason: StallReason | null;
  // When frames started arriving again during the current stall, or null while
  // nothing is arriving. The label clears once this is STALL_CLEAR_MS old.
  clearingSince: number | null;
};

export const INITIAL_STALL_STATE: StallState = { reason: null, clearingSince: null };

// Pure: fold one tick's classification into what the tile shows (same shape as
// netquality's updateTierState). Two kinds of stillness:
//  - the reason is latched for the whole stall, so the text does not swap
//    under the reader when our tier crosses 2 — the one exception is
//    escalating away from 'layer-switch', since a keyframe wait that outlives
//    its window was really a network problem all along;
//  - clearing waits for STALL_CLEAR_MS of frames, so a trickle of stray frames
//    cannot flash the overlay off and straight back on.
export function updateStallState(
  state: StallState,
  candidate: StallReason | null,
  now: number,
): StallState {
  if (candidate !== null) {
    if (state.reason === null) return { reason: candidate, clearingSince: null };
    const reason =
      state.reason === 'layer-switch' && candidate !== 'layer-switch' ? candidate : state.reason;
    return { reason, clearingSince: null };
  }
  if (state.reason === null) return state;
  if (state.clearingSince === null) return { reason: state.reason, clearingSince: now };
  if (now - state.clearingSince >= STALL_CLEAR_MS) return INITIAL_STALL_STATE;
  return state;
}

// The i18n key for a reason's overlay label.
export function stallLabelKey(reason: StallReason): string {
  return `media.stall.${reason}`;
}
