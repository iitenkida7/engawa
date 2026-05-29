import { afterEach, describe, expect, it } from 'bun:test';
import { InputManager } from '../input';

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

  it('moves left on ArrowLeft and right on "d"', () => {
    const left = new InputManager();
    press('ArrowLeft');
    expect(left.getDirection()).toEqual({ dx: -1, dy: 0 });
    release('ArrowLeft');

    const right = new InputManager();
    press('d');
    expect(right.getDirection()).toEqual({ dx: 1, dy: 0 });
    release('d');
  });

  it('maps w/s to up/down', () => {
    const im = new InputManager();
    press('w');
    expect(im.getDirection()).toEqual({ dx: 0, dy: -1 });
    release('w');
    press('s');
    expect(im.getDirection()).toEqual({ dx: 0, dy: 1 });
    release('s');
  });

  it('cancels opposite keys', () => {
    const im = new InputManager();
    press('ArrowLeft');
    press('ArrowRight');
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });

  it('normalizes diagonal movement to unit length', () => {
    const im = new InputManager();
    press('w');
    press('d');
    const { dx, dy } = im.getDirection();
    const inv = 1 / Math.sqrt(2);
    expect(dx).toBeCloseTo(inv, 10);
    expect(dy).toBeCloseTo(-inv, 10);
    expect(Math.hypot(dx, dy)).toBeCloseTo(1, 10);
  });

  it('is case-insensitive for letter keys', () => {
    const im = new InputManager();
    press('D');
    expect(im.getDirection()).toEqual({ dx: 1, dy: 0 });
  });

  it('clears all keys on window blur', () => {
    const im = new InputManager();
    press('w');
    window.dispatchEvent(new Event('blur'));
    expect(im.getDirection()).toEqual({ dx: 0, dy: 0 });
  });
});
