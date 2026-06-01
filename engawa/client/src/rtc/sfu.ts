import type { SfuTrack, StreamKind } from '@/core/types';
import { SFU_CAM_LAYERS, SFU_SCREEN_MAX_BITRATE } from '@/rtc/cam-bitrate';
import {
  diffRtcStats,
  type RtcConn,
  type RtcSnapshot,
  type RtcStreamRate,
  summarizeRtcStats,
} from '@/rtc/rtcstats';
import { transformSdpForLowLatency } from '@/rtc/sdp';
import {
  chainOp,
  reconcilePeerTracks,
  remoteKey,
  sfuErrorMessage,
  sfuSessionError,
  shouldFallbackToMesh,
} from '@/rtc/sfu-logic';
import { tuneReceiver, tuneSfuSender } from '@/rtc/tune';

// Sentinel conn ids for the debug console. The SFU is one PC, so our published
// tracks aren't per-peer: they go to one synthetic "upstream" conn. Received
// tracks whose trackId we can't map back to a peer fall into a generic one.
export const SFU_UPSTREAM_ID = '__sfu_up__';
export const SFU_DOWNSTREAM_ID = '__sfu_down__';

// Cloudflare Realtime SFU transport.
//
// Mirrors WebRtcManager's media-facing surface (addLocalStream / removeLocalStream
// / closeAll + the onRemoteStream / onRemoteStreamRemoved / onPeerClosed events)
// so the App can swap mesh ↔ SFU behind one interface and the DOM/recording
// layers (remote-media, recorder, compositor) need no changes.
//
// One RTCPeerConnection carries everything: we PUSH our own tracks (camera as a
// simulcast ladder) and PULL every group peer's tracks, all multiplexed. Control
// messages go through our /api/sfu/* proxy, which attaches the Cloudflare app id
// + token — the browser never sees them (invariant #3). Media flows browser ↔
// Cloudflare, never through our own server (invariant #1).
//
// Cloudflare's signaling flow:
//   - push: we create the offer → POST tracks/new (location:'local') → answer.
//   - pull: POST tracks/new (location:'remote') → the SFU replies with an offer
//     and requiresImmediateRenegotiation → we answer via PUT renegotiate.
// Every op mutates the single PC, so they are serialized on one chain to avoid
// interleaved offer/answer races.

const MIC_BITRATE = 64_000;

type SessionResponse = { sessionId?: string; errorCode?: string; errorDescription?: string };

type TracksResponse = {
  requiresImmediateRenegotiation?: boolean;
  sessionDescription?: { type: 'offer' | 'answer'; sdp: string };
  tracks?: { mid?: string; trackName?: string; errorCode?: string }[];
  errorCode?: string;
  errorDescription?: string;
};

export type SfuEvents = {
  onRemoteStream: (userId: string, stream: MediaStream, kind: StreamKind) => void;
  onRemoteStreamRemoved: (userId: string, streamId: string) => void;
  onPeerClosed: (userId: string) => void;
  // Fired after our published track set changes so the App can announce it to
  // the server (sfu-publish) for relay to the group.
  onPublished: (sessionId: string, tracks: SfuTrack[]) => void;
  // Fired when the SFU peer connection fails, so the App can fall back to mesh.
  onFailed: () => void;
};

type LocalEntry = { kind: StreamKind; trackName: string; sender: RTCRtpSender; streamId: string };
type RemoteEntry = {
  userId: string;
  kind: StreamKind;
  trackName: string;
  mid: string | null;
  streamId: string | null;
  // The pulled MediaStreamTrack's id, captured on the 'track' event. getStats
  // inbound-rtp.trackIdentifier matches it, letting the debug console attribute
  // each received stream (single SFU PC) back to a peer.
  trackId: string | null;
  preferredRid: string | null;
};

export class SfuManager {
  private events: SfuEvents;

  private pc: RTCPeerConnection | null = null;
  // Aborted in closeAll to detach the PC's 'track'/'connectionstatechange'
  // listeners and every per-track 'ended' listener in one shot, so they don't
  // outlive the closed PC (issue #127). Recreated alongside the PC in ensurePc.
  private pcAbort: AbortController | null = null;
  private sessionId: string | null = null;
  private iceServers: RTCIceServer[] | null = null;
  private closed = false;

