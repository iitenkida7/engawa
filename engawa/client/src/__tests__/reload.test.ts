import { afterEach, describe, expect, it, mock } from 'bun:test';
import { t } from '@/core/i18n';
import { countdownMessage, evaluateBoot, ReloadBanner } from '@/core/reload';

describe('evaluateBoot', () => {
  it('records the boot id on the first welcome without reloading', () => {
    expect(evaluateBoot(null, 'boot-a')).toEqual({ reload: false, bootId: 'boot-a' });
  });

  it('does not reload when the boot id is unchanged', () => {
    expect(evaluateBoot('boot-a', 'boot-a')).toEqual({ reload: false, bootId: 'boot-a' });
  });

  it('reloads when the boot id changes (server restarted)', () => {
    expect(evaluateBoot('boot-a', 'boot-b')).toEqual({ reload: true, bootId: 'boot-b' });
  });
});

describe('countdownMessage', () => {
  it('renders the remaining seconds', () => {
    expect(countdownMessage(5)).toBe(t('reload.countdown', { seconds: 5 }));
    expect(countdownMessage(5)).toContain('5');
  });

  it('never shows a negative number', () => {
    expect(countdownMessage(-1)).toBe(t('reload.countdown', { seconds: 0 }));
  });
});

describe('ReloadBanner', () => {
  let banner: ReloadBanner | null = null;

  afterEach(() => {
    // Stop the interval started by show() and clean up the DOM between tests.
    banner?.reloadNow();
    banner = null;
    document.getElementById('reload-banner')?.remove();
  });

  it('adds a single banner to the document on show() (idempotent)', () => {
    banner = new ReloadBanner({ reload: () => {} });
    banner.show();
    banner.show();
    expect(document.querySelectorAll('#reload-banner')).toHaveLength(1);
  });

  it('reloads immediately when the button is clicked', () => {
    const reload = mock();
    banner = new ReloadBanner({ reload });
    banner.show();
    document.querySelector<HTMLButtonElement>('#reload-banner button')?.click();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('counts down and reloads when it reaches zero', () => {
    const reload = mock();
    banner = new ReloadBanner({ reload, seconds: 2 });
    banner.show();
    const countdown = document.querySelector('#reload-banner .reload-banner-countdown');
    expect(countdown?.textContent).toBe(t('reload.countdown', { seconds: 2 }));
    banner.tick();
    expect(countdown?.textContent).toBe(t('reload.countdown', { seconds: 1 }));
    expect(reload).not.toHaveBeenCalled();
    banner.tick();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('fires reload only once even if triggered repeatedly', () => {
    const reload = mock();
    banner = new ReloadBanner({ reload, seconds: 1 });
    banner.show();
    banner.reloadNow();
    banner.reloadNow();
    banner.tick();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
