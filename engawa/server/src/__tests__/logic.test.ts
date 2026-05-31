import { describe, expect, test } from 'bun:test';
import {
  CHAT_MAX_LENGTH,
  clampPosition,
  computeProximityGroups,
  type GroupMember,
  generateSpawn,
  isAllowedReaction,
  MAP_HEIGHT,
  MAP_WIDTH,
  MAX_VELOCITY,
  normalizeBool,
  normalizeChatText,
  normalizeIceServers,
  normalizeName,
  normalizePlayerStatus,
  normalizeSfuTracks,
  normalizeStatusNote,
  normalizeUntil,
  normalizeVelocity,
  normalizeWorkspace,
  PLAYER_STATUSES,
  PROXIMITY_CONNECT_RADIUS,
  parseWorkspacePasswords,
  REACTION_EMOJIS,
  SFU_MAX_TRACKS,
  SFU_PROMOTE_AT,
  SFU_TRACK_NAME_MAX_LENGTH,
  STATUS_NOTE_MAX_LENGTH,
  sfuLatchSeeds,
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

describe('normalizeChatText', () => {
  test('trims surrounding whitespace', () => {
    expect(normalizeChatText('  hello  ')).toBe('hello');
  });

  test('returns empty for non-string input', () => {
    expect(normalizeChatText(undefined)).toBe('');
    expect(normalizeChatText(123)).toBe('');
    expect(normalizeChatText(null)).toBe('');
  });

  test('returns empty for whitespace-only input', () => {
    expect(normalizeChatText('   ')).toBe('');
  });

  test('caps length at CHAT_MAX_LENGTH', () => {
    const long = 'a'.repeat(CHAT_MAX_LENGTH + 50);
    expect(normalizeChatText(long)).toHaveLength(CHAT_MAX_LENGTH);
  });
});

describe('normalizeStatusNote', () => {
  test('trims and keeps the note', () => {
    expect(normalizeStatusNote('  ランチ  ')).toBe('ランチ');
  });

  test('returns empty for non-string or empty input', () => {
    expect(normalizeStatusNote(undefined)).toBe('');
    expect(normalizeStatusNote(42)).toBe('');
    expect(normalizeStatusNote('   ')).toBe('');
  });

  test('caps length at STATUS_NOTE_MAX_LENGTH', () => {
    const long = 'あ'.repeat(STATUS_NOTE_MAX_LENGTH + 10);
    expect(normalizeStatusNote(long)).toHaveLength(STATUS_NOTE_MAX_LENGTH);
  });
});

describe('normalizeUntil', () => {
  test('passes through a finite positive epoch ms', () => {
    expect(normalizeUntil(1893456000000)).toBe(1893456000000);
  });

  test('rejects non-numbers, non-finite, and non-positive values', () => {
    expect(normalizeUntil(undefined)).toBeNull();
    expect(normalizeUntil('soon')).toBeNull();
    expect(normalizeUntil(Number.NaN)).toBeNull();
    expect(normalizeUntil(Infinity)).toBeNull();
    expect(normalizeUntil(0)).toBeNull();
    expect(normalizeUntil(-5)).toBeNull();
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
    const arr = [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ];
    expect(normalizeIceServers(arr)).toBe(arr);
  });

  test('yields an empty array for null/undefined/primitive input', () => {
    expect(normalizeIceServers(null)).toEqual([]);
    expect(normalizeIceServers(undefined)).toEqual([]);
    expect(normalizeIceServers('stun:foo')).toEqual([]);
  });
});

describe('computeProximityGroups', () => {
  const m = (userId: string, x: number, y: number, zoneId: string | null = null): GroupMember => ({
    userId,
    x,
    y,
    zoneId,
  });

  const groupOf = (groups: ReturnType<typeof computeProximityGroups>, userId: string) =>
    groups.find((g) => g.memberIds.includes(userId));

  test('open floor: two players within the radius form one mesh group', () => {
    const groups = computeProximityGroups([m('a', 0, 0), m('b', 50, 0)], { sfuEnabled: true });
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(['a', 'b']);
    expect(groups[0].method).toBe('mesh');
    expect(groups[0].isMeeting).toBe(false);
  });

  test('open floor: players beyond the radius are separate single-member groups', () => {
    const groups = computeProximityGroups([m('a', 0, 0), m('b', PROXIMITY_CONNECT_RADIUS + 1, 0)], {
      sfuEnabled: true,
    });
    expect(groups).toHaveLength(2);
    expect(groups.every((g) => g.method === 'mesh')).toBe(true);
  });

  test('connectivity is transitive (A-B and B-C close, A-C far → one group)', () => {
    const groups = computeProximityGroups([m('a', 0, 0), m('b', 100, 0), m('c', 200, 0)], {
      sfuEnabled: true,
      connectRadius: 120,
    });
    expect(groups).toHaveLength(1);
    expect(groups[0].memberIds).toEqual(['a', 'b', 'c']);
  });

  test('open floor: promotes to SFU at exactly SFU_PROMOTE_AT members', () => {
    const cluster = (n: number): GroupMember[] =>
      Array.from({ length: n }, (_, i) => m(String(i), i * 30, 0));
    expect(
      computeProximityGroups(cluster(SFU_PROMOTE_AT - 1), { sfuEnabled: true })[0].method,
    ).toBe('mesh');
    expect(computeProximityGroups(cluster(SFU_PROMOTE_AT), { sfuEnabled: true })[0].method).toBe(
      'sfu',
    );
  });

  test('meeting room: same-zone members are always SFU regardless of count/distance', () => {
    const groups = computeProximityGroups(
      [m('a', 0, 0, 'meeting-1'), m('b', 9999, 9999, 'meeting-1')],
      { sfuEnabled: true },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].method).toBe('sfu');
    expect(groups[0].isMeeting).toBe(true);
  });

  test('different meeting rooms are separate groups', () => {
    const groups = computeProximityGroups([m('a', 0, 0, 'meeting-1'), m('b', 10, 0, 'meeting-2')], {
      sfuEnabled: true,
    });
    expect(groups).toHaveLength(2);
  });

  test('a room member and an adjacent open-floor member never share a group', () => {
    const groups = computeProximityGroups([m('a', 0, 0, 'meeting-1'), m('b', 1, 0, null)], {
      sfuEnabled: true,
    });
    expect(groups).toHaveLength(2);
    expect(groupOf(groups, 'a')?.method).toBe('sfu'); // room → SFU
    expect(groupOf(groups, 'b')?.method).toBe('mesh'); // open floor, alone → mesh
  });

  test('latch: a shrinking SFU cluster stays SFU (no demotion)', () => {
    // a, b, c, d, e were an open-floor SFU group; now e has left.
    const members = ['a', 'b', 'c', 'd'].map((id, i) => m(id, i * 30, 0));
    const groups = computeProximityGroups(members, {
      sfuEnabled: true,
      prevSfuMemberSets: [['a', 'b', 'c', 'd', 'e']],
    });
    expect(groups[0].memberIds).toEqual(['a', 'b', 'c', 'd']);
    expect(groups[0].method).toBe('sfu');
  });

  test('no latch without history: a fresh 4-person cluster is mesh', () => {
    const members = ['a', 'b', 'c', 'd'].map((id, i) => m(id, i * 30, 0));
    const groups = computeProximityGroups(members, { sfuEnabled: true, prevSfuMemberSets: [] });
    expect(groups[0].method).toBe('mesh');
  });

  test('disperse and reform: a cluster with no shared members starts fresh as mesh', () => {
    const members = ['x', 'y'].map((id, i) => m(id, i * 30, 0));
    const groups = computeProximityGroups(members, {
      sfuEnabled: true,
      prevSfuMemberSets: [['a', 'b', 'c', 'd', 'e']],
    });
    expect(groups[0].method).toBe('mesh');
  });

  test('full disperse: former SFU members now alone are mesh, never solo-latched', () => {
    // a..e were an SFU cluster; now each stands far from the rest (own group).
    // A solo member must NOT inherit SFU — the cluster has effectively dissolved.
    const members = ['a', 'b', 'c', 'd', 'e'].map((id, i) => m(id, i * 1000, 0));
    const groups = computeProximityGroups(members, {
      sfuEnabled: true,
      prevSfuMemberSets: [['a', 'b', 'c', 'd', 'e']],
    });
    expect(groups).toHaveLength(5);
    expect(groups.every((g) => g.method === 'mesh')).toBe(true);
  });

  test('sfuEnabled=false: everything is mesh (rooms and big clusters too)', () => {
    const members = [
      ...['a', 'b', 'c', 'd', 'e'].map((id, i) => m(id, i * 30, 0)),
      m('r', 0, 0, 'meeting-1'),
    ];
    const groups = computeProximityGroups(members, { sfuEnabled: false });
    expect(groups.every((g) => g.method === 'mesh')).toBe(true);
  });

  test('groupId is deterministic (sorted members) regardless of input order', () => {
    const g1 = computeProximityGroups([m('b', 0, 0), m('a', 30, 0)], { sfuEnabled: true });
    const g2 = computeProximityGroups([m('a', 30, 0), m('b', 0, 0)], { sfuEnabled: true });
    expect(g1[0].groupId).toBe('a,b');
    expect(g2[0].groupId).toBe('a,b');
  });

  test('empty input yields no groups', () => {
    expect(computeProximityGroups([], { sfuEnabled: true })).toEqual([]);
  });

  describe('open-floor hysteresis (connect vs disconnect radius)', () => {
    // a, b sit between the two radii: too far to form a NEW edge, but close
    // enough that an existing edge survives.
    const between = [m('a', 0, 0), m('b', 135, 0)]; // 135: in (120, 150]

    test('a pair between the radii does NOT connect without prior grouping', () => {
      const groups = computeProximityGroups(between, {
        sfuEnabled: true,
        connectRadius: 120,
        disconnectRadius: 150,
      });
      expect(groups).toHaveLength(2); // no edge formed by hysteresis alone
    });

    test('a pair between the radii STAYS connected if they were grouped last tick', () => {
      const groups = computeProximityGroups(between, {
        sfuEnabled: true,
        connectRadius: 120,
        disconnectRadius: 150,
        prevGroupMemberSets: [['a', 'b']],
      });
      expect(groups).toHaveLength(1);
      expect(groups[0].memberIds).toEqual(['a', 'b']);
    });

    test('an edge breaks once the pair exceeds the disconnect radius', () => {
      const groups = computeProximityGroups([m('a', 0, 0), m('b', 200, 0)], {
        sfuEnabled: true,
        connectRadius: 120,
        disconnectRadius: 150,
        prevGroupMemberSets: [['a', 'b']],
      });
      expect(groups).toHaveLength(2);
    });
  });
});

