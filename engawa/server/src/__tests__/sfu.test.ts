import { describe, expect, test } from 'bun:test';
import { isAllowedSessionPath } from '../sfu';

describe('isAllowedSessionPath', () => {
  test('allows the documented SFU control-plane paths', () => {
    expect(isAllowedSessionPath('/new')).toBe(true);
    expect(isAllowedSessionPath('/abc123/tracks/new')).toBe(true);
    expect(isAllowedSessionPath('/abc123/renegotiate')).toBe(true);
    expect(isAllowedSessionPath('/abc123/tracks/update')).toBe(true);
    expect(isAllowedSessionPath('/abc123/tracks/close')).toBe(true);
  });

  test('accepts the alphanumeric session-id characters Cloudflare uses', () => {
    expect(isAllowedSessionPath('/Az_a-z0-9/tracks/new')).toBe(true);
  });

  test('rejects anything outside the whitelist (SSRF / path-traversal guard)', () => {
    expect(isAllowedSessionPath('')).toBe(false);
    expect(isAllowedSessionPath('/')).toBe(false);
    expect(isAllowedSessionPath('/other')).toBe(false);
    expect(isAllowedSessionPath('/sid/tracks/delete')).toBe(false);
    expect(isAllowedSessionPath('/../tracks/new')).toBe(false);
    expect(isAllowedSessionPath('/sid/tracks/new/extra')).toBe(false);
    expect(isAllowedSessionPath('/sid with space/tracks/new')).toBe(false);
  });
});
