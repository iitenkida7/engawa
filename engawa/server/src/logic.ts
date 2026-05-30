// Pure, side-effect-free logic extracted from the WS handler so it can be
// unit-tested in isolation. Behaviour must stay identical to the inline code
// that previously lived in websocket.ts.

/** Map bounds used to clamp player positions. */
export const MAP_WIDTH = 2000;
export const MAP_HEIGHT = 1500;

/**
 * Validate a workspace password against the configured password table.
 *
 * Returns true when access is allowed:
 * - the workspace has no configured password (open workspace), or
 * - the supplied password exactly matches the configured one.
 */
export function verifyWorkspacePassword(
  workspace: string,
  password: string | undefined,
  table: Map<string, string>,
): boolean {
  const requiredPass = table.get(workspace);
  if (!requiredPass) return true;
  return password === requiredPass;
}

/**
 * Parse the WORKSPACE_PASSWORDS env value into a lookup table.
 *
 * Expected format: JSON object like {"ws1":"pass1","ws2":"pass2"}.
 * Empty/unset/invalid input yields an empty map (all workspaces open).
 */
export function parseWorkspacePasswords(raw: string | undefined): Map<string, string> {
  if (!raw) return new Map();
  try {
    const obj = JSON.parse(raw) as Record<string, string>;
    return new Map(Object.entries(obj));
  } catch {
    console.warn('[auth] WORKSPACE_PASSWORDS is not valid JSON, ignoring');
    return new Map();
  }
}

/** Normalize a workspace name: default fallback and length cap. */
export function normalizeWorkspace(workspace: string | undefined): string {
  return (workspace || 'default').slice(0, 64);
}

/** Normalize a player name: default fallback and length cap. */
export function normalizeName(name: string | undefined): string {
  return (name || 'anon').slice(0, 24);
}

/**
 * Clamp a coordinate pair into the map bounds. Non-finite inputs collapse to 0,
 * matching the original `Number(v) || 0` behaviour.
 */
export function clampPosition(
  x: number,
  y: number,
  w: number = MAP_WIDTH,
  h: number = MAP_HEIGHT,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(w, Number(x) || 0)),
    y: Math.max(0, Math.min(h, Number(y) || 0)),
  };
}

/**
 * Generate a spawn position in the open office area (center aisle, avoids
 * walls/desks). The random source is injectable so spawns can be made
 * deterministic in tests.
 */
export function generateSpawn(rand: () => number = Math.random): { x: number; y: number } {
  return {
    x: 800 + rand() * 400,
    y: 400 + rand() * 600,
  };
}

/**
 * Normalize an `iceServers` value into the array shape RTCPeerConnection
 * requires. Cloudflare's credentials endpoint returns a single object
 * ({ urls, username, credential }), but the browser rejects a non-array
 * `iceServers` ("must have a callable @@iterator property"), so a bare object
 * is wrapped in a one-element array. Arrays pass through unchanged; anything
 * else (null/undefined/primitive) yields an empty array.
 */
export function normalizeIceServers(iceServers: unknown): unknown[] {
  if (Array.isArray(iceServers)) return iceServers;
  if (iceServers && typeof iceServers === 'object') return [iceServers];
  return [];
}
