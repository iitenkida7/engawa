// Movement keys: the arrows, vim's hjkl, and WASD (issue #302) — all three
// dialects walk, so nobody has to learn someone else's. Those twelve keys are
// reserved for movement alone: the action shortcuts in core/shortcuts.ts stay
// off them, which is why mic moved to 'm' and screen share to Shift+S.

type Direction = 'up' | 'down' | 'left' | 'right';

// Every key that walks, mapped to the direction it walks in. One table per
// direction rather than per dialect, so adding a dialect is one line each.
const DIRECTION_OF: Record<string, Direction | undefined> = {
  arrowup: 'up',
  k: 'up',
  w: 'up',
  arrowdown: 'down',
  j: 'down',
  s: 'down',
  arrowleft: 'left',
  h: 'left',
  a: 'left',
  arrowright: 'right',
  l: 'right',
  d: 'right',
};
const MOVEMENT_KEYS = new Set(Object.keys(DIRECTION_OF));
const STEP_OF: Record<Direction, { dx: number; dy: number }> = {
  up: { dx: 0, dy: -1 },
  down: { dx: 0, dy: 1 },
  left: { dx: -1, dy: 0 },
  right: { dx: 1, dy: 0 },
};

export class InputManager {
  private keys = new Set<string>();
  // Held movement keys in press order (oldest first). Used by getStepDirection
  // so the most recently pressed direction wins (press Right while holding Up →
  // step right), which feels natural for grid-step movement (issue #206).
  private order: string[] = [];

  constructor() {
    window.addEventListener('keydown', (e) => {
      if (this.isTextInput(e.target)) return;
      // Ignore modifier combos — they're browser/OS shortcuts (Cmd+D, Ctrl+S,
      // Cmd/Alt+Arrow to navigate), not movement. Treating them as movement both
      // hijacks the shortcut (preventDefault) and, on macOS, sticks the key:
      // keyup for a letter is suppressed while Cmd is held, so the avatar would
      // walk indefinitely.
      // Shift is in that list too (issue #302): Shift+S shares the screen and
      // Shift+R records, so holding Shift must not also walk the avatar south.
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const key = e.key.toLowerCase();
      if (this.isMovementKey(key)) {
        if (!this.keys.has(key)) this.order.push(key);
        this.keys.add(key);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      // Always clear on keyup — even when focus has moved into a text input
      // between the keydown and this keyup (e.g. clicking the chat box while
      // holding a movement key). Filtering here would leave the key "held" and
      // the avatar walking; deleting a key that was never added is a harmless no-op.
      const key = e.key.toLowerCase();
      this.keys.delete(key);
      this.order = this.order.filter((k) => k !== key);
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.order = [];
    });
  }

  private isTextInput(target: EventTarget | null): boolean {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
  }

  private isMovementKey(k: string) {
    return MOVEMENT_KEYS.has(k);
  }

  // True when any of the keys bound to `dir` is currently held.
  private heldInDirection(dir: Direction): boolean {
    for (const key of this.keys) {
      if (DIRECTION_OF[key] === dir) return true;
    }
    return false;
  }

  getDirection(): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    if (this.heldInDirection('left')) dx -= 1;
    if (this.heldInDirection('right')) dx += 1;
    if (this.heldInDirection('up')) dy -= 1;
    if (this.heldInDirection('down')) dy += 1;
    if (dx !== 0 && dy !== 0) {
      const inv = 1 / Math.sqrt(2);
      dx *= inv;
      dy *= inv;
    }
    return { dx, dy };
  }

  // A single cardinal step direction for grid movement (issue #206): the most
  // recently pressed held key wins, so there is no diagonal — pressing two axes
  // moves along whichever was pressed last. Returns {0,0} when nothing is held.
  getStepDirection(): { dx: number; dy: number } {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const dir = DIRECTION_OF[this.order[i]];
      // Copied so a caller can't mutate the shared table.
      if (dir) return { ...STEP_OF[dir] };
    }
    return { dx: 0, dy: 0 };
  }
}
