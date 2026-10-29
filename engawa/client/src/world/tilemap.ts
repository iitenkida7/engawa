import {
  type Facing,
  type FurnitureKind,
  furnitureRect,
  furnitureSeats,
  type MapDef,
  type RoomKind,
  TILE_SIZE,
  type TileRect,
} from '@maps/map-def';
import { getLang } from '@/core/i18n';
import type { FloorStyle } from '@/world/floor-styles';
import { takeMap } from '@/world/map-data';
import type { Direction } from '@/world/outfit';

// Split-out modules, re-exported so callers keep importing from tilemap.
export {
  CAFE_COLOR,
  FLOOR_COLOR_COUNT,
  FLOOR_PATTERNS,
  type FloorPattern,
  type FloorStyle,
} from '@/world/floor-styles';

export { TILE_SIZE };

// The layout itself is data (maps/map-def.ts), served by the server and
// installed before this module loads (world/map-data.ts); this module builds the
// walkable grid, call zones and every derived rect from it, and answers position
// queries. It stays pure layout + collision: tile colours and part art live with
// the renderer (world/map-art.ts).
export const MAP = takeMap();

export const MAP_COLS = MAP.cols;
export const MAP_ROWS = MAP.rows;
// Pixel size of the whole map. The server clamps positions to the same bounds,
// derived from the same map.
export const MAP_WIDTH = MAP_COLS * TILE_SIZE;
export const MAP_HEIGHT = MAP_ROWS * TILE_SIZE;

export const Tile = {
  FLOOR: 0,
  WALL: 1,
  DESK: 2,
  MEETING: 3,
  LOUNGE: 4,
  PLANT: 5,
  // Outdoor tiles (#229): walkable grass, plus solid trees and a pond on it.
  GRASS: 6,
  TREE: 7,
  POND: 8,
} as const;

export const SOLID = new Set<number>([Tile.WALL, Tile.DESK, Tile.PLANT, Tile.TREE, Tile.POND]);

type Rect = { x: number; y: number; w: number; h: number };

// Tile rect → pixel rect. NOT `px`: that is the pixel-x parameter name of
// every position query below, which would shadow it there.
function toPx(t: TileRect): Rect {
  return { x: t.c * TILE_SIZE, y: t.r * TILE_SIZE, w: t.w * TILE_SIZE, h: t.h * TILE_SIZE };
}

