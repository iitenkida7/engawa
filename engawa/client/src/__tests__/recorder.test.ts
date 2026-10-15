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

describe('RecorderManager.saveSnapshot (emergency save on tab close)', () => {
  // happy-dom has no blob URLs; capture the anchor the download goes through.
  let downloads: string[] = [];
  let origCreate: unknown;
  let origRevoke: unknown;
  let origClick: unknown;
  beforeEach(() => {
    downloads = [];
    origCreate = URL.createObjectURL;
    origRevoke = URL.revokeObjectURL;
    origClick = HTMLAnchorElement.prototype.click;
    URL.createObjectURL = () => 'blob:fake';
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    };
  });
  afterEach(() => {
    URL.createObjectURL = origCreate as typeof URL.createObjectURL;
    URL.revokeObjectURL = origRevoke as typeof URL.revokeObjectURL;
    HTMLAnchorElement.prototype.click = origClick as () => void;
  });

  it('downloads the chunks collected so far and keeps recording', () => {
    const rec = new RecorderManager();
    rec.start([makeStream([makeTrack('audio')])]);
    recorders[0].ondataavailable?.({ data: { size: 10 } });
    recorders[0].ondataavailable?.({ data: { size: 10 } });

    expect(rec.saveSnapshot()).toBe(true);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatch(/^recording-.*-autosave\.(mp4|webm)$/);
    // Not stopped, not cleared: a later stop() still saves the full file.
    expect(rec.recording).toBe(true);
    rec.stop();
    expect(downloads).toHaveLength(2);
    expect(downloads[1]).not.toContain('autosave');
  });

  it('is a no-op when not recording or when nothing has been collected yet', () => {
    const rec = new RecorderManager();
    expect(rec.saveSnapshot()).toBe(false);
    rec.start([makeStream([makeTrack('audio')])]);
    expect(rec.saveSnapshot()).toBe(false);
    expect(downloads).toHaveLength(0);
  });
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
