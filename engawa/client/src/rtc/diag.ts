// Call-quality diagnosis for the debug console: a per-connection verdict with
// human-readable reasons, a "whose side is it?" attribution across connections,
// a stability summary over a short tier history, and a Markdown report meant to
// be pasted into Claude for analysis. All pure (inputs in, strings out) so the
// DOM in debug-console.ts stays a thin renderer and the rules are unit-tested.
//
// Verdict strings are Japanese (like describeTransport): engawa is an internal
// tool and the report is read by a human or Claude, not parsed.

import type { NetLogEntry } from '@/core/netlog';
import type { GroupMethod } from '@/core/types';
import { AVAIL_SIGNAL_MIN_SEND_KBPS, classifySample, type NetTier } from '@/rtc/netquality';
import { describeStream, type RtcConn, summarizeConnQuality } from '@/rtc/rtcstats';

export const TIER_LABELS: Record<NetTier, string> = {
  0: '良好',
  1: 'やや注意',
  2: '不良',
  3: '深刻',
};

// Thresholds below which a metric is not worth calling out. They match the
// tier-1 thresholds of netquality.ts so a reason exists for every non-zero tier.
const LOSS_WARN_PCT = 2;
const RTT_WARN_MS = 250;
const JITTER_WARN_MS = 30;
const AVAIL_WARN_KBPS = 900;
const LOW_FPS = 10;

export type ConnVerdict = {
  tier: NetTier;
  reasons: string[]; // what pushes the tier up (empty when good)
  notes: string[]; // informational, never affects the tier (e.g. TURN relay)
  sendBad: boolean; // our → their direction degraded
  recvBad: boolean; // their → our direction degraded
};

// Pure: grade one connection and say why. The tier reuses classifySample so the
// console agrees with the tile quality dots and the degradation ladder.
export function diagnoseConn(c: RtcConn): ConnVerdict {
  const q = summarizeConnQuality([c]);
  let tier = classifySample(q);
  const reasons: string[] = [];
  const notes: string[] = [];
  let sendBad = false;
  let recvBad = false;

  if ((q.sendLossPct ?? 0) >= LOSS_WARN_PCT) {
    reasons.push(`送信ロス ${q.sendLossPct}%（自分→相手）`);
    sendBad = true;
  }
  if ((q.recvLossPct ?? 0) >= LOSS_WARN_PCT) {
    reasons.push(`受信ロス ${q.recvLossPct}%（相手→自分）`);
    recvBad = true;
  }
  if ((q.rttMs ?? 0) >= RTT_WARN_MS) reasons.push(`RTT ${q.rttMs}ms（遅延大）`);
  // classifySample ignores jitter (the receiver widens its jitter buffer for
  // it), but the user still hears it as delay/choppiness, so here it counts
  // as at least "fair".
  if ((q.recvJitterMs ?? 0) >= JITTER_WARN_MS) {
    reasons.push(`ジッタ ${q.recvJitterMs}ms（揺らぎ大）`);
    recvBad = true;
    tier = Math.max(tier, 1) as NetTier;
  }
  if (
    q.availableOutgoingKbps !== undefined &&
    q.sendKbps >= AVAIL_SIGNAL_MIN_SEND_KBPS &&
    q.availableOutgoingKbps < AVAIL_WARN_KBPS
  ) {
    reasons.push(`上り推定帯域 ${q.availableOutgoingKbps}kbps（細い）`);
    sendBad = true;
  }
  if (q.cpuLimited) reasons.push('CPU 制限（自分の端末が高負荷）');

  for (const s of c.streams) {
    if (s.dir === 'send' && s.qualityLimitationReason === 'bandwidth') {
      notes.push(`${s.kind === 'audio' ? '音声' : '映像'}送信が帯域制限で画質低下中`);
    }
    if (
      s.dir === 'recv' &&
      s.kind === 'video' &&
      s.kbps > 0 &&
      s.fps !== undefined &&
      s.fps < LOW_FPS
    ) {
      notes.push(`受信映像 ${s.fps}fps（カクつき）`);
    }
  }
  if (c.transport === 'TURN中継') notes.push('TURN 中継経由（直結より 1 ホップ遅い）');

  return { tier, reasons, notes, sendBad, recvBad };
}

