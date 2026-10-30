import { beforeEach, describe, expect, it } from 'bun:test';
import { PlacementMode } from '@/ui/placement';

describe('PlacementMode', () => {
  let changes: number;
  let mode: PlacementMode;

  beforeEach(() => {
    document.body.innerHTML = '';
    changes = 0;
    mode = new PlacementMode(() => {
      changes++;
    });
  });

  const bar = () => document.getElementById('placement-bar');
  const tool = (name: string) =>
    document.querySelector<HTMLButtonElement>(`.placement-btn[data-tool="${name}"]`);

  it('opens a bar with a button per item and the eraser, chair selected first', () => {
    mode.open();
    expect(bar()).not.toBeNull();
    for (const name of ['chair', 'bench', 'plant', 'erase']) expect(tool(name)).not.toBeNull();
    expect(mode.currentTool).toBe('chair');
    expect(tool('chair')?.classList.contains('active')).toBe(true);
  });

  it('choosing a tool selects it and reports the change', () => {
    mode.open();
    const before = changes;
    tool('plant')?.click();
    expect(mode.currentTool).toBe('plant');
    expect(tool('plant')?.classList.contains('active')).toBe(true);
    expect(tool('chair')?.classList.contains('active')).toBe(false);
    expect(changes).toBeGreaterThan(before);
  });

  it('rotate turns the facing a quarter each time', () => {
    mode.open();
    const first = mode.facing;
    mode.rotate();
    expect(mode.facing).not.toBe(first);
    mode.rotate();
    mode.rotate();
    mode.rotate();
    expect(mode.facing).toBe(first);
  });

  it('the Done button and toggle close the bar', () => {
    mode.open();
    document.querySelector<HTMLButtonElement>('.placement-btn[data-action="done"]')?.click();
    expect(mode.isOpen).toBe(false);
    expect(bar()).toBeNull();
    mode.toggle();
    expect(mode.isOpen).toBe(true);
    mode.toggle();
    expect(bar()).toBeNull();
  });

  it('keeps the chosen tool when reopened', () => {
    mode.open();
    tool('bench')?.click();
    mode.close();
    mode.open();
    expect(mode.currentTool).toBe('bench');
  });
});