describe('sfuLatchSeeds', () => {
  test('returns member lists of open-floor SFU groups only (excludes rooms and mesh)', () => {
    const groups = [
      {
        groupId: 'a,b',
        memberIds: ['a', 'b', 'c', 'd', 'e'],
        method: 'sfu' as const,
        isMeeting: false,
      },
      { groupId: 'r1,r2', memberIds: ['r1', 'r2'], method: 'sfu' as const, isMeeting: true },
      { groupId: 'x,y', memberIds: ['x', 'y'], method: 'mesh' as const, isMeeting: false },
    ];
    expect(sfuLatchSeeds(groups)).toEqual([['a', 'b', 'c', 'd', 'e']]);
  });

  test('round-trips: a promoted cluster seeds its own latch the next tick', () => {
    const full = ['a', 'b', 'c', 'd', 'e'].map(
      (id, i): GroupMember => ({ userId: id, x: i * 30, y: 0, zoneId: null }),
    );
    const seeds = sfuLatchSeeds(computeProximityGroups(full, { sfuEnabled: true }));
    // Drop two members; the remaining 3-person cluster must stay SFU via latch.
    const shrunk = ['a', 'b', 'c'].map(
      (id, i): GroupMember => ({ userId: id, x: i * 30, y: 0, zoneId: null }),
    );
    const second = computeProximityGroups(shrunk, { sfuEnabled: true, prevSfuMemberSets: seeds });
    expect(second[0].method).toBe('sfu');
  });
});

