import { describe, expect, it } from 'bun:test';
import { ALONE_MEDIA_OFF_MS, isAloneWithMediaOn, stepAloneMedia } from '@/core/alone-media';

// #426: mic/camera/screen left on while alone on the open floor are cut after a
// minute, so an unattended desk stops broadcasting to passers-by.

const base = {
  anyMediaOn: true,
  callZoneId: null as string | null,
  peerCount: 0,
  recording: false,
  transcribing: false,
};

describe('isAloneWithMediaOn', () => {
  it('is true with media on, alone, out on the open floor', () => {
    expect(isAloneWithMediaOn(base)).toBe(true);
  });

  it('is false with nothing being captured', () => {
    expect(isAloneWithMediaOn({ ...base, anyMediaOn: false })).toBe(false);
  });

  it('is false whenever anyone else is in our call group', () => {
    expect(isAloneWithMediaOn({ ...base, peerCount: 1 })).toBe(false);
  });

  it('exempts every place people sit down in to be available', () => {
    // Rooms, 1-on-1s, booths, the hanare, the lounges — and the team areas,
    // which report a call zone id of their own (callZoneAt).
    for (const zone of ['meeting-1', 'oneonone-2', 'booth-1', 'hanare', 'cafe-left', 'team-a']) {
      expect(isAloneWithMediaOn({ ...base, callZoneId: zone })).toBe(false);
    }
  });

  it('holds off while recording or transcribing', () => {
    // Both are started deliberately and both are routinely done alone, so
    // cutting the mic underneath them would break what the user is doing.
    expect(isAloneWithMediaOn({ ...base, recording: true })).toBe(false);
    expect(isAloneWithMediaOn({ ...base, transcribing: true })).toBe(false);
  });
});

describe('stepAloneMedia', () => {
  it('starts the timer on the first alone frame without cutting anything', () => {
    expect(stepAloneMedia(null, true, 1_000)).toEqual({ since: 1_000, disable: false });
  });

  it('keeps the original start time while the minute runs', () => {
    expect(stepAloneMedia(1_000, true, 30_000)).toEqual({ since: 1_000, disable: false });
  });

  it('cuts once the full minute has passed', () => {
    const t = 1_000 + ALONE_MEDIA_OFF_MS;
    expect(stepAloneMedia(1_000, true, t)).toEqual({ since: null, disable: true });
  });

  it('does not cut a frame early', () => {
    const t = 1_000 + ALONE_MEDIA_OFF_MS - 1;
    expect(stepAloneMedia(1_000, true, t)).toEqual({ since: 1_000, disable: false });
  });

  it('resets the timer the moment the situation ends', () => {
    // Someone walks up 59s in: the clock goes back to zero, so a later
    // stretch alone always gets a full uninterrupted minute of its own.
    expect(stepAloneMedia(1_000, false, 60_000)).toEqual({ since: null, disable: false });
    expect(stepAloneMedia(null, true, 70_000)).toEqual({ since: 70_000, disable: false });
    expect(stepAloneMedia(70_000, true, 70_000 + ALONE_MEDIA_OFF_MS - 1)).toEqual({
      since: 70_000,
      disable: false,
    });
  });

  it('fires once per stretch, not every frame', () => {
    // The cut turns the media off, so the next frame is no longer "alone with
    // media on" — and the cleared `since` keeps it quiet even if it were.
    expect(stepAloneMedia(1_000, true, 61_000).disable).toBe(true);
    expect(stepAloneMedia(null, false, 61_017)).toEqual({ since: null, disable: false });
  });

  it('stays quiet forever while nothing is on', () => {
    expect(stepAloneMedia(null, false, 10_000_000)).toEqual({ since: null, disable: false });
  });
});
