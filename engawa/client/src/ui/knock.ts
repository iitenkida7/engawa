import { t } from '@/core/i18n';
import type { ClientMessage } from '@/core/types';
import type { Toasts } from '@/ui/notify';
import type { SoundManager } from '@/ui/sounds';
import type { PlayerState } from '@/world/player';

// A knock can't be re-sent to the same person until this elapses; it also
// covers the pending window, so you can't spam someone while waiting for a
// reply. The no-answer timeout matches it: once it fires the cooldown is up too.
export const KNOCK_COOLDOWN_MS = 20000;

export interface KnockDeps {
  // The authoritative player map (owned by App). Used to resolve names and to
  // guard against knocking self / a player who has left.
  players: Map<string, PlayerState>;
  send: (msg: ClientMessage) => void;
  toasts: Toasts;
  sounds: SoundManager;
  // Walk self over to a player. App owns movement, so accepting a knock (on
  // either side) calls back here rather than moving directly.
  goTo: (userId: string) => void;
  // Injectable clock for deterministic tests; defaults to performance.now.
  now?: () => number;
  // Whether the tab is in the background; defaults to document.hidden.
  isHidden?: () => boolean;
}

// A knock received while the tab was hidden, keyed by sender (latest wins).
type MissedKnock = { name: string; at: number };

// Owns the knock (call-request) feature end to end: the knocker-side pending /
// cooldown state and both sides' toast interactions. App used to embed this; it
// now just forwards roster clicks and server messages here (Manager-callback
// pattern), keeping the orchestrator focused on the game loop.
export class KnockController {
  // target userId → no-answer timeout handle, and target userId →
  // this.now() until which a re-knock is suppressed.
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private cooldownUntil = new Map<string, number>();
  private missed = new Map<string, MissedKnock>();
  private now: () => number;
  private isHidden: () => boolean;

  constructor(private deps: KnockDeps) {
    this.now = deps.now ?? (() => performance.now());
    this.isHidden = deps.isHidden ?? (() => document.hidden);
  }

  // Roster "🔔" button: send a knock to that player. Throttled per target
  // (KNOCK_COOLDOWN_MS), which also blocks re-knocking while a reply is still
  // pending. A local no-answer timer fires if they never respond.
  request(userId: string) {
    const target = this.deps.players.get(userId);
    if (!target || target.isSelf) return;
    const now = this.now();
    if (now < (this.cooldownUntil.get(userId) ?? 0)) return;
    this.cooldownUntil.set(userId, now + KNOCK_COOLDOWN_MS);

    this.deps.send({ type: 'knock', to: userId });
    this.deps.toasts.info(t('knock.sent', { name: target.name }));

    const timer = setTimeout(() => {
      this.pending.delete(userId);
      const p = this.deps.players.get(userId);
      this.deps.toasts.info(t('knock.noResponse', { name: p?.name ?? t('knock.someone') }));
    }, KNOCK_COOLDOWN_MS);
    this.pending.set(userId, timer);
  }

  // Someone knocked us: offer an accept/decline toast. Accepting tells them OK
  // and walks us over to them (the responder goes to the caller, like Gather);
  // 「あとで」 declines politely.
  received(fromUserId: string, name: string) {
    // Remember knocks that land in a background tab: the toast below expires
    // after KNOCK_COOLDOWN_MS, possibly before the user comes back (#140).
    if (this.isHidden()) this.missed.set(fromUserId, { name, at: this.now() });
    this.deps.sounds.enter();
    this.deps.toasts.action(
      t('knock.wantsTalk', { name }),
      [
        {
          label: t('knock.accept'),
          primary: true,
          onClick: () => {
            this.deps.send({ type: 'knock-reply', to: fromUserId, accept: true });
            this.deps.goTo(fromUserId);
          },
        },
        {
          label: t('knock.later'),
          onClick: () => this.deps.send({ type: 'knock-reply', to: fromUserId, accept: false }),
        },
      ],
      KNOCK_COOLDOWN_MS,
    );
  }

  // Reply to a knock we sent. On accept the responder walks over to us (they
  // call goTo on their side), so we just acknowledge; on decline we say so
  // quietly. Either way the reply clears our pending timer and cooldown so we
  // can try again right away.
  reply(fromUserId: string, name: string, accept: boolean) {
    this.forget(fromUserId);
    if (accept) {
      this.deps.toasts.info(t('knock.accepted', { name }));
    } else {
      this.deps.toasts.info(t('knock.busy', { name }));
    }
  }

  // The tab became visible again. Knocks whose live toast is still up can be
  // answered there; for ones that already expired, offer a call-back toast
  // (a regular knock to the sender, so the usual cooldown applies).
  onVisible() {
    const now = this.now();
    for (const [userId, k] of this.missed) {
      const elapsed = now - k.at;
      if (elapsed < KNOCK_COOLDOWN_MS || !this.deps.players.has(userId)) continue;
      const minutes = Math.max(1, Math.floor(elapsed / 60000));
      this.deps.toasts.action(
        t('knock.missed', { name: k.name, minutes }),
        [
          { label: t('knock.callBack'), primary: true, onClick: () => this.request(userId) },
          { label: t('knock.dismiss'), onClick: () => {} },
        ],
        0,
      );
    }
    this.missed.clear();
  }

  // A player left: drop any pending timer, cooldown and missed knock we held
  // for them.
  onPlayerLeft(userId: string) {
    this.forget(userId);
    this.missed.delete(userId);
  }

  private forget(userId: string) {
    const timer = this.pending.get(userId);
    if (timer) {
      clearTimeout(timer);
      this.pending.delete(userId);
    }
    this.cooldownUntil.delete(userId);
  }
}
