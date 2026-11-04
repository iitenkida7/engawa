import { describe, expect, it } from 'bun:test';
import { pinSelfFirst, togglePinned } from '@/ui/media-layout';

const cam = (key: string) => ({ key, item: { aspectLocked: true } });
const share = (key: string) => ({ key, item: { aspectLocked: false } });
const keys = (ps: { key: string }[]) => ps.map((p) => p.key);

describe('pinSelfFirst', () => {
  it('moves your own tile ahead of the other cameras', () => {
    const out = pinSelfFirst([cam('cam:a'), cam('cam:b'), cam('cam:c'), cam('self')]);
    expect(keys(out)).toEqual(['self', 'cam:a', 'cam:b', 'cam:c']);
  });

  it('keeps screenshares first (the featured share stays the main window)', () => {
    const out = pinSelfFirst([share('screen:x'), cam('cam:a'), cam('self'), share('screen:y')]);
    expect(keys(out)).toEqual(['screen:x', 'screen:y', 'self', 'cam:a']);
  });

  it('gives your tile the same slot however many people are in the meeting', () => {
    const few = pinSelfFirst([cam('cam:a'), cam('self')]);
    const crowd = ['cam:a', 'cam:b', 'cam:c', 'cam:d'].map(cam);
    const many = pinSelfFirst([...crowd, cam('self')]);
    expect(few.findIndex((p) => p.key === 'self')).toBe(0);
    expect(many.findIndex((p) => p.key === 'self')).toBe(0);
  });

  it('leaves the order alone when there is no self tile', () => {
    const out = pinSelfFirst([cam('cam:a'), cam('cam:b')]);
    expect(keys(out)).toEqual(['cam:a', 'cam:b']);
  });

  it('keeps the others in their original order', () => {
    const out = pinSelfFirst([cam('cam:c'), cam('self'), cam('cam:a'), cam('cam:b')]);
    expect(keys(out)).toEqual(['self', 'cam:c', 'cam:a', 'cam:b']);
  });
});

describe('togglePinned', () => {
  it('fills the gallery main area one click at a time, oldest pushed out', () => {
    let pins: string[] = [];
    pins = togglePinned(pins, 'cam:a', 2);
    expect(pins).toEqual(['cam:a']);
    pins = togglePinned(pins, 'cam:b', 2);
    expect(pins).toEqual(['cam:a', 'cam:b']);
    pins = togglePinned(pins, 'cam:c', 2);
    expect(pins).toEqual(['cam:b', 'cam:c']);
  });

  it('unpins a window that is already pinned', () => {
    expect(togglePinned(['cam:a', 'cam:b'], 'cam:a', 2)).toEqual(['cam:b']);
    expect(togglePinned(['cam:a'], 'cam:a', 1)).toEqual([]);
  });

  it('swaps the single pin under a share', () => {
    expect(togglePinned(['cam:a'], 'cam:b', 1)).toEqual(['cam:b']);
  });
});