function inRect(r: Rect, x: number, y: number): boolean {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// Rug look for an area that doesn't pick one. Frozen because every area without
// a rug is handed this same object (the map's own styles are frozen too, see
// assertMapDef) — one stray write would restyle the map for the session.
const PLAIN_FLOOR: FloorStyle = Object.freeze({ pattern: 'none', color: 0 });

export function isSolid(px: number, py: number): boolean {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return true;
  if (SOLID.has(officeMap[row][col])) return true;
  // Sub-tile props that don't align to the grid (e.g. the lounge coffee table).
  for (const r of SOLID_RECTS) {
    if (inRect(r, px, py)) return true;
  }
  return false;
}

export function canOccupy(cx: number, cy: number, radius: number): boolean {
  return (
    !isSolid(cx - radius, cy - radius) &&
    !isSolid(cx + radius, cy - radius) &&
    !isSolid(cx - radius, cy + radius) &&
    !isSolid(cx + radius, cy + radius)
  );
}

// ── Desk units ──
// Each open-office desk is an isolated workstation (#263 follow-up): a 3-tile
// desk with ONE chair centred in front, so a desk seat is a private one-person
// spot until someone steps into the tiles around it (the server shrinks a
// seated person's proximity bubble; see SEAT_CONNECT_RADIUS).
type DeskUnit = MapDef['desks'][number];

// The chair tile sits one row in front of the desk's centre (south → above,
// north → below).
function seatOf(u: DeskUnit): [number, number] {
  return [u.c, u.r + (u.facing === 'south' ? -1 : 1)];
}

function buildOfficeMap(): number[][] {
  const m: number[][] = [];
  for (let r = 0; r < MAP_ROWS; r++) {
    m.push(new Array(MAP_COLS).fill(Tile.GRASS));
  }
  const fill = (c: number, r: number, w: number, h: number, t: number) => {
    for (let rr = r; rr < r + h; rr++)
      for (let cc = c; cc < c + w; cc++) {
        if (rr >= 0 && rr < MAP_ROWS && cc >= 0 && cc < MAP_COLS) m[rr][cc] = t;
      }
  };
  const set = (c: number, r: number, t: number) => fill(c, r, 1, 1, t);

  // ── Buildings: floor, then the outer wall ring, then its doors ──
  for (const b of MAP.buildings) {
    fill(b.c, b.r, b.w, b.h, Tile.FLOOR);
    fill(b.c, b.r, b.w, 1, Tile.WALL);
    fill(b.c, b.r + b.h - 1, b.w, 1, Tile.WALL);
    fill(b.c, b.r, 1, b.h, Tile.WALL);
    fill(b.c + b.w - 1, b.r, 1, b.h, Tile.WALL);
    for (const [c, r] of b.doors) set(c, r, Tile.FLOOR);
  }

  // ── Rooms: wall ring → MEETING interior → doors → table ──
  for (const room of MAP.rooms) {
    const { c, r, w, h } = room;
    fill(c - 1, r - 1, w + 2, 1, Tile.WALL); // top wall
    fill(c - 1, r + h, w + 2, 1, Tile.WALL); // bottom wall
    fill(c - 1, r - 1, 1, h + 2, Tile.WALL); // left wall
    fill(c + w, r - 1, 1, h + 2, Tile.WALL); // right wall
    fill(c, r, w, h, Tile.MEETING); // interior
    for (const [dc, dr] of room.doors) set(dc, dr, Tile.FLOOR);
    if (room.table) fill(room.table.c, room.table.r, room.table.w, room.table.h, Tile.DESK);
  }

  // ── Household furniture: solid bodies (a sofa is all seats, so walkable) ──
  for (const f of MAP.furniture ?? []) {
    if (f.kind === 'sofa') continue;
    const t = furnitureRect(f);
    fill(t.c, t.r, t.w, t.h, Tile.DESK);
  }

  // ── Café rugs (walkable), then desks + greenery ──
  for (const lo of MAP.lounges) fill(lo.c, lo.r, lo.w, lo.h, Tile.LOUNGE);
  for (const u of MAP.desks) fill(u.c - 1, u.r, 3, 1, Tile.DESK);
  for (const [c, r] of MAP.plants) set(c, r, Tile.PLANT);

  // ── Outdoors: ponds and trees (both solid) ──
  // Trees go down last; assertMapDef has already checked each is on open grass,
  // so none overwrites anything (or seals a doorway).
  for (const p of MAP.ponds) fill(p.c, p.r, p.w, p.h, Tile.POND);
  for (const t of MAP.trees) fill(t.c, t.r, t.size, t.size, Tile.TREE);

  return m;
}

export const officeMap = buildOfficeMap();

// One tree on the grounds: its top-left pixel and tile span (1 = small, 2 = a big
// 2×2 tree). The renderer draws from this list.
export type Tree = { x: number; y: number; tiles: number; variant: number };
export const TREES: Tree[] = MAP.trees.map((t) => ({
  x: t.c * TILE_SIZE,
  y: t.r * TILE_SIZE,
  tiles: t.size,
  variant: t.variant,
}));

// Pixel rects of the outdoor ponds; the renderer draws the water.
export const POND_RECTS: Rect[] = MAP.ponds.map(toPx);

// Furniture footprint for the renderer: the room's table rect (the meeting-table
// surface) plus the room interior rect (to bound chair placement). Every room —
// including the president's office — gets a meeting table with chairs.
export type RoomFurniture = {
  x: number;
  y: number;
  w: number;
  h: number;
  ix: number;
  iy: number;
  iw: number;
  ih: number;
};

export const ROOM_FURNITURE: RoomFurniture[] = MAP.rooms.flatMap((room) => {
  if (!room.table) return [];
  const t = toPx(room.table);
  const i = toPx(room);
  return [{ ...t, ix: i.x, iy: i.y, iw: i.w, ih: i.h }];
});

// Household furniture for the renderer: each piece's pixel rect (already turned
// for east/west) and the way it faces.
export const FURNITURE: { kind: FurnitureKind; facing: Facing; rect: Rect }[] = (
  MAP.furniture ?? []
).map((f) => ({ kind: f.kind, facing: f.facing ?? 'south', rect: toPx(furnitureRect(f)) }));

// Interior pixel rects of the meeting rooms, for the renderer to add a wall
// whiteboard and a filing cabinet.
export const MEETING_ROOM_RECTS: Rect[] = MAP.rooms.filter((r) => r.kind === 'meeting').map(toPx);

// Desk tiles drawn facing south (map coords), for the renderer's monitor flip.
const SOUTH_DESK_TILES = new Set<string>(
  MAP.desks
    .filter((u) => u.facing === 'south')
    .flatMap((u) => [u.c - 1, u.c, u.c + 1].map((c) => `${c},${u.r}`)),
);

/** True when the open-office desk at (map col,row) is drawn facing south. */
export function deskFacesSouth(col: number, row: number): boolean {
  return SOUTH_DESK_TILES.has(`${col},${row}`);
}

// Chairs for the renderer: the desk centre tile + facing; the chair is drawn one
// tile in front of it.
export const OPEN_DESK_CHAIRS: { col: number; row: number; facesSouth: boolean }[] = MAP.desks.map(
  (u) => ({ col: u.c, row: u.r, facesSouth: u.facing === 'south' }),
);

// Seat tiles — the whole walkable rug around a desk, not just the chair tile:
// the seat row (chair + its two side tiles) plus the row on the far side of the
// desk, i.e. the 3×3 pod rug minus the solid desk row. Standing anywhere on the
// rug marks you "seated", which privatises your proximity bubble (server-side) —
// so you can shuffle around your own rug without losing the private bubble, and
// others only greet you once they step onto the rug too.
const SEAT_TILES = new Set<string>(
  MAP.desks.flatMap((u) => {
    const [sc, sr] = seatOf(u);
    const tiles: string[] = [];
    for (let c = sc - 1; c <= sc + 1; c++) {
      for (let r = sr - 1; r <= sr + 1; r++) {
        if (r === u.r) continue; // skip the solid desk row (can't stand there)
        tiles.push(`${c},${r}`);
      }
    }
    return tiles;
  }),
);

/**
 * True when (px,py) is on a desk's rug (a private one-person spot). A desk inside
 * a room counts too, though it changes nothing there: the server groups zone
 * members by zone without ever looking at the seated flag.
 */
export function isDeskSeat(px: number, py: number): boolean {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  return SEAT_TILES.has(`${col},${row}`);
}

// One accent rug per desk that asks for one — a 3×3 block centred on the chair,
// i.e. the exact "connect zone" (the seat + its 8 adjacent tiles,
// SEAT_CONNECT_RADIUS). It makes each private seat legible: step onto someone's
// rug and you connect, stay off it and you don't. The desk is drawn over the
// desk-side row of the rug.
export const POD_RUGS: { rect: Rect; style: FloorStyle }[] = MAP.desks.flatMap((u) => {
  if (!u.rug) return [];
  const [sc, sr] = seatOf(u);
  return [{ rect: toPx({ c: sc - 1, r: sr - 1, w: 3, h: 3 }), style: u.rug }];
});

// Team areas: a shared rug where everyone on it is in one call, like a room, but
// it is NOT a zone on the client: it looks and behaves like a pod rug (no meeting
// layout, frame or exit mute) and only reports a call zone id to the server for
// grouping (callZoneAt).
export const TEAM_AREAS: { id: string; rect: Rect; style: FloorStyle }[] = MAP.teamAreas.map(
  (a) => ({ id: a.id, rect: toPx(a), style: a.floor ?? PLAIN_FLOOR }),
);

/**
 * The pod rug (a seat's 3×3 rect, or a shared team-area rug) that (px,py) sits
 * on, or null. Used to focus just your own desk island while a desk-side
 * conversation is active — the same dim veil as a meeting room (#223) but
 * scoped to the rug.
 */
const ALL_RUGS: Rect[] = [...POD_RUGS.map((p) => p.rect), ...TEAM_AREAS.map((a) => a.rect)];

export function podRugAt(px: number, py: number): Rect | null {
  for (const rug of ALL_RUGS) {
    if (inRect(rug, px, py)) return rug;
  }
  return null;
}

// Pixel rect of each café, for the renderer (rug accent + sofas/coffee table).
export const LOUNGE_RECTS: Rect[] = MAP.lounges.map(toPx);

// Pixel rect of each café's coffee table, centered in the café (46% × 20% of it).
// Shared by the renderer (draws it) and collision (SOLID_RECTS) so the two can't
// drift — you can't walk onto the table (#225).
export const LOUNGE_TABLE_RECTS: Rect[] = LOUNGE_RECTS.map((r) => ({
  x: r.x + r.w / 2 - (r.w * 0.46) / 2,
  y: r.y + r.h / 2 - (r.h * 0.2) / 2,
  w: r.w * 0.46,
  h: r.h * 0.2,
}));

// Impassable sub-tile props, checked by isSolid in addition to the SOLID tile
// kinds. Pixel rects so props that don't fill a whole tile still block.
const SOLID_RECTS: Rect[] = [...LOUNGE_TABLE_RECTS];

// ===== Sitting spots =====
// Where an avatar is drawn seated (world/canvas.ts): standing still on a desk
// chair's tile or on a café armchair. It is a pure position → facing lookup, so
// every viewer derives the same pose from the positions that are already synced
// — nothing extra goes over the wire, and the server's `seated` flag (the whole
// desk rug, see isDeskSeat) is untouched.

// Armchair layout around each café's coffee table: three above (facing down) and
// three below (facing up), `ARMCHAIR_GAP` from the table edge. The renderer
// (canvas.ts drawLounge) draws the chairs from these same numbers.
export const ARMCHAIR_GAP = 26;
export const ARMCHAIR_DX = [-52, 0, 52];
export const ARMCHAIR_SPOTS: { x: number; y: number; facing: Direction }[] = LOUNGE_RECTS.flatMap(
  (f, i) => {
    const table = LOUNGE_TABLE_RECTS[i];
    const cx = f.x + f.w / 2;
    return ARMCHAIR_DX.flatMap((dx): { x: number; y: number; facing: Direction }[] => [
      { x: cx + dx, y: table.y - ARMCHAIR_GAP, facing: 'down' },
      { x: cx + dx, y: table.y + table.h + ARMCHAIR_GAP, facing: 'up' },
    ]);
  },
);
// How close to an armchair's centre counts as sitting in it.
const ARMCHAIR_SEAT_RADIUS = 25;

/**
 * A sitting spot: which way its occupant faces, and how far UP to draw them (and
 * everything anchored to them) so they land on the chair rather than beside it.
 *
 * Every desk chair is drawn tucked against its desk. For a chair ABOVE its desk
 * that is the near edge of the seat tile — right where an avatar standing in the
 * middle of that tile already has its feet, so no lift. For a chair BELOW its
 * desk it is the FAR edge, a whole tile above those feet, and the avatar read as
 * standing behind its chair. Half a tile closes that gap; a full tile put the
 * avatar up on the desk. The café armchairs are centred on their spot: no lift.
 */
export type Seat = { facing: Direction; lift: number };

// How far up a chair below its desk seats its occupant (see Seat.lift).
const SEAT_LIFT = TILE_SIZE / 2;

// The chair tile of every desk → its seat: the desk is in front of the chair, so
// a south-facing unit (chair above) faces down.
const DESK_SEATS = new Map<string, Seat>(
  MAP.desks.map((u): [string, Seat] => {
    const [sc, sr] = seatOf(u);
    const south = u.facing === 'south';
    return [`${sc},${sr}`, { facing: south ? 'down' : 'up', lift: south ? 0 : SEAT_LIFT }];
  }),
);

// Map facing → the way a sitter looks.
const LOOK: Record<Facing, Direction> = { south: 'down', north: 'up', east: 'right', west: 'left' };

// Sofa seats and dining chairs: drawn centred on their tile, so no lift.
const FURNITURE_SEATS = new Map<string, Seat>(
  (MAP.furniture ?? [])
    .flatMap(furnitureSeats)
    .map((s): [string, Seat] => [`${s.c},${s.r}`, { facing: LOOK[s.facing], lift: 0 }]),
);

/**
 * The seat at (px,py), or null when it is not a chair. Pure geometry; the caller
 * decides *when* to sit (standing still).
 */
export function seatAt(px: number, py: number): Seat | null {
  const tile = `${Math.floor(px / TILE_SIZE)},${Math.floor(py / TILE_SIZE)}`;
  const desk = DESK_SEATS.get(tile) ?? FURNITURE_SEATS.get(tile);
  if (desk) return desk;
  for (const a of ARMCHAIR_SPOTS) {
    if (Math.hypot(px - a.x, py - a.y) <= ARMCHAIR_SEAT_RADIUS) {
      return { facing: a.facing, lift: 0 };
    }
  }
  return null;
}

/**
 * Named call zone: a room or a café. Zones act as isolated call bubbles: everyone
 * inside the same zone is connected regardless of distance, and audio/video
 * never leaks to/from people outside (see proximity.ts). The pixel rect is the
 * interior bounding box, used for drawing the frame/label and the floor rug.
 */
export type Zone = {
  id: string;
  name: string;
  kind: RoomKind | 'lounge';
  x: number;
  y: number;
  w: number;
  h: number;
};

/**
 * Build one named Zone per room and café. zoneGrid marks a room's whole interior
 * rect (incl. its table, so the room's floor rug shows under the furniture too)
 * and only a café's LOUNGE tiles (it has no walls).
 */
function buildZones(): { zones: Zone[]; grid: number[][]; styles: Map<string, FloorStyle> } {
  const grid: number[][] = officeMap.map((row) => row.map(() => -1));
  const zones: Zone[] = [];
  const styles = new Map<string, FloorStyle>();
  const lang = getLang();
  const add = (
    area: TileRect & { id: string; name: { ja: string; en: string }; floor?: FloorStyle },
    kind: Zone['kind'],
    onlyTile?: number,
  ) => {
    const idx = zones.length;
    for (let rr = area.r; rr < area.r + area.h; rr++) {
      for (let cc = area.c; cc < area.c + area.w; cc++) {
        if (rr < 0 || rr >= MAP_ROWS || cc < 0 || cc >= MAP_COLS) continue;
        if (onlyTile === undefined || officeMap[rr][cc] === onlyTile) grid[rr][cc] = idx;
      }
    }
    zones.push({ id: area.id, name: area.name[lang] ?? area.name.en, kind, ...toPx(area) });
    styles.set(area.id, area.floor ?? PLAIN_FLOOR);
  };
  for (const room of MAP.rooms) add(room, room.kind);
  for (const lo of MAP.lounges) add(lo, 'lounge', Tile.LOUNGE);
  return { zones, grid, styles };
}

const { zones: zonesList, grid: zoneGrid, styles: zoneStyles } = buildZones();

export const ZONES: Zone[] = zonesList;

// The meeting rooms proper (kind 'meeting'), as opposed to the president's
// office, 1-on-1 rooms, booths and cafés. A Set, not a scan: the game loop calls
// this every frame (core/app.ts).
const MEETING_ROOM_IDS = new Set<string>(
  ZONES.filter((z) => z.kind === 'meeting').map((z) => z.id),
);

export function isMeetingRoom(zoneId: string | null | undefined): boolean {
  return !!zoneId && MEETING_ROOM_IDS.has(zoneId);
}

// Every zone is a conversation-restricted call bubble (meeting rooms, 1-on-1
// rooms, booths and the outdoor cafés), and the server already puts every zone
// group on the SFU unconditionally (computeProximityGroups: non-null zoneId =>
// meeting group). Entering any of them flips the media view to the full-screen
// immersive meeting layout (issue #263, widened in #287) so the client's
// "meeting mode" and the server's "always SFU" cover exactly the same ground. A
// hallway bump (no zone) keeps the small floating tiles over the map.
export function isMeetingZone(zoneId: string | null | undefined): boolean {
  return !!zoneId;
}

export function zoneAt(px: number, py: number): Zone | null {
  const col = Math.floor(px / TILE_SIZE);
  const row = Math.floor(py / TILE_SIZE);
  if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) return null;
  const idx = zoneGrid[row][col];
  return idx === -1 ? null : ZONES[idx];
}

