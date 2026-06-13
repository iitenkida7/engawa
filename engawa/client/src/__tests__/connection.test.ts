import { describe, expect, it } from 'bun:test';
import { ConnectionManager } from '@/core/connection';
import { RECONNECT_MAX_ATTEMPTS } from '@/core/reconnect';
import type { Toasts } from '@/ui/notify';

type ToastCall = { text: string; actionLabels: string[]; timeoutMs: number };

// Records every action() toast and exposes the last one's buttons so tests can
// press the manual 再接続 button.
function fakeToasts() {
  const calls: ToastCall[] = [];
  let dismissed = 0;
  let lastActions: { label: string; onClick: () => void }[] = [];
  const toasts = {
    action(text: string, actions: { label: string; onClick: () => void }[], timeoutMs: number) {
      calls.push({ text, actionLabels: actions.map((a) => a.label), timeoutMs });
      lastActions = actions;
      return () => {
        dismissed++;
      };
    },
  } as unknown as Toasts;
  return {
    toasts,
    calls,
    get dismissed() {
      return dismissed;
    },
    get lastActions() {
      return lastActions;
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 1));

function make(connects: number[] = []) {
  const t = fakeToasts();
  const conn = new ConnectionManager({
    connect: () => connects.push(Date.now()),
    toasts: t.toasts,
    // Zero backoff so tests don't wait on real timers.
    delayFn: () => 0,
  });
  return { conn, t, connects };
}

describe('ConnectionManager', () => {
  it('schedules a reconnect on close and shows the persistent reconnecting toast once', async () => {
    const connects: number[] = [];
    const { conn, t } = make(connects);
    conn.onClose();
    await tick();
    expect(connects.length).toBe(1);
    expect(t.calls.length).toBe(1);
    expect(t.calls[0].timeoutMs).toBe(0);
    // A second drop reuses the existing toast.
    conn.onClose();
    await tick();
    expect(connects.length).toBe(2);
    expect(t.calls.length).toBe(1);
  });

  it('does not stack timers when error and close both fire', async () => {
    const connects: number[] = [];
    const { conn } = make(connects);
    conn.onClose();
    conn.onClose();
    await tick();
    expect(connects.length).toBe(1);
  });

  it('an auth failure consumes the next close without retrying', async () => {
    const connects: number[] = [];
    const { conn } = make(connects);
    conn.markAuthFailed();
    expect(conn.authFailed).toBe(true);
    conn.onClose();
    await tick();
    expect(connects.length).toBe(0);
    expect(conn.authFailed).toBe(false);
    // The flag is consumed: a later close retries normally.
    conn.onClose();
    await tick();
    expect(connects.length).toBe(1);
  });

  it('stops auto-retrying past the cap and offers a manual 再接続 action', async () => {
    const connects: number[] = [];
    const { conn, t } = make(connects);
    for (let i = 0; i < RECONNECT_MAX_ATTEMPTS; i++) {
      conn.onClose();
      await tick();
    }
    expect(connects.length).toBe(RECONNECT_MAX_ATTEMPTS);
    conn.onClose();
    await tick();
    expect(connects.length).toBe(RECONNECT_MAX_ATTEMPTS);
    const last = t.calls[t.calls.length - 1];
    expect(last.actionLabels).toEqual(['再接続']);
    // Pressing the button reconnects immediately and resets the backoff.
    t.lastActions[0].onClick();
    expect(connects.length).toBe(RECONNECT_MAX_ATTEMPTS + 1);
  });

  it('onOpen resets the attempt counter and dismisses the toast', async () => {
    const connects: number[] = [];
    const { conn, t } = make(connects);
    conn.onClose();
    await tick();
    conn.onOpen();
    expect(t.dismissed).toBe(1);
    // After a successful open, the next close starts a fresh backoff series
    // (observable as a new persistent toast).
    conn.onClose();
    await tick();
    expect(t.calls.length).toBe(2);
  });

  it('manualReconnect clears a pending retry and connects now', async () => {
    const connects: number[] = [];
    const { conn } = make(connects);
    conn.onClose();
    conn.manualReconnect();
    expect(connects.length).toBe(1);
    await tick();
    // The pending timer was cleared — no second connect.
    expect(connects.length).toBe(1);
  });
});
