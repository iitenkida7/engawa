import SimplePeer, { type Instance as PeerInstance } from 'simple-peer';
import { mediaAuthHeaders } from '@/core/media-auth';
import type { StreamKind } from '@/core/types';
import type { MediaManager } from '@/media/media';
import {
  type CamEncoding,
  computeCamEncoding,
  computeScreenEncoding,
  computeScreenScale,
  type ScreenEncoding,
} from '@/rtc/cam-bitrate';
import { diffRtcStats, type RtcConn, type RtcSnapshot, summarizeRtcStats } from '@/rtc/rtcstats';
import { transformSdp } from '@/rtc/sdp';
import { tuneReceivers } from '@/rtc/tune';

// Fixed mic send-bitrate ceiling (bps). The encoder still adapts down to the
// available bandwidth. Camera and screen ceilings are dynamic and live in the
// per-instance send policy (see cam-bitrate.ts / setCamEncoding / setScreenEncoding).
const MIC_BITRATE = 64_000;

function getPc(peer: PeerInstance): RTCPeerConnection | undefined {
  return (peer as unknown as { _pc?: RTCPeerConnection })._pc;
}

// Receiver playout/jitter buffer floor lives in rtc/tune.ts now, shared with the
// SFU path so both transports get the same low-latency receiver tuning.

