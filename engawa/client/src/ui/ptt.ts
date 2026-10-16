// Push-to-talk (experimental). While active, a live mic stays silent until the
// PTT key is held: the capture itself keeps running (no getUserMedia round trip,
// so the first syllable is not clipped) and only its tracks are enabled/disabled.
// Gated by the experimental master switch like the other experiments (ui/experimental.ts).

export const PTT_STORAGE_KEY = 'engawa-ptt';

// 'v' is also the meeting-view shortcut; while push-to-talk is active the key
// belongs to PTT (the App skips the shortcut table for it).
export const PTT_KEY = 'v';

// Per-feature switch, default on: only an explicit '0' disables it (same
// convention as face-pip). It only matters once the user has opted into
// experimental features as a whole.
export function parsePttSetting(stored: string | null): boolean {
  return stored !== '0';
}

// The parts of a KeyboardEvent the check reads (structural, so tests can pass a
// plain object).
export type PttKeyEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

// Whether this key event is the bare PTT key. Modifier combos belong to the
// browser/OS (Cmd+V paste), and mid-IME keystrokes belong to the IME.
export function isPttKey(e: PttKeyEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.isComposing) return false;
  return e.key.toLowerCase() === PTT_KEY;
}
