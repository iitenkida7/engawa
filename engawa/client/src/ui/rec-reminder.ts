// "Forgot to record?" reminder for meeting rooms. Opt-in from the "⋯" menu
// (off by default): once a meeting room has had at least two people with their
// mic or camera on (you included) for a minute and nobody in the call is
// recording, a toast asks whether to start. A lone person, or people sitting
// there with everything off, is not a meeting worth recording. Asked at most
// once per room visit, so declining (or recording and then stopping) never nags
// again until you leave and come back.

export const REC_REMINDER_STORAGE_KEY = 'engawa-rec-reminder';

export const REC_REMINDER_DELAY_MS = 60_000;

// People with mic or camera on (us included) needed before the clock runs.
export const REC_REMINDER_MIN_ACTIVE = 2;

// Off unless explicitly enabled: only '1' turns the reminder on.
export function parseRecReminderSetting(stored: string | null): boolean {
  return stored === '1';
}

export type RecReminderState = {
  // Meeting room we are in, or null outside one.
  roomId: string | null;
  // When "enough active people, nobody recording" last became true.
  since: number | null;
  // Already asked (or someone recorded) during this visit.
  done: boolean;
};

export function newRecReminderState(): RecReminderState {
  return { roomId: null, since: null, done: false };
}

export type RecReminderInput = {
  // Meeting room we are in, or null outside one.
  roomId: string | null;
  // People in our call, us included, whose mic or camera is on.
  activePeople: number;
  // Whether we or anyone in our call is recording.
  anyoneRecording: boolean;
  now: number;
};

// Pure: advance the reminder (mutating `state`) and return true exactly once,
// at the moment the toast should appear.
export function stepRecReminder(state: RecReminderState, input: RecReminderInput): boolean {
  if (input.roomId !== state.roomId) {
    state.roomId = input.roomId;
    state.since = null;
    state.done = false;
  }
  if (!state.roomId || state.done) return false;
  if (input.anyoneRecording) {
    state.done = true;
    return false;
  }
  if (input.activePeople < REC_REMINDER_MIN_ACTIVE) {
    state.since = null;
    return false;
  }
  state.since ??= input.now;
  if (input.now - state.since < REC_REMINDER_DELAY_MS) return false;
  state.done = true;
  return true;
}
