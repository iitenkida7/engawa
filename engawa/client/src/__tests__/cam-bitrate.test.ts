import { describe, expect, it } from 'bun:test';
import {
  CAM_BITRATE_QUIET,
  CAM_BITRATE_SPEAKING,
  CAM_FPS,
  CAM_SCALE_QUIET,
  CAM_SCALE_SPEAKING,
  CAM_THROTTLE_MIN_PEERS,
  computeCamEncoding,
  computePreferredRid,
  computePreferredRidHysteretic,
  computeScreenEncoding,
  computeScreenScale,
  computeSfuCamRid,
  initialSfuCamRid,
  isHeldSpeaking,
  SCREEN_BITRATE_HIGH,
  SCREEN_BITRATE_THROTTLED,
  SCREEN_CAPTURE_CONSTRAINTS,
  SCREEN_FPS_DEFAULT,
  SCREEN_FPS_LARGE,
  SCREEN_LARGE_MIN_PEERS,
  SCREEN_LONG_EDGE_DEFAULT,
  SCREEN_LONG_EDGE_LARGE,
  SFU_CAM_DEFAULT_RID,
  SFU_CAM_FULL_BITRATE,
  SFU_CAM_HALF_RID,
  SFU_CAM_LAYERS,
  SFU_CAM_QUARTER_RID,
  SFU_SCREEN_MAX_BITRATE,
  SFU_SCREEN_MAX_FRAMERATE,
  SFU_SCREEN_MAX_LONG_EDGE,
  SIMULCAST_FULL_MIN_WIDTH,
  SIMULCAST_HALF_MIN_WIDTH,
  SIMULCAST_HYSTERESIS_PX,
  SPEAKER_HOLD_MS,
  sfuCamSimulcast,
} from '@/rtc/cam-bitrate';

describe('computeCamEncoding', () => {
  const HIGH = {
    maxBitrate: CAM_BITRATE_SPEAKING,
    maxFramerate: CAM_FPS,
    scaleResolutionDownBy: CAM_SCALE_SPEAKING,
  };
  const QUIET = {
    maxBitrate: CAM_BITRATE_QUIET,
    maxFramerate: CAM_FPS,
    scaleResolutionDownBy: CAM_SCALE_QUIET,
  };

  it('keeps the high encoding in small groups regardless of speaking', () => {
    // At or below the threshold the throttle never kicks in.
    for (let n = 0; n < CAM_THROTTLE_MIN_PEERS; n++) {
      expect(computeCamEncoding(n, false)).toEqual(HIGH);
      expect(computeCamEncoding(n, true)).toEqual(HIGH);
    }
  });

  it('throttles non-speakers (bitrate + resolution) once the group is large', () => {
    expect(computeCamEncoding(CAM_THROTTLE_MIN_PEERS, false)).toEqual(QUIET);
    expect(computeCamEncoding(19, false)).toEqual(QUIET);
  });

  it('gives a large-group speaker the high bitrate but keeps the half resolution', () => {
    // Issue #311: resolution follows the (rarely-changing) peer count only, so
    // toggling speech never flips scaleResolutionDownBy (which would black out
    // the receiver until the next keyframe). A big-group speaker gets the high
    // bitrate at half resolution.
    const SPEAKING_BIG = {
      maxBitrate: CAM_BITRATE_SPEAKING,
      maxFramerate: CAM_FPS,
      scaleResolutionDownBy: CAM_SCALE_QUIET,
    };
    expect(computeCamEncoding(CAM_THROTTLE_MIN_PEERS, true)).toEqual(SPEAKING_BIG);
    expect(computeCamEncoding(19, true)).toEqual(SPEAKING_BIG);
  });

  it('never changes resolution on a speaker toggle within the same group size', () => {
    // The whole point of #311: only bitrate may differ between speaking and
    // quiet; the resolution must be identical so no keyframe-blackout occurs.
    for (const n of [0, 2, CAM_THROTTLE_MIN_PEERS, 5, 19]) {
      expect(computeCamEncoding(n, true).scaleResolutionDownBy).toBe(
        computeCamEncoding(n, false).scaleResolutionDownBy,
      );
    }
  });

  it('the quiet encoding is meaningfully lighter than the speaking one', () => {
    expect(CAM_BITRATE_QUIET).toBeLessThan(CAM_BITRATE_SPEAKING);
    expect(CAM_SCALE_QUIET).toBeGreaterThan(CAM_SCALE_SPEAKING);
  });
});

