// Own status state (status / one-liner / return time) and its broadcast,
// extracted from App so the auto-return state machine is testable on its own.
// The roster reads the current values through the getters and commits changes
// via set(); broadcast() also rides every mic/cam toggle so peers see the live
// mute/video flags.

import type { ClientMessage, PlayerStatus } from '@/core/types';
import type { PlayerState } from '@/world/player';

export class StatusManager {
  private send: (msg: ClientMessage) => void;
  private getMe: () => PlayerState | null;
  private isMicOn: () => boolean;
  private isCamOn: () => boolean;
  private onChanged: () => void;

  // Status one-liner and return time (#85). `myUntil` is an absolute epoch ms
  // (null = none); `myUntilMin` is the chosen preset in minutes, kept so the
  // status menu can re-highlight it. A timer auto-returns to online at `myUntil`.
  private myStatus: PlayerStatus = 'online';
  private myNote = '';
  private myUntil: number | null = null;
  private myUntilMin: number | null = null;
  private untilTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: {
    send: (msg: ClientMessage) => void;
    getMe: () => PlayerState | null;
    isMicOn: () => boolean;
    isCamOn: () => boolean;
    // Fired after a status change is applied (the roster re-highlights).
    onChanged: () => void;
  }) {
    this.send = opts.send;
    this.getMe = opts.getMe;
    this.isMicOn = opts.isMicOn;
    this.isCamOn = opts.isCamOn;
    this.onChanged = opts.onChanged;
  }

  get status(): PlayerStatus {
    return this.myStatus;
  }

  get note(): string {
    return this.myNote;
  }

  get untilMin(): number | null {
    return this.myUntilMin;
  }

  // Mirror the current status + live mic/cam flags onto self and broadcast them
  // to the workspace. Also called on every mic/cam toggle (no status change).
  broadcast() {
    const me = this.getMe();
    if (!me) return;
    me.status = this.myStatus;
    me.note = this.myNote;
    me.until = this.myUntil;
    me.isMuted = !this.isMicOn();
    me.isVideoOn = this.isCamOn();
    this.send({
      type: 'status',
      status: this.myStatus,
      isMuted: !this.isMicOn(),
      isVideoOn: this.isCamOn(),
      note: this.myNote,
      until: this.myUntil,
    });
  }

  // Set status plus optional one-liner and return time (#85). `untilMin` is a
  // preset in minutes (null = no time); it's resolved to an absolute epoch ms so
  // every peer shows the same clock target. A timer flips us back to online when
  // the time arrives. No-ops only when status, note, and time all match.
  set(status: PlayerStatus, note = '', untilMin: number | null = null) {
    const until = untilMin == null ? null : Date.now() + untilMin * 60_000;
    if (this.myStatus === status && this.myNote === note && this.myUntilMin === untilMin) return;
    this.myStatus = status;
    this.myNote = note;
    this.myUntil = until;
    this.myUntilMin = untilMin;
    this.broadcast();
    this.onChanged();
    this.scheduleAutoReturn();
  }

  // (Re)arm the auto-return-to-online timer for the current `myUntil`. Cleared
  // and reset on every status change; on fire it broadcasts online with no note.
  private scheduleAutoReturn() {
    if (this.untilTimer != null) {
      clearTimeout(this.untilTimer);
      this.untilTimer = null;
    }
    if (this.myUntil == null) return;
    const delay = Math.max(0, this.myUntil - Date.now());
    this.untilTimer = setTimeout(() => {
      this.untilTimer = null;
      this.set('online');
    }, delay);
  }
}
