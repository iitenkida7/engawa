import { beforeEach, describe, expect, it } from 'bun:test';
import { t } from '@/core/i18n';
import type { MediaManager } from '@/media/media';
import type { RecorderManager } from '@/media/recorder';
import { RemoteMediaView } from '@/ui/remote-media';
import {
  classifyStall,
  INITIAL_STALL_STATE,
  LAYER_SWITCH_WINDOW_MS,
  STALL_ATTACH_GRACE_MS,
  STALL_CLEAR_MS,
  STALL_MS,
  updateStallState,
} from '@/ui/video-stall';
import type { PlayerState } from '@/world/player';

// Why a camera tile went dark (issue #312): the pure classifier, then the view
// wiring that turns track mute events / missing frames into the overlay label
// and the placeholder note.

describe('classifyStall', () => {
  it('is quiet while frames keep coming', () => {
    expect(classifyStall({ stalledMs: STALL_MS - 1, sinceLayerSwitchMs: null, myTier: 3 })).toBe(
      null,
    );
    // No frame clock at all (-Infinity): only a muted track can flag a stall.
    expect(
      classifyStall({ stalledMs: Number.NEGATIVE_INFINITY, sinceLayerSwitchMs: null, myTier: 3 }),
    ).toBe(null);
  });

  it('blames a recent layer request first', () => {
    expect(
      classifyStall({
        stalledMs: STALL_MS,
        sinceLayerSwitchMs: LAYER_SWITCH_WINDOW_MS - 1,
        myTier: 3,
      }),
    ).toBe('layer-switch');
    expect(
      classifyStall({ stalledMs: STALL_MS, sinceLayerSwitchMs: LAYER_SWITCH_WINDOW_MS, myTier: 0 }),
    ).toBe('peer-network');
  });

  it('blames our own link at tier ≥2, otherwise the peer', () => {
    expect(classifyStall({ stalledMs: STALL_MS, sinceLayerSwitchMs: null, myTier: 2 })).toBe(
      'my-network',
    );
    expect(classifyStall({ stalledMs: STALL_MS, sinceLayerSwitchMs: null, myTier: 1 })).toBe(
      'peer-network',
    );
    // A muted track reads as stalled forever.
    expect(
      classifyStall({ stalledMs: Number.POSITIVE_INFINITY, sinceLayerSwitchMs: null, myTier: 0 }),
    ).toBe('peer-network');
  });
});

describe('updateStallState', () => {
  it('shows the first reason of a stall and stays quiet while frames flow', () => {
    expect(updateStallState(INITIAL_STALL_STATE, null, 1000)).toEqual(INITIAL_STALL_STATE);
    expect(updateStallState(INITIAL_STALL_STATE, 'peer-network', 1000)).toEqual({
      reason: 'peer-network',
      clearingSince: null,
    });
  });

  it('latches the reason so the label does not swap mid-stall', () => {
    const shown = updateStallState(INITIAL_STALL_STATE, 'peer-network', 1000);
    // Our tier crossing 2 would otherwise rewrite the text under the reader.
    expect(updateStallState(shown, 'my-network', 1500).reason).toBe('peer-network');
  });

  it('escalates away from a layer switch that outlived its window', () => {
    const shown = updateStallState(INITIAL_STALL_STATE, 'layer-switch', 1000);
    expect(updateStallState(shown, 'peer-network', 6000).reason).toBe('peer-network');
  });

  it('keeps the label until frames have been back for STALL_CLEAR_MS', () => {
    const shown = updateStallState(INITIAL_STALL_STATE, 'peer-network', 1000);
    // One stray frame starts the recovery clock but changes nothing on screen.
    const clearing = updateStallState(shown, null, 2000);
    expect(clearing).toEqual({ reason: 'peer-network', clearingSince: 2000 });
    expect(updateStallState(clearing, null, 2000 + STALL_CLEAR_MS - 1).reason).toBe('peer-network');
    expect(updateStallState(clearing, null, 2000 + STALL_CLEAR_MS)).toEqual(INITIAL_STALL_STATE);
  });

  it('restarts the recovery clock when the video stalls again', () => {
    const clearing = { reason: 'peer-network' as const, clearingSince: 2000 };
    const again = updateStallState(clearing, 'peer-network', 2500);
    expect(again).toEqual({ reason: 'peer-network', clearingSince: null });
    // The hold is measured from the new recovery, not the abandoned one.
    const reclearing = updateStallState(again, null, 3000);
    expect(updateStallState(reclearing, null, 3000 + STALL_CLEAR_MS - 1).reason).toBe(
      'peer-network',
    );
  });
});