describe('isAllowedReaction', () => {
  test('accepts every whitelisted emoji', () => {
    for (const emoji of REACTION_EMOJIS) {
      expect(isAllowedReaction(emoji)).toBe(true);
    }
  });

  test('rejects emojis outside the whitelist', () => {
    expect(isAllowedReaction('🔥')).toBe(false);
    expect(isAllowedReaction('😀')).toBe(false);
  });

  test('rejects non-string and empty input', () => {
    expect(isAllowedReaction('')).toBe(false);
    expect(isAllowedReaction(undefined)).toBe(false);
    expect(isAllowedReaction(42)).toBe(false);
    // No arbitrary text — guards against an emoji with extra characters.
    expect(isAllowedReaction('👍 hello')).toBe(false);
  });
});

describe('normalizePlayerStatus', () => {
  test('passes through every known status', () => {
    for (const status of PLAYER_STATUSES) {
      expect(normalizePlayerStatus(status)).toBe(status);
    }
  });

  test('falls back to online for unknown or non-string input', () => {
    expect(normalizePlayerStatus('offline')).toBe('online');
    expect(normalizePlayerStatus('')).toBe('online');
    expect(normalizePlayerStatus(undefined)).toBe('online');
    expect(normalizePlayerStatus(null)).toBe('online');
    expect(normalizePlayerStatus(42)).toBe('online');
    expect(normalizePlayerStatus({ status: 'busy' })).toBe('online');
  });
});

