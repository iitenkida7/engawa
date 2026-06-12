import { describe, expect, it } from 'bun:test';
import { el } from '@/ui/dom';

describe('el', () => {
  it('creates the requested tag with no props by default', () => {
    const node = el('div');
    expect(node.tagName).toBe('DIV');
    expect(node.className).toBe('');
    expect(node.childNodes.length).toBe(0);
  });

  it('sets className, textContent and title', () => {
    const node = el('button', {
      className: 'device-item selected',
      textContent: '✓ カメラ',
      title: 'リアクション (1)',
    });
    expect(node.className).toBe('device-item selected');
    expect(node.textContent).toBe('✓ カメラ');
    expect(node.title).toBe('リアクション (1)');
  });

  it('merges dataset entries', () => {
    const node = el('div', { dataset: { userId: 'u1', mode: 'grid' } });
    expect(node.dataset.userId).toBe('u1');
    expect(node.dataset.mode).toBe('grid');
  });

  it('wires onClick to fire on a click event', () => {
    let clicks = 0;
    const node = el('button', { onClick: () => clicks++ });
    node.dispatchEvent(new MouseEvent('click'));
    expect(clicks).toBe(1);
  });

  it('appends element and string children in order', () => {
    const child = el('span', { textContent: 'b' });
    const node = el('div', {}, ['a', child, 'c']);
    expect(node.childNodes.length).toBe(3);
    expect(node.textContent).toBe('abc');
    expect(node.childNodes[1]).toBe(child);
  });

  it('returns a node typed by the tag (property access compiles)', () => {
    const video = el('video', { className: 'tile' });
    // Type-level check: HTMLVideoElement-specific property is accessible.
    video.autoplay = true;
    expect(video.autoplay).toBe(true);
  });
});
