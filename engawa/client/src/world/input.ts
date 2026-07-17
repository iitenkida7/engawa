export class InputManager {
  private keys = new Set<string>();

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
        this.keys.add(key);
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => {
      // Always clear on keyup — even when focus has moved into a text input
      // between the keydown and this keyup (e.g. clicking the chat box while
      // holding a movement key). Filtering here would leave the key "held" and
      // the avatar walking; deleting a key that was never added is a harmless no-op.
      this.keys.delete(e.key.toLowerCase());
    });
    window.addEventListener('blur', () => this.keys.clear());
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
}
