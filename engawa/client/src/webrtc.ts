import SimplePeer, { type Instance as PeerInstance } from 'simple-peer';
import type { StreamKind } from './types';
import type { MediaManager } from './media';
import { transformSdpForLowLatency } from './sdp';

// Per-kind bitrate ceilings. These are the maximum the encoder is allowed
// to spend; the actual rate adapts down to available bandwidth.
const SEND_BITRATE: Record<StreamKind, number> = {
  mic: 64_000,
  cam: 600_000,
  screen: 3_000_000,
};

function getPc(peer: PeerInstance): RTCPeerConnection | undefined {
  return (peer as unknown as { _pc?: RTCPeerConnection })._pc;
}

// Receiver playout/jitter buffer floor. Lower = less perceived lag, but small
// jitter bursts cause clicks. Chrome's default ramps up to 100–200ms for
// audio; we target 50ms which is the lowest that survives typical Wi-Fi /
// consumer ISP jitter without audible artifacts.
const PLAYOUT_DELAY_HINT_S = 0.05; // 50ms (seconds)
const JITTER_BUFFER_TARGET_MS = 50;

function tuneReceivers(pc: RTCPeerConnection) {
  for (const r of pc.getReceivers()) {
    try { (r as unknown as { playoutDelayHint: number }).playoutDelayHint = PLAYOUT_DELAY_HINT_S; } catch { /* unsupported */ }
    try { (r as unknown as { jitterBufferTarget: number }).jitterBufferTarget = JITTER_BUFFER_TARGET_MS; } catch { /* unsupported */ }
  }
}

// Apply per-kind bitrate / priority / degradationPreference to every sender.
// kind is inferred from track.kind (audio→mic) and contentHint (detail→screen,
// else cam) — both are set at the MediaManager layer.
async function tuneSenders(pc: RTCPeerConnection) {
  for (const sender of pc.getSenders()) {
    const track = sender.track;
    if (!track) continue;
    const kind: StreamKind =
      track.kind === 'audio' ? 'mic' : track.contentHint === 'detail' ? 'screen' : 'cam';
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const enc = params.encodings[0] as RTCRtpEncodingParameters & {
        networkPriority?: 'very-low' | 'low' | 'medium' | 'high';
        priority?: 'very-low' | 'low' | 'medium' | 'high';
      };
      enc.maxBitrate = SEND_BITRATE[kind];
      if (kind === 'mic') {
        enc.networkPriority = 'high';
        enc.priority = 'high';
      } else if (kind === 'screen') {
        params.degradationPreference = 'maintain-framerate';
      } else {
        params.degradationPreference = 'balanced';
      }
      await sender.setParameters(params);
    } catch (err) {
      console.warn('[rtc] setParameters failed', err);
    }
  }
}

// Fixed media slots negotiated up-front for every peer. Both sides create the
// same three sendrecv transceivers in this order, so the m-line layout is
// symmetric and either side can start/stop sending a given kind later via
// replaceTrack — no renegotiation, and crucially no dependency on who is the
// offer initiator. (simple-peer only lets the initiator renegotiate, so the
// old addStream-after-connect path silently failed for the non-initiator.)
const SLOT_KINDS = ['mic', 'cam', 'screen'] as const;

type PeerEntry = {
  peer: PeerInstance;
  remoteUserId: string;
  initiator: boolean;
  ready: boolean;
  // The three pre-created transceivers, one per StreamKind.
  tx: Record<StreamKind, RTCRtpTransceiver>;
  // One stable MediaStream per kind wrapping the remote receiver track, so the
  // UI sees a consistent stream.id across mute/unmute toggles.
  remoteStreams: Partial<Record<StreamKind, MediaStream>>;
};

export type WebRtcEvents = {
  onRemoteStream: (userId: string, stream: MediaStream, kind: StreamKind) => void;
  onRemoteStreamRemoved: (userId: string, streamId: string) => void;
  onSignal: (toUserId: string, data: unknown) => void;
  // Retained for source-compatibility with callers; the slot-based model no
  // longer needs out-of-band kind announcements, so this is never invoked.
  onStreamMeta: (toUserId: string, streamId: string, kind: StreamKind | 'removed') => void;
  onPeerClosed: (userId: string) => void;
};

function trackOf(stream: MediaStream, kind: StreamKind): MediaStreamTrack | null {
  const tracks = kind === 'mic' ? stream.getAudioTracks() : stream.getVideoTracks();
  return tracks[0] ?? null;
}

export class WebRtcManager {
  private peers = new Map<string, PeerEntry>();
  private iceServers: RTCIceServer[] | null = null;
  private media: MediaManager;
  private events: WebRtcEvents;

  constructor(media: MediaManager, events: WebRtcEvents) {
    this.media = media;
    this.events = events;
  }

