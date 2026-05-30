import SimplePeer, { type Instance as PeerInstance } from 'simple-peer';
import type { StreamKind } from './types';
import type { MediaManager } from './media';
import { transformSdp } from './sdp';
import { CAM_BITRATE_SPEAKING } from './cam-bitrate';

// Per-kind bitrate ceilings. These are the maximum the encoder is allowed
// to spend; the actual rate adapts down to available bandwidth. The cam value
// is the high (speaking) ceiling — in big proximity groups the App lowers it
// per-peer via setCamBitrate (see cam-bitrate.ts).
const SEND_BITRATE: Record<StreamKind, number> = {
  mic: 64_000,
  cam: CAM_BITRATE_SPEAKING,
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
// else cam) — both are set at the MediaManager layer. `camBitrate` is the
// current speaker-aware ceiling for camera senders (mic/screen use their fixed
// per-kind ceiling).
async function tuneSenders(pc: RTCPeerConnection, camBitrate: number) {
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
      enc.maxBitrate = kind === 'cam' ? camBitrate : SEND_BITRATE[kind];
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

type PeerEntry = {
  peer: PeerInstance;
  remoteUserId: string;
  initiator: boolean;
  ready: boolean;
  // streamId → kind map for incoming streams (populated via stream-meta WS msgs)
  remoteStreamKinds: Map<string, StreamKind>;
  // streamId → kind map for our own outgoing streams (so we can re-announce on
  // reconnect/renegotiation).
  localStreamKinds: Map<string, StreamKind>;
};

export type WebRtcEvents = {
  onRemoteStream: (userId: string, stream: MediaStream, kind: StreamKind) => void;
  onRemoteStreamRemoved: (userId: string, streamId: string) => void;
  onSignal: (toUserId: string, data: unknown) => void;
  onStreamMeta: (toUserId: string, streamId: string, kind: StreamKind | 'removed') => void;
  onPeerClosed: (userId: string) => void;
};

export class WebRtcManager {
  private peers = new Map<string, PeerEntry>();
  private iceServers: RTCIceServer[] | null = null;
  private media: MediaManager;
  private events: WebRtcEvents;

  // Current camera send-bitrate ceiling applied to every peer's cam sender. The
  // App drives this via setCamBitrate (speaker-aware; see cam-bitrate.ts);
  // defaults to the high rate so behaviour is unchanged until the App lowers it.
  private camBitrate = CAM_BITRATE_SPEAKING;

  // Pending stream-meta announcements that arrived before the corresponding
  // 'stream' / 'track' event on the peer.
  private pendingMeta = new Map<string, Map<string, StreamKind>>();

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

  // Number of currently connected proximity peers (the mesh degree). The App
  // feeds this to computeCamBitrate to decide whether to throttle.
  get peerCount(): number {
    return this.peers.size;
  }

  // Update the camera send-bitrate ceiling and re-tune every peer's cam sender.
  // RTCRtpSender.setParameters is seamless — no renegotiation, the track keeps
  // flowing. No-op when the value is unchanged so the App can call it freely.
  setCamBitrate(bitrate: number) {
    if (bitrate === this.camBitrate) return;
    this.camBitrate = bitrate;
    for (const entry of this.peers.values()) {
      const pc = getPc(entry.peer);
      if (pc) void tuneSenders(pc, this.camBitrate);
    }
  }

  async createPeer(remoteUserId: string, initiator: boolean): Promise<PeerEntry> {
    const existing = this.peers.get(remoteUserId);
    if (existing) return existing;

    const iceServers = await this.ensureIceServers();

    // Bundle whatever local streams we already have so the peer is created with
    // them from the start. We do NOT auto-request permissions here — the user
    // decides via the toolbar buttons.
    const initialStreams: { stream: MediaStream; kind: StreamKind }[] = [];
    const micStream = this.media.micStream;
    if (micStream) initialStreams.push({ stream: micStream, kind: 'mic' });
    const camStream = this.media.camStream;
    if (camStream) initialStreams.push({ stream: camStream, kind: 'cam' });
    const screenStream = this.media.screenStream;
    if (screenStream) initialStreams.push({ stream: screenStream, kind: 'screen' });

    const peer = new SimplePeer({
      initiator,
      trickle: true,
      config: { iceServers },
      // simple-peer accepts one stream up-front; we add the rest via addStream.
      stream: initialStreams[0]?.stream,
      // Applied to every offer/answer: low-latency Opus (audio) + VP9-preferred
      // codec ordering (video).
      sdpTransform: transformSdp,
    });

    const entry: PeerEntry = {
      peer,
      remoteUserId,
      initiator,
      ready: false,
      remoteStreamKinds: new Map(),
      localStreamKinds: new Map(),
    };
    this.peers.set(remoteUserId, entry);

    // Wire the stream→kind map for the initial stream(s).
    for (const { stream, kind } of initialStreams) {
      entry.localStreamKinds.set(stream.id, kind);
      this.events.onStreamMeta(remoteUserId, stream.id, kind);
    }
    // Anything beyond the first must be added explicitly.
    for (const { stream } of initialStreams.slice(1)) {
      try {
        peer.addStream(stream);
      } catch (err) {
        console.warn('[rtc] addStream failed', err);
      }
    }

    if (initialStreams.length > 0) {
      // Senders exist synchronously after addStream; tune them on the next
      // microtask once simple-peer is done wiring transceivers.
      queueMicrotask(() => {
        const pc = getPc(peer);
        if (pc) void tuneSenders(pc, this.camBitrate);
      });
    }

    // Apply any stream-meta that arrived before the peer existed.
    const pending = this.pendingMeta.get(remoteUserId);
    if (pending) {
      for (const [streamId, kind] of pending) entry.remoteStreamKinds.set(streamId, kind);
      this.pendingMeta.delete(remoteUserId);
    }

    peer.on('signal', (data) => {
      this.events.onSignal(remoteUserId, data);
    });

    peer.on('connect', () => {
      entry.ready = true;
      const pc = getPc(peer);
      if (pc) {
        tuneReceivers(pc);
        void tuneSenders(pc, this.camBitrate);
      }
    });

    const handleIncoming = (stream: MediaStream) => {
      const kind = entry.remoteStreamKinds.get(stream.id) ?? inferKind(stream);
      this.events.onRemoteStream(remoteUserId, stream, kind);
    };

    peer.on('stream', handleIncoming);

    // Track end → tell UI to drop this stream's tile/stage.
    peer.on('track', (track, stream) => {
      track.addEventListener('ended', () => {
        this.events.onRemoteStreamRemoved(remoteUserId, stream.id);
      });
      // New incoming transceiver — re-apply receiver hints.
      const pc = getPc(peer);
      if (pc) tuneReceivers(pc);
    });

    peer.on('error', (err) => {
      console.warn(`[rtc] peer ${remoteUserId} error`, err);
    });

    peer.on('close', () => {
      this.cleanupPeer(remoteUserId);
    });

    return entry;
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

  applyRemoteStreamMeta(remoteUserId: string, streamId: string, kind: StreamKind | 'removed') {
    if (kind === 'removed') {
      const entry = this.peers.get(remoteUserId);
      entry?.remoteStreamKinds.delete(streamId);
      this.events.onRemoteStreamRemoved(remoteUserId, streamId);
      return;
    }
    const entry = this.peers.get(remoteUserId);
    if (entry) {
      entry.remoteStreamKinds.set(streamId, kind);
    } else {
      let pending = this.pendingMeta.get(remoteUserId);
      if (!pending) {
        pending = new Map();
        this.pendingMeta.set(remoteUserId, pending);
      }
      pending.set(streamId, kind);
    }
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
    this.pendingMeta.delete(remoteUserId);
    this.events.onPeerClosed(remoteUserId);
  }

  // Add a new local stream of the given kind to every connected peer.
  addLocalStream(stream: MediaStream, kind: StreamKind) {
    for (const entry of this.peers.values()) {
      entry.localStreamKinds.set(stream.id, kind);
      this.events.onStreamMeta(entry.remoteUserId, stream.id, kind);
      try {
        entry.peer.addStream(stream);
      } catch (err) {
        console.warn('[rtc] addStream failed', err);
        continue;
      }
      // Re-tune senders after the new tracks have been attached.
      queueMicrotask(() => {
        const pc = getPc(entry.peer);
        if (pc) void tuneSenders(pc, this.camBitrate);
      });
    }
  }

  // Remove a local stream from every connected peer.
  removeLocalStream(stream: MediaStream) {
    for (const entry of this.peers.values()) {
      entry.localStreamKinds.delete(stream.id);
      this.events.onStreamMeta(entry.remoteUserId, stream.id, 'removed');
      try {
        entry.peer.removeStream(stream);
      } catch (err) {
        console.warn('[rtc] removeStream failed', err);
      }
    }
  }
}

function inferKind(stream: MediaStream): StreamKind {
  // Fallback when no meta has arrived. Streams without video are mic; with
  // video we default to cam (screen will normally be announced via meta).
  return stream.getVideoTracks().length === 0 ? 'mic' : 'cam';
}
