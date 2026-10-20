import { describe, expect, it } from 'bun:test';
import {
  newRecReminderState,
  parseRecReminderSetting,
  REC_REMINDER_DELAY_MS,
  stepRecReminder,
} from '@/ui/rec-reminder';

const base = { roomId: 'meeting-1', peers: 1, anyoneRecording: false };

describe('parseRecReminderSetting', () => {
  it('is off unless explicitly enabled', () => {
    expect(parseRecReminderSetting(null)).toBe(false);
    expect(parseRecReminderSetting('0')).toBe(false);
    expect(parseRecReminderSetting('1')).toBe(true);
  });
});

describe('stepRecReminder', () => {
  it('asks once after a minute in a room with others and nobody recording', () => {
    const s = newRecReminderState();
    expect(stepRecReminder(s, { ...base, now: 0 })).toBe(false);
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS - 1 })).toBe(false);
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS })).toBe(true);
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS * 5 })).toBe(false);
  });

  it('does not count time spent alone', () => {
    const s = newRecReminderState();
    stepRecReminder(s, { ...base, peers: 0, now: 0 });
    stepRecReminder(s, { ...base, peers: 0, now: REC_REMINDER_DELAY_MS * 2 });
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS * 2 })).toBe(false);
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS * 3 })).toBe(true);
  });

  it('never asks during a visit where someone recorded', () => {
    const s = newRecReminderState();
    stepRecReminder(s, { ...base, now: 0 });
    stepRecReminder(s, { ...base, anyoneRecording: true, now: 1_000 });
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS * 2 })).toBe(false);
  });

  it('starts over on entering another room, and stays quiet outside rooms', () => {
    const s = newRecReminderState();
    stepRecReminder(s, { ...base, now: 0 });
    expect(stepRecReminder(s, { ...base, now: REC_REMINDER_DELAY_MS })).toBe(true);
    expect(stepRecReminder(s, { ...base, roomId: null, now: REC_REMINDER_DELAY_MS * 2 })).toBe(
      false,
    );
    stepRecReminder(s, { ...base, roomId: 'meeting-2', now: REC_REMINDER_DELAY_MS * 3 });
    expect(
      stepRecReminder(s, { ...base, roomId: 'meeting-2', now: REC_REMINDER_DELAY_MS * 4 }),
    ).toBe(true);
  });
});