// ─── View wiring ────────────────────────────────────────────────────────────

const MY_ID = 'me';

function mountDom() {
  document.body.innerHTML = `
    <div id="app">
      <div id="remote-videos"></div>
      <button id="filmstrip-toggle" type="button" style="display: none"></button>
      <div id="filmstrip-resizer" style="display: none"></div>
      <button id="meeting-minimize" type="button" style="display: none"></button>
      <div id="self-preview" class="panel hidden">
        <div class="panel-header"><span class="label" id="self-preview-label"></span></div>
        <div class="panel-body"><video id="self-video"></video><div class="no-video" id="self-no-video"><span class="no-video-initials" id="self-no-video-initials"></span><span class="no-video-name" id="self-no-video-name"></span></div></div>
      </div>
    </div>`;
}

function player(userId: string, name: string): PlayerState {
  return {
    userId,
    name,
    isVideoOn: false,
    camAutoOff: false,
    initials: () => name.slice(0, 2).toUpperCase(),
  } as unknown as PlayerState;
}

// A real MediaStream (happy-dom checks srcObject's type) whose single video
// track is a fake the test can mute.
function makeCamStream(id: string) {
  const track = new EventTarget() as MediaStreamTrack & { muted: boolean };
  Object.assign(track, { kind: 'video', id: `${id}-trk`, muted: false });
  const stream = new MediaStream();
  Object.defineProperties(stream, {
    id: { value: id },
    getVideoTracks: { value: () => [track] },
    getAudioTracks: { value: () => [] },
    getTracks: { value: () => [track] },
  });
  const setMuted = (muted: boolean) => {
    track.muted = muted;
    track.dispatchEvent(new Event(muted ? 'mute' : 'unmute'));
  };
  return { stream, setMuted };
}

type FrameCb = () => void;
// happy-dom has no requestVideoFrameCallback: install one that hands the
// callback back to the test so it can "render" frames on demand.
function installFrameCallback() {
  const cbs = new Map<number, FrameCb>();
  let next = 1;
  const proto = HTMLVideoElement.prototype as unknown as Record<string, unknown>;
  proto.requestVideoFrameCallback = (cb: FrameCb) => {
    const h = next++;
    cbs.set(h, cb);
    return h;
  };
  proto.cancelVideoFrameCallback = (h: number) => {
    cbs.delete(h);
  };
  return {
    // Fire every pending callback once (one rendered frame).
    frame: () => {
      const pending = [...cbs.values()];
      cbs.clear();
      for (const cb of pending) cb();
    },
    pending: () => cbs.size,
    uninstall: () => {
      delete proto.requestVideoFrameCallback;
      delete proto.cancelVideoFrameCallback;
    },
  };
}

function setup() {
  mountDom();
  const players = new Map<string, PlayerState>();
  players.set(MY_ID, player(MY_ID, 'Me'));
  const view = new RemoteMediaView({
    players,
    media: { micOn: true, camStream: null } as unknown as MediaManager,
    recorder: {
      recording: false,
      addAudioStream: () => {},
      removeAudioStream: () => {},
    } as unknown as RecorderManager,
    getMyId: () => MY_ID,
    onAutoplayBlocked: () => {},
    onAutoplayUnlocked: () => {},
  });
  return { view, players };
}

const tileOf = (userId: string) =>
  document.querySelector<HTMLElement>(`.remote-tile[data-user-id="${userId}"]`)!;
const stallLabel = (userId: string) =>
  tileOf(userId).querySelector<HTMLElement>('.panel-body')!.dataset.stallLabel;
const reasonOf = (userId: string) =>
  tileOf(userId).querySelector<HTMLElement>('.no-video-reason')!.textContent;