export type ConnDiag = {
  name: string;
  isPeer: boolean; // a real remote person (not an SFU synthetic entry)
  isUpstream: boolean; // the SFU "self → SFU" entry (our uplink)
  verdict: ConnVerdict;
};

// Pure: diagnose every connection, worst first (stable for equal tiers).
// `nameOf` resolves a peer id to a display name ('' when unknown); synthetic SFU
// entries keep their label. `upstreamId` marks the SFU "self → SFU" entry.
export function diagnoseConns(
  conns: readonly RtcConn[],
  nameOf: (id: string) => string,
  upstreamId: string,
): { conn: RtcConn; diag: ConnDiag }[] {
  return conns
    .map((conn) => ({
      conn,
      diag: {
        name: conn.label ?? (nameOf(conn.id) || conn.id.slice(0, 8)),
        isPeer: conn.label === undefined,
        isUpstream: conn.id === upstreamId,
        verdict: diagnoseConn(conn),
      },
    }))
    .sort((a, b) => b.diag.verdict.tier - a.diag.verdict.tier);
}

// Pure: guess whose side is to blame, from how the bad connections are spread.
// One person bad while the rest are fine → their network/device. Everyone bad
// → ours. Our uplink (SFU upstream, send-side signals, CPU) is called out on
// its own. Heuristics, worded as likelihoods — the report gives the raw numbers.
export function attributeBlame(diags: ConnDiag[]): string[] {
  const peers = diags.filter((d) => d.isPeer);
  const out: string[] = [];
  if (diags.length === 0) return out;

  const cpu = diags.some((d) => d.verdict.reasons.some((r) => r.startsWith('CPU')));
  const up = diags.find((d) => d.isUpstream);
  const upBad = up !== undefined && up.verdict.tier >= 1 && !cpu;
  const sendBadPeers = peers.filter((d) => d.verdict.sendBad);
  const recvBadPeers = peers.filter((d) => d.verdict.tier >= 1 && !d.verdict.sendBad);
  const badPeers = peers.filter((d) => d.verdict.tier >= 1);

  if (cpu)
    out.push(
      '自分の端末が CPU 高負荷です（他アプリ・タブを閉じる、カメラ/背景効果を切ると改善しやすい）',
    );
  if (upBad) out.push('自分 → SFU の上り回線が劣化しています（自分の回線が原因の可能性が高い）');
  if (peers.length >= 2 && sendBadPeers.length === peers.length) {
    out.push('全員への送信が劣化しています（自分の上り回線が原因の可能性が高い）');
  }

  if (peers.length >= 2 && recvBadPeers.length === peers.length) {
    out.push('全員からの受信が劣化しています（自分の下り回線・Wi-Fi が原因の可能性が高い）');
  } else if (recvBadPeers.length > 0 && recvBadPeers.length < peers.length) {
    const names = recvBadPeers.map((d) => `${d.name} さん`).join('、');
    out.push(
      `${names}からの受信だけが劣化しています（${names}側の上り回線・端末が原因の可能性が高い）`,
    );
  } else if (peers.length === 1 && badPeers.length === 1 && !upBad) {
    out.push(
      '相手が 1 人のため自分側か相手側か切り分けできません（相手のレポートとも比較してください）',
    );
  }

  if (out.length === 0) {
    out.push(badPeers.length === 0 ? '全接続良好です' : '軽微な劣化のみです');
  }
  return out;
}

export type TierHistorySummary = {
  samples: number;
  current?: NetTier;
  worst?: NetTier;
  goodPct: number; // share of samples at tier 0
  changes: number; // tier transitions between consecutive samples
  unstable: boolean;
};

