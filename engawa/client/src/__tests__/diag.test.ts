import { describe, expect, it } from 'bun:test';
import type { NetLogEntry } from '@/core/netlog';
import {
  attributeBlame,
  describeVerdict,
  diagnoseConn,
  diagnoseConns,
  formatDiagReport,
  peerQualityRows,
  summarizePeers,
  summarizeTierHistory,
} from '@/rtc/diag';
import type { RtcConn, RtcStreamRate } from '@/rtc/rtcstats';

const recv = (over: Partial<RtcStreamRate> = {}): RtcStreamRate => ({
  dir: 'recv',
  kind: 'audio',
  ssrc: 1,
  kbps: 40,
  packetLossPct: 0,
  jitterMs: 5,
  ...over,
});
const send = (over: Partial<RtcStreamRate> = {}): RtcStreamRate => ({
  dir: 'send',
  kind: 'audio',
  ssrc: 2,
  kbps: 40,
  packetLossPct: 0,
  ...over,
});
const conn = (id: string, streams: RtcStreamRate[], over: Partial<RtcConn> = {}): RtcConn => ({
  id,
  rttMs: 40,
  streams,
  ...over,
});
const names: Record<string, string> = { a: 'Alice', b: 'Bob', c: 'Carol' };
const nameOf = (id: string) => names[id] ?? '';

describe('diagnoseConn', () => {
  it('is good with no reasons on a clean link', () => {
    const v = diagnoseConn(conn('a', [recv(), send()]));
    expect(v.tier).toBe(0);
    expect(v.reasons).toEqual([]);
    expect(v.sendBad).toBe(false);
    expect(v.recvBad).toBe(false);
  });

  it('names receive loss with its direction and grades it', () => {
    const v = diagnoseConn(conn('a', [recv({ packetLossPct: 6 })]));
    expect(v.tier).toBe(2);
    expect(v.reasons[0]).toContain('受信ロス 6%');
    expect(v.recvBad).toBe(true);
    expect(v.sendBad).toBe(false);
  });

  it('flags send loss, RTT, CPU and notes TURN / low fps without raising the tier', () => {
    const v = diagnoseConn(
      conn(
        'a',
        [
          send({ packetLossPct: 3, qualityLimitationReason: 'cpu' }),
          recv({ kind: 'video', kbps: 200, fps: 4 }),
        ],
        { rttMs: 300, transport: 'TURN中継' },
      ),
    );
    expect(v.tier).toBe(2); // cpu floors at 2
    expect(v.sendBad).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('送信ロス 3%'))).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('RTT 300ms'))).toBe(true);
    expect(v.reasons.some((r) => r.startsWith('CPU'))).toBe(true);
    expect(v.notes.some((n) => n.includes('4fps'))).toBe(true);
    expect(v.notes.some((n) => n.includes('TURN'))).toBe(true);
  });

  it('ignores the uplink estimate while sending too little to probe', () => {
    const v = diagnoseConn(conn('a', [send({ kbps: 40 })], { availableOutgoingKbps: 300 }));
    expect(v.tier).toBe(0);
    expect(v.reasons).toEqual([]);
  });
});

describe('diagnoseConns', () => {
  it('resolves names, keeps labels, marks upstream and sorts worst first', () => {
    const out = diagnoseConns(
      [
        conn('a', [recv()]),
        conn('up', [send()], { label: '自分 → SFU' }),
        conn('zzzzzzzzzz', [recv({ packetLossPct: 12 })]),
      ],
      nameOf,
      'up',
    );
    expect(out.map((d) => d.diag.name)).toEqual(['zzzzzzzz', 'Alice', '自分 → SFU']);
    expect(out[2].diag.isUpstream).toBe(true);
    expect(out[2].diag.isPeer).toBe(false);
    expect(out[0].diag.isPeer).toBe(true);
  });
});

