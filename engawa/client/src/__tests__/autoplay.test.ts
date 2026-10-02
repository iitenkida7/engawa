import { describe, expect, it, mock } from 'bun:test';
import { AutoplayGate, isAutoplayBlocked } from '@/ui/autoplay';

const blockedErr = () => Object.assign(new Error('autoplay'), { name: 'NotAllowedError' });

// Fake media element whose play() outcome the test scripts per call.
function makeEl(results: ('ok' | 'blocked' | 'abort')[]) {
  const play = mock(async () => {
    const r = results.shift() ?? 'ok';
    if (r === 'blocked') throw blockedErr();
    if (r === 'abort') throw Object.assign(new Error('aborted'), { name: 'AbortError' });
  });
  return { play, srcObject: {} as MediaStream | null };
}

// Minimal EventTarget stand-in for the document: records gesture listeners so
// a test can fire a "user gesture" and check that they are detached again.
function makeTarget() {
  const listeners = new Map<string, () => void>();
  return {
    addEventListener: mock((type: string, fn: () => void) => listeners.set(type, fn)),
    removeEventListener: mock((type: string) => listeners.delete(type)),
    gesture: (type = 'pointerdown') => listeners.get(type)?.(),
    listening: () => listeners.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('isAutoplayBlocked', () => {
  it('matches only the autoplay-policy rejection', () => {
    expect(isAutoplayBlocked(blockedErr())).toBe(true);
    expect(isAutoplayBlocked({ name: 'AbortError' })).toBe(false);
    expect(isAutoplayBlocked(null)).toBe(false);
  });
});

describe('AutoplayGate (issue #201)', () => {
  it('replays blocked media on the next user gesture and clears the prompt', async () => {
    const target = makeTarget();
    const onBlocked = mock();
    const onUnlocked = mock();
    const gate = new AutoplayGate({ onBlocked, onUnlocked, target });
    const audio = makeEl(['blocked', 'ok']);

    gate.play(audio);
    await flush();
    expect(gate.isBlocked).toBe(true);
    expect(onBlocked).toHaveBeenCalledTimes(1);

    target.gesture('keydown');
    await flush();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(gate.isBlocked).toBe(false);
    expect(onUnlocked).toHaveBeenCalledTimes(1);
    // Gesture listeners are detached once nothing is blocked.
    expect(target.listening()).toBe(0);
  });

  it('prompts once for several blocked elements and replays them all', async () => {
    const target = makeTarget();
    const onBlocked = mock();
    const gate = new AutoplayGate({ onBlocked, onUnlocked: mock(), target });
    const a = makeEl(['blocked', 'ok']);
    const b = makeEl(['blocked', 'ok']);

    gate.play(a);
    gate.play(b);
    await flush();
    expect(onBlocked).toHaveBeenCalledTimes(1);

    gate.unlock(); // the prompt's button
    await flush();
    expect(a.play).toHaveBeenCalledTimes(2);
    expect(b.play).toHaveBeenCalledTimes(2);
  });

  it('re-prompts when a replay is still refused', async () => {
    const target = makeTarget();
    const onBlocked = mock();
    const gate = new AutoplayGate({ onBlocked, onUnlocked: mock(), target });
    const audio = makeEl(['blocked', 'blocked', 'ok']);

    gate.play(audio);
    await flush();
    target.gesture();
    await flush();
    expect(gate.isBlocked).toBe(true);
    expect(onBlocked).toHaveBeenCalledTimes(2);

    target.gesture();
    await flush();
    expect(gate.isBlocked).toBe(false);
  });

  it('ignores non-autoplay failures and skips elements detached meanwhile', async () => {
    const target = makeTarget();
    const onBlocked = mock();
    const gate = new AutoplayGate({ onBlocked, onUnlocked: mock(), target });

    gate.play(makeEl(['abort']));
    await flush();
    expect(gate.isBlocked).toBe(false);
    expect(onBlocked).not.toHaveBeenCalled();

    const gone = makeEl(['blocked']);
    gate.play(gone);
    await flush();
    gone.srcObject = null; // the peer left before the user clicked
    target.gesture();
    await flush();
    expect(gone.play).toHaveBeenCalledTimes(1);
  });
});