// Apply per-kind encoding ceilings / priority / degradationPreference to every
// sender. kind is inferred from track.kind (audio→mic) and contentHint
// (detail→screen, else cam) — both set at the MediaManager layer. `camEnc` is
// the speaker-aware camera ceiling; `screenEnc` is the peer-count-aware screen
// ceiling (bitrate + framerate + longest-edge resolution cap). Both are read
// live by the caller (see retunePeer) so a late-resolving setParameters never
// writes a stale ceiling.
async function tuneSenders(pc: RTCPeerConnection, camEnc: CamEncoding, screenEnc: ScreenEncoding) {
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
      if (kind === 'cam') {
        enc.maxBitrate = camEnc.maxBitrate;
        enc.maxFramerate = camEnc.maxFramerate;
        enc.scaleResolutionDownBy = camEnc.scaleResolutionDownBy;
        params.degradationPreference = 'balanced';
      } else if (kind === 'screen') {
        enc.maxBitrate = screenEnc.maxBitrate;
        // Cap the encoded resolution (longest edge) and framerate so the share
        // doesn't saturate the CPU when encoded once per peer in the mesh
        // (encode cost ~scales with pixels × fps × peers). Big clusters drop to
        // 720p-class / lower fps. getSettings() reports the live capture size;
        // computeScreenScale returns 1 (no scaling) when it is unknown or
        // already within the cap.
        const s = track.getSettings();
        enc.scaleResolutionDownBy = computeScreenScale(
          s.width ?? 0,
          s.height ?? 0,
          screenEnc.maxLongEdge,
        );
        enc.maxFramerate = screenEnc.maxFramerate;
        // contentHint='detail' optimizes for crisp text/UI, so under congestion
        // keep the (capped) resolution and drop framerate instead — the opposite
        // of maintain-framerate, which would blur the very text we want sharp.
        params.degradationPreference = 'maintain-resolution';
      } else {
        enc.maxBitrate = MIC_BITRATE;
        enc.networkPriority = 'high';
        enc.priority = 'high';
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
  // Serializes setParameters re-tunes for this peer: each re-tune is chained
  // after the previous one so concurrent tunes can't race and leave a stale
  // ceiling applied (the last-enqueued tune runs last and reads live values).
  tuneChain: Promise<void>;
  // Aborted on cleanup to detach every track 'ended' listener wired for this
  // peer in one shot (the tracks can outlive peer.destroy(), so a per-listener
  // signal is how we make create/destroy symmetric — see issue #127).
  abort: AbortController;
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

  // Current send policy applied to every peer. The App drives these each frame
  // (camEnc is speaker-aware, screenEnc is peer-count-aware; see cam-bitrate.ts).
  // Defaults to the small-group/high-quality values so behaviour is unchanged
  // until the App throttles.
  private camEnc: CamEncoding = computeCamEncoding(0, false);
  private screenEnc: ScreenEncoding = computeScreenEncoding(0);

  // Pending stream-meta announcements that arrived before the corresponding
  // 'stream' / 'track' event on the peer.
  private pendingMeta = new Map<string, Map<string, StreamKind>>();

  // Previous getStats snapshot per peer, for the debug console per-second diff.
  private statsPrev = new Map<string, RtcSnapshot>();

  constructor(media: MediaManager, events: WebRtcEvents) {
    this.media = media;
    this.events = events;
  }

  async ensureIceServers(): Promise<RTCIceServer[]> {
    if (this.iceServers) return this.iceServers;
    try {
      const res = await fetch('/api/turn-credentials', { headers: mediaAuthHeaders() });
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

  // Ids of the currently connected mesh peers. The App reconciles this against
  // its server-assigned group membership to open/close peers.
  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  // Number of currently connected proximity peers (the mesh degree). The App
  // feeds this to computeCamEncoding / computeScreenEncoding to decide throttling.
  get peerCount(): number {
    return this.peers.size;
  }

  // Update the camera encoding ceiling and re-tune every peer's cam sender.
  // RTCRtpSender.setParameters is seamless — no renegotiation, the track keeps
  // flowing. No-op when unchanged so the App can call it every frame.
  setCamEncoding(enc: CamEncoding) {
    if (
      enc.maxBitrate === this.camEnc.maxBitrate &&
      enc.maxFramerate === this.camEnc.maxFramerate &&
      enc.scaleResolutionDownBy === this.camEnc.scaleResolutionDownBy
    ) {
      return;
    }
    this.camEnc = enc;
    this.retuneAll();
  }

  // Update the screen-share encoding ceiling (bitrate + framerate + resolution
  // cap) and re-tune every peer's screen sender. No-op when unchanged so the App
  // can call it every frame.
  setScreenEncoding(enc: ScreenEncoding) {
    if (
      enc.maxBitrate === this.screenEnc.maxBitrate &&
      enc.maxFramerate === this.screenEnc.maxFramerate &&
      enc.maxLongEdge === this.screenEnc.maxLongEdge
    ) {
      return;
    }
    this.screenEnc = enc;
    this.retuneAll();
  }

  private retuneAll() {
    for (const entry of this.peers.values()) this.retunePeer(entry);
  }

  // Queue a sender re-tune for one peer, serialized after any in-flight tune for
  // the same peer. tuneSenders reads the live camEnc/screenEnc, so whichever
  // tune runs last applies the current ceilings — concurrent calls can't leave a
  // stale value applied.
  private retunePeer(entry: PeerEntry) {
    entry.tuneChain = entry.tuneChain
      .then(() => {
        const pc = getPc(entry.peer);
        return pc ? tuneSenders(pc, this.camEnc, this.screenEnc) : undefined;
      })
      .catch((err) => {
        console.warn('[rtc] retune failed', err);
      });
  }

  // Poll getStats() on every peer and return the per-second diff vs the previous
  // poll, one RtcConn per peer (used by the debug console; see rtcstats.ts).
  // Each mesh peer has its own PC, so a conn carries both our send streams and
  // what we receive from them. Peers seen for the first time are recorded but
  // omitted until there is a delta to report.
  async collectStats(): Promise<RtcConn[]> {
    const out: RtcConn[] = [];
    for (const entry of this.peers.values()) {
      const pc = getPc(entry.peer);
      if (!pc) continue;
      let report: RTCStatsReport;
      try {
        report = await pc.getStats();
      } catch {
        continue;
      }
      const arr: Record<string, unknown>[] = [];
      report.forEach((s) => {
        arr.push(s as Record<string, unknown>);
      });
      const cur = summarizeRtcStats(arr);
      const prev = this.statsPrev.get(entry.remoteUserId);
      this.statsPrev.set(entry.remoteUserId, cur);
      if (prev) {
        const rates = diffRtcStats(prev, cur);
        out.push({
          id: entry.remoteUserId,
          rttMs: rates.rttMs,
          transport: rates.transport,
          streams: rates.streams,
        });
      }
    }
    return out;
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
      tuneChain: Promise.resolve(),
      abort: new AbortController(),
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
      queueMicrotask(() => this.retunePeer(entry));
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
      if (pc) tuneReceivers(pc);
      this.retunePeer(entry);
    });

    const handleIncoming = (stream: MediaStream) => {
      const kind = entry.remoteStreamKinds.get(stream.id) ?? inferKind(stream);
      this.events.onRemoteStream(remoteUserId, stream, kind);
    };

    peer.on('stream', handleIncoming);

    // Track end → tell UI to drop this stream's tile/stage.
    peer.on('track', (track, stream) => {
      track.addEventListener(
        'ended',
        () => {
          this.events.onRemoteStreamRemoved(remoteUserId, stream.id);
        },
        { signal: entry.abort.signal },
      );
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
    const entry = this.peers.get(remoteUserId);
    if (!entry) return;
    // Detach the track 'ended' listeners before dropping the entry.
    entry.abort.abort();
    this.peers.delete(remoteUserId);
    this.pendingMeta.delete(remoteUserId);
    this.statsPrev.delete(remoteUserId);
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
      queueMicrotask(() => this.retunePeer(entry));
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

  // Swap the track behind an already-sent stream (device switch, or crossing the
  // virtual-background on/off boundary) via replaceTrack, instead of a
  // removeStream+addStream that renegotiates twice and races (the remote could
  // be left on the torn-down track → blackout, #148). The transceiver and the
  // remote's stream→kind mapping are untouched, so the peer's existing video
  // element just starts rendering the new device's frames. New peers that join
  // later pick up the swapped track automatically (createPeer reads the live
  // media streams). Matches the sender by the old track reference, falling back
  // to the sole sender of the right media kind.
  replaceLocalStream(oldStream: MediaStream, newStream: MediaStream, kind: StreamKind) {
    const oldTrack = kind === 'mic' ? oldStream.getAudioTracks()[0] : oldStream.getVideoTracks()[0];
    const newTrack = kind === 'mic' ? newStream.getAudioTracks()[0] : newStream.getVideoTracks()[0];
    if (!newTrack) return;
    const mediaKind = kind === 'mic' ? 'audio' : 'video';
    for (const entry of this.peers.values()) {
      const pc = getPc(entry.peer);
      if (!pc) continue;
      const senders = pc.getSenders();
      const sender =
        senders.find((s) => s.track === oldTrack) ??
        senders.find(
          (s) => s.track?.kind === mediaKind && s.track.contentHint === newTrack.contentHint,
        );
      if (!sender) continue;
      sender.replaceTrack(newTrack).catch((err) => console.warn('[rtc] replaceTrack failed', err));
      queueMicrotask(() => this.retunePeer(entry));
    }
  }
}

function inferKind(stream: MediaStream): StreamKind {
  // Fallback when no meta has arrived. Streams without video are mic; with
  // video we default to cam (screen will normally be announced via meta).
  return stream.getVideoTracks().length === 0 ? 'mic' : 'cam';
}