  // Our published tracks, keyed by trackName.
  private localTracks = new Map<string, LocalEntry>();
  // Remote tracks we've pulled, keyed by `${userId}/${kind}`.
  private remoteTracks = new Map<string, RemoteEntry>();
  // transceiver mid → remote key, for routing ontrack to (userId, kind).
  private midToRemote = new Map<string, string>();

  // Serializes every renegotiation against the single PC.
  private opChain: Promise<void> = Promise.resolve();

  // Previous getStats snapshot for the per-second diff (debug console).
  private statsPrev: RtcSnapshot | null = null;

  constructor(events: SfuEvents) {
    this.events = events;
  }

  // True once we have (or are creating) a session — i.e. SFU is the active path.
  get active(): boolean {
    return this.pc !== null;
  }

  get peerCount(): number {
    return new Set([...this.remoteTracks.values()].map((r) => r.userId)).size;
  }

  // ─── public API (mirrors WebRtcManager where it overlaps) ─────────────────

  addLocalStream(stream: MediaStream, kind: StreamKind) {
    const track = kind === 'mic' ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    if (!track) return;
    this.reopen();
    this.enqueue(() => this.pushTrack(track, kind, stream.id));
  }

  removeLocalStream(stream: MediaStream) {
    this.enqueue(() => this.unpublishStream(stream.id));
  }

  // Swap the track behind an already-published stream (a camera/mic device
  // switch, or crossing the virtual-background on/off boundary) WITHOUT a
  // remove+repush. The old path unpublished the track (leaving an idle slot of
  // the same trackName) and pushed a fresh transceiver under that same name, so
  // the Cloudflare session ended up with two tracks called e.g. 'cam' and peers
  // pulled the stale, frame-less one — a remote blackout (#148). replaceTrack
  // keeps the same transceiver, simulcast encodings and trackName, so peers keep
  // pulling the same track and just receive the new device's frames. Falls back
  // to a fresh publish when nothing of that kind is published yet.
  replaceLocalStream(_oldStream: MediaStream, newStream: MediaStream, kind: StreamKind) {
    const track = kind === 'mic' ? newStream.getAudioTracks()[0] : newStream.getVideoTracks()[0];
    if (!track) return;
    this.reopen();
    this.enqueue(async () => {
      const entry = this.localTracks.get(kind);
      if (!entry) {
        await this.pushTrack(track, kind, newStream.id);
        return;
      }
      await entry.sender.replaceTrack(track);
      entry.streamId = newStream.id;
    });
  }

  // Reconcile the tracks a group peer is publishing: pull anything new, drop
  // anything that disappeared (e.g. they turned their camera off).
  setPeerTracks(userId: string, sessionId: string, tracks: SfuTrack[]) {
    this.reopen();
    this.enqueue(async () => {
      const { toPull, toDrop } = reconcilePeerTracks(userId, tracks, this.remoteTracks.keys());
      for (const t of toPull) {
        await this.pullTrack(userId, sessionId, t.kind, t.trackName);
      }
      for (const key of toDrop) this.dropRemote(key);
    });
  }

  // A peer left the group entirely: drop all of their pulled tracks.
  removePeer(userId: string) {
    this.enqueue(async () => {
      for (const key of [...this.remoteTracks.keys()]) {
        if (this.remoteTracks.get(key)!.userId === userId) this.dropRemote(key);
      }
      this.events.onPeerClosed(userId);
    });
  }

  // Ask the SFU to deliver a specific simulcast layer for one remote camera
  // (issue #78: small tiles take the half layer to save downlink). No-op unless
  // the rid actually changes.
  setPreferredLayer(userId: string, kind: StreamKind, rid: string) {
    const entry = this.remoteTracks.get(remoteKey(userId, kind));
    if (!entry || entry.preferredRid === rid) return;
    entry.preferredRid = rid;
    this.enqueue(async () => {
      if (!this.sessionId || !entry.mid) return;
      try {
        await this.api<TracksResponse>(`/${this.sessionId}/tracks/update`, 'PUT', {
          tracks: [{ mid: entry.mid, simulcast: { preferredRid: rid } }],
        });
      } catch (err) {
        // Layer selection is a downlink optimization, not call-critical: a failed
        // tweak must not tear the whole group down to mesh, so swallow it here
        // rather than let it reach the op-chain fallback.
        console.warn('[sfu] preferred layer update failed', err);
      }
    });
  }

