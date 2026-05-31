import { describe, expect, it } from 'bun:test';
import {
  BG_PRESETS,
  VBG_OFF,
  VBG_BLUR,
  VBG_CUSTOM,
  allChoices,
  parseVbgChoice,
  serializeVbgChoice,
  isProcessingChoice,
  choiceLabel,
  downscaleSize,
} from '@/media/vbg';

describe('vbg preset registry', () => {
  it('preset ids are unique and exclude the reserved values', () => {
    const ids = BG_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(VBG_OFF);
    expect(ids).not.toContain(VBG_BLUR);
    expect(ids).not.toContain(VBG_CUSTOM);
  });

  it('allChoices lists off, blur, every preset, then custom', () => {
    expect(allChoices()).toEqual([VBG_OFF, VBG_BLUR, ...BG_PRESETS.map((p) => p.id), VBG_CUSTOM]);
  });
});

describe('parseVbgChoice', () => {
  it('defaults to off for null/unknown values', () => {
    expect(parseVbgChoice(null, false)).toBe(VBG_OFF);
    expect(parseVbgChoice('nonsense', false)).toBe(VBG_OFF);
  });

  it('accepts reserved and preset choices', () => {
    expect(parseVbgChoice(serializeVbgChoice(VBG_BLUR), false)).toBe(VBG_BLUR);
    const preset = BG_PRESETS[0].id;
    expect(parseVbgChoice(serializeVbgChoice(preset), false)).toBe(preset);
  });

  it('tolerates a bare string as well as the JSON form', () => {
    expect(parseVbgChoice(VBG_BLUR, false)).toBe(VBG_BLUR);
    expect(parseVbgChoice(BG_PRESETS[0].id, false)).toBe(BG_PRESETS[0].id);
  });

  it('downgrades custom to off when no image is stored', () => {
    expect(parseVbgChoice(serializeVbgChoice(VBG_CUSTOM), false)).toBe(VBG_OFF);
    expect(parseVbgChoice(serializeVbgChoice(VBG_CUSTOM), true)).toBe(VBG_CUSTOM);
  });

  it('returns off for malformed JSON', () => {
    expect(parseVbgChoice('{not json', false)).toBe(VBG_OFF);
    expect(parseVbgChoice('{"choice":123}', false)).toBe(VBG_OFF);
  });
});

describe('isProcessingChoice', () => {
  it('is false only for off', () => {
    expect(isProcessingChoice(VBG_OFF)).toBe(false);
    expect(isProcessingChoice(VBG_BLUR)).toBe(true);
    expect(isProcessingChoice(VBG_CUSTOM)).toBe(true);
    expect(isProcessingChoice(BG_PRESETS[0].id)).toBe(true);
  });
});

describe('choiceLabel', () => {
  it('labels reserved choices and presets, falling back for unknown', () => {
    expect(choiceLabel(VBG_OFF)).toBe('🪄 背景');
    expect(choiceLabel(VBG_BLUR)).toBe('🌫 ぼかし');
    expect(choiceLabel(VBG_CUSTOM)).toBe('🖼 画像');
    expect(choiceLabel(BG_PRESETS[0].id)).toBe(BG_PRESETS[0].label);
    expect(choiceLabel('nope')).toBe('🪄 背景');
  });
});

describe('downscaleSize', () => {
  it('leaves small images untouched', () => {
    expect(downscaleSize(640, 480, 1280)).toEqual({ w: 640, h: 480 });
  });

  it('scales down to the max edge keeping aspect ratio', () => {
    expect(downscaleSize(2560, 1440, 1280)).toEqual({ w: 1280, h: 720 });
    expect(downscaleSize(1000, 4000, 1280)).toEqual({ w: 320, h: 1280 });
  });

  it('guards against degenerate input', () => {
    expect(downscaleSize(0, 100, 1280)).toEqual({ w: 0, h: 0 });
    expect(downscaleSize(-5, 5, 1280)).toEqual({ w: 0, h: 0 });
  });

  it('never rounds a positive dimension down to zero', () => {
    expect(downscaleSize(3000, 1, 10)).toEqual({ w: 10, h: 1 });
  });
});
