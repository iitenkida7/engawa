// How many enter/leave chimes may start close together. A crowd walking in or out
// at once would otherwise stack a dozen chimes on top of each other, summing past
// full scale (the crackle) and reading as noise anyway: the first couple say
// "somebody came / went", the rest add nothing.

export const CHIME_WINDOW_MS = 600;
export const CHIME_MAX_IN_WINDOW = 2;

/**
 * Decide whether a chime starting at `now` may play, given the start times of the
 * recent ones. Returns the verdict and the history to keep (old entries dropped;
 * `now` added only when it plays). Pure, so the policy is testable without audio.
 */
export function admitChime(
  history: number[],
  now: number,
  windowMs: number = CHIME_WINDOW_MS,
  max: number = CHIME_MAX_IN_WINDOW,
): { ok: boolean; history: number[] } {
  const live = history.filter((t) => now - t < windowMs);
  if (live.length >= max) return { ok: false, history: live };
  return { ok: true, history: [...live, now] };
}
