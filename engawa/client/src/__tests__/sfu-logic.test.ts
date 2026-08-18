import { describe, expect, it } from 'bun:test';
import type { SfuTrack } from '@/core/types';
import {
  chainOp,
  isRetryableSfuHttp,
  partitionMembers,
  reconcilePeerTracks,
  remoteKey,
  sfuApiRetryDelayMs,
  sfuErrorMessage,
  sfuSessionError,
  sfuTrackError,
  shouldFallbackToMesh,
} from '@/rtc/sfu-logic';

describe('remoteKey', () => {
  it('joins userId and kind with a slash', () => {
    expect(remoteKey('alice', 'cam')).toBe('alice/cam');
    expect(remoteKey('bob', 'mic')).toBe('bob/mic');
  });
});

describe('sfuErrorMessage', () => {
  it('returns null when there is no errorCode', () => {
    expect(sfuErrorMessage({})).toBeNull();
    expect(sfuErrorMessage({ sessionDescription: undefined } as never)).toBeNull();
  });

  it('prefers the human-readable description', () => {
    expect(sfuErrorMessage({ errorCode: 'E1', errorDescription: 'boom' })).toBe('boom');
  });

  it('falls back to the code when no description is given', () => {
    expect(sfuErrorMessage({ errorCode: 'E1' })).toBe('E1');
  });
});

describe('sfuTrackError', () => {
  it('returns null for a clean track with a mid', () => {
    expect(sfuTrackError({ tracks: [{ mid: '0' }] })).toBeNull();
  });

  it('reports a per-track errorCode (200 top-level, error inside tracks[])', () => {
    expect(sfuTrackError({ tracks: [{ errorCode: 'no_such_track' }] })).toBe('no_such_track');
  });

  it("reports 'no mid' when the track came back without a routable mid", () => {
    expect(sfuTrackError({ tracks: [{}] })).toBe('no mid');
  });

  it("reports 'no track in response' when tracks is empty or missing", () => {
    expect(sfuTrackError({ tracks: [] })).toBe('no track in response');
    expect(sfuTrackError({})).toBe('no track in response');
  });
});

describe('sfuSessionError', () => {
  it('returns null when a session id came back', () => {
    expect(sfuSessionError({ sessionId: 'sess-1' })).toBeNull();
  });

  it('reports the description when creation failed', () => {
    expect(sfuSessionError({ errorDescription: 'rate limited' })).toBe('rate limited');
  });

  it("falls back to 'no id' when nothing useful is returned", () => {
    expect(sfuSessionError({})).toBe('no id');
  });
});

describe('shouldFallbackToMesh', () => {
  it('falls back only on a failed connection', () => {
    expect(shouldFallbackToMesh('failed', false)).toBe(true);
    expect(shouldFallbackToMesh('disconnected', false)).toBe(false);
    expect(shouldFallbackToMesh('connected', false)).toBe(false);
  });

  it('never falls back after we deliberately closed the transport', () => {
    expect(shouldFallbackToMesh('failed', true)).toBe(false);
  });
});

describe('reconcilePeerTracks', () => {
  const mic: SfuTrack = { kind: 'mic', trackName: 'mic' };
  const cam: SfuTrack = { kind: 'cam', trackName: 'cam' };

  it('pulls every track when nothing is held yet', () => {
    const { toPull, toDrop } = reconcilePeerTracks('alice', [mic, cam], []);
    expect(toPull).toEqual([mic, cam]);
    expect(toDrop).toEqual([]);
  });

  it('pulls only the newly announced track', () => {
    const { toPull, toDrop } = reconcilePeerTracks('alice', [mic, cam], ['alice/mic']);
    expect(toPull).toEqual([cam]);
    expect(toDrop).toEqual([]);
  });

  it('drops a track the peer stopped publishing (e.g. camera off)', () => {
    const { toPull, toDrop } = reconcilePeerTracks('alice', [mic], ['alice/mic', 'alice/cam']);
    expect(toPull).toEqual([]);
    expect(toDrop).toEqual(['alice/cam']);
  });

  it('drops everything when the peer announces no tracks', () => {
    const { toPull, toDrop } = reconcilePeerTracks('alice', [], ['alice/mic', 'alice/cam']);
    expect(toPull).toEqual([]);
    expect(toDrop.sort()).toEqual(['alice/cam', 'alice/mic']);
  });

  it('never touches another peer’s tracks', () => {
    const { toPull, toDrop } = reconcilePeerTracks('alice', [mic], ['bob/mic', 'bob/cam']);
    expect(toPull).toEqual([mic]);
    expect(toDrop).toEqual([]);
  });
});

