// Network-tier classification and the audio-first degradation ladder (issue
// #185). Pure: the App samples QualitySample every 5s (netlog cadence), folds
// it through updateTierState (hysteresis so one bad sample doesn't flap the
// picture), and applies the tier to the existing cam/screen send ceilings.
//
// Policy: voice is the last thing to give. Under pressure the ladder sheds, in
// order, video bitrate → resolution/framerate → the camera itself (the App
// auto-pauses it at tier 3 and auto-resumes on recovery). The mic ceiling is
// never touched here — mesh senders already carry priority 'high' so the
// browser starves video first within each connection; this ladder is what
// protects audio ACROSS connections, which no per-PC priority can do (each
// mesh peer is its own PeerConnection with its own congestion controller).

import type { CamEncoding, ScreenEncoding } from '@/rtc/cam-bitrate';
import type { QualitySample } from '@/rtc/rtcstats';

// 0 = good, 1 = fair (mild pressure), 2 = poor (real congestion), 3 = bad
// (voice at risk — video must go).
export type NetTier = 0 | 1 | 2 | 3;

// Loss / RTT thresholds per tier. Loss is the primary signal (it is what makes
// audio break up); RTT catches bufferbloat before loss shows. Values are the
// worst across connections (one bad link is what the user hears).
const LOSS_TIER_PCT = [2, 5, 10] as const; // ≥ → tier 1 / 2 / 3
const RTT_TIER_MS = [250, 500, 800] as const;

// Uplink-estimate thresholds (kbps, min across connections). Below ~250kbps
// even audio + a floor-quality video don't fit; GCC's estimate reacts faster
// than loss reaches the remote-inbound reports.
const AVAIL_TIER_KBPS = [900, 500, 250] as const; // < → tier 1 / 2 / 3

// Pure: the tier one sample classifies to, taking the worst of the signals.
export function classifySample(s: QualitySample): NetTier {
  const loss = Math.max(s.sendLossPct ?? 0, s.recvLossPct ?? 0);
  const rtt = s.rttMs ?? 0;
  let tier = 0;
  for (let i = 0; i < 3; i++) {
    if (loss >= LOSS_TIER_PCT[i] || rtt >= RTT_TIER_MS[i]) tier = i + 1;
  }
  if (s.availableOutgoingKbps !== undefined) {
    for (let i = 0; i < 3; i++) {
      if (s.availableOutgoingKbps < AVAIL_TIER_KBPS[i]) tier = Math.max(tier, i + 1);
    }
  }
  return tier as NetTier;
}

// Hysteresis: downgrade after 2 consecutive worse samples (~10s — fast, the
// user is already suffering), upgrade one step only after 6 consecutive better
// samples (~30s — climbing back too eagerly re-congests the link and pulses
// the picture).
export const TIER_DOWNGRADE_SAMPLES = 2;
export const TIER_UPGRADE_SAMPLES = 6;

export type TierState = {
  tier: NetTier;
  // Consecutive samples classifying worse / better than the current tier.
  worse: number;
  better: number;
};

export const INITIAL_TIER_STATE: TierState = { tier: 0, worse: 0, better: 0 };

// Pure: fold one classified sample into the tier state machine.
export function updateTierState(state: TierState, sample: NetTier): TierState {
  if (sample > state.tier) {
    const worse = state.worse + 1;
    if (worse >= TIER_DOWNGRADE_SAMPLES) return { tier: sample, worse: 0, better: 0 };
    return { tier: state.tier, worse, better: 0 };
  }
  if (sample < state.tier) {
    const better = state.better + 1;
    if (better >= TIER_UPGRADE_SAMPLES) {
      return { tier: (state.tier - 1) as NetTier, worse: 0, better: 0 };
    }
    return { tier: state.tier, worse: 0, better };
  }
  return { tier: state.tier, worse: 0, better: 0 };
}

// ─── Applying the tier to the send ceilings ────────────────────────────────
// These wrap the existing peer-count/speaker policies (cam-bitrate.ts): the
// base ceiling is computed as before, then shrunk by the network tier. Only
// ever tightens — a bad network must never raise a ceiling the group policy
// lowered.

// Camera floor while tier 3 is (briefly) still sending, before the App's
// auto-pause lands: barely-moving thumbnail, but voice keeps its headroom.
const CAM_TIER3: CamEncoding = { maxBitrate: 80_000, maxFramerate: 8, scaleResolutionDownBy: 2 };

export function applyNetTierToCam(base: CamEncoding, tier: NetTier): CamEncoding {
  switch (tier) {
    case 0:
      return base;
    case 1:
      return { ...base, maxBitrate: Math.round(base.maxBitrate * 0.6) };
    case 2:
      return {
        maxBitrate: Math.min(base.maxBitrate, 120_000),
        maxFramerate: Math.min(base.maxFramerate, 15),
        scaleResolutionDownBy: Math.max(base.scaleResolutionDownBy, 2),
      };
    case 3:
      return {
        maxBitrate: Math.min(base.maxBitrate, CAM_TIER3.maxBitrate),
        maxFramerate: Math.min(base.maxFramerate, CAM_TIER3.maxFramerate),
        scaleResolutionDownBy: Math.max(
          base.scaleResolutionDownBy,
          CAM_TIER3.scaleResolutionDownBy,
        ),
      };
  }
}

export function applyNetTierToScreen(base: ScreenEncoding, tier: NetTier): ScreenEncoding {
  switch (tier) {
    case 0:
      return base;
    case 1:
      return { ...base, maxBitrate: Math.round(base.maxBitrate * 0.7) };
    case 2:
      return {
        maxBitrate: Math.min(base.maxBitrate, 800_000),
        maxFramerate: Math.min(base.maxFramerate, 8),
        maxLongEdge: Math.min(base.maxLongEdge, 1280),
      };
    case 3:
      return {
        maxBitrate: Math.min(base.maxBitrate, 500_000),
        maxFramerate: Math.min(base.maxFramerate, 5),
        maxLongEdge: Math.min(base.maxLongEdge, 1280),
      };
  }
}