describe('computeScreenEncoding', () => {
  it('keeps full bitrate / fps / FHD in small groups', () => {
    for (let n = 0; n < CAM_THROTTLE_MIN_PEERS; n++) {
      expect(computeScreenEncoding(n)).toEqual({
        maxBitrate: SCREEN_BITRATE_HIGH,
        maxFramerate: SCREEN_FPS_DEFAULT,
        maxLongEdge: SCREEN_LONG_EDGE_DEFAULT,
      });
    }
  });

  it('throttles only the bitrate in mid-size groups (keeps FHD/full fps for text)', () => {
    for (let n = CAM_THROTTLE_MIN_PEERS; n < SCREEN_LARGE_MIN_PEERS; n++) {
      expect(computeScreenEncoding(n)).toEqual({
        maxBitrate: SCREEN_BITRATE_THROTTLED,
        maxFramerate: SCREEN_FPS_DEFAULT,
        maxLongEdge: SCREEN_LONG_EDGE_DEFAULT,
      });
    }
  });

  it('also drops fps and resolution in large clusters (per-frame encode cut)', () => {
    expect(computeScreenEncoding(SCREEN_LARGE_MIN_PEERS)).toEqual({
      maxBitrate: SCREEN_BITRATE_THROTTLED,
      maxFramerate: SCREEN_FPS_LARGE,
      maxLongEdge: SCREEN_LONG_EDGE_LARGE,
    });
    expect(computeScreenEncoding(20).maxLongEdge).toBe(SCREEN_LONG_EDGE_LARGE);
  });

  it('the large-cluster ceilings are strictly lower (more aggressive)', () => {
    expect(SCREEN_BITRATE_THROTTLED).toBeLessThan(SCREEN_BITRATE_HIGH);
    expect(SCREEN_FPS_LARGE).toBeLessThan(SCREEN_FPS_DEFAULT);
    expect(SCREEN_LONG_EDGE_LARGE).toBeLessThan(SCREEN_LONG_EDGE_DEFAULT);
  });
});

