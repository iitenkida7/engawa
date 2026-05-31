// Pure, side-effect-free logic extracted from the WS handler so it can be
// unit-tested in isolation. Behaviour must stay identical to the inline code
// that previously lived in websocket.ts.

import type { GroupMethod } from './types';

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

/** Max length (chars) of a single chat message after trimming. */
export const CHAT_MAX_LENGTH = 500;

/**
 * Normalize an incoming chat message: coerce to string, trim surrounding
 * whitespace, and cap length. Non-string or empty-after-trim input yields ''
 * (the caller drops empty messages). The browser renders chat with textContent,
 * so HTML is never interpreted; this only guards length and type.
 */
export function normalizeChatText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, CHAT_MAX_LENGTH);
}

/**
 * Allowed emoji reactions. The server validates against this list so a client
 * can only ever broadcast one of these (no arbitrary text). Must stay in sync
 * with the client's REACTION_EMOJIS in client/src/core/types.ts.
 */
export const REACTION_EMOJIS = ['👋', '👍', '❤️', '😂', '🎉', '🙏'] as const;

/** True when `emoji` is one of the whitelisted reaction emojis. */
export function isAllowedReaction(emoji: unknown): boolean {
  return typeof emoji === 'string' && (REACTION_EMOJIS as readonly string[]).includes(emoji);
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

// ─── Server-driven proximity grouping (SFU hybrid, issues #77/#78) ──────────
//
// The server is the single source of truth for which transport each proximity
// group uses. It computes connected components from positions + reported zone
// ids and assigns each group a method:
//   - meeting-room groups → always SFU (membership decides, distance ignored);
//   - open-floor clusters → mesh until they reach SFU_PROMOTE_AT members, then
//     they promote to SFU and *latch*: a cluster that shares any member with a
//     previous open-floor SFU group stays SFU even as it shrinks. A cluster that
//     fully disperses and reforms starts fresh as mesh.
// When SFU is disabled (no Cloudflare app configured) every group is mesh, so
// the pre-SFU behaviour is preserved exactly.

// Open-floor cluster size at which a group promotes to SFU (one-way latch).
export const SFU_PROMOTE_AT = 5;
// Connect radius (px) for the open-floor proximity graph. Mirrors the client's
// CONNECT_RADIUS so the server's grouping matches what users see on the map.
export const PROXIMITY_CONNECT_RADIUS = 120;
// Disconnect radius (px) for the open-floor proximity graph. Hysteresis is
// applied at the GROUP level (not per-pair): an edge survives out to this larger
// distance when the two members were in the same group last tick, so members
// near the boundary don't flap in and out of a group. New edges still only form
// at the connect radius. NOTE this is group-scoped, so it differs subtly from a
// per-pair rule — a pair that was only ever *transitively* connected (a chain
// A–B–C, never A–C directly) can keep an A–C edge out to this radius once they
// remain co-grouped. That is intentional under the "whole group meshes" model
// (a latecomer connects to every member, not just nearby ones).
export const PROXIMITY_DISCONNECT_RADIUS = 150;

export type GroupMember = {
  userId: string;
  x: number;
  y: number;
  // Meeting-room zone id, or null when standing on the open floor.
  zoneId: string | null;
};

export type ProximityGroup = {
  // Deterministic id (sorted member ids joined). Used only to detect change;
  // SFU-latch continuity is decided by member overlap, not by this id.
  groupId: string;
  memberIds: string[];
  method: GroupMethod;
  // True for meeting-room groups. These are NOT fed back as latch seeds, so
  // leaving a room starts a fresh open-floor mesh instead of inheriting SFU.
  isMeeting: boolean;
};

function sharesAnyMember(ids: string[], set: Set<string>): boolean {
  return ids.some((id) => set.has(id));
}

/**
 * Partition members into proximity groups and assign each a transport method.
 * Pure: identical input (including `prevSfuMemberSets`) yields identical output.
 *
 * @param members all joined members of one workspace, with positions + zone ids
 * @param opts.sfuEnabled false → every group is mesh (no Cloudflare app)
 * @param opts.prevSfuMemberSets member-id lists of the previous tick's
 *   *open-floor* SFU groups, used to latch promotion (shrinking keeps SFU).
 *   Meeting-room groups must NOT be passed here (use sfuLatchSeeds()).
 * @param opts.disconnectRadius open-floor hysteresis distance. Defaults to
 *   connectRadius (no hysteresis); pass PROXIMITY_DISCONNECT_RADIUS together
 *   with prevGroupMemberSets to keep an already-grouped pair connected out to it.
 * @param opts.prevGroupMemberSets member-id lists of the previous tick's groups
 *   (all of them), used so an existing open-floor edge survives out to
 *   disconnectRadius instead of breaking the instant a member drifts past
 *   connectRadius.
 */
export function computeProximityGroups(
  members: GroupMember[],
  opts: {
    sfuEnabled: boolean;
    prevSfuMemberSets?: string[][];
    connectRadius?: number;
    disconnectRadius?: number;
    promoteAt?: number;
    prevGroupMemberSets?: string[][];
  },
): ProximityGroup[] {
  const connectRadius = opts.connectRadius ?? PROXIMITY_CONNECT_RADIUS;
  const disconnectRadius = opts.disconnectRadius ?? connectRadius;
  const promoteAt = opts.promoteAt ?? SFU_PROMOTE_AT;
  const prevSfu = (opts.prevSfuMemberSets ?? []).map((set) => new Set(set));

  // Map each member to the index of the group it was in last tick, so an
  // open-floor edge can apply hysteresis: a pair that was already together stays
  // connected out to disconnectRadius (prevents flapping at the boundary).
  const prevGroupOf = new Map<string, number>();
  (opts.prevGroupMemberSets ?? []).forEach((ids, i) => {
    for (const id of ids) prevGroupOf.set(id, i);
  });
  const wereTogether = (aId: string, bId: string): boolean => {
    const ga = prevGroupOf.get(aId);
    return ga !== undefined && ga === prevGroupOf.get(bId);
  };

  // Two members share a proximity-graph edge iff: both stand in the same meeting
  // room (distance ignored), or both are on the open floor within the connect
  // radius — or within the (larger) disconnect radius if they were already in
  // the same group last tick. Room-vs-floor and different-room pairs never connect.
  const membersConnected = (a: GroupMember, b: GroupMember): boolean => {
    if (a.zoneId !== null || b.zoneId !== null) {
      return a.zoneId !== null && a.zoneId === b.zoneId;
    }
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d <= connectRadius) return true;
    return d <= disconnectRadius && wereTogether(a.userId, b.userId);
  };

  // Union-find over the proximity graph.
  const n = members.length;
  const parent = members.map((_, i) => i);
  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root];
    while (parent[i] !== root) {
      const next = parent[i];
      parent[i] = root;
      i = next;
    }
    return root;
  };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (membersConnected(members[i], members[j])) {
        parent[find(i)] = find(j);
      }
    }
  }

  // Bucket members by component root.
  const buckets = new Map<number, GroupMember[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const bucket = buckets.get(root);
    if (bucket) bucket.push(members[i]);
    else buckets.set(root, [members[i]]);
  }

  const groups: ProximityGroup[] = [];
  for (const bucket of buckets.values()) {
    const memberIds = bucket.map((mem) => mem.userId).sort();
    const isMeeting = bucket[0].zoneId !== null;
    // Only 2+ member groups can latch: a fully-dispersed cluster (everyone ends
    // up solo) must reset to mesh, so a lone member never inherits SFU — it has
    // no peer to talk to anyway. Symmetric with sfuLatchSeeds, which only seeds
    // 2+ groups.
    const latched =
      !isMeeting && memberIds.length >= 2 && prevSfu.some((set) => sharesAnyMember(memberIds, set));
    const method: GroupMethod = !opts.sfuEnabled
      ? 'mesh'
      : isMeeting || memberIds.length >= promoteAt || latched
        ? 'sfu'
        : 'mesh';
    groups.push({ groupId: memberIds.join(','), memberIds, method, isMeeting });
  }
  return groups;
}

/**
 * Latch seeds for the next tick: the member-id lists of the current *open-floor*
 * SFU groups. Meeting-room groups are excluded so leaving a room starts a fresh
 * mesh cluster instead of inheriting the room's SFU.
 */
export function sfuLatchSeeds(groups: ProximityGroup[]): string[][] {
  // Only 2+ member groups seed the latch: a cluster that fully disperses (every
  // member ends up alone) drops its seeds, so a later reformation starts fresh
  // as mesh rather than silently inheriting SFU.
  return groups
    .filter((g) => g.method === 'sfu' && !g.isMeeting && g.memberIds.length >= 2)
    .map((g) => g.memberIds);
}
