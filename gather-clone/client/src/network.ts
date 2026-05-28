import type { ClientMessage, ServerMessage } from './types';

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
    // In dev, Vite (http-proxy) does not correctly relay Bun's 101 upgrade
    // response, so connect to the Bun server directly. In prod the same Bun
    // server hosts the static assets, so reuse window.location.host.
    const wsHost = import.meta.env.DEV
      ? `${window.location.hostname}:${import.meta.env.VITE_WS_PORT ?? '3000'}`
      : window.location.host;
    this.url = `${proto}://${wsHost}/ws`;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.addEventListener('open', () => this.onOpen());
    this.ws.addEventListener('close', () => this.onClose());
    this.ws.addEventListener('error', (e) => console.error('[ws] error', e));
    this.ws.addEventListener('message', (e) => {
      try {
        const msg = JSON.parse(e.data) as ServerMessage;
        this.onMsg(msg);
      } catch (err) {
        console.error('[ws] parse error', err);
      }
    });
  }

  send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }
}
