import { REACTION_EMOJIS } from '@/core/types';

// Keyboard shortcuts (issue #297). The key → action table is a pure function so
// it can be tested without a DOM; the App performs the action it returns.
// Movement keys are NOT here — they're held-state, owned by world/input.ts.
export type Shortcut =
  | {
      action:
        | 'meeting-view'
        | 'map-view'
        | 'zoom'
        | 'mic'
        | 'cam'
        | 'screen'
        | 'record'
        | 'roster'
        | 'help';
    }
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

  // '?' is Shift+/ on most layouts, so it is read before the Shift branch below.
  if (key === '?') return { action: 'help' };

  // The one rule worth remembering: a bare key only affects you, Shift means
  // everyone in the call sees it (issue #302). Recording announces itself
  // (issue #293) and a screen share puts your desktop on their tiles — neither
  // should ever fire from a stray keypress. Shift + anything else is
  // deliberately dead rather than falling through to the bare-key table
  // (Shift+M is not "mic").
  if (e.shiftKey) {
    if (key === 'r') return { action: 'record' };
    if (key === 's') return { action: 'screen' };
    return null;
  }

  // Bare keys stay off w/a/s/d and h/j/k/l — those twelve walk (world/input.ts).
  switch (key) {
    case 'm':
      return { action: 'mic' };
    case 'c':
      return { action: 'cam' };
    case 'v':
      return { action: 'meeting-view' };
    case 'z':
      return { action: 'zoom' };
    case 'p':
      return { action: 'roster' };
    // One-way "back to the map" from the immersive meeting view. Unlike 'v' it
    // never flips back, so Esc can't drop you INTO a meeting. Overlays that use
    // Esc themselves (key help, a maximized window) claim it first by calling
    // preventDefault, and the App skips it then.
    case 'escape':
      return { action: 'map-view' };
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
  { keys: ['←', '↓', '↑', '→'], labelKey: 'keys.moveArrows' },
  { keys: ['H', 'J', 'K', 'L'], labelKey: 'keys.move' },
  { keys: ['W', 'A', 'S', 'D'], labelKey: 'keys.moveWasd' },
  { keys: ['M'], labelKey: 'keys.mic' },
  { keys: ['Space'], labelKey: 'keys.ptt' },
  { keys: ['C'], labelKey: 'keys.cam' },
  { keys: ['V'], labelKey: 'keys.meetingView' },
  { keys: ['Z'], labelKey: 'keys.zoom' },
  { keys: ['P'], labelKey: 'keys.roster' },
  { keys: [`1–${REACTION_EMOJIS.length}`], labelKey: 'keys.reaction' },
  { keys: ['Shift + S'], labelKey: 'keys.screen' },
  { keys: ['Shift + R'], labelKey: 'keys.record' },
  { keys: ['R'], labelKey: 'keys.rotate' },
  { keys: ['?'], labelKey: 'keys.help' },
  { keys: ['Esc'], labelKey: 'keys.escape' },
];