// Rug style for a room/café tile (zone-based), or null when the tile isn't one.
export function floorStyleAt(col: number, row: number): FloorStyle | null {
  const z = zoneAt(col * TILE_SIZE + TILE_SIZE / 2, row * TILE_SIZE + TILE_SIZE / 2);
  return z ? (zoneStyles.get(z.id) ?? null) : null;
}

/**
 * The call zone id to report to the server for grouping: the zone at (px,py),
 * or the team area there (one shared call, though the client treats it as a rug).
 */
export function callZoneAt(px: number, py: number): string | null {
  return zoneAt(px, py)?.id ?? TEAM_AREAS.find((a) => inRect(a.rect, px, py))?.id ?? null;
}

/** Find the nearest walkable pixel position, snapping to tile centers. */
export function findWalkableSpawn(
  px: number,
  py: number,
  radius: number,
): { x: number; y: number } {
  if (canOccupy(px, py, radius)) return { x: px, y: py };

  // Spiral outward in tile increments to find a walkable spot
  for (let dist = 1; dist < Math.max(MAP_COLS, MAP_ROWS); dist++) {
    for (let dr = -dist; dr <= dist; dr++) {
      for (let dc = -dist; dc <= dist; dc++) {
        if (Math.abs(dr) !== dist && Math.abs(dc) !== dist) continue;
        const col = Math.floor(px / TILE_SIZE) + dc;
        const row = Math.floor(py / TILE_SIZE) + dr;
        if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) continue;
        const cx = col * TILE_SIZE + TILE_SIZE / 2;
        const cy = row * TILE_SIZE + TILE_SIZE / 2;
        if (canOccupy(cx, cy, radius)) return { x: cx, y: cy };
      }
    }
  }
  return { x: px, y: py };
}

