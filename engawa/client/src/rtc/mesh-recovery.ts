import { logNet } from '@/core/netlog';
import { isInitiator } from '@/core/proximity';
import {
  computePeerRetryDelay,
  PEER_CONNECT_STALL_MS,
  PEER_DISCONNECTED_TIMEOUT_MS,
} from '@/core/reconnect';

// Minimum gap between two honoured rtc-restart nudges from the same peer.
const RTC_RESTART_DEBOUNCE_MS = 3000;

export interface MeshRecoveryCallbacks {
  getMyId: () => string;
  // Whether this peer should still be in our mesh call (we run mesh and the
  // server's group-update lists them).
  isMeshMember: (userId: string) => boolean;
  hasPeer: (userId: string) => boolean;
  isPeerReady: (userId: string) => boolean;
  createPeer: (userId: string, initiator: boolean) => void;
  closePeer: (userId: string) => void;
  // Nudge `userId` (our elected initiator) to rebuild the pair with a fresh offer.
  sendRestart: (userId: string) => void;
}

// ─── Mesh-peer recovery (issue #184) ──────────────────────────────────────
// A mesh pair that dies mid-call (ICE failure after a Wi-Fi roam, TURN
// allocation expiry, …) never comes back on its own: the server re-sends
// group-update only on topology changes, and simple-peer does not resend
// offers. So dead pairs are rebuilt here, with a per-peer backoff. App owns the
// transports and membership and feeds peer events in; tick() runs every
// simulation step.
export class MeshRecovery {
  // All keyed by peer userId:
  //  - retryAt: performance.now deadline of the pending rebuild.
  //  - retryAttempts: consecutive failures, for the backoff (reset on connect).
  //  - stallAt: deadline by which a created peer must reach 'connect'.
  //  - disconnectedSince: when iceConnectionState went 'disconnected'.
  //  - restartHandledAt: debounce for inbound rtc-restart nudges.
  private retryAt = new Map<string, number>();
  private retryAttempts = new Map<string, number>();
  private stallAt = new Map<string, number>();
  private disconnectedSince = new Map<string, number>();
  private restartHandledAt = new Map<string, number>();

  constructor(private cb: MeshRecoveryCallbacks) {}

  // Create one mesh peer and arm the stall watchdog: if it never reaches
  // 'connect' the recovery loop tears it down and retries. All outbound mesh
  // createPeer call sites (group reconcile, recovery, restart nudges) go here.
  createPeer(userId: string, initiator: boolean) {
    this.armStall(userId);
    this.cb.createPeer(userId, initiator);
  }

  // Arm the connect-stall watchdog for a peer created elsewhere (an inbound
  // offer creates the non-initiator side itself).
  armStall(userId: string) {
    this.stallAt.set(userId, performance.now() + PEER_CONNECT_STALL_MS);
  }

  // Fully up: recovery bookkeeping resets so the next failure starts a fresh
  // backoff, and the stall/disconnected watchdogs disarm.
  onPeerConnected(userId: string) {
    this.retryAttempts.delete(userId);
    this.retryAt.delete(userId);
    this.stallAt.delete(userId);
    this.disconnectedSince.delete(userId);
  }

  // Track sustained 'disconnected' (see tick). 'failed'/'closed' need no
  // handling here — simple-peer destroys the pair, which lands in onPeerClosed.
  onIceState(userId: string, state: string) {
    if (state === 'disconnected') {
      if (!this.disconnectedSince.has(userId)) {
        this.disconnectedSince.set(userId, performance.now());
      }
    } else if (state === 'connected' || state === 'completed') {
      this.disconnectedSince.delete(userId);
    }
  }

  // A peer closed. If it should still be in our call, schedule a rebuild with
  // backoff; otherwise clear its recovery state. Deliberate closes (group
  // reconcile, mesh→SFU, session reset) pass the guards because membership is
  // updated *before* the close in those paths.
  onPeerClosed(userId: string) {
    this.stallAt.delete(userId);
    this.disconnectedSince.delete(userId);
    if (!this.cb.isMeshMember(userId)) {
      this.retryAt.delete(userId);
      this.retryAttempts.delete(userId);
      return;
    }
    if (this.retryAt.has(userId)) return;
    const attempt = (this.retryAttempts.get(userId) ?? 0) + 1;
    this.retryAttempts.set(userId, attempt);
    const delay = computePeerRetryDelay(attempt);
    logNet('mesh-retry-scheduled', { peer: userId, attempt, delayMs: delay });
    this.retryAt.set(userId, performance.now() + delay);
  }

  // A group peer detected our pair is dead and asks us — their elected
  // initiator — to rebuild it with a fresh offer. Debounced: their retry loop
  // may nudge several times while we renegotiate. Only honoured when the
  // deterministic election really makes us the initiator: otherwise a
  // misbehaving peer could tear a healthy pair down into offer-glare (two
  // initiators) every few seconds.
  onRestartRequest(from: string) {
    if (!this.cb.isMeshMember(from)) return;
    if (!isInitiator(this.cb.getMyId(), from)) return;
    const now = performance.now();
    const last = this.restartHandledAt.get(from);
    if (last != null && now - last < RTC_RESTART_DEBOUNCE_MS) return;
    this.restartHandledAt.set(from, now);
    logNet('rtc-restart-received', { peer: from });
    this.cb.closePeer(from);
    this.createPeer(from, true);
  }

  // The recovery pump, run every simulation step: fires due rebuilds, tears
  // down peers stuck in 'disconnected' or stalled short of 'connect'. Teardowns
  // land back in onPeerClosed via the transport, bumping the backoff.
  tick(now: number) {
    for (const [userId, at] of this.retryAt) {
      if (now < at) continue;
      this.retryAt.delete(userId);
      if (!this.cb.isMeshMember(userId)) continue;
      if (this.cb.hasPeer(userId)) continue;
      const initiator = isInitiator(this.cb.getMyId(), userId);
      logNet('mesh-retry', { peer: userId, initiator });
      this.createPeer(userId, initiator);
      // Only the elected initiator can send the fresh offer; the other side
      // nudges it (rtc-restart) in case it hasn't noticed the pair is dead.
      if (!initiator) this.cb.sendRestart(userId);
    }
    for (const [userId, since] of this.disconnectedSince) {
      if (now - since < PEER_DISCONNECTED_TIMEOUT_MS) continue;
      this.disconnectedSince.delete(userId);
      logNet('mesh-disconnected-timeout', { peer: userId });
      this.cb.closePeer(userId);
    }
    for (const [userId, at] of this.stallAt) {
      if (now < at) continue;
      this.stallAt.delete(userId);
      if (!this.cb.hasPeer(userId) || this.cb.isPeerReady(userId)) continue;
      logNet('mesh-connect-stall', { peer: userId });
      this.cb.closePeer(userId);
    }
  }

  // Drop every per-peer recovery record for peers outside `keep` (or all).
  clear(keep?: Set<string>) {
    for (const map of [
      this.retryAt,
      this.retryAttempts,
      this.stallAt,
      this.disconnectedSince,
      this.restartHandledAt,
    ]) {
      for (const id of [...map.keys()]) {
        if (!keep?.has(id)) map.delete(id);
      }
    }
  }
}
