import { beforeEach, describe, expect, it } from 'bun:test';
import { RosterPanel } from '@/ui/roster';
import type { PlayerState } from '@/world/player';

// Minimal stand-ins: the roster only reads these fields.
const player = (userId: string, name: string, isSelf = false): PlayerState =>
  ({
    userId,
    name,
    x: 10,
    y: 10,
    isSelf,
    isSpeaking: false,
    isMuted: false,
    isVideoOn: false,
    isSharingScreen: false,
    status: 'online',
    color: '#888888',
    avatarImage: undefined,
    initials: () => name.slice(0, 2),
  }) as unknown as PlayerState;

function mount() {
  document.body.innerHTML = `
    <button id="btn-roster"></button>
    <div id="roster" class="hidden">
      <span id="roster-title"></span>
      <button id="roster-scope" class="hidden"></button>
      <button id="roster-close"></button>
      <div id="roster-list"></div>
    </div>`;
}

describe('RosterPanel row actions', () => {
  let calls: string[];
  let roster: RosterPanel;

  beforeEach(() => {
    mount();
    calls = [];
    const players = new Map<string, PlayerState>([
      ['me', player('me', 'Me', true)],
      ['a', player('a', 'Alice')],
    ]);
    roster = new RosterPanel({
      getPlayers: () => players,
      onLocate: (id) => calls.push(`locate:${id}`),
      onGoTo: (id) => calls.push(`goto:${id}`),
      onCall: (id) => calls.push(`call:${id}`),
    });
    roster.toggle();
  });

  const rowOf = (id: string) =>
    document.querySelector<HTMLElement>(`.roster-row[data-user-id="${id}"]`);
  const button = (action: string) =>
    document.querySelector<HTMLElement>(`.roster-action[data-action="${action}"]`);

  it('clicking a row locates that person and reveals the go / call buttons', () => {
    rowOf('a')?.click();
    expect(calls).toEqual(['locate:a']);
    expect(rowOf('a')?.classList.contains('selected')).toBe(true);
    expect(button('goto')).not.toBeNull();
    expect(button('call')).not.toBeNull();
  });

  it('the buttons run go-to and call for that person without re-locating', () => {
    rowOf('a')?.click();
    button('goto')?.click();
    button('call')?.click();
    expect(calls).toEqual(['locate:a', 'goto:a', 'call:a']);
  });

  it('clicking the selected row again closes its buttons', () => {
    rowOf('a')?.click();
    rowOf('a')?.click();
    expect(calls).toEqual(['locate:a']);
    expect(button('goto')).toBeNull();
  });

  it('your own row locates (re-centers) but never offers go / call', () => {
    rowOf('me')?.click();
    expect(calls).toEqual(['locate:me']);
    expect(button('goto')).toBeNull();
  });

  it('select(null) clears the selection (the locate timed out)', () => {
    rowOf('a')?.click();
    roster.select(null);
    expect(rowOf('a')?.classList.contains('selected')).toBe(false);
    expect(button('goto')).toBeNull();
  });
});