  async ensureIceServers(): Promise<RTCIceServer[]> {
    if (this.iceServers) return this.iceServers;
    try {
      const res = await fetch('/api/turn-credentials');
      this.iceServers = (await res.json()) as RTCIceServer[];
    } catch (err) {
      console.error('[rtc] failed to fetch ice servers', err);
      this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    return this.iceServers;
  }

  hasPeer(remoteUserId: string) {
    return this.peers.has(remoteUserId);
  }

  async createPeer(remoteUserId: string, initiator: boolean): Promise<PeerEntry> {
    const existing = this.peers.get(remoteUserId);
    if (existing) return existing;

    const iceServers = await this.ensureIceServers();

    // Create the peer with NO up-front stream: we manage media exclusively via
    // pre-created transceivers + replaceTrack (see SLOT_KINDS).
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers },
      // Low-latency Opus tuning is applied during offer/answer.
      sdpTransform: transformSdpForLowLatency,
    });

    const pc = getPc(peer);
    if (!pc) throw new Error('[rtc] simple-peer did not expose an RTCPeerConnection');

    // Pre-create the fixed sendrecv slots synchronously, before simple-peer's
    // first offer is generated, so every connection negotiates audio+video+
    // video m-lines regardless of which side has media yet.
    const tx = {
      mic: pc.addTransceiver('audio', { direction: 'sendrecv' }),
      cam: pc.addTransceiver('video', { direction: 'sendrecv' }),
      screen: pc.addTransceiver('video', { direction: 'sendrecv' }),
    } as Record<StreamKind, RTCRtpTransceiver>;

    const entry: PeerEntry = {
      peer,
      remoteUserId,
      initiator,
      ready: false,
      tx,
      remoteStreams: {},
    };
    this.peers.set(remoteUserId, entry);

    // Attach whatever local media is already live to its slot. We do NOT
    // auto-request permissions here — the user decides via the toolbar buttons.
    const live: Partial<Record<StreamKind, MediaStream | null>> = {
      mic: this.media.micStream,
      cam: this.media.camStream,
      screen: this.media.screenStream,
    };
    for (const kind of SLOT_KINDS) {
      const stream = live[kind];
      if (!stream) continue;
      const track = trackOf(stream, kind);
      if (track) {
        try {
          void tx[kind].sender.replaceTrack(track);
        } catch (err) {
          console.warn('[rtc] replaceTrack (initial) failed', err);
        }
      }
    }
    queueMicrotask(() => void tuneSenders(pc));

    peer.on('signal', (data) => {
      this.events.onSignal(remoteUserId, data);
    });

    peer.on('connect', () => {
      entry.ready = true;
      tuneReceivers(pc);
      void tuneSenders(pc);
    });

    // A 'track' fires once per inbound slot during the initial negotiation
    // (even while muted). From then on the same track toggles mute/unmute as
    // the remote calls replaceTrack(track|null); we surface those as
    // stream add/remove so the UI shows a tile only when media is flowing.
    peer.on('track', (track) => {
      const kind = this.kindOfRemoteTrack(entry, track);
      if (!kind) return;

      let stream = entry.remoteStreams[kind];
      if (!stream) {
        stream = new MediaStream();
        entry.remoteStreams[kind] = stream;
      }
      if (!stream.getTracks().includes(track)) {
        for (const t of stream.getTracks()) stream.removeTrack(t);
        stream.addTrack(track);
      }
      const ms = stream;

      const present = () => this.events.onRemoteStream(remoteUserId, ms, kind);
      const absent = () => this.events.onRemoteStreamRemoved(remoteUserId, ms.id);

      if (!track.muted) present();
      track.addEventListener('unmute', present);
      track.addEventListener('mute', absent);
      track.addEventListener('ended', absent);

      tuneReceivers(pc);
    });

    peer.on('error', (err) => {
      console.warn(`[rtc] peer ${remoteUserId} error`, err);
    });

    peer.on('close', () => {
      this.cleanupPeer(remoteUserId);
    });

    return entry;
  }

  // Map an inbound remote track back to its slot kind by identity.
  private kindOfRemoteTrack(entry: PeerEntry, track: MediaStreamTrack): StreamKind | null {
    for (const kind of SLOT_KINDS) {
      if (entry.tx[kind].receiver.track === track) return kind;
    }
    return null;
  }

  signal(remoteUserId: string, data: unknown) {
    const entry = this.peers.get(remoteUserId);
    if (!entry) return;
    try {
      entry.peer.signal(data as SimplePeer.SignalData);
    } catch (err) {
      console.error('[rtc] signal error', err);
    }
  }

  // No-op retained for source-compatibility. Stream kinds are now derived from
  // the fixed transceiver slot, so out-of-band stream-meta is no longer used.
  applyRemoteStreamMeta(_remoteUserId: string, _streamId: string, _kind: StreamKind | 'removed') {
    /* intentionally empty — see SLOT_KINDS */
  }

  closePeer(remoteUserId: string) {
    const entry = this.peers.get(remoteUserId);
    if (!entry) return;
    try {
      entry.peer.destroy();
    } catch {
      /* noop */
    }
    this.cleanupPeer(remoteUserId);
  }

  closeAll() {
    for (const id of [...this.peers.keys()]) this.closePeer(id);
  }

  private cleanupPeer(remoteUserId: string) {
    if (!this.peers.has(remoteUserId)) return;
    this.peers.delete(remoteUserId);
    this.events.onPeerClosed(remoteUserId);
  }

  // Start sending a local stream of the given kind to every connected peer by
  // swapping its track into the pre-negotiated slot. replaceTrack needs no
  // renegotiation, so this works for initiator and non-initiator alike.
  addLocalStream(stream: MediaStream, kind: StreamKind) {
    const track = trackOf(stream, kind);
    for (const entry of this.peers.values()) {
      try {
        void entry.tx[kind].sender.replaceTrack(track);
      } catch (err) {
        console.warn('[rtc] replaceTrack (add) failed', err);
        continue;
      }
      const pc = getPc(entry.peer);
      if (pc) queueMicrotask(() => void tuneSenders(pc));
    }
  }

  // Stop sending the given stream: clear whichever slot currently holds one of
  // its tracks. (Called with the stream returned by MediaManager.disableX().)
  removeLocalStream(stream: MediaStream) {
    const ids = new Set(stream.getTracks().map((t) => t.id));
    for (const entry of this.peers.values()) {
      for (const kind of SLOT_KINDS) {
        const sender = entry.tx[kind].sender;
        if (sender.track && ids.has(sender.track.id)) {
          try {
            void sender.replaceTrack(null);
          } catch (err) {
            console.warn('[rtc] replaceTrack (remove) failed', err);
          }
        }
      }
    }
  }
}