describe('partitionMembers', () => {
  it('opens members we are not connected to and closes those who left', () => {
    const { toClose, toOpen } = partitionMembers(['a', 'b'], new Set(['b', 'c']));
    expect(toClose).toEqual(['a']);
    expect(toOpen).toEqual(['c']);
  });

  it('is a no-op when the sets already match', () => {
    const { toClose, toOpen } = partitionMembers(['a', 'b'], new Set(['a', 'b']));
    expect(toClose).toEqual([]);
    expect(toOpen).toEqual([]);
  });

  it('opens all when nothing is connected', () => {
    const { toClose, toOpen } = partitionMembers([], new Set(['a', 'b']));
    expect(toClose).toEqual([]);
    expect(toOpen).toEqual(['a', 'b']);
  });

  it('closes all when the group emptied', () => {
    const { toClose, toOpen } = partitionMembers(['a', 'b'], new Set());
    expect(toClose).toEqual(['a', 'b']);
    expect(toOpen).toEqual([]);
  });
});

describe('chainOp', () => {
  it('runs ops in enqueue order even when they resolve out of order', async () => {
    const order: number[] = [];
    let chain = Promise.resolve();
    const closed = () => false;
    const onError = () => {};
    // First op resolves slowly, second quickly: serialization must still keep 1→2.
    chain = chainOp(
      chain,
      closed,
      async () => {
        await new Promise((r) => setTimeout(r, 20));
        order.push(1);
      },
      onError,
    );
    chain = chainOp(
      chain,
      closed,
      async () => {
        order.push(2);
      },
      onError,
    );
    await chain;
    expect(order).toEqual([1, 2]);
  });

  it('skips the op once the transport is closed', async () => {
    let ran = false;
    const chain = chainOp(
      Promise.resolve(),
      () => true,
      async () => {
        ran = true;
      },
      () => {},
    );
    await chain;
    expect(ran).toBe(false);
  });

  it('isolates a failing op so the next one still runs', async () => {
    const order: number[] = [];
    const errors: unknown[] = [];
    const closed = () => false;
    const onError = (e: unknown) => errors.push(e);
    let chain = chainOp(
      Promise.resolve(),
      closed,
      async () => {
        throw new Error('op failed');
      },
      onError,
    );
    chain = chainOp(
      chain,
      closed,
      async () => {
        order.push(2);
      },
      onError,
    );
    await chain;
    expect(errors).toHaveLength(1);
    expect(order).toEqual([2]);
  });
});

describe('sfu control-plane retry policy (issue #186)', () => {
  it('backs off 500ms then 1s', () => {
    expect(sfuApiRetryDelayMs(1)).toBe(500);
    expect(sfuApiRetryDelayMs(2)).toBe(1000);
    expect(sfuApiRetryDelayMs(0)).toBe(500);
  });

  it('retries network errors and transient statuses', () => {
    expect(isRetryableSfuHttp('network')).toBe(true);
    expect(isRetryableSfuHttp(500)).toBe(true);
    expect(isRetryableSfuHttp(502)).toBe(true);
    expect(isRetryableSfuHttp(408)).toBe(true);
    expect(isRetryableSfuHttp(429)).toBe(true);
  });

  it('retries 401 (media token is re-minted by a reconnect) but no other 4xx', () => {
    expect(isRetryableSfuHttp(401)).toBe(true);
    expect(isRetryableSfuHttp(400)).toBe(false);
    expect(isRetryableSfuHttp(403)).toBe(false);
    expect(isRetryableSfuHttp(404)).toBe(false);
  });
});
