import { afterEach, describe, expect, it } from 'bun:test';
import { InputManager } from '@/world/input';

function press(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key }));
}
function release(key: string) {
  window.dispatchEvent(new KeyboardEvent('keyup', { key }));
}

describe('InputManager.getDirection', () => {
  afterEach(() => {
    // Clear any held keys via the blur handler.
    window.dispatchEvent(new Event('blur'));
  });

  it('returns zero vector with no keys held', () => {
    const im = new InputManager();
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('moves left on ArrowLeft and right on vim\'s "l"', () => {
    const left = new InputManager();
    press('ArrowLeft');
    expect(left.getDirection()).toEqual({ dx: -1, dy: 0 });
    release('ArrowLeft');

    const right = new InputManager();
    press('l');
    expect(right.getDirection()).toEqual({ dx: 1, dy: 0 });
    release('l');
  });

  it('maps vim k/j to up/down and h to left', () => {
    const im = new InputManager();
    press('k');
    expect(im.getDirection()).toEqual({ dx: 0, dy: -1 });
    release('k');
    press('j');
    expect(im.getDirection()).toEqual({ dx: 0, dy: 1 });
    release('j');
    press('h');
    expect(im.getDirection()).toEqual({ dx: -1, dy: 0 });
    release('h');
  });

  it('walks on WASD too (#302) — all three dialects move', () => {
    const cases: [string, { dx: number; dy: number }][] = [
      ['w', { dx: 0, dy: -1 }],
      ['a', { dx: -1, dy: 0 }],
      ['s', { dx: 0, dy: 1 }],
      ['d', { dx: 1, dy: 0 }],
    ];
    for (const [key, expected] of cases) {
      const im = new InputManager();
      press(key);
      expect(im.getDirection()).toEqual(expected);
      expect(im.getStepDirection()).toEqual(expected);
      release(key);
    }
  });

  it('cancels opposite keys across dialects (WASD vs vim vs arrows)', () => {
    const im = new InputManager();
    press('a'); // left
    press('l'); // right
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
    release('a');
    release('l');

    press('w'); // up
    press('ArrowDown');
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('does not walk while Shift is held, so Shift+S stays the screen-share key', () => {
    const im = new InputManager();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', shiftKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', shiftKey: true }));
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
    expect(im.getStepDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('cancels opposite keys', () => {
    const im = new InputManager();
    press('ArrowLeft');
    press('ArrowRight');
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('treats the same direction pressed in two dialects as one', () => {
    const im = new InputManager();
    press('h'); // left
    press('a'); // also left
    expect(im.getDirection()).toEqual({ dx: -1, dy: 0 });
    release('h');
    // Still held in the other dialect → keep walking left.
    expect(im.getDirection()).toEqual({ dx: -1, dy: 0 });
  });

  it('normalizes diagonal movement to unit length', () => {
    const im = new InputManager();
    press('k');
    press('l');
    const { dx, dy } = im.getDirection();
    const inv = 1 / Math.sqrt(2);
    expect(dx).toBeCloseTo(inv, 10);
    expect(dy).toBeCloseTo(-inv, 10);
    expect(Math.hypot(dx, dy)).toBeCloseTo(1, 10);
  });

  it('is case-insensitive for letter keys', () => {
    const im = new InputManager();
    press('L');
    expect(im.getDirection()).toEqual({ dx: 1, dy: 0 });
  });

  it('clears all keys on window blur', () => {
    const im = new InputManager();
    press('k');
    window.dispatchEvent(new Event('blur'));
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('clears a held key even when keyup fires from a text input (no stuck key)', () => {
    const im = new InputManager();
    press('k');
    expect(im.getDirection()).toEqual({ dx: 0, dy: -1 });

    // Focus moved into the chat box between keydown and keyup: the keyup now
    // targets the INPUT and bubbles to window. It must still clear the key.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keyup', { key: 'k', bubbles: true }));
    input.remove();

    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('ignores modifier combos so browser shortcuts are not treated as movement', () => {
    const im = new InputManager();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', metaKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h', altKey: true }));
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });
});

describe('InputManager.getStepDirection', () => {
  afterEach(() => {
    window.dispatchEvent(new Event('blur'));
  });

  it('returns zero vector with no keys held', () => {
    const im = new InputManager();
    expect(im.getStepDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('returns a single cardinal direction per key (never diagonal)', () => {
    const im = new InputManager();
    press('k');
    press('l');
    // Last pressed wins — 'l' (right), not a diagonal.
    expect(im.getStepDirection()).toEqual({ dx: 1, dy: 0 });
  });

  it('falls back to the still-held key when the latest is released', () => {
    const im = new InputManager();
    press('k');
    press('l');
    expect(im.getStepDirection()).toEqual({ dx: 1, dy: 0 });
    release('l');
    // 'k' is still held → resume moving up.
    expect(im.getStepDirection()).toEqual({ dx: 0, dy: -1 });
  });

  it('clears order on blur', () => {
    const im = new InputManager();
    press('k');
    window.dispatchEvent(new Event('blur'));
    expect(im.getStepDirection()).toEqual({ dx: 0, dy: 0 });
  });
});
