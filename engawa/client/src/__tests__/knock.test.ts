import { describe, expect, it } from 'bun:test';
import type { ClientMessage } from '@/core/types';
import { KNOCK_COOLDOWN_MS, KnockController, type KnockDeps } from '@/ui/knock';
import type { ToastAction } from '@/ui/notify';
import type { PlayerState } from '@/world/player';

// Minimal player stand-ins; KnockController only reads `name` / `isSelf`.
function player(name: string, isSelf = false): PlayerState {
  return { name, isSelf } as unknown as PlayerState;
}

type Harness = {
  ctrl: KnockController;
  sent: ClientMessage[];
  infos: string[];
  actions: { text: string; actions: ToastAction[] }[];
  enters: number;
  goTos: string[];
  setNow: (ms: number) => void;
  setHidden: (hidden: boolean) => void;
};

function setup(players: Map<string, PlayerState>): Harness {
  const sent: ClientMessage[] = [];
  const infos: string[] = [];
  const actions: { text: string; actions: ToastAction[] }[] = [];
  let enters = 0;
  const goTos: string[] = [];
  let nowMs = 0;
  let hidden = false;

  const deps: KnockDeps = {
    players,
    send: (msg) => sent.push(msg),
    toasts: {
      info: (text: string) => infos.push(text),
      action: (text: string, a: ToastAction[]) => {
        actions.push({ text, actions: a });
        return () => {};
      },
    } as unknown as KnockDeps['toasts'],
    sounds: {
      enter: () => {
        enters++;
      },
    } as unknown as KnockDeps['sounds'],
    goTo: (id) => goTos.push(id),
    now: () => nowMs,
    isHidden: () => hidden,
  };

  return {
    ctrl: new KnockController(deps),
    sent,
    infos,
    actions,
    get enters() {
      return enters;
    },
    goTos,
    setNow: (ms) => {
      nowMs = ms;
    },
    setHidden: (h) => {
      hidden = h;
    },
  } as Harness;
}

describe('KnockController', () => {
  it('sends a knock and an info toast for a valid target', () => {
    const players = new Map([['u1', player('田中')]]);
    const h = setup(players);
    h.ctrl.request('u1');
    expect(h.sent).toEqual([{ type: 'knock', to: 'u1' }]);
    expect(h.infos.length).toBe(1);
    h.ctrl.onPlayerLeft('u1'); // clear the pending no-answer timer
  });

  it('does not knock self or an unknown user', () => {
    const players = new Map([['me', player('自分', true)]]);
    const h = setup(players);
    h.ctrl.request('me');
    h.ctrl.request('ghost');
    expect(h.sent).toEqual([]);
  });

  it('suppresses a re-knock while within the cooldown window', () => {
    const players = new Map([['u1', player('田中')]]);
    const h = setup(players);
    h.setNow(0);
    h.ctrl.request('u1');
    h.setNow(KNOCK_COOLDOWN_MS - 1);
    h.ctrl.request('u1'); // still cooling down → ignored
    expect(h.sent.length).toBe(1);
    h.ctrl.onPlayerLeft('u1');
  });

  it('allows a re-knock once the cooldown has elapsed', () => {
    const players = new Map([['u1', player('田中')]]);
    const h = setup(players);
    h.setNow(0);
    h.ctrl.request('u1');
    h.ctrl.onPlayerLeft('u1'); // clear the first pending timer
    h.setNow(KNOCK_COOLDOWN_MS);
    h.ctrl.request('u1');
    expect(h.sent.length).toBe(2);
    h.ctrl.onPlayerLeft('u1');
  });

  it('reply(accept) does not walk over (the responder comes to us) but clears the cooldown', () => {
    const players = new Map([['u1', player('田中')]]);
    const h = setup(players);
    h.setNow(0);
    h.ctrl.request('u1');
    h.ctrl.reply('u1', '田中', true);
    // The caller stays put; the responder walks over on their side.
    expect(h.goTos).toEqual([]);
    // cooldown cleared → an immediate re-knock goes through
    h.ctrl.request('u1');
    expect(h.sent.filter((m) => m.type === 'knock').length).toBe(2);
    h.ctrl.onPlayerLeft('u1');
  });

  it('reply(decline) does not walk over', () => {
    const players = new Map([['u1', player('田中')]]);
    const h = setup(players);
    h.ctrl.request('u1');
    h.ctrl.reply('u1', '田中', false);
    expect(h.goTos).toEqual([]);
    h.ctrl.onPlayerLeft('u1');
  });

  it('received plays the enter chime; accepting replies and walks us to the caller', () => {
    const players = new Map([['u2', player('佐藤')]]);
    const h = setup(players);
    h.ctrl.received('u2', '佐藤');
    expect(h.enters).toBe(1);
    expect(h.actions.length).toBe(1);
    const [accept, decline] = h.actions[0].actions;
    accept.onClick();
    decline.onClick();
    expect(h.sent).toEqual([
      { type: 'knock-reply', to: 'u2', accept: true },
      { type: 'knock-reply', to: 'u2', accept: false },
    ]);
    // Accepting walks the responder over to the caller (Gather-style).
    expect(h.goTos).toEqual(['u2']);
  });

  it('offers a call-back on return for a knock whose toast expired while hidden', () => {
    const players = new Map([['u2', player('佐藤')]]);
    const h = setup(players);
    h.setHidden(true);
    h.setNow(0);
    h.ctrl.received('u2', '佐藤');
    h.setHidden(false);
    h.setNow(3 * 60000);
    h.ctrl.onVisible();
    expect(h.actions.length).toBe(2); // live knock toast + call-back toast
    expect(h.actions[1].text).toContain('佐藤');
    h.actions[1].actions[0].onClick(); // 呼び返す
    expect(h.sent).toEqual([{ type: 'knock', to: 'u2' }]);
    // Shown once: a second return doesn't repeat it.
    h.ctrl.onVisible();
    expect(h.actions.length).toBe(2);
    h.ctrl.onPlayerLeft('u2');
  });

  it('skips the call-back while the live knock toast is still up', () => {
    const players = new Map([['u2', player('佐藤')]]);
    const h = setup(players);
    h.setHidden(true);
    h.setNow(0);
    h.ctrl.received('u2', '佐藤');
    h.setNow(KNOCK_COOLDOWN_MS - 1);
    h.ctrl.onVisible();
    expect(h.actions.length).toBe(1);
  });

  it('does not record knocks received while visible', () => {
    const players = new Map([['u2', player('佐藤')]]);
    const h = setup(players);
    h.ctrl.received('u2', '佐藤');
    h.setNow(KNOCK_COOLDOWN_MS * 10);
    h.ctrl.onVisible();
    expect(h.actions.length).toBe(1);
  });

  it('drops a missed knock when its sender has left', () => {
    const players = new Map([['u2', player('佐藤')]]);
    const h = setup(players);
    h.setHidden(true);
    h.ctrl.received('u2', '佐藤');
    players.delete('u2');
    h.ctrl.onPlayerLeft('u2');
    h.setNow(KNOCK_COOLDOWN_MS * 10);
    h.ctrl.onVisible();
    expect(h.actions.length).toBe(1);
  });
});
