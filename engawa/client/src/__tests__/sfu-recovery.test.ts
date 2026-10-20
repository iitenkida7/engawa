import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import {
  SFU_REBUILD_RESET_MS,
  SFU_RECONNECT_NOTICE_FROM,
  SFU_STALE_STREAM_GRACE_MS,
  sfuRebuildDelayMs,
} from '@/rtc/sfu-logic';
import { SfuRecovery } from '@/rtc/sfu-recovery';

let now = 1000;
const clock = () => spyOn(performance, 'now').mockImplementation(() => now);

function setup(frozen: { userId: string; streamId: string }[] = []) {
  const log: string[] = [];
  let reconnecting = false;
  let notices = 0;
  const rec = new SfuRecovery({
    closeKeepTiles: () => frozen.map((s) => ({ ...s })),
    rebuild: () => log.push('rebuild'),
    setReconnecting: (on) => {
      reconnecting = on;
    },
    detachStream: (userId, streamId) => log.push(`detach ${userId}/${streamId}`),
    showNotice: () => {
      notices++;
      return () => notices--;
    },
  });
  return { rec, log, reconnecting: () => reconnecting, notices: () => notices };
}

afterEach(() => {
  now = 1000;
});

describe('SfuRecovery', () => {
  it('schedules one rebuild per failure, with backoff', () => {
    clock();
    const { rec, log, reconnecting } = setup();
    expect(rec.onFailed()).toBe(true);
    expect(rec.pending).toBe(true);
    expect(reconnecting()).toBe(true);
    // Already pending: a second failure is ignored.
    expect(rec.onFailed()).toBe(false);
    rec.tick(now + sfuRebuildDelayMs(1) - 1);
    expect(log).toEqual([]);
    rec.tick(now + sfuRebuildDelayMs(1));
    expect(log).toEqual(['rebuild']);
    expect(rec.pending).toBe(false);
  });

  it('shows the notice only from the Nth consecutive failure', () => {
    clock();
    const { rec, notices } = setup();
    for (let i = 1; i < SFU_RECONNECT_NOTICE_FROM; i++) {
      rec.onFailed();
      rec.tick(now + 1_000_000);
    }
    expect(notices()).toBe(0);
    rec.onFailed();
    expect(notices()).toBe(1);
    rec.onConnected();
    expect(notices()).toBe(0);
  });

  it('a failure long after a good connection restarts the backoff', () => {
    clock();
    const { rec, log } = setup();
    const failAndRebuild = () => {
      rec.onFailed();
      rec.tick(now + 1_000_000);
    };
    failAndRebuild();
    failAndRebuild();
    rec.onConnected();
    // Soon after connecting: same outage, so this is attempt 3 (backed off).
    now += 1000;
    rec.onFailed();
    log.length = 0;
    rec.tick(now + sfuRebuildDelayMs(1));
    expect(log).toEqual([]);
    rec.tick(now + sfuRebuildDelayMs(3));
    expect(log).toEqual(['rebuild']);
    rec.onConnected();
    // Long after connecting: a new outage, back to attempt 1.
    now += SFU_REBUILD_RESET_MS + 1;
    rec.onFailed();
    log.length = 0;
    rec.tick(now + sfuRebuildDelayMs(1));
    expect(log).toEqual(['rebuild']);
  });

  it('sweeps frozen streams after the grace period once connected', () => {
    clock();
    const { rec, log, reconnecting } = setup([{ userId: 'a', streamId: 's1' }]);
    rec.onFailed();
    rec.tick(now + 1_000_000);
    log.length = 0;
    rec.onConnected();
    expect(reconnecting()).toBe(false);
    rec.tick(now + SFU_STALE_STREAM_GRACE_MS - 1);
    expect(log).toEqual([]);
    rec.tick(now + SFU_STALE_STREAM_GRACE_MS);
    expect(log).toEqual(['detach a/s1']);
  });

  it('pruneDeparted returns and forgets frozen streams of non-members', () => {
    clock();
    const { rec, log } = setup([
      { userId: 'a', streamId: 's1' },
      { userId: 'b', streamId: 's2' },
    ]);
    rec.onFailed();
    expect(rec.pruneDeparted((id) => id === 'a')).toEqual(['b']);
    rec.end();
    expect(log).toEqual(['detach a/s1']);
  });

  it('end() drops the pending rebuild and sweeps immediately', () => {
    clock();
    const { rec, log, notices } = setup([{ userId: 'a', streamId: 's1' }]);
    for (let i = 0; i < SFU_RECONNECT_NOTICE_FROM; i++) {
      rec.onFailed();
      if (i < SFU_RECONNECT_NOTICE_FROM - 1) rec.tick(now + 1_000_000);
    }
    log.length = 0;
    rec.end();
    expect(rec.pending).toBe(false);
    expect(notices()).toBe(0);
    expect(log.filter((l) => l.startsWith('detach'))).toEqual(
      Array(SFU_RECONNECT_NOTICE_FROM).fill('detach a/s1'),
    );
    rec.tick(now + 1_000_000);
    expect(log.includes('rebuild')).toBe(false);
  });
});