/**
 * A walkable tile ADJACENT to (tx, ty) — the one of its 8 neighbours nearest to
 * (fromX, fromY). Used to walk up *beside* someone (knock-accept / "go there")
 * instead of onto their exact tile: tile collision ignores player occupancy, so
 * targeting their position lands you overlapping them. Stopping one tile away
 * (50px ≪ CONNECT_RADIUS 120px) still triggers normal proximity. Falls back to
 * findWalkableSpawn when no neighbour is free (e.g. a one-seat booth).
 */
export function findAdjacentSpawn(
  tx: number,
  ty: number,
  fromX: number,
  fromY: number,
  radius: number,
): { x: number; y: number } {
  const tc = Math.floor(tx / TILE_SIZE);
  const tr = Math.floor(ty / TILE_SIZE);
  let best: { x: number; y: number } | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const col = tc + dc;
      const row = tr + dr;
      if (col < 0 || col >= MAP_COLS || row < 0 || row >= MAP_ROWS) continue;
      const cx = col * TILE_SIZE + TILE_SIZE / 2;
      const cy = row * TILE_SIZE + TILE_SIZE / 2;
      if (!canOccupy(cx, cy, radius)) continue;
      const d = (cx - fromX) ** 2 + (cy - fromY) ** 2;
      if (d < bestDist) {
        bestDist = d;
        best = { x: cx, y: cy };
      }
    }
  }
  return best ?? findWalkableSpawn(tx, ty, radius);
}

// Dev only: floor layout/styles are baked into the renderer's cached map image,
// which survives HMR — so a hot edit here would not show. Force a full reload.
if (import.meta.hot) import.meta.hot.accept(() => location.reload());