describe('computeScreenScale', () => {
  it('does not scale a source already within the cap', () => {
    // 16:9 1080p monitor: longest edge 1920 == FHD cap → no downscale.
    expect(computeScreenScale(1920, 1080, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
    // 720p is well within the FHD cap.
    expect(computeScreenScale(1280, 720, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
  });

  it('scales an ultrawide source down to the FHD long edge', () => {
    // 3420 wide → 3420 / 1920 ≈ 1.781 (encoded ~1920×649).
    expect(computeScreenScale(3420, 1156, SCREEN_LONG_EDGE_DEFAULT)).toBeCloseTo(
      3420 / SCREEN_LONG_EDGE_DEFAULT,
      5,
    );
  });

  it('scales a 4K source to exactly half against the FHD cap', () => {
    expect(computeScreenScale(3840, 2160, SCREEN_LONG_EDGE_DEFAULT)).toBe(2);
  });

  it('uses the longer edge regardless of orientation', () => {
    expect(computeScreenScale(1156, 3420, SCREEN_LONG_EDGE_DEFAULT)).toBeCloseTo(
      3420 / SCREEN_LONG_EDGE_DEFAULT,
      5,
    );
  });

  it('never upscales and is safe for an unknown (0) source size', () => {
    expect(computeScreenScale(640, 480, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
    expect(computeScreenScale(0, 0, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
    expect(computeScreenScale(0, 1080, SCREEN_LONG_EDGE_DEFAULT)).toBe(1);
  });

  it('downscales harder against the 720p (large-cluster) cap', () => {
    // 1080p monitor against the 720p cap scales by 1.5 → 1280×720.
    expect(computeScreenScale(1920, 1080, SCREEN_LONG_EDGE_LARGE)).toBeCloseTo(1.5, 5);
    // An FHD-capped share is already small; the 720p cap still bites.
    expect(computeScreenScale(1920, 649, SCREEN_LONG_EDGE_LARGE)).toBeCloseTo(1.5, 5);
  });
});

describe('isHeldSpeaking', () => {
  it('is true whenever the mic is loud now', () => {
    expect(isHeldSpeaking(true, null, 1000)).toBe(true);
    expect(isHeldSpeaking(true, 0, 1_000_000)).toBe(true);
  });

  it('is false when never loud yet (e.g. mic off / just joined)', () => {
    // null lastLoudAtMs is the safe default: counts as a quiet peer.
    expect(isHeldSpeaking(false, null, 1000)).toBe(false);
  });

  it('holds the speaking state for the hold window after speech stops', () => {
    const lastLoud = 1000;
    // Just after stopping: still within the hold → speaking.
    expect(isHeldSpeaking(false, lastLoud, lastLoud + 1)).toBe(true);
    expect(isHeldSpeaking(false, lastLoud, lastLoud + SPEAKER_HOLD_MS - 1)).toBe(true);
  });

  it('drops the speaking state once the hold window elapses', () => {
    const lastLoud = 1000;
    // Exactly at the boundary is no longer held (strict less-than).
    expect(isHeldSpeaking(false, lastLoud, lastLoud + SPEAKER_HOLD_MS)).toBe(false);
    expect(isHeldSpeaking(false, lastLoud, lastLoud + SPEAKER_HOLD_MS + 5000)).toBe(false);
  });

  it('respects a custom hold duration', () => {
    expect(isHeldSpeaking(false, 0, 500, 1000)).toBe(true);
    expect(isHeldSpeaking(false, 0, 1500, 1000)).toBe(false);
  });
});

describe('computePreferredRid (SFU simulcast layer selection)', () => {
  it('requests the full layer at or above the tile-width threshold', () => {
    expect(computePreferredRid(SIMULCAST_FULL_MIN_WIDTH)).toBe('f');
    expect(computePreferredRid(SIMULCAST_FULL_MIN_WIDTH + 200)).toBe('f');
    // A maximized window / a 2-person gallery on a 1920 screen.
    expect(computePreferredRid(900)).toBe('f');
  });

  it('requests the half layer for ordinary gallery cells (#314)', () => {
    expect(computePreferredRid(SIMULCAST_FULL_MIN_WIDTH - 1)).toBe('h');
    expect(computePreferredRid(SIMULCAST_HALF_MIN_WIDTH)).toBe('h');
    // A 3-column gallery cell on a 1920 screen (~600px) no longer pulls full.
    expect(computePreferredRid(600)).toBe('h');
    expect(computePreferredRid(400)).toBe('h');
  });

  it('requests the quarter layer for thumbnails and dense galleries', () => {
    expect(computePreferredRid(SIMULCAST_HALF_MIN_WIDTH - 1)).toBe('q');
    expect(computePreferredRid(280)).toBe('q');
    expect(computePreferredRid(148)).toBe('q');
    expect(computePreferredRid(0)).toBe('q');
  });
});

describe('computePreferredRidHysteretic (issue #311)', () => {
  it('matches the plain thresholds when not already on the neighbouring layer', () => {
    // Stepping UP: coming from a lower layer needs width past threshold+margin.
    expect(computePreferredRidHysteretic(SIMULCAST_FULL_MIN_WIDTH, 'h')).toBe('h');
    expect(
      computePreferredRidHysteretic(SIMULCAST_FULL_MIN_WIDTH + SIMULCAST_HYSTERESIS_PX, 'h'),
    ).toBe('f');
    expect(computePreferredRidHysteretic(SIMULCAST_HALF_MIN_WIDTH, 'q')).toBe('q');
    expect(
      computePreferredRidHysteretic(SIMULCAST_HALF_MIN_WIDTH + SIMULCAST_HYSTERESIS_PX, 'q'),
    ).toBe('h');
  });

  it('sticks to the current layer across the raw threshold (no flapping)', () => {
    // On full now: stay full until width drops a full margin below the threshold.
    expect(computePreferredRidHysteretic(SIMULCAST_FULL_MIN_WIDTH - 1, 'f')).toBe('f');
    expect(
      computePreferredRidHysteretic(SIMULCAST_FULL_MIN_WIDTH - SIMULCAST_HYSTERESIS_PX, 'f'),
    ).toBe('f');
    expect(
      computePreferredRidHysteretic(SIMULCAST_FULL_MIN_WIDTH - SIMULCAST_HYSTERESIS_PX - 1, 'f'),
    ).toBe('h');
    // On half now: stay half until width drops a margin below the half threshold.
    expect(computePreferredRidHysteretic(SIMULCAST_HALF_MIN_WIDTH - 1, 'h')).toBe('h');
    expect(
      computePreferredRidHysteretic(SIMULCAST_HALF_MIN_WIDTH - SIMULCAST_HYSTERESIS_PX - 1, 'h'),
    ).toBe('q');
  });

  it('is stable: re-feeding its own output at a boundary never oscillates', () => {
    // A tile parked exactly on the full threshold: once it settles on a layer it
    // stays there when we feed that layer back in (the flapping #311 fixes).
    const w = SIMULCAST_FULL_MIN_WIDTH;
    let rid = computePreferredRidHysteretic(w, 'f');
    expect(rid).toBe('f');
    rid = computePreferredRidHysteretic(w, rid);
    expect(rid).toBe('f');
  });
});

describe('computeSfuCamRid (issue #269)', () => {
  const visible = { pageHidden: false, congested: false };

  it('follows the tile width while the tab is visible and the downlink is fine', () => {
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH, visible)).toBe('f');
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH - 1, visible)).toBe('h');
  });

  it('drops an off-screen (zero-width) tile to the quarter layer', () => {
    expect(computeSfuCamRid(0, visible)).toBe('q');
  });

  it('drops every camera to the quarter layer in a hidden tab', () => {
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH, { pageHidden: true, congested: false })).toBe(
      'q',
    );
  });

  it('caps every camera at the half layer on a congested downlink', () => {
    const congested = { pageHidden: false, congested: true };
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH, congested)).toBe('h');
    expect(computeSfuCamRid(148, congested)).toBe('q');
  });

  it('uses the plain threshold on first selection (no current layer) — issue #311', () => {
    // Without a currentRid there is nothing to be sticky about.
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH - 1, visible)).toBe('h');
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH, visible)).toBe('f');
  });

  it('sticks to the current layer across the raw threshold once one is set — issue #311', () => {
    // On full now, a width just below the threshold stays full (no flap/blackout).
    expect(computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH - 1, { ...visible, currentRid: 'f' })).toBe(
      'f',
    );
    // Only once it clears the far edge of the band does it step down.
    expect(
      computeSfuCamRid(SIMULCAST_FULL_MIN_WIDTH - SIMULCAST_HYSTERESIS_PX - 1, {
        ...visible,
        currentRid: 'f',
      }),
    ).toBe('h');
  });
});

