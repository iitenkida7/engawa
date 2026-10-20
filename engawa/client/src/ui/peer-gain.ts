import { t } from '@/core/i18n';
import { getSharedAudioContext } from '@/media/speaking';
import {
  gainToPercent,
  PEER_GAIN_DEFAULT,
  PEER_GAIN_MAX,
  percentToGain,
  snapPercent,
} from '@/ui/peer-volume';

// Per-person playback volume. At the default the <audio> element plays
// untouched; only a changed gain routes the voice through a Web Audio GainNode
// (the element stays attached but muted, which WebRTC streams need to keep
// flowing). The chosen gain itself lives with the caller (on the remote tile).
export class PeerGainRoutes {
  private routes = new Map<
    string,
    { source: MediaStreamAudioSourceNode; gain: GainNode; streamId: string }
  >();

  // Make the live voice match the gain: untouched element at the default, a
  // GainNode route otherwise.
  apply(userId: string, audio: HTMLAudioElement, gain: number) {
    const stream = audio.srcObject as MediaStream | null;
    if (gain === PEER_GAIN_DEFAULT || !stream || typeof AudioContext === 'undefined') {
      this.drop(userId);
      audio.muted = false;
      return;
    }
    let route = this.routes.get(userId);
    if (route && route.streamId !== stream.id) {
      this.drop(userId);
      route = undefined;
    }
    // The context the speaking detectors already run in: one per tab, not one
    // per subsystem (see getSharedAudioContext). Fetched on every change, not
    // just when building the route: a context created behind the autoplay gate
    // starts suspended, and the getter resumes it — the slider drag that got us
    // here is the gesture that lets it.
    const ctx = getSharedAudioContext();
    if (!route) {
      const source = ctx.createMediaStreamSource(stream);
      const node = ctx.createGain();
      source.connect(node);
      node.connect(ctx.destination);
      route = { source, gain: node, streamId: stream.id };
      this.routes.set(userId, route);
    }
    route.gain.gain.value = gain;
    // The element only keeps the stream flowing now; the sound comes from the node.
    audio.muted = true;
  }

  drop(userId: string) {
    const route = this.routes.get(userId);
    if (!route) return;
    try {
      route.source.disconnect();
      route.gain.disconnect();
    } catch {
      /* noop */
    }
    this.routes.delete(userId);
  }
}

// The volume control in a remote tile's header: a speaker, the slider, and the
// percentage whenever it is not the default.
//
// The speaker is always visible (dimmed until you hover the tile), because a
// control that only exists on hover is a control nobody finds — and because a
// peer you silenced has to look different from a peer who is simply not
// talking. The slider magnets onto 100% (see snapPercent) so putting someone
// back to normal is a drag, not a pixel hunt.
export function createVolumeControl(
  initialGain: number,
  onChange: (gain: number) => void,
): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = 'vol';

  const icon = document.createElement('span');
  icon.className = 'vol-icon';
  icon.setAttribute('aria-hidden', 'true');

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.className = 'vol-slider';
  slider.min = '0';
  slider.max = String(PEER_GAIN_MAX * 100);
  slider.step = '1';

  const pct = document.createElement('span');
  pct.className = 'vol-pct';

  const show = (g: number) => {
    const p = gainToPercent(g);
    slider.value = String(p);
    // The track fills itself from this (see the --vol-fill rules): the slider
    // spans 0–200%, so the filled share is half the percentage.
    slider.style.setProperty('--vol-fill', `${p / 2}%`);
    slider.title = t('media.volume', { pct: p });
    slider.setAttribute('aria-label', slider.title);
    icon.textContent = p === 0 ? '🔇' : '🔊';
    // Only a changed volume is worth the ink; the default reads as "normal".
    pct.textContent = g === PEER_GAIN_DEFAULT ? '' : `${p}%`;
    wrap.classList.toggle('muted', p === 0);
    wrap.classList.toggle('changed', g !== PEER_GAIN_DEFAULT);
  };
  show(initialGain);

  // Arrow keys must step freely, or every step inside the magnet band would
  // snap back and the slider would be stuck at 100% for keyboard users.
  let fromKey = false;
  slider.addEventListener('keydown', () => {
    fromKey = true;
  });
  slider.addEventListener('input', () => {
    const raw = Number(slider.value);
    const g = percentToGain(fromKey ? raw : snapPercent(raw));
    fromKey = false;
    show(g);
    onChange(g);
  });
  // The header is the drag handle (and the maximize button's neighbour): keep
  // slider gestures from starting a panel drag.
  slider.addEventListener('mousedown', (e) => e.stopPropagation());

  wrap.appendChild(icon);
  wrap.appendChild(slider);
  wrap.appendChild(pct);
  return wrap;
}
