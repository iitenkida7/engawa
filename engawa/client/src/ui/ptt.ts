// Push-to-talk. While on, a live mic stays silent until the PTT key is held:
// the capture itself keeps running (no getUserMedia round trip, so the first
// syllable is not clipped) and only its tracks are enabled/disabled.

export const PTT_STORAGE_KEY = 'engawa-ptt';

// Space: a large key that no other shortcut uses (the letter keys walk or
// toggle things — see core/shortcuts.ts and world/input.ts).
export const PTT_KEY = ' ';

// Off unless explicitly enabled: only '1' turns it on, since push-to-talk
// silences a live mic and nobody should be muted by a setting they never chose.
export function parsePttSetting(stored: string | null): boolean {
  return stored === '1';
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
// browser/OS (Ctrl+Space input-source switch), and mid-IME keystrokes belong to
// the IME (Space picks a conversion candidate).
export function isPttKey(e: PttKeyEvent): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
  if (e.isComposing) return false;
  return e.key === PTT_KEY;
}
