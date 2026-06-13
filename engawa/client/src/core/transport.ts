// Owns the two media transports (mesh WebRtcManager / SFU SfuManager) and the
// server-driven switch between them, extracted from App. The server's
// group-update is the single source of truth for who we are in a call with;
// this class reconciles the active transport against it, guards stray signals,
// and applies the speaker-aware send policy. App forwards the relevant server
// messages here and passes the view callbacks through, so the DOM layer stays
// unchanged. Implements the toolbar's MediaSink surface (addLocalStream /
// removeLocalStream / replaceLocalStream) by routing to the active transport.

import { isInitiator } from '@/core/proximity';
import type { ClientMessage, GroupMethod, SfuTrack, StreamKind } from '@/core/types';
import type { MediaManager } from '@/media/media';
import {
  computeCamEncoding,
  computePreferredRid,
  computeScreenEncoding,
  isHeldSpeaking,
} from '@/rtc/cam-bitrate';
import type { RtcConn } from '@/rtc/rtcstats';
import { type SfuEvents, SfuManager } from '@/rtc/sfu';
import { partitionMembers } from '@/rtc/sfu-logic';
import { type WebRtcEvents, WebRtcManager } from '@/rtc/webrtc';
import type { PlayerState } from '@/world/player';

export type TransportOpts = {
  media: MediaManager;
  getMyId: () => string;
  send: (msg: ClientMessage) => void;
  // Remote-media events, identical for both transports (App forwards them to
  // RemoteMediaView).
  onRemoteStream: (userId: string, stream: MediaStream, kind: StreamKind) => void;
  onRemoteStreamRemoved: (userId: string, streamId: string) => void;
  onPeerClosed: (userId: string) => void;
  // The rendered width of a user's camera tile (SFU simulcast layer selection).
  getCameraTileWidth: (userId: string) => number | null;
  // Fired when the SFU transport failed and the group degraded to mesh, so the
  // App can surface it (toast).
  onFellBack: () => void;
};

// Factory seam for tests: fakes stand in for the real transports so the
// reconciliation / switching logic is testable without WebRTC APIs.
export type TransportFactories = {
  rtc?: (media: MediaManager, events: WebRtcEvents) => WebRtcManager;
  sfu?: (events: SfuEvents) => SfuManager;
};

export class TransportCoordinator {
  private media: MediaManager;
  private getMyId: () => string;
  private onFellBack: () => void;
  private getCameraTileWidth: (userId: string) => number | null;

  private rtc: WebRtcManager;
  private sfu: SfuManager;

  // Server-driven transport for our current proximity group. 'mesh' uses the
  // per-peer WebRtcManager; 'sfu' routes everything through Cloudflare Realtime
  // via SfuManager. Per group the switch is a one-way latch (issues #77/#78):
  // outdoor clusters promote at 5 and never demote until the group disperses;
  // meeting rooms start as SFU. Membership for BOTH methods comes from the
  // server's group-update (the connected component), so a mesh client meshes
  // with every group member — not just peers inside its own radius.
  private currentMethod: GroupMethod = 'mesh';
  // Other members of our current mesh group (excludes self). Empty when SFU.
  private meshMembers = new Set<string>();
  private sfuMembers = new Set<string>();
  // Group peers whose track directory we've handed to SfuManager, so we can drop
  // them when they leave the group.
  private knownSfuPeers = new Set<string>();

  // Speaker-aware send policy. `lastLoudAtMs` is the last frame our mic was loud
  // (drives the post-speech hold). The computed camera encoding / screen bitrate
  // are pushed to the WebRtcManager each frame, which no-ops when unchanged.
  private lastLoudAtMs: number | null = null;

  // Throttle for SFU simulcast layer re-selection (see updateSfuLayers).
  private lastLayerUpdate = 0;

  constructor(opts: TransportOpts, make: TransportFactories = {}) {
    this.media = opts.media;
    this.getMyId = opts.getMyId;
    this.onFellBack = opts.onFellBack;
    this.getCameraTileWidth = opts.getCameraTileWidth;

    const makeRtc = make.rtc ?? ((media, events) => new WebRtcManager(media, events));
    const makeSfu = make.sfu ?? ((events) => new SfuManager(events));

    this.rtc = makeRtc(opts.media, {
      onSignal: (toUserId, data) => opts.send({ type: 'signal', to: toUserId, data }),
      onStreamMeta: (toUserId, streamId, kind) =>
        opts.send({ type: 'stream-meta', to: toUserId, streamId, kind }),
      onRemoteStream: opts.onRemoteStream,
      onRemoteStreamRemoved: opts.onRemoteStreamRemoved,
      onPeerClosed: opts.onPeerClosed,
    });

    // SFU transport. Shares the same remote-media event surface as the mesh, so
    // tiles / recording need no changes. onPublished announces our published
    // track directory to the server for relay; onFailed degrades to mesh.
    this.sfu = makeSfu({
      onRemoteStream: opts.onRemoteStream,
      onRemoteStreamRemoved: opts.onRemoteStreamRemoved,
      onPeerClosed: opts.onPeerClosed,
      onPublished: (sessionId, tracks) => opts.send({ type: 'sfu-publish', sessionId, tracks }),
      onFailed: () => this.onSfuFailed(),
    });
  }