// A connection that flips tier this often within the window reads as "unstable"
// even when its average is fine — the user hears it as intermittent dropouts.
export const UNSTABLE_CHANGES = 4;

// Pure: stability over a tier history (oldest first).
export function summarizeTierHistory(tiers: readonly NetTier[]): TierHistorySummary {
  if (tiers.length === 0) return { samples: 0, goodPct: 100, changes: 0, unstable: false };
  let changes = 0;
  let good = 0;
  let worst: NetTier = 0;
  tiers.forEach((t, i) => {
    if (i > 0 && t !== tiers[i - 1]) changes++;
    if (t === 0) good++;
    if (t > worst) worst = t;
  });
  return {
    samples: tiers.length,
    current: tiers[tiers.length - 1],
    worst,
    goodPct: Math.round((good / tiers.length) * 100),
    changes,
    unstable: changes >= UNSTABLE_CHANGES,
  };
}

// Pure: the one-line state shown in the console header for a connection.
export function describeVerdict(tier: NetTier, h: TierHistorySummary | undefined): string {
  let s = TIER_LABELS[tier];
  if (h?.unstable) s += `・不安定（${h.samples}秒で ${h.changes} 回変動）`;
  else if (h && tier === 0 && (h.worst ?? 0) >= 2) s += '（直近に悪化あり）';
  return s;
}

// ─── Claude-ready Markdown report ───────────────────────────────────────────

export type DiagReportInput = {
  now: number;
  userAgent: string;
  env?: Record<string, string | number | undefined>; // cores, effectiveType, …
  method: GroupMethod;
  conns: { conn: RtcConn; diag: ConnDiag; history?: TierHistorySummary }[];
  blame: string[];
  log: readonly NetLogEntry[]; // merged net log (lifecycle + quality), oldest first
};

// How far back the report looks into the net log, and how many lifecycle
// events it lists — enough to see the incident, small enough to paste.
export const REPORT_WINDOW_MS = 10 * 60_000;
export const REPORT_MAX_EVENTS = 60;

