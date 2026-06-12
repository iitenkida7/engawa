import { afterEach, describe, expect, it } from 'bun:test';
import { addMenuItem, wireMenuToggle } from '@/ui/menu';

function freshMenu(): HTMLDivElement {
  const menu = document.createElement('div');
  menu.className = 'hidden';
  document.body.appendChild(menu);
  return menu;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('addMenuItem', () => {
  it('appends a button.device-item with the label', () => {
    const menu = freshMenu();
    const item = addMenuItem(menu, '🚫 オフ', () => {});
    expect(item.tagName).toBe('BUTTON');
    expect(item.className).toBe('device-item');
    expect(item.textContent).toBe('🚫 オフ');
    expect(item.parentElement).toBe(menu);
  });

  it('marks a selected item with the check prefix and .selected', () => {
    const menu = freshMenu();
    const item = addMenuItem(menu, 'カメラ A', () => {}, true);
    expect(item.classList.contains('selected')).toBe(true);
    expect(item.textContent).toBe('✓ カメラ A');
  });

  it('hides the menu before running the action on click', () => {
    const menu = freshMenu();
    menu.classList.remove('hidden');
    let hiddenWhenPicked = false;
    const item = addMenuItem(menu, 'item', () => {
      hiddenWhenPicked = menu.classList.contains('hidden');
    });
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(hiddenWhenPicked).toBe(true);
  });

  it('stops the click from bubbling to document (outside-click handler must not fire)', () => {
    const menu = freshMenu();
    let reachedDocument = false;
    const onDoc = () => {
      reachedDocument = true;
    };
    document.addEventListener('click', onDoc);
    const item = addMenuItem(menu, 'item', () => {});
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.removeEventListener('click', onDoc);
    expect(reachedDocument).toBe(false);
  });
});

describe('wireMenuToggle', () => {
  it('opening closes other menus first, repopulates, then shows', async () => {
    const menu = freshMenu();
    const btn = document.createElement('button');
    const calls: string[] = [];
    wireMenuToggle(
      btn,
      menu,
      () => {
        calls.push('closeAll');
        menu.classList.add('hidden');
      },
      () => {
        calls.push('populate');
      },
    );
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The click handler may be async (device menus enumerate devices).
    await Promise.resolve();
    expect(calls).toEqual(['closeAll', 'populate']);
    expect(menu.classList.contains('hidden')).toBe(false);
  });

  it('clicking while open closes (via closeAll) without repopulating', async () => {
    const menu = freshMenu();
    menu.classList.remove('hidden');
    const btn = document.createElement('button');
    let populated = 0;
    wireMenuToggle(
      btn,
      menu,
      () => menu.classList.add('hidden'),
      () => {
        populated++;
      },
    );
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
    expect(populated).toBe(0);
    expect(menu.classList.contains('hidden')).toBe(true);
  });

  it('does not stop the toggle click from bubbling (keeps menu groups mutually exclusive)', () => {
    const menu = freshMenu();
    const btn = document.createElement('button');
    document.body.appendChild(btn);
    let reachedDocument = false;
    const onDoc = () => {
      reachedDocument = true;
    };
    document.addEventListener('click', onDoc);
    wireMenuToggle(
      btn,
      menu,
      () => {},
      () => {},
    );
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    document.removeEventListener('click', onDoc);
    expect(reachedDocument).toBe(true);
  });
});
