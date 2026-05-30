import { describe, expect, test } from 'bun:test';
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  clampPosition,
  generateSpawn,
  normalizeIceServers,
  normalizeName,
  normalizeWorkspace,
  parseWorkspacePasswords,
  verifyWorkspacePassword,
} from '../logic';

describe('verifyWorkspacePassword', () => {
  test('allows access when the workspace has no configured password', () => {
    const table = new Map<string, string>();
    expect(verifyWorkspacePassword('open', undefined, table)).toBe(true);
    expect(verifyWorkspacePassword('open', 'whatever', table)).toBe(true);
  });

  test('allows access when the supplied password matches', () => {
    const table = new Map([['ws1', 'secret']]);
    expect(verifyWorkspacePassword('ws1', 'secret', table)).toBe(true);
  });

  test('rejects access when the password is wrong', () => {
    const table = new Map([['ws1', 'secret']]);
    expect(verifyWorkspacePassword('ws1', 'nope', table)).toBe(false);
  });

  test('rejects access when no password is supplied but one is required', () => {
    const table = new Map([['ws1', 'secret']]);
    expect(verifyWorkspacePassword('ws1', undefined, table)).toBe(false);
  });

  test('treats an empty configured password as an open workspace', () => {
    // Empty-string password is falsy, matching the original `if (requiredPass)` check.
    const table = new Map([['ws1', '']]);
    expect(verifyWorkspacePassword('ws1', undefined, table)).toBe(true);
  });
});

describe('parseWorkspacePasswords', () => {
  test('returns an empty map for undefined or empty input', () => {
    expect(parseWorkspacePasswords(undefined).size).toBe(0);
    expect(parseWorkspacePasswords('').size).toBe(0);
  });

  test('parses a valid JSON object into a map', () => {
    const table = parseWorkspacePasswords('{"a":"1","b":"2"}');
    expect(table.get('a')).toBe('1');
    expect(table.get('b')).toBe('2');
    expect(table.size).toBe(2);
  });

  test('returns an empty map for invalid JSON', () => {
    expect(parseWorkspacePasswords('not json {').size).toBe(0);
  });
});

describe('normalizeWorkspace', () => {
  test('falls back to "default" when empty or undefined', () => {
    expect(normalizeWorkspace(undefined)).toBe('default');
    expect(normalizeWorkspace('')).toBe('default');
  });

  test('passes through a normal workspace name', () => {
    expect(normalizeWorkspace('team-a')).toBe('team-a');
  });

  test('caps the workspace name at 64 chars', () => {
    const long = 'x'.repeat(100);
    expect(normalizeWorkspace(long)).toHaveLength(64);
  });
});

describe('normalizeName', () => {
  test('falls back to "anon" when empty or undefined', () => {
    expect(normalizeName(undefined)).toBe('anon');
    expect(normalizeName('')).toBe('anon');
  });

  test('passes through a normal name', () => {
    expect(normalizeName('Alice')).toBe('Alice');
  });

  test('caps the name at 24 chars', () => {
    const long = 'n'.repeat(50);
    expect(normalizeName(long)).toHaveLength(24);
  });
});

describe('clampPosition', () => {
  test('passes through in-range coordinates', () => {
    expect(clampPosition(500, 600)).toEqual({ x: 500, y: 600 });
  });

  test('clamps negative coordinates to 0', () => {
    expect(clampPosition(-100, -50)).toEqual({ x: 0, y: 0 });
  });

  test('clamps coordinates above the map bounds', () => {
    expect(clampPosition(99999, 99999)).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });
  });

  test('respects the boundary values exactly', () => {
    expect(clampPosition(0, 0)).toEqual({ x: 0, y: 0 });
    expect(clampPosition(MAP_WIDTH, MAP_HEIGHT)).toEqual({ x: MAP_WIDTH, y: MAP_HEIGHT });
  });

  test('collapses non-finite input to 0 (matching Number(v) || 0)', () => {
    expect(clampPosition(NaN, NaN)).toEqual({ x: 0, y: 0 });
  });

  test('honors custom width/height bounds', () => {
    expect(clampPosition(1000, 1000, 100, 200)).toEqual({ x: 100, y: 200 });
  });
});

describe('generateSpawn', () => {
  test('is deterministic when given a fixed random source', () => {
    const spawn = generateSpawn(() => 0.5);
    expect(spawn).toEqual({ x: 1000, y: 700 });
  });

  test('produces the minimum corner when rand returns 0', () => {
    expect(generateSpawn(() => 0)).toEqual({ x: 800, y: 400 });
  });

  test('stays within the open office area for any rand in [0,1)', () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
      const { x, y } = generateSpawn(() => r);
      expect(x).toBeGreaterThanOrEqual(800);
      expect(x).toBeLessThan(1200);
      expect(y).toBeGreaterThanOrEqual(400);
      expect(y).toBeLessThan(1000);
    }
  });
});

describe('normalizeIceServers', () => {
  test('wraps a single Cloudflare object in a one-element array', () => {
    // Cloudflare's credentials endpoint returns one object, not an array.
    const cf = {
      urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp'],
      username: 'user',
      credential: 'pass',
    };
    expect(normalizeIceServers(cf)).toEqual([cf]);
  });

  test('passes an array through unchanged', () => {
    const arr = [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }];
    expect(normalizeIceServers(arr)).toBe(arr);
  });

  test('yields an empty array for null/undefined/primitive input', () => {
    expect(normalizeIceServers(null)).toEqual([]);
    expect(normalizeIceServers(undefined)).toEqual([]);
    expect(normalizeIceServers('stun:foo')).toEqual([]);
  });
});