  get method(): GroupMethod {
    return this.currentMethod;
  }

  // The peers we are actually in a call with (drives the App's enter/leave
  // chime). SFU membership includes self; mesh membership does not.
  groupPeers(): Set<string> {
    return this.currentMethod === 'sfu' ? this.sfuMembers : this.meshMembers;
  }

  // ---- MediaSink (the toolbar publishes local streams through here) ----

  private active(): WebRtcManager | SfuManager {
    return this.currentMethod === 'sfu' ? this.sfu : this.rtc;
  }

  addLocalStream(stream: MediaStream, kind: StreamKind) {
    this.active().addLocalStream(stream, kind);
  }

  removeLocalStream(stream: MediaStream) {
    this.active().removeLocalStream(stream);
  }

  replaceLocalStream(oldStream: MediaStream, newStream: MediaStream, kind: StreamKind) {
    this.active().replaceLocalStream(oldStream, newStream, kind);
  }

  // ---- server-message entry points (forwarded by App) ----

  async handleSignal(from: string, data: unknown) {
    // Mesh membership is server-authoritative. Drop a signal from someone who is
    // not in our mesh group when we have no peer for them yet. This guards two
    // cases: (a) a stray late signal would otherwise resurrect a peer we just
    // dropped at the group boundary (there is no per-frame proximity loop to tear
    // it down again); (b) while we are on SFU, meshMembers is empty, so we never
    // spin up a stray mesh peer for a group routed through the SFU. Existing peers
    // (hasPeer) always pass so ICE trickle keeps flowing.
    //
    // Ordering: the server emits a joiner's group-update before any initiator can
    // react to its own group-update and relay an offer, so the non-initiator has
    // the joiner in meshMembers by the time the offer arrives. If that invariant
    // ever broke, the offer would be dropped here (simple-peer does not resend)
    // and the pair would fail to connect.
    if (!this.rtc.hasPeer(from) && !this.meshMembers.has(from)) {
      return;
    }
    // If we have no peer for this user, create as non-initiator.
    if (!this.rtc.hasPeer(from)) {
      await this.rtc.createPeer(from, false);
    }
    this.rtc.signal(from, data);
  }

  applyRemoteStreamMeta(from: string, streamId: string, kind: StreamKind | 'removed') {
    this.rtc.applyRemoteStreamMeta(from, streamId, kind);
  }

  // A group peer's published SFU track directory arrived: remember the peer so
  // we can drop the directory when they leave, and hand it to the SFU to pull.
  setPeerTracks(userId: string, sessionId: string, tracks: SfuTrack[]) {
    this.knownSfuPeers.add(userId);
    this.sfu.setPeerTracks(userId, sessionId, tracks);
  }

  // A player left the workspace: drop them from both transports.
  onPeerLeft(userId: string) {
    this.rtc.closePeer(userId);
    this.sfu.removePeer(userId);
    this.knownSfuPeers.delete(userId);
  }

  // Apply a server group-update: the server is the single source of truth for
  // who is in our call. 'sfu' is a one-way latch per group (only ever promotes;
  // the server never demotes mid-group). 'mesh' means we connect directly to
  // every listed member — the full connected component, so a latecomer joining
  // an existing cluster reaches everyone, not just whoever is closest.
  applyGroupUpdate(method: GroupMethod, members: string[]) {
    if (method === 'sfu') {
      const wasMesh = this.currentMethod !== 'sfu';
      this.currentMethod = 'sfu';
      this.sfuMembers = new Set(members);
      this.meshMembers.clear();
      if (wasMesh) {
        // mesh → SFU: drop every mesh peer, then publish our live streams to the
        // SFU. Remote media comes back via sfu-peer-tracks → pull.
        this.rtc.closeAll();
        this.publishLocalToSfu();
      }
      // Forget directory peers no longer in the group.
      const { toClose } = partitionMembers(this.knownSfuPeers, this.sfuMembers);
      for (const id of toClose) {
        this.sfu.removePeer(id);
        this.knownSfuPeers.delete(id);
      }
    } else {
      if (this.currentMethod === 'sfu') {
        // SFU → mesh: the group dispersed/reformed. Tear the SFU transport down
        // before rebuilding the mesh below.
        this.sfu.closeAll();
        this.knownSfuPeers.clear();
      }
      this.currentMethod = 'mesh';
      this.sfuMembers.clear();
      // Reconcile mesh peers against the group: close peers no longer in it,
      // open one to every member we are not yet connected to. createPeer bundles
      // our live streams automatically; initiator election keeps it to one offer.
      const myId = this.getMyId();
      const next = new Set(members.filter((id) => id !== myId));
      const { toClose, toOpen } = partitionMembers(this.rtc.peerIds(), next);
      for (const id of toClose) this.rtc.closePeer(id);
      for (const id of toOpen) {
        void this.rtc.createPeer(id, isInitiator(myId, id));
      }
      this.meshMembers = next;
    }
  }

