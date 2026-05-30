// Server-restart / redeploy detection.
//
// The server stamps every `welcome` with a boot id that is unique per process
// start. The client remembers the first id it sees; if a later welcome (after
// the automatic reconnect in app.ts) carries a different id, the server
// restarted or was redeployed. The fix is a full page reload: it clears the
// stale "ghost" avatars left behind — once the server's in-memory peer map is
// wiped, the old userId never receives a player-left, so other clients would
// otherwise keep showing duplicates — and it also picks up any new client
// bundle shipped by the deploy.

export type BootResult = { reload: boolean; bootId: string };

// Pure: given the boot id we already know (null before the first welcome) and
// the one just received, decide whether to reload and which id to remember next.
export function evaluateBoot(knownBootId: string | null, incomingBootId: string): BootResult {
  if (knownBootId === null) return { reload: false, bootId: incomingBootId };
  if (knownBootId !== incomingBootId) return { reload: true, bootId: incomingBootId };
  return { reload: false, bootId: knownBootId };
}

export const RELOAD_COUNTDOWN_SECONDS = 5;

// Pure: the countdown line shown in the banner (clamped at 0 so the final tick
// never renders a negative number).
export function countdownMessage(seconds: number): string {
  return `${seconds > 0 ? seconds : 0} 秒後に再読み込みします…`;
}

// A top banner telling the user the server was updated, counting down to an
// automatic reload, with a button to reload immediately. The tick and the
// reload action are injectable so the behaviour is testable without real timers
// or a real navigation.
export class ReloadBanner {
  private shown = false;
  private fired = false;
  private remaining: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private countdownEl: HTMLElement | null = null;
  private doc: Document;
  private reload: () => void;

  constructor(deps: { doc?: Document; reload?: () => void; seconds?: number } = {}) {
    this.doc = deps.doc ?? document;
    this.reload = deps.reload ?? (() => window.location.reload());
    this.remaining = deps.seconds ?? RELOAD_COUNTDOWN_SECONDS;
  }

  // Idempotent: repeated welcomes during a flapping reconnect only ever show one
  // banner and start one countdown.
  show() {
    if (this.shown) return;
    this.shown = true;

    const banner = this.doc.createElement('div');
    banner.id = 'reload-banner';

    const msg = this.doc.createElement('span');
    msg.className = 'reload-banner-msg';
    msg.textContent = 'サーバーが更新されました';

    const countdown = this.doc.createElement('span');
    countdown.className = 'reload-banner-countdown';
    countdown.textContent = countdownMessage(this.remaining);
    this.countdownEl = countdown;

    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.textContent = '今すぐ再読み込み';
    btn.addEventListener('click', () => this.reloadNow());

    banner.append(msg, countdown, btn);
    this.doc.body.appendChild(banner);

    this.timer = setInterval(() => this.tick(), 1000);
  }

  // Advance the countdown by one second. Exposed (not private) so tests can run
  // it to completion without waiting on real timers.
  tick() {
    this.remaining -= 1;
    if (this.countdownEl) this.countdownEl.textContent = countdownMessage(this.remaining);
    if (this.remaining <= 0) this.fireReload();
  }

  reloadNow() {
    this.fireReload();
  }

  private fireReload() {
    if (this.fired) return;
    this.fired = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.reload();
  }
}
