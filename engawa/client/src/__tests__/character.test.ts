import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { CharacterSheet } from '@/world/character';
import { defaultOutfit } from '@/world/outfit';

// Images "load" on the next microtask, so a composite builds without a network.
class InstantImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  width = 1;
  height = 1;
  set src(_url: string) {
    queueMicrotask(() => this.onload?.());
  }
}

const RealImage = globalThis.Image;
beforeEach(() => {
  (globalThis as { Image: unknown }).Image = InstantImage;
});
afterEach(() => {
  (globalThis as { Image: unknown }).Image = RealImage;
});

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('CharacterSheet', () => {
  it('fires onUpdate once a composite finishes building', async () => {
    let updates = 0;
    const sheet = new CharacterSheet(() => updates++);
    const outfit = { ...defaultOutfit(), hair: 1 };
    expect(sheet.getComposite(outfit)).toBeNull();
    await settle();
    expect(updates).toBe(1);
    expect(sheet.getComposite(outfit)).not.toBeNull();
  });

  it('shares finished composites across sheets (join-screen prewarm)', async () => {
    const outfit = { ...defaultOutfit(), hair: 2 };
    new CharacterSheet().getComposite(outfit);
    await settle();
    // A sheet created later (the map renderer, on join) has it ready at once.
    expect(new CharacterSheet().getComposite(outfit)).not.toBeNull();
  });
});
