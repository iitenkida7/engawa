import { createHmac, randomUUID } from 'node:crypto';
import type { GroupMethod } from './types';

// Outbound event webhook (optional, see docs/webhook.md). When EVENT_WEBHOOK_URL
// is set the server POSTs one JSON event as stays and conversations start and
// end. What happens to the events is the receiver's concern. The server only
// keeps the currently-open stays/conversations in memory: a restart drops them
// without an `ended` event (stateless invariant #2).

export type EventType =
  | 'presence.started'
  | 'presence.ended'
  | 'conversation.started'
  | 'conversation.ended';

export type EventData = Record<string, unknown>;
export type Emit = (type: EventType, data: EventData) => void;

// Per-request timeout for the webhook POST. Delivery is best-effort: a slow or
// failing receiver must never hold up the server, so nothing is retried.
const WEBHOOK_TIMEOUT_MS = 5000;

// Length of the anonymous participant id (hex chars of an HMAC-SHA256).
const ANON_ID_LENGTH = 16;

/**
 * How a participant appears in events. With names on it is the display name;
 * otherwise an opaque id that is stable for the same name on the same UTC day
 * within one server process (the salt is random per process), so a receiver can
 * count distinct people per day without learning who they are.
 */
export function participantLabel(
  name: string,
  includeNames: boolean,
  salt: string,
  nowMs: number,
): string {
  if (includeNames) return name;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  return createHmac('sha256', salt).update(`${day}:${name}`).digest('hex').slice(0, ANON_ID_LENGTH);
}

export type GroupSnapshot = {
  memberIds: string[];
  method: GroupMethod;
  // Call zone id of a meeting-room group, null on the open floor.
  zone: string | null;
};

export type OpenConversation = {
  id: string;
  startedAt: number;
  zone: string | null;
  transport: GroupMethod;
  memberIds: string[];
  // Everyone who took part at some point: userId → participant label.
  participants: Map<string, string>;
  maxConcurrent: number;
};

/**
 * Advance the open conversations by one group recompute. Pure.
 *
 * A conversation is a group of 2+ people. A new group continues the open
 * conversation in the same zone it shares the most members with (each open
 * conversation continues at most once), so people joining or leaving keep the
 * conversation going. Unmatched groups start a conversation; unmatched open
 * conversations end (everyone left, it shrank to one person, or it moved zone).
 */
export function trackConversations(
  open: OpenConversation[],
  groups: GroupSnapshot[],
  nowMs: number,
  newId: () => string,
  labelOf: (userId: string) => string,
): { open: OpenConversation[]; started: OpenConversation[]; ended: OpenConversation[] } {
  const live = groups.filter((g) => g.memberIds.length >= 2);

  const pairs: { gi: number; ci: number; overlap: number }[] = [];
  live.forEach((g, gi) => {
    open.forEach((c, ci) => {
      if (c.zone !== g.zone) return;
      const overlap = g.memberIds.filter((id) => c.memberIds.includes(id)).length;
      if (overlap > 0) pairs.push({ gi, ci, overlap });
    });
  });
  pairs.sort((a, b) => b.overlap - a.overlap);

  const matchOf = new Map<number, number>(); // group index → open conversation index
  const claimed = new Set<number>();
  for (const p of pairs) {
    if (matchOf.has(p.gi) || claimed.has(p.ci)) continue;
    matchOf.set(p.gi, p.ci);
    claimed.add(p.ci);
  }

  const next: OpenConversation[] = [];
  const started: OpenConversation[] = [];
  live.forEach((g, gi) => {
    const ci = matchOf.get(gi);
    const prev = ci === undefined ? null : open[ci];
    const participants = new Map(prev?.participants ?? []);
    for (const id of g.memberIds) if (!participants.has(id)) participants.set(id, labelOf(id));
    const conv: OpenConversation = {
      id: prev?.id ?? newId(),
      startedAt: prev?.startedAt ?? nowMs,
      zone: g.zone,
      transport: g.method,
      memberIds: g.memberIds,
      participants,
      maxConcurrent: Math.max(prev?.maxConcurrent ?? 0, g.memberIds.length),
    };
    next.push(conv);
    if (!prev) started.push(conv);
  });
  const ended = open.filter((_, ci) => !claimed.has(ci));
  return { open: next, started, ended };
}

