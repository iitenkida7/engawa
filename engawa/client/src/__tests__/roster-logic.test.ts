import { describe, expect, it } from 'bun:test';
import { groupRoster } from '@/ui/roster-logic';

const p = (name: string, zoneId: string | null) => ({ name, zoneId });
const ORDER = ['all-hands', 'meeting-1', 'cafe-left'];

describe('groupRoster', () => {
  it('puts your own room first, then the other rooms in map order, then the open floor', () => {
    const people = [
      p('a', null),
      p('b', 'cafe-left'),
      p('c', 'meeting-1'),
      p('d', 'all-hands'),
      p('e', 'meeting-1'),
    ];
    const groups = groupRoster(people, ORDER, 'meeting-1');
    expect(groups.map((g) => g.zoneId)).toEqual(['meeting-1', 'all-hands', 'cafe-left', null]);
    expect(groups[0].items.map((i) => i.name)).toEqual(['c', 'e']);
  });

  it('keeps map order when the viewer is not in a room', () => {
    const groups = groupRoster([p('a', 'cafe-left'), p('b', 'all-hands')], ORDER, null);
    expect(groups.map((g) => g.zoneId)).toEqual(['all-hands', 'cafe-left']);
  });

  it('omits empty rooms and an empty floor', () => {
    const groups = groupRoster([p('a', 'meeting-1')], ORDER, null);
    expect(groups).toHaveLength(1);
    expect(groups[0].zoneId).toBe('meeting-1');
  });

  it('keeps everyone on the open floor as one group', () => {
    const groups = groupRoster([p('a', null), p('b', null)], ORDER, null);
    expect(groups).toEqual([{ zoneId: null, items: [p('a', null), p('b', null)] }]);
  });

  it('preserves the input order inside a group (callers sort once)', () => {
    const groups = groupRoster([p('z', 'meeting-1'), p('a', 'meeting-1')], ORDER, null);
    expect(groups[0].items.map((i) => i.name)).toEqual(['z', 'a']);
  });

  it('returns nothing for nobody', () => {
    expect(groupRoster([], ORDER, null)).toEqual([]);
  });
});
