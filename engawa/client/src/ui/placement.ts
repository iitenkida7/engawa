// The bar for placing chairs, benches and plants: pick what to put down (or the
// eraser), turn it with R, click a tile. It only holds the tool state and its
// buttons; the App turns clicks into messages and the renderer draws the ghost.

import { t } from '@/core/i18n';
import type { ItemFacing, ItemKind } from '@/core/types';
import { ITEM_KINDS, rotateFacing } from '@/world/placed-items';

export type PlacementTool = ItemKind | 'erase';

const TOOL_LABEL_KEYS: Record<PlacementTool, string> = {
  chair: 'place.chair',
  bench: 'place.bench',
  plant: 'place.plant',
  erase: 'place.erase',
};

export class PlacementMode {
  private tool: PlacementTool = 'chair';
  private facingValue: ItemFacing = 'down';
  private bar: HTMLDivElement | null = null;
  private buttons = new Map<PlacementTool, HTMLButtonElement>();
  private onChange: () => void;

  // onChange runs whenever the mode, tool or facing changes (the ghost redraws).
  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  get isOpen() {
    return this.bar !== null;
  }
  get currentTool(): PlacementTool {
    return this.tool;
  }
  get facing(): ItemFacing {
    return this.facingValue;
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  open() {
    if (this.bar) return;
    const bar = document.createElement('div');
    bar.id = 'placement-bar';
    for (const tool of [...ITEM_KINDS, 'erase'] as PlacementTool[]) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'placement-btn';
      b.dataset.tool = tool;
      b.textContent = t(TOOL_LABEL_KEYS[tool]);
      b.addEventListener('click', () => this.setTool(tool));
      this.buttons.set(tool, b);
      bar.appendChild(b);
    }
    const rotate = document.createElement('button');
    rotate.type = 'button';
    rotate.className = 'placement-btn';
    rotate.dataset.action = 'rotate';
    rotate.textContent = t('place.rotate');
    rotate.addEventListener('click', () => this.rotate());
    const hint = document.createElement('span');
    hint.className = 'placement-hint';
    hint.textContent = t('place.hint');
    const done = document.createElement('button');
    done.type = 'button';
    done.className = 'placement-btn done';
    done.dataset.action = 'done';
    done.textContent = t('place.done');
    done.addEventListener('click', () => this.close());
    bar.append(rotate, hint, done);
    document.body.appendChild(bar);
    this.bar = bar;
    this.setTool(this.tool);
  }

  close() {
    this.bar?.remove();
    this.bar = null;
    this.buttons.clear();
    this.onChange();
  }

  setTool(tool: PlacementTool) {
    this.tool = tool;
    for (const [k, b] of this.buttons) b.classList.toggle('active', k === tool);
    this.onChange();
  }

  rotate() {
    this.facingValue = rotateFacing(this.facingValue);
    this.onChange();
  }
}
