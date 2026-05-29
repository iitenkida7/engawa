import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { RemoteParticipants } from '../remote';

// --- Browser-media stubs that happy-dom doesn't provide ---------------------
// happy-dom's HTMLMediaElement.srcObject setter rejects non-MediaStream values
// and there is no AudioContext, so we relax srcObject to a plain property and
// install a minimal AudioContext for the speaking detector.
let srcObjectDesc: PropertyDescriptor | undefined;

beforeAll(() => {
  srcObjectDesc = Object.getOwnPropertyDescriptor(
    globalThis.HTMLMediaElement.prototype,
    'srcObject',
  );
  Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'srcObject', {
    configurable: true,
    writable: true,
    value: null,
  });
  (globalThis as any).AudioContext = class {
    createAnalyser() {
      return {
        fftSize: 0,
        smoothingTimeConstant: 0,
        frequencyBinCount: 8,
        getByteFrequencyData: () => {},
      };
    }
    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }
    close() {
      return Promise.resolve();
    }
  };
});

afterAll(() => {
  if (srcObjectDesc) {
    Object.defineProperty(globalThis.HTMLMediaElement.prototype, 'srcObject', srcObjectDesc);
  }
  delete (globalThis as any).AudioContext;
});

let streamSeq = 0;
function makeStream(kind: 'audio' | 'video'): MediaStream {
  const track = { kind } as MediaStreamTrack;
  return {
    id: `stream-${++streamSeq}`,
    getTracks: () => [track],
    getAudioTracks: () => (kind === 'audio' ? [track] : []),
    getVideoTracks: () => (kind === 'video' ? [track] : []),
  } as unknown as MediaStream;
}

function makeRecorder() {
  return {
    recording: false,
    addAudioStream: mock(),
    removeAudioStream: mock(),
  };
}

function setup() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const recorder = makeRecorder();
  const participants = new RemoteParticipants({
    container: container as HTMLDivElement,
    recorder: recorder as any,
    info: (userId) => ({ name: `name-${userId}`, initials: 'XX' }),
  });
  return { container, recorder, participants };
}

const USER = 'u1';

describe('RemoteParticipants', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('attachMic creates a tile and an off-screen audio element', () => {
    const { container, participants } = setup();
    participants.attachMic(USER, makeStream('audio'));

    expect(container.querySelectorAll('.remote-tile')).toHaveLength(1);
    const audio = document.querySelector('audio');
    expect(audio).not.toBeNull();
    expect((audio as HTMLElement).style.display).toBe('none');
  });

  it('attachCam shows the video and hides the placeholder', () => {
    const { container, participants } = setup();
    participants.attachCam(USER, makeStream('video'));

    const tile = container.querySelector('.remote-tile')!;
    const video = tile.querySelector('video') as HTMLVideoElement;
    const placeholder = tile.querySelector('.no-video') as HTMLElement;
    expect(video.style.display).toBe('');
    expect(placeholder.style.display).toBe('none');
    expect((tile.querySelector('.label') as HTMLElement).textContent).toBe(`name-${USER}`);
  });

  it('reuses one tile when the same user has both mic and cam', () => {
    const { container, participants } = setup();
    participants.attachMic(USER, makeStream('audio'));
    participants.attachCam(USER, makeStream('video'));
    expect(container.querySelectorAll('.remote-tile')).toHaveLength(1);
  });

  it('keeps the tile (placeholder) when cam drops but mic remains', () => {
    const { container, participants } = setup();
    participants.attachMic(USER, makeStream('audio'));
    const cam = makeStream('video');
    participants.attachCam(USER, cam);

    participants.detach(USER, cam.id);

    const tile = container.querySelector('.remote-tile') as HTMLElement;
    expect(tile).not.toBeNull();
    expect((tile.querySelector('video') as HTMLElement).style.display).toBe('none');
    expect((tile.querySelector('.no-video') as HTMLElement).style.display).toBe('');
  });

  it('removes the tile when the last stream (mic) drops', () => {
    const { container, participants } = setup();
    const mic = makeStream('audio');
    participants.attachMic(USER, mic);

    participants.detach(USER, mic.id);

    expect(container.querySelectorAll('.remote-tile')).toHaveLength(0);
    expect(document.querySelector('audio')).toBeNull();
  });

  it('detaching mic notifies the recorder mix', () => {
    const { recorder, participants } = setup();
    const mic = makeStream('audio');
    participants.attachMic(USER, mic);
    participants.detach(USER, mic.id);
    expect(recorder.removeAudioStream).toHaveBeenCalledWith(mic.id);
  });

  it('remove() tears down tile and audio together', () => {
    const { container, participants } = setup();
    participants.attachMic(USER, makeStream('audio'));
    participants.attachCam(USER, makeStream('video'));

    participants.remove(USER);

    expect(container.querySelectorAll('.remote-tile')).toHaveLength(0);
    expect(document.querySelector('audio')).toBeNull();
  });

  it('setMuted toggles the muted class on the tile', () => {
    const { container, participants } = setup();
    participants.attachMic(USER, makeStream('audio'));
    const tile = container.querySelector('.remote-tile') as HTMLElement;

    participants.setMuted(USER, true);
    expect(tile.classList.contains('muted')).toBe(true);
    participants.setMuted(USER, false);
    expect(tile.classList.contains('muted')).toBe(false);
  });

  it('audioStreams reports each active remote mic stream', () => {
    const { participants } = setup();
    const mic = makeStream('audio');
    participants.attachMic(USER, mic);
    expect(participants.audioStreams()).toEqual([mic]);
  });

  it('updateSpeaking reports per-user state and toggles the speaking class', () => {
    const { container, participants } = setup();
    participants.attachMic(USER, makeStream('audio'));

    const reported: Array<[string, boolean]> = [];
    participants.updateSpeaking((id, speaking) => reported.push([id, speaking]));

    // Our stubbed analyser yields all-zero data → not speaking.
    expect(reported).toEqual([[USER, false]]);
    const tile = container.querySelector('.remote-tile') as HTMLElement;
    expect(tile.classList.contains('speaking')).toBe(false);
  });
});
