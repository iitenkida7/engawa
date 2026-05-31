// Lightweight toast notifications stacked at the top-center of the viewport.
// Used for knock requests (actionable: 応じる / あとで) and knock replies
// (transient info). Kept separate from the server-update reload banner, which
// is a singleton with its own chrome. The container is created lazily on first
// use and reused for the page's lifetime.

export type ToastAction = { label: string; primary?: boolean; onClick: () => void };

export class Toasts {
  private container: HTMLDivElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.id = 'toasts';
    document.body.appendChild(this.container);
  }

  // A transient informational toast that auto-dismisses after `timeoutMs`.
  info(text: string, timeoutMs = 4500) {
    this.make(text, [], timeoutMs);
  }

  // An actionable toast with buttons. Returns a dismiss fn so callers can close
  // it early (e.g. when superseded). Clicking any action dismisses it first.
  // `timeoutMs` of 0 means it never auto-dismisses.
  action(text: string, actions: ToastAction[], timeoutMs = 20000): () => void {
    return this.make(text, actions, timeoutMs);
  }

  private make(text: string, actions: ToastAction[], timeoutMs: number): () => void {
    const el = document.createElement('div');
    el.className = 'toast';

    const msg = document.createElement('span');
    msg.className = 'toast-msg';
    msg.textContent = text;
    el.appendChild(msg);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const dismiss = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      el.remove();
    };

    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'toast-actions';
      for (const a of actions) {
        const btn = document.createElement('button');
        btn.textContent = a.label;
        if (a.primary) btn.className = 'primary';
        btn.addEventListener('click', () => {
          dismiss();
          a.onClick();
        });
        row.appendChild(btn);
      }
      el.appendChild(row);
    }

    this.container.appendChild(el);
    if (timeoutMs > 0) timer = setTimeout(dismiss, timeoutMs);
    return dismiss;
  }
}
