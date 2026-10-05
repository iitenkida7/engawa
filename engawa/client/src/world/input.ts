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
      if (e.metaKey || e.ctrlKey || e.altKey) return;
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
    return (
      k === 'arrowup' ||
      k === 'arrowdown' ||
      k === 'arrowleft' ||
      k === 'arrowright' ||
      k === 'w' ||
      k === 'a' ||
      k === 's' ||
      k === 'd'
    );
  }

  getDirection(): { dx: number; dy: number } {
    let dx = 0;
    let dy = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) dx -= 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) dx += 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) dy -= 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) dy += 1;
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
      switch (this.order[i]) {
        case 'arrowleft':
        case 'a':
          return { dx: -1, dy: 0 };
        case 'arrowright':
        case 'd':
          return { dx: 1, dy: 0 };
        case 'arrowup':
        case 'w':
          return { dx: 0, dy: -1 };
        case 'arrowdown':
        case 's':
          return { dx: 0, dy: 1 };
      }
    }
    return { dx: 0, dy: 0 };
  }
}
