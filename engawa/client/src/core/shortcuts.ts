import { REACTION_EMOJIS } from '@/core/types';

// Keyboard shortcuts (issue #297). The key → action table is a pure function so
// it can be tested without a DOM; the App performs the action it returns.
// Movement keys are NOT here — they're held-state, owned by world/input.ts.
export type Shortcut =
  | { action: 'meeting-view' | 'zoom' | 'mic' | 'cam' | 'screen' | 'record' | 'roster' }
  // Index into REACTION_EMOJIS, from the 1-6 number row.
  | { action: 'reaction'; index: number };

// The parts of a KeyboardEvent the table reads. Structural so tests can pass a
// plain object instead of synthesising events.
export type ShortcutKeyEvent = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
};

export function resolveShortcut(e: ShortcutKeyEvent): Shortcut | null {
  // Modifier combos belong to the browser/OS — Cmd+Z undo, Cmd+M minimize,
  // Cmd+1 switch tab. Never shadow them (the reaction keys used to: Cmd+1 both
  // changed tab and fired 👋).
  if (e.metaKey || e.ctrlKey || e.altKey) return null;
  // Auto-repeat would mash a toggle for as long as the key is held.
  if (e.repeat) return null;
  // Mid-conversion keystrokes belong to the IME, not to us.
  if (e.isComposing) return null;

  // Lowercased like world/input.ts, so Caps Lock doesn't silently kill the
  // shortcuts.
  const key = e.key.toLowerCase();

  // Recording announces itself to everyone in the call (issue #293), so it is
  // the one binding that takes Shift: a stray keypress must not start it.
  // Shift + anything else is deliberately dead rather than falling through to
  // the bare-key table (Shift+M is not "show map").
  if (e.shiftKey) return key === 'r' ? { action: 'record' } : null;

  switch (key) {
    case 'm':
      return { action: 'meeting-view' };
    case 'z':
      return { action: 'zoom' };
    case 'a':
      return { action: 'mic' };
    case 'c':
      return { action: 'cam' };
    case 's':
      return { action: 'screen' };
    case 'p':
      return { action: 'roster' };
  }

  const n = Number(key);
  if (Number.isInteger(n) && n >= 1 && n <= REACTION_EMOJIS.length) {
    return { action: 'reaction', index: n - 1 };
  }
  return null;
}

// The printed table behind the ⋯ menu's "keyboard shortcuts" panel. It lives
// next to the resolver so the list people read and the table the app obeys
// can't drift apart. Each entry renders one row: `keys` becomes a chip each
// (a combo is one chip, "Shift + R"), `labelKey` is looked up with t().
export const SHORTCUT_HELP: { keys: string[]; labelKey: string }[] = [
  { keys: ['H', 'J', 'K', 'L'], labelKey: 'keys.move' },
  { keys: ['←', '↓', '↑', '→'], labelKey: 'keys.moveArrows' },
  { keys: ['M'], labelKey: 'keys.meetingView' },
  { keys: ['Z'], labelKey: 'keys.zoom' },
  { keys: ['A'], labelKey: 'keys.mic' },
  { keys: ['C'], labelKey: 'keys.cam' },
  { keys: ['S'], labelKey: 'keys.screen' },
  { keys: ['Shift + R'], labelKey: 'keys.record' },
  { keys: ['P'], labelKey: 'keys.roster' },
  { keys: [`1–${REACTION_EMOJIS.length}`], labelKey: 'keys.reaction' },
  { keys: ['Esc'], labelKey: 'keys.focusOut' },
];
