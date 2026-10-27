import { t } from '@/core/i18n';
import { SHORTCUT_HELP } from '@/core/shortcuts';

// The keyboard-shortcut reference behind the ⋯ menu (issue #297). Rows come
// from SHORTCUT_HELP so the printed list can't drift from the resolver. Built
// once on construction — the table is static.
function isTextInput(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable;
}

export class KeyHelpPanel {
  private panel: HTMLDivElement;

  constructor() {
    this.panel = document.getElementById('keyhelp') as HTMLDivElement;
    const title = document.getElementById('keyhelp-title') as HTMLElement;
    const list = document.getElementById('keyhelp-list') as HTMLDivElement;
    const note = document.getElementById('keyhelp-note') as HTMLDivElement;

    title.textContent = t('keys.title');
    note.textContent = t('keys.note');
    list.replaceChildren();
    for (const { keys, labelKey } of SHORTCUT_HELP) {
      const row = document.createElement('div');
      row.className = 'keyhelp-row';
      const chips = document.createElement('span');
      chips.className = 'keyhelp-keys';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.className = 'keyhelp-key';
        kbd.textContent = key;
        chips.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'keyhelp-label';
      label.textContent = t(labelKey);
      row.append(chips, label);
      list.appendChild(row);
    }

    document.getElementById('keyhelp-close')?.addEventListener('click', () => this.close());
    // Esc closes it, like every other overlay. Guarded the same way as the other
    // key handlers (core/app.ts, ui/remote-media.ts) so it doesn't eat an IME
    // conversion cancel or an Esc meant for the field the user is typing in.
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      if (isTextInput(e.target)) return;
      if (this.panel.classList.contains('hidden')) return;
      // Claimed: the App's Esc-to-map shortcut (on window, after us) skips it.
      e.preventDefault();
      this.close();
    });
  }

  toggle() {
    this.panel.classList.toggle('hidden');
  }

  private close() {
    this.panel.classList.add('hidden');
  }
}