  closeAll() {
    this.closed = true;
    this.pcAbort?.abort();
    this.pcAbort = null;
    try {
      this.pc?.close();
    } catch {
      /* noop */
    }
    this.pc = null;
    this.sessionId = null;
    this.localTracks.clear();
    this.remoteTracks.clear();
    this.midToRemote.clear();
    this.statsPrev = null;
  }

  // closeAll() latches `closed` so chainOp skips any still-queued ops while we
  // tear the transport down (mesh fallback, or leaving the SFU group). But this
  // manager is reused across mesh↔SFU transitions, so re-entering an SFU group
  // must clear that latch first — otherwise chainOp skips every push/pull, no
  // PC/session is ever recreated, and no media flows (issue #138: media stopped
  // after leaving and re-entering a meeting room). Called by the two
  // reactivation entry points: publishing our own track and pulling a peer's.
  private reopen() {
    this.closed = false;
  }

  // Poll the single SFU PC's getStats() and split the per-second diff into
  // RtcConns for the debug console: received streams grouped per peer (matched
  // by trackId), plus a synthetic "self → SFU" upstream for our published
  // tracks (the SFU topology sends one upstream, not one per peer). The first
  // poll only seeds the baseline and returns nothing.
  async collectStats(): Promise<RtcConn[]> {
    if (!this.pc) return [];
    let report: RTCStatsReport;
    try {
      report = await this.pc.getStats();
    } catch {
      return [];
    }
    const arr: Record<string, unknown>[] = [];
    report.forEach((s) => {
      arr.push(s as Record<string, unknown>);
    });
    const cur = summarizeRtcStats(arr);
    const prev = this.statsPrev;
    this.statsPrev = cur;
    if (!prev) return [];

    const rates = diffRtcStats(prev, cur);
    const trackToUser = new Map<string, string>();
    for (const e of this.remoteTracks.values()) {
      if (e.trackId) trackToUser.set(e.trackId, e.userId);
    }

    const byUser = new Map<string, RtcStreamRate[]>();
    const upstream: RtcStreamRate[] = [];
    const unknown: RtcStreamRate[] = [];
    for (const s of rates.streams) {
      if (s.dir === 'send') {
        upstream.push(s);
        continue;
      }
      const uid = s.trackId ? trackToUser.get(s.trackId) : undefined;
      if (uid) {
        const list = byUser.get(uid) ?? [];
        list.push(s);
        byUser.set(uid, list);
      } else {
        unknown.push(s);
      }
    }

    const out: RtcConn[] = [];
    for (const [uid, streams] of byUser) out.push({ id: uid, streams });
    if (unknown.length) out.push({ id: SFU_DOWNSTREAM_ID, label: 'SFU 受信', streams: unknown });
    if (upstream.length) {
      out.push({
        id: SFU_UPSTREAM_ID,
        label: '自分 → SFU',
        rttMs: rates.rttMs,
        transport: rates.transport,
        streams: upstream,
      });
    }
    return out;
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private enqueue(op: () => Promise<void>) {
    this.opChain = chainOp(
      this.opChain,
      () => this.closed,
      op,
      (err) => {
        // A control-plane op failed (bad HTTP status, invalid JSON, renegotiation
        // error, …). The SFU transport can no longer be trusted, so degrade this
        // group to mesh — the same safety net as a 'failed' connection state. The
        // App's handler calls closeAll(), which sets closed=true, so chainOp skips
        // the rest of the queue and this can't re-fire. The cosmetic
        // layer-preference op swallows its own error (see setPreferredLayer) so a
        // failed tweak never trips this fallback.
        console.warn('[sfu] op failed; falling back to mesh', err);
        if (!this.closed) this.events.onFailed();
      },
    );
  }

  private async ensureIceServers(): Promise<RTCIceServer[]> {
    if (this.iceServers) return this.iceServers;
    try {
      const res = await fetch('/api/turn-credentials');
      this.iceServers = (await res.json()) as RTCIceServer[];
    } catch (err) {
      console.error('[sfu] failed to fetch ice servers', err);
      this.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
    }
    return this.iceServers;
  }

  private async ensurePc(): Promise<RTCPeerConnection> {
    if (this.pc) return this.pc;
    const iceServers = await this.ensureIceServers();
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    const abort = new AbortController();
    this.pcAbort = abort;
    const signal = abort.signal;

    pc.addEventListener(
      'track',
      (event) => {
        const mid = event.transceiver.mid ?? '';
        const key = this.midToRemote.get(mid);
        if (!key) return;
        const entry = this.remoteTracks.get(key);
        if (!entry) return;
        // Pin this pulled track's playout/jitter buffer to the low-latency floor,
        // the same tuning the mesh applies to its receivers. Without it the SFU
        // path inherits Chrome's (higher) adaptive default, adding perceived
        // audio/video lag over the internet (#146).
        tuneReceiver(event.receiver);
        const stream = new MediaStream([event.track]);
        entry.streamId = stream.id;
        entry.trackId = event.track.id;
        this.events.onRemoteStream(entry.userId, stream, entry.kind);
        event.track.addEventListener(
          'ended',
          () => {
            if (entry.streamId) this.events.onRemoteStreamRemoved(entry.userId, entry.streamId);
          },
          { signal },
        );
      },
      { signal },
    );

    pc.addEventListener(
      'connectionstatechange',
      () => {
        if (shouldFallbackToMesh(pc.connectionState, this.closed)) this.events.onFailed();
      },
      { signal },
    );

    this.pc = pc;
    return pc;
  }

  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const resp = await this.api<SessionResponse>('/new', 'POST', undefined);
    const err = sfuSessionError(resp);
    if (err) throw new Error(`sfu: session create failed (${err})`);
    this.sessionId = resp.sessionId!;
    return this.sessionId;
  }