const iso = (ms: number) => new Date(ms).toISOString();
const seconds = (ms: number) => Math.round(ms / 1000);

export type EventRecorder = {
  presenceStarted(userId: string, name: string): void;
  presenceEnded(userId: string): void;
  groupsChanged(workspace: string, groups: GroupSnapshot[]): void;
};

/** Turns join/leave and group recomputes into events. Memory-only. */
export function createEventRecorder(
  emit: Emit,
  opts: { includeNames: boolean; now?: () => number; salt?: string },
): EventRecorder {
  const now = opts.now ?? Date.now;
  const salt = opts.salt ?? randomUUID();
  const presence = new Map<string, { label: string; joinedAt: number }>();
  const conversations = new Map<string, OpenConversation[]>();
  const labelOf = (userId: string) => presence.get(userId)?.label ?? 'unknown';

  return {
    presenceStarted(userId, name) {
      const t = now();
      const label = participantLabel(name, opts.includeNames, salt, t);
      presence.set(userId, { label, joinedAt: t });
      emit('presence.started', { presenceId: userId, participant: label });
    },

    presenceEnded(userId) {
      const p = presence.get(userId);
      if (!p) return;
      presence.delete(userId);
      const t = now();
      emit('presence.ended', {
        presenceId: userId,
        participant: p.label,
        joinedAt: iso(p.joinedAt),
        leftAt: iso(t),
        durationSec: seconds(t - p.joinedAt),
      });
    },

    groupsChanged(workspace, groups) {
      const t = now();
      const r = trackConversations(
        conversations.get(workspace) ?? [],
        groups,
        t,
        randomUUID,
        labelOf,
      );
      if (r.open.length > 0) conversations.set(workspace, r.open);
      else conversations.delete(workspace);
      for (const c of r.ended) {
        emit('conversation.ended', {
          conversationId: c.id,
          zone: c.zone,
          transport: c.transport,
          startedAt: iso(c.startedAt),
          endedAt: iso(t),
          durationSec: seconds(t - c.startedAt),
          participants: [...c.participants.values()],
          participantCount: c.participants.size,
          maxConcurrent: c.maxConcurrent,
        });
      }
      for (const c of r.started) {
        emit('conversation.started', {
          conversationId: c.id,
          zone: c.zone,
          transport: c.transport,
          participants: [...c.participants.values()],
          participantCount: c.participants.size,
        });
      }
    },
  };
}

/**
 * Emit that POSTs each event as JSON to `url`, fire-and-forget. With a secret
 * the raw body is signed: `X-Engawa-Signature: sha256=<hex HMAC-SHA256>`.
 */
export function createWebhookEmit(
  url: string,
  secret: string | undefined,
  fetchFn: typeof fetch = fetch,
  now: () => number = Date.now,
): Emit {
  return (type, data) => {
    const body = JSON.stringify({ id: randomUUID(), type, at: iso(now()), data });
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'user-agent': 'engawa-webhook',
      'x-engawa-event': type,
    };
    if (secret) {
      headers['x-engawa-signature'] =
        `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
    }
    void fetchFn(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    })
      .then((res) => {
        if (!res.ok) console.warn(`[events] webhook ${type} → HTTP ${res.status}`);
      })
      .catch((err) => console.warn(`[events] webhook ${type} failed: ${err}`));
  };
}

/** The recorder configured by env, or null when EVENT_WEBHOOK_URL is unset/invalid. */
export function createEventRecorderFromEnv(
  env: Record<string, string | undefined> = process.env,
): EventRecorder | null {
  const url = env.EVENT_WEBHOOK_URL?.trim();
  if (!url) return null;
  try {
    const { protocol } = new URL(url);
    if (protocol !== 'https:' && protocol !== 'http:') throw new Error(protocol);
  } catch {
    console.warn('[events] EVENT_WEBHOOK_URL is not an http(s) URL; events disabled');
    return null;
  }
  const emit = createWebhookEmit(url, env.EVENT_WEBHOOK_SECRET?.trim() || undefined);
  return createEventRecorder(emit, { includeNames: env.EVENT_INCLUDE_NAMES === 'true' });
}
