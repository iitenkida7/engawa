import { describe, expect, it } from 'bun:test';
import { KnockController, KNOCK_COOLDOWN_MS, type KnockDeps } from '@/ui/knock';
import type { ClientMessage } from '@/core/types';
import type { PlayerState } from '@/world/player';
import type { ToastAction } from '@/ui/notify';

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
};

function setup(players: Map<string, PlayerState>): Harness {
  const sent: ClientMessage[] = [];
  const infos: string[] = [];
  const actions: { text: string; actions: ToastAction[] }[] = [];
  let enters = 0;
  const goTos: string[] = [];
  let nowMs = 0;

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
    sounds: { enter: () => { enters++; } } as unknown as KnockDeps['sounds'],
    goTo: (id) => goTos.push(id),
    now: () => nowMs,
  };

  return {
    ctrl: new KnockController(deps),
    sent,
    infos,
    actions,
    get enters() { return enters; },
    goTos,
    setNow: (ms) => { nowMs = ms; },
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

  it('reply(accept) walks over and clears the cooldown so re-knock is immediate', () => {
    const players = new Map([['u1', player('田中')]]);
    const h = setup(players);
    h.setNow(0);
    h.ctrl.request('u1');
    h.ctrl.reply('u1', '田中', true);
    expect(h.goTos).toEqual(['u1']);
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

  it('received plays the enter chime and offers accept/decline actions that reply', () => {
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
  });
});