describe('sfuCamSimulcast (issue #269)', () => {
  it('lets the SFU step down by rid order and keeps the preferred rid', () => {
    expect(sfuCamSimulcast('h')).toEqual({
      preferredRid: 'h',
      priorityOrdering: 'asciibetical',
      ridNotAvailable: 'asciibetical',
    });
  });

  it('orders the ladder rids asciibetically from best to worst quality', () => {
    // Cloudflare's asciibetical policy treats the alphabetically-first rid as
    // the most desirable, so the ladder (best first) must already be sorted.
    const rids = SFU_CAM_LAYERS.map((l) => l.rid);
    expect([...rids].sort()).toEqual(rids);
  });
});

describe('SFU_CAM_LAYERS (simulcast ladder)', () => {
  it('has unique rids and strictly descending resolution', () => {
    const rids = SFU_CAM_LAYERS.map((l) => l.rid);
    expect(new Set(rids).size).toBe(rids.length);
    for (let i = 1; i < SFU_CAM_LAYERS.length; i++) {
      expect(SFU_CAM_LAYERS[i].scaleResolutionDownBy).toBeGreaterThan(
        SFU_CAM_LAYERS[i - 1].scaleResolutionDownBy,
      );
    }
  });

  it('keeps the full layer at the capture resolution but under the mesh ceiling (#314)', () => {
    const full = SFU_CAM_LAYERS.find((l) => l.rid === 'f');
    expect(full?.scaleResolutionDownBy).toBe(1);
    expect(full?.maxBitrate).toBe(SFU_CAM_FULL_BITRATE);
    expect(full?.maxBitrate).toBeLessThan(CAM_BITRATE_SPEAKING);
    expect(full?.maxFramerate).toBe(CAM_FPS);
  });

  it('keeps the screen share ceiling between the mesh throttled and high tiers (#324)', () => {
    expect(SFU_SCREEN_MAX_BITRATE).toBe(2_000_000);
    expect(SFU_SCREEN_MAX_BITRATE).toBeGreaterThan(SCREEN_BITRATE_THROTTLED);
    expect(SFU_SCREEN_MAX_BITRATE).toBeLessThan(SCREEN_BITRATE_HIGH);
  });

  it('caps the SFU screen share like the mesh small group (#324)', () => {
    const mesh = computeScreenEncoding(1);
    expect(SFU_SCREEN_MAX_FRAMERATE).toBe(mesh.maxFramerate);
    expect(SFU_SCREEN_MAX_LONG_EDGE).toBe(mesh.maxLongEdge);
  });

  it('contains every rid computePreferredRid can return', () => {
    const rids = SFU_CAM_LAYERS.map((l) => l.rid);
    expect(rids).toContain(SFU_CAM_DEFAULT_RID);
    expect(rids).toContain(SFU_CAM_HALF_RID);
    expect(rids).toContain(SFU_CAM_QUARTER_RID);
  });

  it('runs every camera layer at the camera capture rate', () => {
    for (const layer of SFU_CAM_LAYERS) {
      expect(layer.maxFramerate).toBe(CAM_FPS);
    }
  });

  it('steps bitrate down with each smaller layer', () => {
    for (let i = 1; i < SFU_CAM_LAYERS.length; i++) {
      expect(SFU_CAM_LAYERS[i].maxBitrate).toBeLessThan(SFU_CAM_LAYERS[i - 1].maxBitrate);
    }
  });
});