describe('normalizeBool', () => {
  test('only literal true is true', () => {
    expect(normalizeBool(true)).toBe(true);
  });

  test('everything else is false', () => {
    expect(normalizeBool(false)).toBe(false);
    expect(normalizeBool(undefined)).toBe(false);
    expect(normalizeBool(null)).toBe(false);
    expect(normalizeBool(1)).toBe(false);
    expect(normalizeBool('true')).toBe(false);
    expect(normalizeBool(0)).toBe(false);
  });
});

describe('normalizeVelocity', () => {
  test('passes through a finite value within bounds', () => {
    expect(normalizeVelocity(0)).toBe(0);
    expect(normalizeVelocity(210)).toBe(210);
    expect(normalizeVelocity(-630)).toBe(-630);
  });

  test('clamps values beyond ±MAX_VELOCITY', () => {
    expect(normalizeVelocity(MAX_VELOCITY + 1000)).toBe(MAX_VELOCITY);
    expect(normalizeVelocity(-(MAX_VELOCITY + 1000))).toBe(-MAX_VELOCITY);
    expect(normalizeVelocity(1e9)).toBe(MAX_VELOCITY);
  });

  test('collapses non-finite and garbage to 0', () => {
    expect(normalizeVelocity(Number.NaN)).toBe(0);
    expect(normalizeVelocity(Number.POSITIVE_INFINITY)).toBe(0);
    expect(normalizeVelocity(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(normalizeVelocity('fast')).toBe(0);
    expect(normalizeVelocity(undefined)).toBe(0);
    expect(normalizeVelocity(null)).toBe(0);
  });

  test('coerces a numeric string like the original Number() behaviour', () => {
    expect(normalizeVelocity('120')).toBe(120);
  });
});

describe('normalizeSfuTracks', () => {
  test('keeps well-formed entries', () => {
    const tracks = [
      { kind: 'mic', trackName: 'mic-1' },
      { kind: 'cam', trackName: 'cam-1' },
      { kind: 'screen', trackName: 'screen-1' },
    ] as const;
    expect(normalizeSfuTracks(tracks)).toEqual([...tracks]);
  });

  test('drops entries with an unknown kind or bad trackName', () => {
    const tracks = [
      { kind: 'mic', trackName: 'ok' },
      { kind: 'bogus', trackName: 'x' },
      { kind: 'cam', trackName: '' },
      { kind: 'cam', trackName: 42 },
      { kind: 'screen' },
      'not-an-object',
      null,
    ];
    expect(normalizeSfuTracks(tracks)).toEqual([{ kind: 'mic', trackName: 'ok' }]);
  });

  test('drops a trackName over the length cap', () => {
    const long = 'a'.repeat(SFU_TRACK_NAME_MAX_LENGTH + 1);
    const atCap = 'b'.repeat(SFU_TRACK_NAME_MAX_LENGTH);
    expect(
      normalizeSfuTracks([
        { kind: 'mic', trackName: long },
        { kind: 'cam', trackName: atCap },
      ]),
    ).toEqual([{ kind: 'cam', trackName: atCap }]);
  });

  test('bounds the total number of tracks', () => {
    const many = Array.from({ length: SFU_MAX_TRACKS + 5 }, (_, i) => ({
      kind: 'mic' as const,
      trackName: `t-${i}`,
    }));
    expect(normalizeSfuTracks(many)).toHaveLength(SFU_MAX_TRACKS);
  });

  test('returns an empty array for non-array input', () => {
    expect(normalizeSfuTracks(undefined)).toEqual([]);
    expect(normalizeSfuTracks(null)).toEqual([]);
    expect(normalizeSfuTracks('tracks')).toEqual([]);
    expect(normalizeSfuTracks({ kind: 'mic', trackName: 'x' })).toEqual([]);
  });
});
