import { afterEach, describe, expect, it } from 'bun:test';
import {
  BoundedLog,
  formatNetLogExport,
  logNet,
  type NetLogEntry,
  netLogEntries,
  resetNetLog,
} from '@/core/netlog';

afterEach(() => resetNetLog());

describe('BoundedLog', () => {
  it('keeps entries in insertion order', () => {
    const log = new BoundedLog<number>(5);
    log.push(1);
    log.push(2);
    log.push(3);
    expect([...log.entries()]).toEqual([1, 2, 3]);
  });

  it('drops the oldest entries past capacity', () => {
    const log = new BoundedLog<number>(3);
    for (let i = 1; i <= 5; i++) log.push(i);
    expect([...log.entries()]).toEqual([3, 4, 5]);
  });

  it('clamps a nonsensical capacity to at least one entry', () => {
    const log = new BoundedLog<number>(0);
    log.push(1);
    log.push(2);
    expect([...log.entries()]).toEqual([2]);
  });

  it('clear() empties the buffer', () => {
    const log = new BoundedLog<number>(3);
    log.push(1);
    log.clear();
    expect(log.entries().length).toBe(0);
  });
});

describe('logNet / netLogEntries', () => {
  it('records type, timestamp and detail', () => {
    logNet('ws-close', { code: 1006 });
    const entries = netLogEntries();
    expect(entries.length).toBe(1);
    expect(entries[0].type).toBe('ws-close');
    expect(entries[0].detail).toEqual({ code: 1006 });
    expect(entries[0].t).toBeGreaterThan(0);
  });

  it('omits the detail key when none is given', () => {
    logNet('ws-open');
    expect('detail' in netLogEntries()[0]).toBe(false);
  });
});

describe('formatNetLogExport', () => {
  it('produces parseable JSON with meta and entries', () => {
    const entries: NetLogEntry[] = [{ t: 1700000000000, type: 'ws-open' }];
    const out = formatNetLogExport(entries, { exportedAt: 1700000001000, userAgent: 'test-ua' });
    const parsed = JSON.parse(out) as {
      exportedAt: string;
      userAgent: string;
      entries: NetLogEntry[];
    };
    expect(parsed.userAgent).toBe('test-ua');
    expect(parsed.exportedAt).toBe(new Date(1700000001000).toISOString());
    expect(parsed.entries).toEqual(entries);
  });
});
