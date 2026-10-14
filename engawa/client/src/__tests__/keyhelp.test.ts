import { beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from '@/core/i18n';
import { SHORTCUT_HELP } from '@/core/shortcuts';
import { KeyHelpPanel } from '@/ui/keyhelp';

// The panel is built from index.html's markup in App's field initializers, so a
// renamed/missing id would throw before the app ever paints. Load the real
// markup rather than a hand-written stand-in, so the two can't drift.
const html = readFileSync(join(import.meta.dir, '../../index.html'), 'utf-8');

function mountKeyHelpMarkup() {
  const start = html.indexOf('<div id="keyhelp"');
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('<div id="roster"', start);
  document.body.innerHTML = html.slice(start, end);
}

describe('KeyHelpPanel', () => {
  beforeEach(mountKeyHelpMarkup);

  test('renders one row per shortcut, with its keys and label', () => {
    new KeyHelpPanel();
    const rows = document.querySelectorAll('.keyhelp-row');
    expect(rows.length).toBe(SHORTCUT_HELP.length);

    const first = SHORTCUT_HELP[0];
    const firstRow = rows[0] as HTMLElement;
    expect([...firstRow.querySelectorAll('.keyhelp-key')].map((k) => k.textContent)).toEqual(
      first.keys,
    );
    expect(firstRow.querySelector('.keyhelp-label')?.textContent).toBe(t(first.labelKey));
  });

  test('starts hidden, and toggle opens and closes it', () => {
    const panel = new KeyHelpPanel();
    const el = document.getElementById('keyhelp') as HTMLElement;
    expect(el.classList.contains('hidden')).toBe(true);
    panel.toggle();
    expect(el.classList.contains('hidden')).toBe(false);
    panel.toggle();
    expect(el.classList.contains('hidden')).toBe(true);
  });

  test('Esc closes it', () => {
    const panel = new KeyHelpPanel();
    const el = document.getElementById('keyhelp') as HTMLElement;
    panel.toggle();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(el.classList.contains('hidden')).toBe(true);
  });

  test('ignores Esc while a text field has focus', () => {
    const panel = new KeyHelpPanel();
    const el = document.getElementById('keyhelp') as HTMLElement;
    panel.toggle();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    input.remove();

    expect(el.classList.contains('hidden')).toBe(false);
  });

  test('the close button closes it', () => {
    const panel = new KeyHelpPanel();
    const el = document.getElementById('keyhelp') as HTMLElement;
    panel.toggle();
    (document.getElementById('keyhelp-close') as HTMLButtonElement).click();
    expect(el.classList.contains('hidden')).toBe(true);
  });
});
