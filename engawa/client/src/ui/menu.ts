// Shared dropdown-menu helpers for the toolbar and roster menus.

import { el } from '@/ui/dom';

// Append one dropdown item (button.device-item). Clicking stops propagation —
// the document-level outside-click handler must not also fire — hides the menu
// first, then runs the action. `selected` adds the check-mark prefix and the
// .selected class (the current device / background / status).
export function addMenuItem(
  menu: HTMLElement,
  label: string,
  onPick: () => void,
  selected = false,
): HTMLButtonElement {
  const item = el('button', {
    className: selected ? 'device-item selected' : 'device-item',
    textContent: selected ? `✓ ${label}` : label,
    onClick: (e) => {
      e.stopPropagation();
      menu.classList.add('hidden');
      onPick();
    },
  });
  menu.appendChild(item);
  return item;
}

// Wire a menu toggle button: opening closes every other menu first (closeAll),
// then (re)populates and shows; clicking while open just closes. Deliberately
// NO stopPropagation on the toggle: the click must bubble to document so other
// menu groups' outside-click handlers close too (e.g. the toolbar menus and the
// roster status menu stay mutually exclusive); each document handler is guarded
// by "target !== its own button", so a toggle never closes the menu it just
// opened.
export function wireMenuToggle(
  btn: HTMLButtonElement,
  menu: HTMLElement,
  closeAll: () => void,
  populate: () => void | Promise<void>,
): void {
  btn.addEventListener('click', async () => {
    const open = menu.classList.contains('hidden');
    closeAll();
    if (open) {
      await populate();
      menu.classList.remove('hidden');
    }
  });
}