  // POST/PUT against our /api/sfu/* proxy. Throws on a network error, a non-2xx
  // status, or a body that isn't valid JSON — previously the response was parsed
  // blind, so a 4xx/5xx (or an HTML error page) slipped through as a malformed
  // object and corrupted PC state silently. Throwing rejects the op, which the
  // op-chain handler turns into a mesh fallback (see enqueue).
  private async api<T>(sessionPath: string, method: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`/api/sfu/sessions${sessionPath}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(
        `sfu api ${method} ${sessionPath}: network error (${(err as Error).message})`,
      );
    }
    if (!res.ok) {
      throw new Error(`sfu api ${method} ${sessionPath}: HTTP ${res.status}`);
    }
    try {
      return (await res.json()) as T;
    } catch (err) {
      throw new Error(`sfu api ${method} ${sessionPath}: invalid JSON (${(err as Error).message})`);
    }
  }

  private sendEncodingsFor(kind: StreamKind): RTCRtpEncodingParameters[] {
    if (kind === 'cam') {
      return SFU_CAM_LAYERS.map((l) => ({
        rid: l.rid,
        scaleResolutionDownBy: l.scaleResolutionDownBy,
        maxBitrate: l.maxBitrate,
      }));
    }
    if (kind === 'screen') return [{ maxBitrate: SFU_SCREEN_MAX_BITRATE }];
    return [{ maxBitrate: MIC_BITRATE }];
  }

  private async pushTrack(track: MediaStreamTrack, kind: StreamKind, streamId: string) {
    const pc = await this.ensurePc();
    const sid = await this.ensureSession();
    // trackName only needs to be unique within our own session; the session id
    // already disambiguates us from other publishers, so the kind alone suffices.
    const trackName = kind;

    const tx = pc.addTransceiver(track, {
      direction: 'sendonly',
      sendEncodings: this.sendEncodingsFor(kind),
    });
    const offer = await pc.createOffer();
    await pc.setLocalDescription({
      type: 'offer',
      sdp: transformSdpForLowLatency(offer.sdp ?? ''),
    });

    const resp = await this.api<TracksResponse>(`/${sid}/tracks/new`, 'POST', {
      sessionDescription: { type: 'offer', sdp: pc.localDescription?.sdp ?? '' },
      tracks: [{ location: 'local', mid: tx.mid, trackName }],
    });
    const pushErr = sfuErrorMessage(resp);
    if (pushErr) throw new Error(`sfu push: ${pushErr}`);
    if (resp.sessionDescription) await pc.setRemoteDescription(resp.sessionDescription);

    this.localTracks.set(trackName, { kind, trackName, sender: tx.sender, streamId });
    // Layer on the per-kind priority / congestion-degradation policy (mic gets
    // top network priority; cam=balanced, screen=maintain-resolution). The
    // bitrate ceilings already went in via sendEncodings above. Best-effort: a
    // setParameters failure must not fail the push and trip the mesh fallback.
    try {
      await tuneSfuSender(tx.sender, kind);
    } catch (err) {
      console.warn('[sfu] sender tune failed', err);
    }
    this.announcePublished();
  }

  private async unpublishStream(streamId: string) {
    for (const [trackName, lt] of [...this.localTracks]) {
      if (lt.streamId !== streamId) continue;
      // Stop sending without renegotiating the whole session: replaceTrack(null)
      // halts media immediately, and announcePublished() drops it from the
      // directory so peers stop pulling it. (Cloudflare keeps the now-idle slot;
      // it is reclaimed when the group disbands and the session closes.)
      try {
        await lt.sender.replaceTrack(null);
      } catch {
        /* noop */
      }
      this.localTracks.delete(trackName);
    }
    this.announcePublished();
  }

  private async pullTrack(
    userId: string,
    theirSessionId: string,
    kind: StreamKind,
    trackName: string,
  ) {
    const pc = await this.ensurePc();
    const sid = await this.ensureSession();
    const key = remoteKey(userId, kind);
    if (this.remoteTracks.has(key)) return;

    const resp = await this.api<TracksResponse>(`/${sid}/tracks/new`, 'POST', {
      tracks: [{ location: 'remote', sessionId: theirSessionId, trackName }],
    });
    const pullErr = sfuErrorMessage(resp);
    if (pullErr) throw new Error(`sfu pull: ${pullErr}`);

    // Cloudflare returns, in resp.tracks, the mid it assigned this remote track
    // in the offer SDP it just sent us — the same mid the browser exposes on the
    // transceiver in the 'track' event, so we route ontrack by it.
    const mid = resp.tracks?.[0]?.mid ?? null;
    const entry: RemoteEntry = {
      userId,
      kind,
      trackName,
      mid,
      streamId: null,
      trackId: null,
      preferredRid: null,
    };
    this.remoteTracks.set(key, entry);
    if (mid) this.midToRemote.set(mid, key);

    if (resp.requiresImmediateRenegotiation && resp.sessionDescription) {
      await pc.setRemoteDescription(resp.sessionDescription);
      const answer = await pc.createAnswer();
      // Same low-latency Opus tuning the mesh applies to every answer. Video
      // codec order is left to the browser: the camera publish is simulcast, for
      // which VP8 is the reliable path — forcing VP9/SVC can break the rids.
      await pc.setLocalDescription({
        type: 'answer',
        sdp: transformSdpForLowLatency(answer.sdp ?? ''),
      });
      const reneg = await this.api<TracksResponse>(`/${sid}/renegotiate`, 'PUT', {
        sessionDescription: { type: 'answer', sdp: pc.localDescription?.sdp ?? '' },
      });
      const renegErr = sfuErrorMessage(reneg);
      if (renegErr) throw new Error(`sfu renegotiate: ${renegErr}`);
    }
  }

  private dropRemote(key: string) {
    const entry = this.remoteTracks.get(key);
    if (!entry) return;
    if (entry.streamId) this.events.onRemoteStreamRemoved(entry.userId, entry.streamId);
    if (entry.mid) this.midToRemote.delete(entry.mid);
    this.remoteTracks.delete(key);
  }

  private announcePublished() {
    if (!this.sessionId) return;
    const tracks: SfuTrack[] = [...this.localTracks.values()].map((l) => ({
      kind: l.kind,
      trackName: l.trackName,
    }));
    this.events.onPublished(this.sessionId, tracks);
  }
}
