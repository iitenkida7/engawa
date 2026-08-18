import { type HeartbeatPhase, heartbeatAction } from '@/core/heartbeat';
import { logNet } from '@/core/netlog';
import type { ClientMessage, ServerMessage } from '@/core/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMsg: (msg: ServerMessage) => void;
  private onOpen: () => void;
  private onClose: () => void;

  // Heartbeat timestamps (issue #183), all on the caller's clock (the App
  // passes performance.now() into beat()). `connectStartedAt` bounds CONNECTING;
  // `lastPingAt` / `lastPongAt` drive the ping cadence and the dead-socket
  // timeout. null = not applicable for the current socket yet.
  private connectStartedAt: number | null = null;
  private lastPingAt: number | null = null;
  private lastPongAt: number | null = null;

  constructor(opts: {
    onMessage: (msg: ServerMessage) => void;
    onOpen: () => void;
    onClose: () => void;
  }) {
    this.onMsg = opts.onMessage;
    this.onOpen = opts.onOpen;
    this.onClose = opts.onClose;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    // Both dev (Caddy at https://engawa.localhost) and prod front /ws on the
    // same origin and relay the WebSocket upgrade, so reuse the page host.
    this.url = `${proto}://${window.location.host}/ws`;
  }

  connect() {
    // Abandon any previous socket: swap in the new one FIRST, then close the old.
    // Every listener checks socket identity, so the old socket's close (and any
    // late open/message) is ignored once `this.ws` points at the new socket —
    // preventing an orphaned socket from driving a stale join or a spurious
    // reconnect over the live one (which would force-rejoin with a new userId and
    // spawn ghosts).
    const prev = this.ws;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.connectStartedAt = null; // stamped by the first beat() while CONNECTING
    this.lastPingAt = null;
    this.lastPongAt = null;
    logNet('ws-connecting');
    ws.addEventListener('open', () => {
      if (this.ws !== ws) return;
      logNet('ws-open');
      this.onOpen();
    });
    ws.addEventListener('close', (e) => {
      if (this.ws !== ws) return;
      logNet('ws-close', { code: e?.code, reason: e?.reason });
      this.onClose();
    });
    ws.addEventListener('error', (e) => {
      logNet('ws-error');
      console.error('[ws] error', e);
    });
    ws.addEventListener('message', (e) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data) as ServerMessage;
        // Heartbeat replies are consumed here — they only feed the dead-socket
        // detection and are never part of the App's message routing.
        if (msg.type === 'pong') {
          this.lastPongAt = this.lastBeatNow;
          return;
        }
        this.onMsg(msg);
      } catch (err) {
        console.error('[ws] parse error', err);
      }
    });
    if (prev) {
      try {
        prev.close();
      } catch {
        /* noop */
      }
    }
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  // The clock value of the most recent beat(). Pongs arrive between beats; they
  // are stamped with this so every heartbeat timestamp lives on one clock (the
  // App's performance.now()). The ≤1-tick staleness is noise against the 12s
  // timeout.
  private lastBeatNow = 0;

  // One heartbeat tick, driven from the App's game loop (rAF while visible, the
  // background Worker while hidden — so it is immune to hidden-tab timer
  // throttling). Sends the periodic ping, abandons a hung CONNECT, and declares
  // a silent socket dead (issue #183). The decision itself is pure
  // (heartbeatAction); this maps it onto the live socket.
  beat(nowMs: number) {
    this.lastBeatNow = nowMs;
    const ws = this.ws;
    if (!ws) return;

    let phase: HeartbeatPhase = 'idle';
    if (ws.readyState === WebSocket.CONNECTING) {
      phase = 'connecting';
      this.connectStartedAt ??= nowMs;
    } else if (ws.readyState === WebSocket.OPEN) {
      phase = 'open';
      // First beat after open: anchor the pong clock so the timeout measures
      // silence from the open, not from a stale previous connection.
      this.lastPongAt ??= nowMs;
    }

    const action = heartbeatAction({
      phase,
      connectingMs: this.connectStartedAt != null ? nowMs - this.connectStartedAt : 0,
      sincePingMs: this.lastPingAt != null ? nowMs - this.lastPingAt : Number.POSITIVE_INFINITY,
      sincePongMs: this.lastPongAt != null ? nowMs - this.lastPongAt : Number.POSITIVE_INFINITY,
    });

    if (action === 'send-ping') {
      this.lastPingAt = nowMs;
      this.send({ type: 'ping' });
    } else if (action === 'timeout') {
      logNet('ws-heartbeat-timeout', { phase });
      this.forceClose();
    }
  }

  // Send a ping immediately (e.g. right after the OS reports the network came
  // back) so a half-open socket is detected within the pong timeout instead of
  // waiting for the next scheduled ping.
  pingNow() {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.lastPingAt = this.lastBeatNow;
    this.send({ type: 'ping' });
  }

  // Tear the current socket down (half-open detection, or the OS went offline).
  // Closing fires the socket's 'close', which — via the identity guard — drives
  // the App's normal reconnect path; there is no separate teardown code path.
  // The private 4000 code marks this as "reconnecting, not leaving": if the
  // close frame does reach the server, it must still grant the resume grace —
  // only 1000/1001 (tab close / reload) finalize the leave immediately.
  forceClose() {
    if (!this.ws) return;
    try {
      this.ws.close(4000, 'reconnecting');
    } catch {
      /* noop */
    }
  }

  // True while the socket is open or still opening — i.e. connect() does not need
  // to be (re)called. Used by the visibility handler to reconnect a dropped
  // socket on return from a long background stint, without stacking connects on
  // one that is merely mid-handshake (a hung handshake is bounded by beat()'s
  // connect timeout).
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING;
  }
}
