import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { isInitiator } from '@/core/proximity';
import {
  PEER_CONNECT_STALL_MS,
  PEER_DISCONNECTED_TIMEOUT_MS,
  PEER_RETRY_MAX_MS,
} from '@/core/reconnect';
import { MeshRecovery } from '@/rtc/mesh-recovery';

// Two ids where 'me' is the elected initiator towards INIT_PEER and not towards
// RESP_PEER, whatever the election rule is.
const ME = 'm';
const [INIT_PEER, RESP_PEER] = ['a', 'z'].sort((x, y) =>
  isInitiator(ME, x) === isInitiator(ME, y) ? 0 : isInitiator(ME, x) ? -1 : 1,
);

let now = 1000;
const clock = () => spyOn(performance, 'now').mockImplementation(() => now);

function setup(members: string[]) {
  const peers = new Set<string>();
  const ready = new Set<string>();
  const log: string[] = [];
  const memberSet = new Set(members);
  const rec = new MeshRecovery({
    getMyId: () => ME,
    isMeshMember: (id) => memberSet.has(id),
    hasPeer: (id) => peers.has(id),
    isPeerReady: (id) => ready.has(id),
    createPeer: (id, initiator) => {
      peers.add(id);
      log.push(`create ${id} ${initiator}`);
    },
    closePeer: (id) => {
      peers.delete(id);
      log.push(`close ${id}`);
    },
    sendRestart: (id) => log.push(`restart ${id}`),
  });
  return { rec, peers, ready, log, memberSet };
}

afterEach(() => {
  now = 1000;
});

describe('MeshRecovery', () => {
  it('rebuilds a member that died, after the backoff', () => {
    clock();
    const { rec, log } = setup([INIT_PEER]);
    rec.onPeerClosed(INIT_PEER);
    rec.tick(now);
    expect(log).toEqual([]);
    rec.tick(now + PEER_RETRY_MAX_MS);
    expect(log).toEqual([`create ${INIT_PEER} true`]);
  });

  it('a non-initiator rebuild also nudges the peer to restart', () => {
    clock();
    const { rec, log } = setup([RESP_PEER]);
    rec.onPeerClosed(RESP_PEER);
    rec.tick(now + PEER_RETRY_MAX_MS);
    expect(log).toEqual([`create ${RESP_PEER} false`, `restart ${RESP_PEER}`]);
  });

  it('does not rebuild a peer that left the group', () => {
    clock();
    const { rec, log, memberSet } = setup([INIT_PEER]);
    rec.onPeerClosed(INIT_PEER);
    memberSet.delete(INIT_PEER);
    rec.tick(now + PEER_RETRY_MAX_MS);
    expect(log).toEqual([]);
  });

  it('tears down a peer that never connects, and disarms once connected', () => {
    clock();
    const { rec, ready, log } = setup([INIT_PEER, RESP_PEER]);
    rec.createPeer(INIT_PEER, true);
    rec.createPeer(RESP_PEER, false);
    ready.add(RESP_PEER);
    rec.onPeerConnected(RESP_PEER);
    log.length = 0;
    rec.tick(now + PEER_CONNECT_STALL_MS);
    expect(log).toEqual([`close ${INIT_PEER}`]);
  });

  it('closes a peer stuck in disconnected; a reconnect clears the timer', () => {
    clock();
    const { rec, log } = setup([INIT_PEER, RESP_PEER]);
    rec.onIceState(INIT_PEER, 'disconnected');
    rec.onIceState(RESP_PEER, 'disconnected');
    rec.onIceState(RESP_PEER, 'connected');
    rec.tick(now + PEER_DISCONNECTED_TIMEOUT_MS);
    expect(log).toEqual([`close ${INIT_PEER}`]);
  });

  it('honours a restart request only as initiator, debounced', () => {
    clock();
    const { rec, log } = setup([INIT_PEER, RESP_PEER]);
    rec.onRestartRequest(RESP_PEER);
    expect(log).toEqual([]);
    rec.onRestartRequest(INIT_PEER);
    rec.onRestartRequest(INIT_PEER);
    expect(log).toEqual([`close ${INIT_PEER}`, `create ${INIT_PEER} true`]);
    now += 3000;
    rec.onRestartRequest(INIT_PEER);
    expect(log.length).toBe(4);
  });

  it('clear(keep) drops records for everyone else', () => {
    clock();
    const { rec, log } = setup([INIT_PEER, RESP_PEER]);
    rec.onPeerClosed(INIT_PEER);
    rec.onPeerClosed(RESP_PEER);
    rec.clear(new Set([INIT_PEER]));
    rec.tick(now + PEER_RETRY_MAX_MS);
    expect(log).toEqual([`create ${INIT_PEER} true`]);
  });
});
