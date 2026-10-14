import { describe, expect, it } from 'bun:test';
import { shouldDisableOnZoneExit } from '@/core/zone-media';

// #306: walking out of a zone (room, 1-on-1, booth, hanare, lounge) cuts the
// local mic, camera and screen share.
describe('shouldDisableOnZoneExit', () => {
  it('cuts media when stepping from a zone onto the open floor', () => {
    expect(shouldDisableOnZoneExit('meeting-1', null, true)).toBe(true);
    expect(shouldDisableOnZoneExit('cafe-left', null, true)).toBe(true);
    expect(shouldDisableOnZoneExit('booth-2', null, true)).toBe(true);
    expect(shouldDisableOnZoneExit('hanare', null, true)).toBe(true);
  });

  it('does nothing on the way IN — re-entering never re-enables anything', () => {
    expect(shouldDisableOnZoneExit(null, 'meeting-1', true)).toBe(false);
  });

  it('does nothing while staying put, inside or outside', () => {
    expect(shouldDisableOnZoneExit('meeting-1', 'meeting-1', true)).toBe(false);
    expect(shouldDisableOnZoneExit(null, null, true)).toBe(false);
  });

  it('does nothing when moving straight from one zone to another', () => {
    // Rooms are walled, so this needs a hallway step in practice — but if it
    // ever happens, the user is still inside a room and still talking.
    expect(shouldDisableOnZoneExit('meeting-1', 'meeting-2', true)).toBe(false);
  });

  it('stays quiet when nothing is being captured', () => {
    // No media on → nothing to cut, and no toast about cutting it.
    expect(shouldDisableOnZoneExit('meeting-1', null, false)).toBe(false);
  });

  it('fires once per exit, not repeatedly, because the cut is one-way', () => {
    // Frame 1: the step out cuts media. Frame 2 onwards the media is off, so
    // the predicate goes quiet even though we are still on the open floor.
    expect(shouldDisableOnZoneExit('meeting-1', null, true)).toBe(true);
    expect(shouldDisableOnZoneExit(null, null, false)).toBe(false);
    // Pacing back across the doorway does not flap it: going in is a no-op,
    // and coming back out finds nothing left to cut.
    expect(shouldDisableOnZoneExit(null, 'meeting-1', false)).toBe(false);
    expect(shouldDisableOnZoneExit('meeting-1', null, false)).toBe(false);
  });
});
