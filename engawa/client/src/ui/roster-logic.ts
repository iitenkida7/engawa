// Pure grouping behind the participant roster's by-room view (ui/roster.ts).

export type RosterGroup<T> = { zoneId: string | null; items: T[] };

/**
 * Bucket people by the zone (meeting room, booth, café…) they stand in, with the
 * viewer's own room first so "who is in here with me" is at the top. Other rooms
 * follow in `zoneOrder` (the map's order), the open floor (`zoneId` null) comes
 * last, and empty rooms are left out. Order inside a group is the input order.
 */
export function groupRoster<T extends { zoneId: string | null }>(
  items: T[],
  zoneOrder: string[],
  myZoneId: string | null,
): RosterGroup<T>[] {
  const byZone = new Map<string | null, T[]>();
  for (const it of items) {
    const list = byZone.get(it.zoneId);
    if (list) list.push(it);
    else byZone.set(it.zoneId, [it]);
  }
  const order = myZoneId ? [myZoneId, ...zoneOrder.filter((id) => id !== myZoneId)] : zoneOrder;
  const groups: RosterGroup<T>[] = [];
  for (const id of order) {
    const list = byZone.get(id);
    if (list?.length) groups.push({ zoneId: id, items: list });
  }
  const floor = byZone.get(null);
  if (floor?.length) groups.push({ zoneId: null, items: floor });
  return groups;
}
