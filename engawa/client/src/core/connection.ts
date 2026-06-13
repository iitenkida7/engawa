// Socket reconnect orchestration, extracted from App so the backoff/auth/toast
// state machine is testable on its own. The pure delay math stays in
// core/reconnect.ts; this class owns the timers and the "connection lost"
// toast. The App wires `connect` to NetworkClient.connect() and forwards the
// socket's open/close events here.

import { computeReconnectDelay, RECONNECT_MAX_ATTEMPTS } from '@/core/reconnect';
import type { Toasts } from '@/ui/notify';

export class ConnectionManager {
  private connect: () => void;
  private toasts: Toasts;
  private delayFn: (attempt: number) => number;

  // Exponential-backoff reconnect state (issue #126). `reconnectAttempt` counts
  // consecutive failures (reset on a successful open); `reconnectTimer` holds the
  // pending retry so we never stack timers; `dismissConnToast` closes the active
  // "connection lost" toast.
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private dismissConnToast: (() => void) | null = null;

  // Set when the server rejected our join (auth-error); the close that follows
  // must not trigger a retry — the user re-enters the password instead.
  private authFailedFlag = false;

  constructor(opts: {
    connect: () => void;
    toasts: Toasts;
    // Injectable for tests (zero delays); defaults to the tested backoff math.
    delayFn?: (attempt: number) => number;
  }) {
    this.connect = opts.connect;
    this.toasts = opts.toasts;
    this.delayFn = opts.delayFn ?? ((attempt) => computeReconnectDelay(attempt));
  }

  get authFailed(): boolean {
    return this.authFailedFlag;
  }

  markAuthFailed() {
    this.authFailedFlag = true;
  }

  onOpen() {
    // Connected: the backoff resets and any "connection lost" toast clears. If
    // auth then fails the auth-error handler re-shows the join overlay.
    this.reconnectAttempt = 0;
    this.dismissConnToast?.();
    this.dismissConnToast = null;
  }

  onClose() {
    if (this.authFailedFlag) {
      this.authFailedFlag = false;
      return;
    }
    this.scheduleReconnect();
  }

  // Reconnect with exponential backoff + jitter (computeReconnectDelay), bounded
  // by RECONNECT_MAX_ATTEMPTS. Past the cap we stop auto-retrying and leave a
  // persistent toast with a manual 再接続 button, so a long-down server isn't
  // pinged forever (the old code retried every 2s with no ceiling).
  private scheduleReconnect() {
    // A retry is already pending: 'error' and 'close' can both fire, so don't
    // stack timers.
    if (this.reconnectTimer != null) return;
    if (this.reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
      this.dismissConnToast?.();
      this.dismissConnToast = this.toasts.action(
        'サーバーに接続できません。',
        [{ label: '再接続', primary: true, onClick: () => this.manualReconnect() }],
        0,
      );
      return;
    }
    const delay = this.delayFn(this.reconnectAttempt);
    this.reconnectAttempt++;
    console.warn(
      `[ws] connection closed; retrying in ${delay}ms (attempt ${this.reconnectAttempt})`,
    );
    // Show the (persistent) reconnecting notice once; later attempts reuse it.
    if (!this.dismissConnToast) {
      this.dismissConnToast = this.toasts.action('接続が切れました。再接続しています…', [], 0);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  // User asked to retry (manual button) or returned to a backgrounded tab whose
  // socket dropped: clear any pending backoff, reset the counter, and reconnect now.
  manualReconnect() {
    this.dismissConnToast?.();
    this.dismissConnToast = null;
    this.reconnectAttempt = 0;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connect();
  }
}