const hms = (t: number) => {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const cell = (v: unknown) => (v === undefined || v === null || v === '' ? '-' : String(v));
const isNum = (v: unknown): v is number => typeof v === 'number';

// A per-peer row stored in each 'quality' net-log sample (see App.sampleQuality).
export type PeerQuality = {
  name: string;
  tier: NetTier;
  rttMs?: number;
  sendLossPct?: number;
  recvLossPct?: number;
  recvJitterMs?: number;
};

// Pure: compact per-peer rows for a quality net-log sample.
export function peerQualityRows(diags: { conn: RtcConn; diag: ConnDiag }[]): PeerQuality[] {
  return diags.map(({ conn, diag }) => {
    const q = summarizeConnQuality([conn]);
    return {
      name: diag.name,
      tier: diag.verdict.tier,
      rttMs: q.rttMs,
      sendLossPct: q.sendLossPct,
      recvLossPct: q.recvLossPct,
      recvJitterMs: q.recvJitterMs,
    };
  });
}

// Pure: build the Markdown report. Sections go from conclusion to raw data so a
// human can stop early and Claude gets everything it needs.
export function formatDiagReport(input: DiagReportInput): string {
  const L: string[] = [];
  const since = input.now - REPORT_WINDOW_MS;
  const recent = input.log.filter((e) => e.t >= since);
  const quality = recent.filter((e) => e.type === 'quality');
  const events = recent.filter((e) => e.type !== 'quality').slice(-REPORT_MAX_EVENTS);

  L.push('# engawa 通話品質 診断レポート');
  L.push('');
  L.push(
    '> Claude へ: これはブラウザ仮想オフィス engawa（WebRTC。2 人以上は Cloudflare Realtime SFU 経由、未設定時は P2P メッシュ）の' +
      'クライアント側計測値です。**どの接続・誰の回線/端末・どの方向（上り/下り）が品質低下の原因か**を数値の根拠つきで推定し、' +
      '本人ができる対処と、アプリ側で改善できる点を提案してください。',
  );
  L.push('');

  L.push('## 環境');
  L.push(`- 取得時刻: ${new Date(input.now).toISOString()}（ローカル ${hms(input.now)}）`);
  L.push(
    `- 通話方式: ${input.method === 'sfu' ? 'SFU' : 'P2P メッシュ'} / 接続数: ${input.conns.length}`,
  );
  L.push(`- UA: ${input.userAgent || '-'}`);
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (v !== undefined) L.push(`- ${k}: ${v}`);
  }
  L.push('');

  L.push('## 自動判定');
  for (const b of input.blame) L.push(`- ${b}`);
  if (input.blame.length === 0) L.push('- 接続なし');
  L.push('');

  L.push('## 接続ごとの現在値（直近 1 秒）');
  if (input.conns.length === 0) L.push('接続なし');
  for (const { conn, diag, history } of input.conns) {
    const v = diag.verdict;
    L.push(`### ${diag.name} — ${describeVerdict(v.tier, history)}`);
    if (v.reasons.length) L.push(`- 要因: ${v.reasons.join(' / ')}`);
    if (v.notes.length) L.push(`- 補足: ${v.notes.join(' / ')}`);
    const path = [
      conn.transport && `経路 ${conn.transport}`,
      isNum(conn.rttMs) && `RTT ${conn.rttMs}ms`,
      isNum(conn.availableOutgoingKbps) && `上り推定帯域 ${conn.availableOutgoingKbps}kbps`,
    ].filter(Boolean);
    if (path.length) L.push(`- ${path.join(' / ')}`);
    if (history && history.samples > 0) {
      L.push(
        `- 直近 ${history.samples} 秒: 良好 ${history.goodPct}% / 最悪 ${TIER_LABELS[history.worst ?? 0]} / 変動 ${history.changes} 回`,
      );
    }
    if (conn.streams.length) {
      L.push('');
      L.push('| 方向 | 種別 | 詳細 |');
      L.push('|---|---|---|');
      for (const s of conn.streams) {
        L.push(
          `| ${s.dir === 'send' ? '送信' : '受信'} | ${s.kind === 'audio' ? '音声' : '映像'} | ${describeStream(s).join(' · ')} |`,
        );
      }
    }
    L.push('');
  }

  L.push(`## 直近 ${REPORT_WINDOW_MS / 60_000} 分の推移（5 秒ごと・全接続の最悪値）`);
  if (quality.length === 0) {
    L.push('記録なし');
  } else {
    L.push(
      '| 時刻 | 接続 | RTT | 送信ロス% | 受信ロス% | ジッタms | 上りkbps | 下りkbps | 推定帯域 | CPU | 判定が悪い相手 |',
    );
    L.push('|---|---|---|---|---|---|---|---|---|---|---|');
    for (const e of quality) {
      const d = e.detail ?? {};
      const peers = Array.isArray(d.peers) ? (d.peers as PeerQuality[]) : [];
      const bad = peers
        .filter((p) => p.tier >= 1)
        .map((p) => `${p.name}(${TIER_LABELS[p.tier]})`)
        .join(' ');
      L.push(
        `| ${hms(e.t)} | ${cell(d.conns)} | ${cell(d.rttMs)} | ${cell(d.sendLossPct)} | ${cell(d.recvLossPct)} | ${cell(d.recvJitterMs)} | ${cell(d.sendKbps)} | ${cell(d.recvKbps)} | ${cell(d.availableOutgoingKbps)} | ${d.cpuLimited ? '⚠' : ''} | ${bad || '-'} |`,
      );
    }
    const perPeer = summarizePeers(quality);
    if (perPeer.length) {
      L.push('');
      L.push('### 相手ごとの集計（同期間）');
      L.push(
        '| 相手 | サンプル | 良好% | 最悪 | 最大RTT | 最大送信ロス% | 最大受信ロス% | 最大ジッタms |',
      );
      L.push('|---|---|---|---|---|---|---|---|');
      for (const p of perPeer) {
        L.push(
          `| ${p.name} | ${p.samples} | ${p.goodPct} | ${TIER_LABELS[p.worst]} | ${cell(p.maxRtt)} | ${cell(p.maxSendLoss)} | ${cell(p.maxRecvLoss)} | ${cell(p.maxJitter)} |`,
        );
      }
    }
  }
  L.push('');

  L.push(`## 接続イベント（直近 ${REPORT_WINDOW_MS / 60_000} 分・最大 ${REPORT_MAX_EVENTS} 件）`);
  if (events.length === 0) L.push('なし');
  for (const e of events) {
    L.push(`- ${hms(e.t)} ${e.type}${e.detail ? ` ${JSON.stringify(e.detail)}` : ''}`);
  }
  L.push('');

  L.push('## 読み方・判定基準');
  L.push(
    '- 判定: 良好 / やや注意（ロス≥2% or RTT≥250ms or 上り推定<900kbps or 受信ジッタ≥30ms）/ 不良（ロス≥5% or RTT≥500ms or 推定<500kbps or CPU 制限）/ 深刻（ロス≥10% or RTT≥800ms or 推定<250kbps）',
  );
  L.push(
    '- 送信ロス = 相手（SFU では SFU）が報告した自分の送信パケットの損失。受信ロス = 自分が受け取る側で数えた損失',
  );
  L.push(
    '- SFU 方式では「自分 → SFU」が自分の上り回線そのもの。相手ごとの行は各人の上り＋SFU→自分の下りを反映',
  );
  L.push('- 1 人だけ受信が悪い → その人の上り/端末、全員悪い → 自分の下り/Wi-Fi が疑わしい');
  L.push(
    '- 制限:cpu = エンコーダが CPU 不足、制限:bandwidth = 帯域不足で画質を下げている。enc = 1 フレームのエンコード時間',
  );
  L.push(
    '- 回線劣化時はアプリが自動で映像ビットレート→解像度→カメラ停止の順に落とす（net-tier イベント）',
  );
  return L.join('\n');
}

