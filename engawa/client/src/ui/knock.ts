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
}

// Owns the knock (call-request) feature end to end: the knocker-side pending /
// cooldown state and both sides' toast interactions. App used to embed this; it
// now just forwards roster clicks and server messages here (Manager-callback
// pattern), keeping the orchestrator focused on the game loop.
export class KnockController {
  // target userId → no-answer timeout handle, and target userId →
  // this.now() until which a re-knock is suppressed.
  private pending = new Map<string, ReturnType<typeof setTimeout>>();
  private cooldownUntil = new Map<string, number>();
  private now: () => number;

  constructor(private deps: KnockDeps) {
    this.now = deps.now ?? (() => performance.now());
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
  // (their client then walks over); 「あとで」 declines politely.
  received(fromUserId: string, name: string) {
    this.deps.sounds.enter();
    this.deps.toasts.action(
      t('knock.wantsTalk', { name }),
      [
        {
          label: t('knock.accept'),
          primary: true,
          onClick: () => this.deps.send({ type: 'knock-reply', to: fromUserId, accept: true }),
        },
        {
          label: t('knock.later'),
          onClick: () => this.deps.send({ type: 'knock-reply', to: fromUserId, accept: false }),
        },
      ],
      KNOCK_COOLDOWN_MS,
    );
  }

  // Reply to a knock we sent. On accept we walk over to them (via goTo); on
  // decline we just say so quietly. Either way the reply clears our pending
  // timer and cooldown so we can try again right away.
  reply(fromUserId: string, name: string, accept: boolean) {
    this.forget(fromUserId);
    if (accept) {
      this.deps.toasts.info(t('knock.accepted', { name }));
      this.deps.goTo(fromUserId);
    } else {
      this.deps.toasts.info(t('knock.busy', { name }));
    }
  }

  // A player left: drop any pending timer and cooldown we held for them.
  onPlayerLeft(userId: string) {
    this.forget(userId);
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
