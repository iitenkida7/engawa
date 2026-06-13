import { describe, expect, it } from 'bun:test';
import { StatusManager } from '@/core/status';
import type { ClientMessage } from '@/core/types';
import { PlayerState } from '@/world/player';

function make(opts: { micOn?: boolean; camOn?: boolean } = {}) {
  const sent: ClientMessage[] = [];
  const me = new PlayerState({ userId: 'u1', name: 'n', x: 0, y: 0 }, true);
  let changed = 0;
  const status = new StatusManager({
    send: (m) => sent.push(m),
    getMe: () => me,
    isMicOn: () => opts.micOn ?? false,
    isCamOn: () => opts.camOn ?? false,
    onChanged: () => changed++,
  });
  return {
    sent,
    me,
    status,
    get changed() {
      return changed;
    },
  };
}

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('StatusManager', () => {
  it('set() updates self, broadcasts, and notifies the roster', () => {
    const t = make({ micOn: true });
    const before = Date.now();
    t.status.set('busy', '商談', 15);
    expect(t.me.status).toBe('busy');
    expect(t.me.note).toBe('商談');
    expect(t.me.isMuted).toBe(false);
    expect(t.changed).toBe(1);
    const msg = t.sent[0];
    if (msg?.type !== 'status') throw new Error('expected a status message');
    expect(msg.status).toBe('busy');
    expect(msg.note).toBe('商談');
    // until resolves to an absolute epoch ms ≈ now + 15 minutes.
    expect(msg.until).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(msg.until).toBeLessThan(before + 15 * 60_000 + 5_000);
    expect(t.status.status).toBe('busy');
    expect(t.status.note).toBe('商談');
    expect(t.status.untilMin).toBe(15);
  });

  it('set() no-ops when status, note and return time all match', () => {
    const t = make();
    t.status.set('away', 'ランチ', null);
    t.status.set('away', 'ランチ', null);
    expect(t.sent.length).toBe(1);
    expect(t.changed).toBe(1);
  });

  it('broadcast() reflects the live mic/cam state onto self and the wire', () => {
    const t = make({ micOn: false, camOn: true });
    t.status.broadcast();
    expect(t.me.isMuted).toBe(true);
    expect(t.me.isVideoOn).toBe(true);
    const msg = t.sent[0];
    if (msg?.type !== 'status') throw new Error('expected a status message');
    expect(msg.isMuted).toBe(true);
    expect(msg.isVideoOn).toBe(true);
  });

  it('auto-returns to online when the return time arrives', async () => {
    const t = make();
    // untilMin = 0 → the return time is "now", so the timer fires immediately.
    t.status.set('break', '休憩', 0);
    expect(t.status.status).toBe('break');
    await tick();
    expect(t.status.status).toBe('online');
    expect(t.status.note).toBe('');
    expect(t.me.status).toBe('online');
  });

  it('changing status re-arms the auto-return (no stale flip from the old timer)', async () => {
    const t = make();
    t.status.set('break', '', 0);
    // Replace the pending auto-return with a time-less status before it fires.
    t.status.set('busy', '', null);
    await tick();
    expect(t.status.status).toBe('busy');
  });
});