type PeerAgg = {
  name: string;
  samples: number;
  goodPct: number;
  worst: NetTier;
  maxRtt?: number;
  maxSendLoss?: number;
  maxRecvLoss?: number;
  maxJitter?: number;
};

const maxOf = (a: number | undefined, b: number | undefined) =>
  b === undefined ? a : a === undefined ? b : Math.max(a, b);

// Pure: per-peer worst-case aggregation over the quality samples' peer rows.
export function summarizePeers(quality: readonly NetLogEntry[]): PeerAgg[] {
  const by = new Map<string, PeerAgg & { good: number }>();
  for (const e of quality) {
    const peers =
      e.detail && Array.isArray(e.detail.peers) ? (e.detail.peers as PeerQuality[]) : [];
    for (const p of peers) {
      const a = by.get(p.name) ?? {
        name: p.name,
        samples: 0,
        good: 0,
        goodPct: 0,
        worst: 0 as NetTier,
      };
      a.samples++;
      if (p.tier === 0) a.good++;
      if (p.tier > a.worst) a.worst = p.tier;
      a.maxRtt = maxOf(a.maxRtt, p.rttMs);
      a.maxSendLoss = maxOf(a.maxSendLoss, p.sendLossPct);
      a.maxRecvLoss = maxOf(a.maxRecvLoss, p.recvLossPct);
      a.maxJitter = maxOf(a.maxJitter, p.recvJitterMs);
      by.set(p.name, a);
    }
  }
  return [...by.values()]
    .map(({ good, ...a }) => ({ ...a, goodPct: Math.round((good / a.samples) * 100) }))
    .sort((x, y) => y.worst - x.worst || x.goodPct - y.goodPct);
}
