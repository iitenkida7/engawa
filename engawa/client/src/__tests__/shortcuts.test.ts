import { describe, expect, test } from 'bun:test';
import { t } from '@/core/i18n';
import { resolveShortcut, SHORTCUT_HELP } from '@/core/shortcuts';
import { REACTION_EMOJIS } from '@/core/types';

describe('resolveShortcut', () => {
  test('maps each bare key to its action', () => {
    expect(resolveShortcut({ key: 'm' })).toEqual({ action: 'mic' });
    expect(resolveShortcut({ key: 'c' })).toEqual({ action: 'cam' });
    expect(resolveShortcut({ key: 'v' })).toEqual({ action: 'meeting-view' });
    expect(resolveShortcut({ key: 'z' })).toEqual({ action: 'zoom' });
    expect(resolveShortcut({ key: 'p' })).toEqual({ action: 'roster' });
  });

  test('Esc goes back to the map, one way only', () => {
    expect(resolveShortcut({ key: 'Escape' })).toEqual({ action: 'map-view' });
    // Not a second 'v': a toggle would let Esc drop you INTO the meeting view.
    expect(resolveShortcut({ key: 'Escape' })).not.toEqual({ action: 'meeting-view' });
    // Esc cancelling an IME conversion must not also leave the meeting view.
    expect(resolveShortcut({ key: 'Escape', isComposing: true })).toBeNull();
    expect(resolveShortcut({ key: 'Escape', shiftKey: true })).toBeNull();
  });

  test('leaves every movement key to the avatar (#302)', () => {
    // All three dialects walk, so none of these twelve may fire an action —
    // 'a' and 's' in particular used to be mic and screen share.
    for (const key of ['w', 'a', 's', 'd', 'h', 'j', 'k', 'l']) {
      expect(resolveShortcut({ key })).toBeNull();
    }
    for (const key of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']) {
      expect(resolveShortcut({ key })).toBeNull();
    }
  });

  test('opens the shortcut list on ?', () => {
    expect(resolveShortcut({ key: '?', shiftKey: true })).toEqual({ action: 'help' });
    // Some layouts put '?' on a key of its own, with no Shift reported.
    expect(resolveShortcut({ key: '?' })).toEqual({ action: 'help' });
  });

  test('maps 1–6 to the matching reaction index', () => {
    expect(resolveShortcut({ key: '1' })).toEqual({ action: 'reaction', index: 0 });
    expect(resolveShortcut({ key: '6' })).toEqual({
      action: 'reaction',
      index: REACTION_EMOJIS.length - 1,
    });
  });

  test('ignores a number past the end of the reaction list', () => {
    expect(resolveShortcut({ key: String(REACTION_EMOJIS.length + 1) })).toBeNull();
    expect(resolveShortcut({ key: '0' })).toBeNull();
  });

  test('puts what others see behind Shift, so a stray keypress cannot fire it', () => {
    expect(resolveShortcut({ key: 'R', shiftKey: true })).toEqual({ action: 'record' });
    expect(resolveShortcut({ key: 'S', shiftKey: true })).toEqual({ action: 'screen' });
    // Bare 'r' is deliberately dead — recording announces itself to the call.
    // Bare 's' walks the avatar south instead (#302).
    expect(resolveShortcut({ key: 'r' })).toBeNull();
    expect(resolveShortcut({ key: 's' })).toBeNull();
  });

  test('Shift + any other key is dead rather than falling through', () => {
    expect(resolveShortcut({ key: 'M', shiftKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'V', shiftKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'A', shiftKey: true })).toBeNull();
  });

  test('never shadows a browser/OS combo', () => {
    // Cmd+1 switches tab, Cmd+Z undoes, Cmd+M minimizes — all used to double as
    // engawa shortcuts.
    expect(resolveShortcut({ key: '1', metaKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'z', metaKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'm', ctrlKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'c', altKey: true })).toBeNull();
    expect(resolveShortcut({ key: 'r', shiftKey: true, metaKey: true })).toBeNull();
    expect(resolveShortcut({ key: 's', shiftKey: true, ctrlKey: true })).toBeNull();
    expect(resolveShortcut({ key: '?', metaKey: true })).toBeNull();
  });

  test('drops auto-repeat so holding a key does not mash a toggle', () => {
    expect(resolveShortcut({ key: 'm', repeat: true })).toBeNull();
  });

  test('leaves IME composition keystrokes to the IME', () => {
    expect(resolveShortcut({ key: 'm', isComposing: true })).toBeNull();
  });

  test('survives Caps Lock', () => {
    // Caps Lock reports the uppercase key without shiftKey.
    expect(resolveShortcut({ key: 'M' })).toEqual({ action: 'mic' });
  });

  test('ignores keys with no binding', () => {
    for (const key of ['Enter', ' ', 'Tab', 'q', 'e', 'f', 'g']) {
      expect(resolveShortcut({ key })).toBeNull();
    }
  });
});

describe('SHORTCUT_HELP', () => {
  test('every row has a real translation, not a bare key id', () => {
    for (const { labelKey } of SHORTCUT_HELP) {
      expect(t(labelKey)).not.toBe(labelKey);
    }
  });

  test('every row shows at least one key', () => {
    for (const { keys } of SHORTCUT_HELP) {
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) expect(key.trim()).not.toBe('');
    }
  });

  test('lists a row for each action the resolver can return', () => {
    // The printed table and the resolver must not drift apart. Keyed by the
    // action each row documents, in the same order as the table.
    const documented = SHORTCUT_HELP.map((r) => r.labelKey);
    for (const key of [
      'keys.move',
      'keys.moveArrows',
      'keys.moveWasd',
      'keys.meetingView',
      'keys.zoom',
      'keys.mic',
      'keys.cam',
      'keys.screen',
      'keys.record',
      'keys.roster',
      'keys.reaction',
      'keys.help',
      'keys.escape',
    ]) {
      expect(documented).toContain(key);
    }
  });

  test('the reaction row covers the whole emoji list', () => {
    const row = SHORTCUT_HELP.find((r) => r.labelKey === 'keys.reaction');
    expect(row?.keys).toEqual([`1\u2013${REACTION_EMOJIS.length}`]);
  });
});