describe('initialSfuCamRid', () => {
  it('starts camera pulls on the quarter layer in a meeting room', () => {
    expect(initialSfuCamRid(true)).toBe(SFU_CAM_QUARTER_RID);
  });

  it('starts on the full layer everywhere else', () => {
    expect(initialSfuCamRid(false)).toBe(SFU_CAM_DEFAULT_RID);
  });
});

describe('SCREEN_CAPTURE_CONSTRAINTS', () => {
  const c = SCREEN_CAPTURE_CONSTRAINTS as {
    width: { max: number };
    height: { max: number };
    frameRate: { max: number };
  };

  it('caps both edges at the long-edge limit so any aspect ratio fits', () => {
    expect(c.width.max).toBe(SCREEN_LONG_EDGE_DEFAULT);
    expect(c.height.max).toBe(SCREEN_LONG_EDGE_DEFAULT);
  });

  it('never captures less than any send tier encodes', () => {
    for (const peers of [1, 3, 8, 20]) {
      const enc = computeScreenEncoding(peers);
      expect(c.frameRate.max).toBeGreaterThanOrEqual(enc.maxFramerate);
      expect(c.width.max).toBeGreaterThanOrEqual(enc.maxLongEdge);
    }
    expect(c.frameRate.max).toBeGreaterThanOrEqual(SFU_SCREEN_MAX_FRAMERATE);
    expect(c.width.max).toBeGreaterThanOrEqual(SFU_SCREEN_MAX_LONG_EDGE);
  });
});