describe('attributeBlame', () => {
  const diags = (cs: RtcConn[]) => diagnoseConns(cs, nameOf, 'up').map((d) => d.diag);

  it('blames the one peer whose receive side is bad', () => {
    const lines = attributeBlame(
      diags([conn('a', [recv({ packetLossPct: 8 })]), conn('b', [recv()]), conn('c', [recv()])]),
    );
    expect(lines.join()).toContain('Alice さん側');
  });

  it('blames our downlink when every peer is bad', () => {
    const lines = attributeBlame(
      diags([conn('a', [recv({ packetLossPct: 8 })]), conn('b', [recv({ jitterMs: 50 })])]),
    );
    expect(lines.join()).toContain('自分の下り回線');
  });

  it('blames our uplink when the SFU upstream is bad', () => {
    const lines = attributeBlame(
      diags([
        conn('a', [recv()]),
        conn('up', [send({ packetLossPct: 6 })], { label: '自分 → SFU' }),
      ]),
    );
    expect(lines.join()).toContain('上り回線');
  });

  it('says it cannot tell with a single bad peer', () => {
    expect(attributeBlame(diags([conn('a', [recv({ packetLossPct: 8 })])])).join()).toContain(
      '切り分けできません',
    );
  });

  it('reports all good', () => {
    expect(attributeBlame(diags([conn('a', [recv()]), conn('b', [recv()])]))).toEqual([
      '全接続良好です',
    ]);
  });
});

describe('summarizeTierHistory / describeVerdict', () => {
  it('counts changes and flags a flapping link as unstable', () => {
    const h = summarizeTierHistory([0, 2, 0, 2, 0, 0]);
    expect(h).toMatchObject({
      samples: 6,
      current: 0,
      worst: 2,
      goodPct: 67,
      changes: 4,
      unstable: true,
    });
    expect(describeVerdict(0, h)).toContain('不安定');
  });

  it('notes a recent dip on an otherwise stable good link', () => {
    const h = summarizeTierHistory([2, 2, 0, 0, 0]);
    expect(h.unstable).toBe(false);
    expect(describeVerdict(0, h)).toBe('良好（直近に悪化あり）');
  });

  it('handles an empty history', () => {
    expect(summarizeTierHistory([])).toMatchObject({ samples: 0, unstable: false });
    expect(describeVerdict(1, undefined)).toBe('やや注意');
  });
});

describe('report', () => {
  const now = new Date(2026, 0, 1, 12, 0, 0).getTime();
  const q = (t: number, peers: unknown[]): NetLogEntry => ({
    t,
    type: 'quality',
    detail: { conns: peers.length, rttMs: 50, sendKbps: 40, recvKbps: 80, peers },
  });
  const log: NetLogEntry[] = [
    { t: now - 20 * 60_000, type: 'peer-connect', detail: { old: true } }, // outside window
    q(now - 10_000, [
      { name: 'Alice', tier: 2, recvLossPct: 7 },
      { name: 'Bob', tier: 0 },
    ]),
    { t: now - 5_000, type: 'net-tier', detail: { from: 0, to: 1 } },
    q(now - 5_000, [
      { name: 'Alice', tier: 0, recvLossPct: 0 },
      { name: 'Bob', tier: 0 },
    ]),
  ];

  it('summarizes peers worst first', () => {
    const rows = summarizePeers(log.filter((e) => e.type === 'quality'));
    expect(rows[0]).toMatchObject({
      name: 'Alice',
      samples: 2,
      goodPct: 50,
      worst: 2,
      maxRecvLoss: 7,
    });
    expect(rows[1]).toMatchObject({ name: 'Bob', goodPct: 100, worst: 0 });
  });

  it('builds peer rows for the quality log', () => {
    const d = diagnoseConns([conn('a', [recv({ packetLossPct: 3 })])], nameOf, 'up');
    expect(peerQualityRows(d)).toEqual([
      {
        name: 'Alice',
        tier: 1,
        rttMs: 40,
        sendLossPct: undefined,
        recvLossPct: 3,
        recvJitterMs: 5,
      },
    ]);
  });

  it('formats a Markdown report with verdicts, history and windowed events', () => {
    const conns = diagnoseConns([conn('a', [recv({ packetLossPct: 8 })])], nameOf, 'up');
    const md = formatDiagReport({
      now,
      userAgent: 'UA/1',
      env: { 'CPU コア数': 8, missing: undefined },
      method: 'sfu',
      conns: conns.map((c) => ({ ...c, history: summarizeTierHistory([0, 2, 2]) })),
      blame: attributeBlame(conns.map((c) => c.diag)),
      log,
    });
    expect(md).toContain('# engawa 通話品質 診断レポート');
    expect(md).toContain('通話方式: SFU');
    expect(md).toContain('CPU コア数: 8');
    expect(md).not.toContain('missing');
    expect(md).toContain('### Alice — 不良');
    expect(md).toContain('受信ロス 8%');
    expect(md).toContain('直近 3 秒: 良好 33%');
    expect(md).toContain('Alice(不良)');
    expect(md).toContain('net-tier {"from":0,"to":1}');
    expect(md).not.toContain('peer-connect');
  });
});
