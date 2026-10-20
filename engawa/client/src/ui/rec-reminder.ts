// "Forgot to record?" reminder for meeting rooms. Opt-in from the "⋯" menu
// (off by default): once you have been in a meeting room with at least one
// other person for a minute and nobody in the call is recording, a toast asks
// whether to start. Asked at most once per room visit, so declining (or
// recording and then stopping) never nags again until you leave and come back.

export const REC_REMINDER_STORAGE_KEY = 'engawa-rec-reminder';

export const REC_REMINDER_DELAY_MS = 60_000;

// Off unless explicitly enabled: only '1' turns the reminder on.
export function parseRecReminderSetting(stored: string | null): boolean {
  return stored === '1';
}

export type RecReminderState = {
  // Meeting room we are in, or null outside one.
  roomId: string | null;
  // When "in the room with others, nobody recording" last became true.
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
  // People in our call besides us.
  peers: number;
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
  if (input.peers < 1) {
    state.since = null;
    return false;
  }
  state.since ??= input.now;
  if (input.now - state.since < REC_REMINDER_DELAY_MS) return false;
  state.done = true;
  return true;
}
