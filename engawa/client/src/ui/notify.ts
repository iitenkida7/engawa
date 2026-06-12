// Lightweight toast notifications stacked at the top-center of the viewport.
// Used for knock requests (actionable: 応じる / あとで) and knock replies
// (transient info). Kept separate from the server-update reload banner, which
// is a singleton with its own chrome. The container is created lazily on first
// use and reused for the page's lifetime.

import { el } from '@/ui/dom';

export type ToastAction = { label: string; primary?: boolean; onClick: () => void };

export class Toasts {
  private container: HTMLDivElement;

  constructor() {
    this.container = el('div');
    this.container.id = 'toasts';
    document.body.appendChild(this.container);
  }

  // A transient informational toast that auto-dismisses after `timeoutMs`.
  info(text: string, timeoutMs = 4500) {
    this.make(text, [], timeoutMs);
  }

  // A failure toast: like info() but styled with a red accent and kept up a bit
  // longer so the user has time to read it (used for camera/mic/connection
  // errors that previously only hit the console — issue #126).
  error(text: string, timeoutMs = 7000) {
    this.make(text, [], timeoutMs, 'error');
  }

  // An actionable toast with buttons. Returns a dismiss fn so callers can close
  // it early (e.g. when superseded). Clicking any action dismisses it first.
  // `timeoutMs` of 0 means it never auto-dismisses.
  action(text: string, actions: ToastAction[], timeoutMs = 20000): () => void {
    return this.make(text, actions, timeoutMs);
  }

  private make(
    text: string,
    actions: ToastAction[],
    timeoutMs: number,
    variant?: 'error',
  ): () => void {
    const toast = el('div', { className: variant ? `toast ${variant}` : 'toast' }, [
      el('span', { className: 'toast-msg', textContent: text }),
    ]);

    let timer: ReturnType<typeof setTimeout> | null = null;
    const dismiss = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      toast.remove();
    };

    if (actions.length) {
      toast.appendChild(
        el(
          'div',
          { className: 'toast-actions' },
          actions.map((a) =>
            el('button', {
              className: a.primary ? 'primary' : undefined,
              textContent: a.label,
              onClick: () => {
                dismiss();
                a.onClick();
              },
            }),
          ),
        ),
      );
    }

    this.container.appendChild(toast);
    if (timeoutMs > 0) timer = setTimeout(dismiss, timeoutMs);
    return dismiss;
  }
}
