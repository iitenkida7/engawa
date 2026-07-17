import type { ClientMessage, ServerMessage } from '@/core/types';

export class NetworkClient {
  private ws: WebSocket | null = null;
  private url: string;
  private onMsg: (msg: ServerMessage) => void;
  private onOpen: () => void;
  private onClose: () => void;

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
    ws.addEventListener('open', () => {
      if (this.ws === ws) this.onOpen();
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.onClose();
    });
    ws.addEventListener('error', (e) => console.error('[ws] error', e));
    ws.addEventListener('message', (e) => {
      if (this.ws !== ws) return;
      try {
        const msg = JSON.parse(e.data) as ServerMessage;
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

  // True while the socket is open or still opening — i.e. connect() does not need
  // to be (re)called. Used by the visibility handler to reconnect a dropped
  // socket on return from a long background stint, without stacking connects on
  // one that is merely mid-handshake.
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING;
  }
}