  private publishLocalToSfu() {
    if (this.media.micStream) this.sfu.addLocalStream(this.media.micStream, 'mic');
    if (this.media.camStream) this.sfu.addLocalStream(this.media.camStream, 'cam');
    if (this.media.screenStream) this.sfu.addLocalStream(this.media.screenStream, 'screen');
  }

  // The SFU peer connection failed: degrade this group to mesh so the call
  // survives rather than dropping. We mesh directly with the group's members
  // (the same set the SFU was serving). (App-token-less environments never reach
  // SFU, so never get here.)
  private onSfuFailed() {
    if (this.currentMethod !== 'sfu') return;
    console.warn('[sfu] connection failed; falling back to mesh');
    this.onFellBack();
    // Reuse the mesh reconciliation (it tears the SFU transport down and opens a
    // peer to every former SFU member). Snapshot members first — it clears the set.
    //
    // Caveat: the server still considers this group SFU-latched, so if another
    // member later joins it will send method='sfu' again and we re-attempt SFU
    // (and may fail again). There is intentionally no "I fell back" message to the
    // server — signaling stays stateless (invariant #2) — so we accept this rare
    // re-try churn rather than add a control path for it.
    this.applyGroupUpdate('mesh', [...this.sfuMembers]);
  }

  // ---- per-frame policies (driven by App's game loop) ----

  // Speaker-aware send policy (issues #70, #74). Each frame we read our own live
  // speaking flag + connected peer count and compute the camera encoding and
  // screen-share ceiling. A post-speech hold (isHeldSpeaking) keeps the high
  // camera rate for a few seconds after we stop talking so the picture doesn't
  // pulse. The WebRtcManager setters no-op when the values are unchanged, so
  // calling every frame is cheap (a two-level policy → changes are infrequent).
  // Mic off → isSpeaking is false and lastLoudAtMs never advances, so we safely
  // count as a quiet peer.
  updateSendPolicy(me: PlayerState, nowMs: number) {
    // SFU sends a single upstream regardless of headcount, so it skips the mesh
    // peer-count throttle entirely — SfuManager publishes a fixed simulcast
    // ladder (the quality floor) and the SFU / receiver pick the layer instead.
    if (this.currentMethod === 'sfu') return;
    if (me.isSpeaking) this.lastLoudAtMs = nowMs;
    const speaking = isHeldSpeaking(me.isSpeaking, this.lastLoudAtMs, nowMs);
    const peerCount = this.rtc.peerCount;
    this.rtc.setCamEncoding(computeCamEncoding(peerCount, speaking));
    this.rtc.setScreenEncoding(computeScreenEncoding(peerCount));
  }

  // Pick each SFU camera's simulcast layer by its rendered tile width (issue
  // #78): small thumbnails take the half layer to save downlink, the stage-sized
  // view takes full. Throttled to ~1s here; setPreferredLayer additionally
  // no-ops when the rid is unchanged, so this is cheap to call from the loop.
  updateSfuLayers(nowMs: number) {
    if (nowMs - this.lastLayerUpdate <= 1000) return;
    this.lastLayerUpdate = nowMs;
    if (this.currentMethod !== 'sfu') return;
    const myId = this.getMyId();
    for (const userId of this.sfuMembers) {
      if (userId === myId) continue;
      const width = this.getCameraTileWidth(userId);
      if (width == null) continue;
      this.sfu.setPreferredLayer(userId, 'cam', computePreferredRid(width));
    }
  }

  // Snapshot the active transport's per-connection getStats diff for the debug
  // console. Only the live path has peers: mesh has one PeerConnection per peer,
  // the SFU one PC split back into per-peer conns (see each collectStats).
  collectStats(): Promise<{ method: GroupMethod; conns: RtcConn[] }> {
    const conns = this.currentMethod === 'sfu' ? this.sfu.collectStats() : this.rtc.collectStats();
    return conns.then((c) => ({ method: this.currentMethod, conns: c }));
  }

  // Symmetric teardown of both transports (App.dispose).
  closeAll() {
    this.rtc.closeAll();
    this.sfu.closeAll();
  }
}