describe('RemoteMediaView stall overlay (issue #312)', () => {
  let view: RemoteMediaView;
  let players: Map<string, PlayerState>;

  beforeEach(() => {
    ({ view, players } = setup());
    players.set('a', player('a', 'Alice'));
  });

  it('labels a muted track as the peer not delivering, and clears on unmute', () => {
    const { stream, setMuted } = makeCamStream('cam-a');
    view.attachRemoteStream('a', stream, 'cam');
    const now = performance.now();
    view.tickStalls(now, 0);
    expect(tileOf('a').classList.contains('stalled')).toBe(false);

    setMuted(true);
    view.tickStalls(now + 100, 0);
    expect(tileOf('a').classList.contains('stalled')).toBe(true);
    expect(stallLabel('a')).toBe(t('media.stall.peer-network'));

    // Unmuting does not drop the overlay straight away: frames have to keep
    // coming for STALL_CLEAR_MS, or a flapping track blinks the label.
    setMuted(false);
    view.tickStalls(now + 200, 0);
    expect(tileOf('a').classList.contains('stalled')).toBe(true);
    view.tickStalls(now + 200 + STALL_CLEAR_MS, 0);
    expect(tileOf('a').classList.contains('stalled')).toBe(false);
    expect(stallLabel('a')).toBe('');
  });

  it('blames our own link when our tier is poor', () => {
    const { stream, setMuted } = makeCamStream('cam-a');
    view.attachRemoteStream('a', stream, 'cam');
    setMuted(true);
    view.tickStalls(performance.now(), 2);
    expect(stallLabel('a')).toBe(t('media.stall.my-network'));
  });

  it('blames a layer switch we just requested', () => {
    const { stream, setMuted } = makeCamStream('cam-a');
    view.attachRemoteStream('a', stream, 'cam');
    view.noteLayerSwitch('a');
    setMuted(true);
    view.tickStalls(performance.now() + 10, 0);
    expect(stallLabel('a')).toBe(t('media.stall.layer-switch'));
  });

  it('detects missing frames through the frame callback, with an attach grace', () => {
    const frames = installFrameCallback();
    try {
      const { stream } = makeCamStream('cam-a');
      const t0 = performance.now();
      view.attachRemoteStream('a', stream, 'cam');
      expect(frames.pending()).toBe(1);

      // No frame yet, but still within the attach grace: not a stall.
      view.tickStalls(t0 + STALL_MS + 1, 0);
      expect(tileOf('a').classList.contains('stalled')).toBe(false);
      // Past the grace with still no frame: stalled.
      view.tickStalls(t0 + STALL_ATTACH_GRACE_MS + STALL_MS + 1, 0);
      expect(tileOf('a').classList.contains('stalled')).toBe(true);

      // A rendered frame re-arms the callback, but a single frame is not a
      // recovery: the label waits out STALL_CLEAR_MS of steady frames.
      frames.frame();
      expect(frames.pending()).toBe(1);
      // (frames.frame() stamps the real clock, so tick from there too.)
      const back = performance.now();
      view.tickStalls(back, 0);
      expect(tileOf('a').classList.contains('stalled')).toBe(true);
      frames.frame();
      view.tickStalls(back + STALL_CLEAR_MS, 0);
      expect(tileOf('a').classList.contains('stalled')).toBe(false);

      // Detaching the camera stops watching and drops the overlay.
      view.setConversationMembers(['a']);
      view.detachRemoteStream('a', 'cam-a');
      frames.frame();
      expect(frames.pending()).toBe(0);
      expect(tileOf('a').classList.contains('stalled')).toBe(false);
    } finally {
      frames.uninstall();
    }
  });

  it('keeps the overlay off while the tab is hidden', () => {
    const { stream, setMuted } = makeCamStream('cam-a');
    view.attachRemoteStream('a', stream, 'cam');
    setMuted(true);
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    try {
      view.tickStalls(performance.now(), 0);
      expect(tileOf('a').classList.contains('stalled')).toBe(false);
    } finally {
      Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    }
  });
});

describe('RemoteMediaView placeholder reason (issue #312)', () => {
  let view: RemoteMediaView;
  let players: Map<string, PlayerState>;

  beforeEach(() => {
    ({ view, players } = setup());
    players.set('a', player('a', 'Alice'));
    view.setConversationMembers(['a']);
  });

  it('is blank for a camera that is simply off', () => {
    expect(reasonOf('a')).toBe('');
  });

  it("names the peer's network-paused camera", () => {
    players.get('a')!.camAutoOff = true;
    view.refreshTileReason('a');
    expect(reasonOf('a')).toBe(t('media.peerCamAutoOff'));
    players.get('a')!.camAutoOff = false;
    view.refreshTileReason('a');
    expect(reasonOf('a')).toBe('');
  });

  it('names our own paused video pulls only when the peer is actually sending', () => {
    view.setRecvVideoPaused(true);
    expect(reasonOf('a')).toBe('');
    players.get('a')!.isVideoOn = true;
    view.refreshTileReason('a');
    expect(reasonOf('a')).toBe(t('media.recvVideoPaused'));
    view.setRecvVideoPaused(false);
    expect(reasonOf('a')).toBe('');
  });
});
