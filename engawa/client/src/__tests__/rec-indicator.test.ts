import { afterEach, describe, expect, it } from 'bun:test';
import { formatRecDuration, RecIndicator, recordingTitle } from '@/ui/rec-indicator';

describe('formatRecDuration', () => {
  it('formats sub-hour durations as m:ss', () => {
    expect(formatRecDuration(0)).toBe('0:00');
    expect(formatRecDuration(5_000)).toBe('0:05');
    expect(formatRecDuration(754_000)).toBe('12:34');
  });

  it('switches to h:mm:ss past an hour', () => {
    expect(formatRecDuration(3_600_000)).toBe('1:00:00');
    expect(formatRecDuration(3_723_000)).toBe('1:02:03');
  });

  it('floors partial seconds and clamps negative input to zero', () => {
    expect(formatRecDuration(1_999)).toBe('0:01');
    expect(formatRecDuration(-5_000)).toBe('0:00');
  });
});

describe('recordingTitle', () => {
  it('prefixes the base title with the REC marker and elapsed time', () => {
    expect(recordingTitle('engawa', 65_000)).toBe('● REC 1:05 · engawa');
  });
});

describe('RecIndicator', () => {
  let indicator: RecIndicator | null = null;

  afterEach(() => {
    indicator?.hide();
    indicator = null;
    document.title = 'engawa';
  });

  it('shows a pill with the elapsed time and marks the tab title', () => {
    document.title = 'engawa';
    let now = 100_000;
    indicator = new RecIndicator(() => now);
    now = 100_000 + 83_000;
    indicator.show(100_000);

    const el = document.getElementById('rec-indicator');
    expect(el).not.toBeNull();
    expect(el?.querySelector('.rec-indicator-time')?.textContent).toBe('1:23');
    expect(document.title).toBe('● REC 1:23 · engawa');
    expect(indicator.visible).toBe(true);
  });

  it('is idempotent on show and restores the title on hide', () => {
    document.title = 'engawa';
    indicator = new RecIndicator(() => 5_000);
    indicator.show(0);
    indicator.show(0);
    expect(document.querySelectorAll('#rec-indicator').length).toBe(1);

    indicator.hide();
    expect(document.getElementById('rec-indicator')).toBeNull();
    expect(document.title).toBe('engawa');
    expect(indicator.visible).toBe(false);
    // A second hide is a no-op.
    indicator.hide();
  });
});
