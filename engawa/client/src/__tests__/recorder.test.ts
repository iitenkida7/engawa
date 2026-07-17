import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { RecorderManager } from '@/media/recorder';

// Minimal fakes for the recording browser APIs (happy-dom provides none of them).
// Each test captures the instances the RecorderManager creates so it can drive a
// spontaneous stop / error and assert teardown.

const audioContexts: FakeAudioContext[] = [];
const recorders: FakeMediaRecorder[] = [];

class FakeAudioContext {
  state = 'running';
  closed = false;
  constructor() {
    audioContexts.push(this);
  }
  createMediaStreamDestination() {
    return { stream: makeStream([makeTrack('audio')]) };
  }
  createMediaStreamSource() {
    return { connect: mock(), disconnect: mock() };
  }
  resume() {
    return Promise.resolve();
  }
  close() {
    this.closed = true;
    return Promise.resolve();
  }
}

class FakeMediaRecorder {
  static isTypeSupported() {
    return true;
  }
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor() {
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  // Simulate the browser stopping the recorder on its own (encoder error, OOM).
  spontaneousStop() {
    this.state = 'inactive';
    this.onstop?.();
  }
  fireError() {
    this.onerror?.({ error: new Error('encoder died') });
  }
}

function makeTrack(kind: 'audio' | 'video') {
  return { kind, stop: mock() } as unknown as MediaStreamTrack;
}
function makeStream(tracks: MediaStreamTrack[]) {
  return {
    id: `stream-${Math.round(tracks.length)}-${kindKey(tracks)}`,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  } as unknown as MediaStream;
}
function kindKey(tracks: MediaStreamTrack[]) {
  return tracks.map((t) => t.kind).join('');
}

let origAC: unknown;
let origMR: unknown;
let origMS: unknown;

beforeEach(() => {
  audioContexts.length = 0;
  recorders.length = 0;
  origAC = (globalThis as any).AudioContext;
  origMR = (globalThis as any).MediaRecorder;
  origMS = (globalThis as any).MediaStream;
  (globalThis as any).AudioContext = FakeAudioContext;
  (globalThis as any).MediaRecorder = FakeMediaRecorder;
  (globalThis as any).MediaStream = class {
    constructor(public tracks: MediaStreamTrack[] = []) {}
    getTracks() {
      return this.tracks;
    }
    getAudioTracks() {
      return this.tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks() {
      return this.tracks.filter((t) => t.kind === 'video');
    }
  };
});

afterEach(() => {
  (globalThis as any).AudioContext = origAC;
  (globalThis as any).MediaRecorder = origMR;
  (globalThis as any).MediaStream = origMS;
});

describe('RecorderManager teardown', () => {
  it('recovers from a spontaneous stop so recording can be restarted', () => {
    const rec = new RecorderManager();
    rec.start([makeStream([makeTrack('audio')])]);
    expect(rec.recording).toBe(true);
    expect(recorders).toHaveLength(1);

    // The browser stops the recorder on its own (no stop() call).
    recorders[0].spontaneousStop();

    // State is reclaimed: not recording, and the mix AudioContext is closed.
    expect(rec.recording).toBe(false);
    expect(audioContexts[0].closed).toBe(true);

    // A fresh recording can start (previously start() no-op'd forever).
    rec.start([makeStream([makeTrack('audio')])]);
    expect(rec.recording).toBe(true);
    expect(recorders).toHaveLength(2);
  });

  it('tears down on a recorder error (no permanent leak)', () => {
    const rec = new RecorderManager();
    rec.start([makeStream([makeTrack('audio')])]);
    recorders[0].fireError();
    expect(rec.recording).toBe(false);
    expect(audioContexts[0].closed).toBe(true);
  });

  it('closes the AudioContext on an explicit stop()', () => {
    const rec = new RecorderManager();
    rec.start([makeStream([makeTrack('audio')])]);
    rec.stop();
    expect(rec.recording).toBe(false);
    expect(audioContexts[0].closed).toBe(true);
  });
});
