# Event Webhook API

English | [日本語](./webhook.ja.md)

The engawa server can notify an external endpoint, by **JSON HTTP POST**, when people join and leave and when
conversations start and end. This is optional. The server itself stores nothing (invariant #2): storing,
aggregating and visualising the events is up to the receiver. A sample Google Apps Script receiver lives in
[`examples/webhook-gas/`](../examples/webhook-gas/).

## Configuration (environment variables)

| Variable | Default | Description |
|---|---|---|
| `EVENT_WEBHOOK_URL` | unset | Destination URL (`http://` or `https://`). **When unset the feature is off** and nothing is sent. |
| `EVENT_WEBHOOK_SECRET` | unset | When set, an HMAC-SHA256 signature of the request body is sent in the `X-Engawa-Signature` header. |
| `EVENT_INCLUDE_NAMES` | `false` | Only when `true` are participants sent by **display name**. Otherwise they are anonymous ids (see below). |

## Request

One POST per event.

```
POST {EVENT_WEBHOOK_URL}
Content-Type: application/json
User-Agent: engawa-webhook
X-Engawa-Event: conversation.ended
X-Engawa-Signature: sha256=<hex HMAC-SHA256>   ← only when EVENT_WEBHOOK_SECRET is set
```

### Body (common envelope)

```json
{
  "id": "6f1c1f0e-3b0a-4c55-9a8e-2a7d5f0f6c11",
  "type": "conversation.ended",
  "at": "2026-10-24T01:05:00.000Z",
  "data": { }
}
```

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique per event. Use it to deduplicate. |
| `type` | string | Event type (table below). Same value as the `X-Engawa-Event` header. |
| `at` | string (ISO 8601, UTC) | When the server issued the event. |
| `data` | object | Type-specific payload (below). |

### Verifying the signature

With `EVENT_WEBHOOK_SECRET` set, requests carry `X-Engawa-Signature: sha256=<hex>`, where `<hex>` is the
HMAC-SHA256 of the **raw request body bytes** keyed with the secret, in hex. Compute the same on the receiver and
compare in constant time (use the raw body, not re-serialised JSON).

```js
// Verification in Node.js
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-engawa-signature'] ?? ''));
```

Receivers that cannot read headers (such as Google Apps Script) can instead check a token carried in the URL
query (for example `https://script.google.com/macros/s/.../exec?token=...`).

## Events

| `type` | When |
|---|---|
| `presence.started` | Someone joined (not sent when a reconnect resumes the session) |
| `presence.ended` | Someone left (closed the tab, lost the connection and did not return within 15 s, or was replaced by a newer tab of the same browser) |
| `conversation.started` | A conversation of 2 or more people started |
| `conversation.ended` | A conversation ended (everyone left, it shrank to one person, or it moved to another zone) |

### `presence.started`

```json
{ "presenceId": "0b6c6f2e-...", "participant": "3f9a1c0d2b7e4a51" }
```

### `presence.ended`

```json
{
  "presenceId": "0b6c6f2e-...",
  "participant": "3f9a1c0d2b7e4a51",
  "joinedAt": "2026-10-24T00:10:00.000Z",
  "leftAt": "2026-10-24T03:40:12.000Z",
  "durationSec": 12612
}
```

| Field | Type | Description |
|---|---|---|
| `presenceId` | string | Id of one stay. Same value in `started` and `ended`. |
| `participant` | string | The participant (see "How participants are represented"). |
| `joinedAt` / `leftAt` | string (ISO 8601, UTC) | When they joined and left. |
| `durationSec` | number | Length of the stay in seconds (rounded). |

### `conversation.started`

```json
{
  "conversationId": "c2a8d7a4-...",
  "zone": "meeting-1",
  "transport": "sfu",
  "participants": ["3f9a1c0d2b7e4a51", "a07b55e9c1d24f80"],
  "participantCount": 2
}
```

### `conversation.ended`

```json
{
  "conversationId": "c2a8d7a4-...",
  "zone": "meeting-1",
  "transport": "sfu",
  "startedAt": "2026-10-24T01:00:00.000Z",
  "endedAt": "2026-10-24T01:05:00.000Z",
  "durationSec": 300,
  "participants": ["3f9a1c0d2b7e4a51", "a07b55e9c1d24f80", "9e0d3b7c4a1f2e68"],
  "participantCount": 3,
  "maxConcurrent": 2
}
```

| Field | Type | Description |
|---|---|---|
| `conversationId` | string | Id of the conversation. Same value in `started` and `ended`. |
| `zone` | string \| null | Zone id of a meeting room and similar (e.g. `all-hands`, `meeting-1`, `1on1-1`, `booth-1`). **`null` on the open floor.** |
| `transport` | `"sfu"` \| `"mesh"` | How the call is carried (in `ended`, the last state). |
| `startedAt` / `endedAt` | string (ISO 8601, UTC) | When the conversation started and ended. |
| `durationSec` | number | Length of the conversation in seconds (rounded). |
| `participants` | string[] | **Everyone who took part at any point**, including people who left early. In `started`, the people present at the start. |
| `participantCount` | number | Number of `participants` (counted per connection, so two different people with the same name count separately). |
| `maxConcurrent` | number | The most people talking at the same time. |

## What counts as a conversation

- A conversation is a **proximity group of 2 or more people**, the same groups the server uses to decide who is
  connected in a call.
- As people come and go, the group that **shares the most members with the previous conversation in the same
  zone** continues it.
  - On a split, the side with the larger overlap continues the conversation and the rest starts a new one.
  - On a merge, one conversation continues and the other ends.
- **Changing zone** (for example walking from the open floor into a meeting room) counts as a **new conversation**.
- Walking past someone on the open floor does not start a conversation (the server only starts one when both
  people are standing still).
- A short connection drop (reconnecting within 15 s) does not break the conversation or the stay.

## How participants are represented

- With `EVENT_INCLUDE_NAMES=true`: the **display name** at join time.
- Otherwise (default): a **16-character anonymous id** derived from the display name. Within one server process,
  **the same name on the same day (UTC) gives the same id**. The id changes when the date changes and when the
  server restarts, so a receiver can count distinct people per day but cannot follow a person across days.

## Delivery guarantees

- **Best effort, at most once.** The timeout is 5 s and failed deliveries are not retried (the server only logs
  a warning).
- **Order is not guaranteed.** Sort by `at` (or `startedAt` / `endedAt`).
- Stays and conversations still open when the server restarts or stops **never get an `ended` event** (the state
  only lives in memory).
- Never sent: what was said, transcripts, chat, positions.
