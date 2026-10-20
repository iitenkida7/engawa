import { logNet } from '@/core/netlog';
import {
  SFU_REBUILD_RESET_MS,
  SFU_RECONNECT_NOTICE_FROM,
  SFU_STALE_STREAM_GRACE_MS,
  sfuRebuildDelayMs,
} from '@/rtc/sfu-logic';

type FrozenStream = { userId: string; streamId: string };

export interface SfuRecoveryCallbacks {
  // Close the SFU transport but keep the tiles up, returning the frozen streams.
  closeKeepTiles: () => FrozenStream[];
  // Rebuild the transport in place (fired by tick() once the backoff is due).
  rebuild: () => void;
  setReconnecting: (on: boolean) => void;
  detachStream: (userId: string, streamId: string) => void;
  // Show the persistent "reconnecting" notice; returns its dismiss function.
  showNotice: () => () => void;
}

// SFU transport recovery (issue #254), split out of App. When the transport
// fails it is rebuilt in place with backoff — fresh PC, fresh Cloudflare
// session (issue #186; Cloudflare offers no client-driven ICE restart) — and
// never degrades to mesh. The tiles stay up, frozen under a "reconnecting"
// overlay, until a re-pull replaces them or the post-connect sweep drops them.
// tick() runs every simulation step, like the WS retry deadline.
export class SfuRecovery {
  // Consecutive rebuilds, for the backoff.
  private failures = 0;
  // Deadline of the pending rebuild (null = none pending).
  private rebuildAt: number | null = null;
  // When the transport last reached 'connected'.
  private connectedAt = Number.NEGATIVE_INFINITY;
  private dismissNotice: (() => void) | null = null;
  // Remote streams frozen in place by a rebuild, swept at `sweepAt` unless a
  // re-pull replaced them first (detach is then a no-op).
  private stale: FrozenStream[] = [];
  private sweepAt: number | null = null;

  constructor(private cb: SfuRecoveryCallbacks) {}

  // True while a rebuild is waiting out its backoff (#258: publishes and
  // directory re-feeds are held back meanwhile).
  get pending(): boolean {
    return this.rebuildAt != null;
  }

  // The transport failed while we are on SFU: freeze the tiles, tear it down
  // and schedule a rebuild. Returns false when one is already pending.
  onFailed(): boolean {
    if (this.rebuildAt != null) return false;
    const now = performance.now();
    // A failure long after the last good connection is a new outage. One with
    // no connection since the last rebuild (-∞) continues the current backoff.
    if (now - this.connectedAt > SFU_REBUILD_RESET_MS && this.connectedAt > -Infinity) {
      this.failures = 0;
    }
    this.connectedAt = Number.NEGATIVE_INFINITY;
    this.failures++;
    const delay = sfuRebuildDelayMs(this.failures);
    logNet('sfu-rebuild', { attempt: this.failures, delayMs: delay });
    console.warn(`[sfu] transport failed; rebuilding in ${delay}ms`);
    this.stale.push(...this.cb.closeKeepTiles());
    this.sweepAt = null;
    this.cb.setReconnecting(true);
    if (this.failures >= SFU_RECONNECT_NOTICE_FROM && !this.dismissNotice) {
      this.dismissNotice = this.cb.showNotice();
    }
    this.rebuildAt = now + delay;
    return true;
  }

  // The (re)built transport connected: clear the reconnecting UI and give
  // re-pulls a grace period to replace the frozen streams before sweeping.
  onConnected() {
    this.connectedAt = performance.now();
    this.dismissNotice?.();
    this.dismissNotice = null;
    this.cb.setReconnecting(false);
    if (this.stale.length > 0) {
      this.sweepAt = performance.now() + SFU_STALE_STREAM_GRACE_MS;
    }
  }

  // Fires the due rebuild, then the due sweep.
  tick(now: number) {
    if (this.rebuildAt != null && now >= this.rebuildAt) {
      this.rebuildAt = null;
      this.cb.rebuild();
    }
    if (this.sweepAt != null && now >= this.sweepAt) {
      this.sweepAt = null;
      this.sweep();
    }
  }

  // Forget the frozen streams of users no longer in the group, returning their
  // userIds (one per stream) so the caller can drop their tiles.
  pruneDeparted(isMember: (userId: string) => boolean): string[] {
    const departed = this.stale.filter((s) => !isMember(s.userId)).map((s) => s.userId);
    this.stale = this.stale.filter((s) => isMember(s.userId));
    return departed;
  }

  // Leaving SFU (group change, away, session reset): drop all recovery state.
  end() {
    this.rebuildAt = null;
    this.failures = 0;
    this.connectedAt = Number.NEGATIVE_INFINITY;
    this.dismissNotice?.();
    this.dismissNotice = null;
    this.cb.setReconnecting(false);
    this.sweepAt = null;
    this.sweep();
  }

  // Detach the frozen streams no re-pull replaced (a no-op for replaced ones,
  // since detachRemoteStream matches the stream id).
  private sweep() {
    const stale = this.stale;
    this.stale = [];
    for (const { userId, streamId } of stale) this.cb.detachStream(userId, streamId);
  }
}
