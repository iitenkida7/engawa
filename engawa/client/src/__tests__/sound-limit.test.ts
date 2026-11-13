import { describe, expect, it } from 'bun:test';
import { admitChime, CHIME_MAX_IN_WINDOW, CHIME_WINDOW_MS } from '@/ui/sound-limit';

describe('admitChime', () => {
  it('lets the first chimes through, up to the cap', () => {
    let history: number[] = [];
    for (let i = 0; i < CHIME_MAX_IN_WINDOW; i++) {
      const r = admitChime(history, 1000 + i);
      expect(r.ok).toBe(true);
      history = r.history;
    }
    expect(admitChime(history, 1000 + CHIME_MAX_IN_WINDOW).ok).toBe(false);
  });

  it('drops the rest of a crowd arriving in the same instant', () => {
    let history: number[] = [];
    let played = 0;
    for (let i = 0; i < 12; i++) {
      const r = admitChime(history, 5000);
      history = r.history;
      if (r.ok) played++;
    }
    expect(played).toBe(CHIME_MAX_IN_WINDOW);
  });

  it('allows chimes again once the window has passed', () => {
    let history: number[] = [];
    for (let i = 0; i < CHIME_MAX_IN_WINDOW; i++) history = admitChime(history, 1000).history;
    expect(admitChime(history, 1000 + CHIME_WINDOW_MS - 1).ok).toBe(false);
    expect(admitChime(history, 1000 + CHIME_WINDOW_MS).ok).toBe(true);
  });

  it('a refused chime is not recorded (it must not extend the quiet period)', () => {
    let history: number[] = [];
    for (let i = 0; i < CHIME_MAX_IN_WINDOW; i++) history = admitChime(history, 1000).history;
    const refused = admitChime(history, 1100);
    expect(refused.ok).toBe(false);
    expect(refused.history).toEqual(history);
  });

  it('honours custom limits', () => {
    expect(admitChime([100], 150, 100, 1).ok).toBe(false);
    expect(admitChime([100], 250, 100, 1).ok).toBe(true);
  });
});
