# Entry tickets

English | [日本語](./entry-token.ja.md)

An engawa office can delegate "who is allowed in" to the control plane that runs it, instead of
asking everyone for a shared passphrase. The control plane signs a short-lived **entry ticket**, the
browser arrives with it in the link, and the office checks the signature locally.

Optional. Unset, nothing changes: `ACCESS_PASSWORD` works exactly as it always has, and a
self-hosted office never sees any of this.

## Why this exists

`ACCESS_PASSWORD` is one phrase shared by everyone. Whoever knows the URL and the phrase is in, the
phrase does not expire, and nothing about a session says who the person actually is — the name on
the avatar is whatever they typed.

That is the right shape for a team running its own office. It is the wrong shape when engawa is run
**for** someone: there the accounts already exist somewhere else, people join and leave, and a
transcript or a recording is only worth keeping if the names in it are real.

Rather than teach engawa about users, sessions and sign-in — an entire second identity system,
kept in step with the first — the office accepts a ticket the control plane signed.

```
①  control plane          mints a ticket:  HMAC-SHA256(CONTROL_PLANE_TOKEN, payload)
②  browser                opens  https://office.example/?t=<ticket>
③  office                 verifies it with the key it already holds, and lets that person in
                           under the name the ticket carries
```

Two properties are worth being explicit about.

**No call-out.** Step ③ is local arithmetic. The office never asks the control plane whether a
ticket is good, so the control plane being down does not stop anyone entering an office that is
already running, and no new failure point sits between a person and the room. The price is that a
ticket cannot be withdrawn before it expires, which is why its lifetime is capped (below).

**The name comes from the ticket.** In this mode the name on the join message is ignored. It is
covered by the signature, so it cannot be spoofed — which is what makes a transcript or a recording
a record of who was actually in the room rather than of what people typed into a box.

Both sides already share one secret, so an HMAC is enough: there is no third party to convince and
nothing here needs a key pair. It is the same scheme as the [settings response](./control-plane.md)
and the [event webhook](./webhook.md) — one idea, used in three places.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `ENTRY_MODE` | `password` | `token` turns the ticket gate on. Anything else (including a typo) means the historical password gate. |
| `CONTROL_PLANE_TOKEN` | unset | **The verification key.** Required for `ENTRY_MODE=token`. The same token the control plane already authenticates with. |

`ENTRY_MODE` is in the [control-plane settings whitelist](./control-plane.md), so the mode can be
switched from the control plane and takes effect **from the next join** — no restart, and nobody
currently in the office is disconnected.

`CONTROL_PLANE_TOKEN` is deliberately **not** in that whitelist. It is the secret itself, and a key
supplied by whoever answered the settings request would verify nothing.

### The two gates are exclusive

With `ENTRY_MODE=token` the access password is not consulted at all — an `ACCESS_PASSWORD` left in
the environment opens nothing — and `GET /api/config` reports `passwordRequired: false`, so the
browser never shows a password step. With `ENTRY_MODE` unset or `password`, tickets are neither
required nor looked at, and a stray `entryToken` on a join is ignored.

### One key per office

Issue `CONTROL_PLANE_TOKEN` **per office** (per server), never one shared across a fleet: a ticket
is valid at every office that holds the key it was signed with. One key per office keeps a leak,
and a ticket, to one office.

## The ticket

```
<payload>.<signature>
```

- `payload` — `base64url` of the claims JSON, **no padding**.
- `signature` — `base64url` of `HMAC-SHA256(CONTROL_PLANE_TOKEN, payload)`, where `payload` is the
  base64url **text above**, not the JSON it decodes to.

Signing the encoded text rather than the JSON means the bytes a ticket carries are the bytes that
are checked: there is no canonical-JSON question to get wrong on either side.

### Claims

```json
{
  "userId": "u_8f21c0",
  "name": "Takeshi Ishii",
  "exp": 1799884800
}
```

| Field | Type | Meaning |
|---|---|---|
| `userId` | string, 1–128 chars | The control plane's id for this person. Required: a ticket names a person, rather than being a bearer pass. engawa does **not** keep it — a connection has its own per-connection id, and nothing is stored past the connection (invariant #2). |
| `name` | string, non-empty | Display name. Used as-is, capped at 24 characters like any other name. |
| `exp` | number | Expiry, **UNIX seconds**. |

Unknown fields are ignored, so a control plane may add its own without breaking an older office.

### Lifetime

**12 hours is the shape this was built for**: long enough that a reload, a closed lid or a train
tunnel does not send someone back to the control plane to be let in again, short enough that a
leaked link is not a lasting key.

The office refuses a ticket claiming more than **24 hours** of remaining life (`too-long`). A ticket
cannot be withdrawn before it expires, so its lifetime is its blast radius — and this also catches
the easy mistake of signing `exp` in milliseconds.

### Minting one

```js
// Node.js. `secret` is that office's CONTROL_PLANE_TOKEN.
import { createHmac } from 'node:crypto';

function mintEntryTicket(secret, { userId, name }, lifetimeS = 12 * 60 * 60) {
  const claims = { userId, name, exp: Math.floor(Date.now() / 1000) + lifetimeS };
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  const signature = createHmac('sha256', secret).update(payload).digest('base64url');

  return `${payload}.${signature}`;
}

const url = `https://office.example/?t=${mintEntryTicket(secret, user)}`;
```

engawa's own implementation of this is `signEntryToken` in `engawa/server/src/entry.ts`, if your
control plane is in TypeScript and would rather import it than reimplement it.

## How it is used

1. The control plane sends the person to `https://office.example/?t=<ticket>`.
2. The browser reads the ticket, **removes it from the address bar** (`history.replaceState`) and
   keeps it in `localStorage` under `engawa-entry-token`. A query string is the most quoted,
   screenshotted and `Referer`-leaked part of a URL, and this one is a credential.
3. Every join — including every automatic reconnect — presents the ticket. The join over the
   websocket is the gate that counts; `GET /api/config` only tells the browser which screen to show.
4. A ticket in a fresh link always wins over a saved one, so sending someone a new link works.
5. When the server turns a ticket away, the browser drops it and shows "you need an entry link".
   There is nothing to retry — the way back in is a fresh link.

## What is rejected

A join in ticket mode is refused — `auth-error`, then the socket is closed with code `4001` — when
the ticket is:

| | |
|---|---|
| missing | no ticket presented |
| malformed | not `<payload>.<signature>`, over 2048 characters, or the claims are unusable (no `userId`, no `name`, no numeric `exp`) |
| bad-signature | edited, or signed with a different key |
| expired | `exp` has passed |
| too-long | more than 24 hours of life left |
| no-key | this office has no `CONTROL_PLANE_TOKEN` to verify with |

The last one is a misconfiguration, and it fails **closed**: an office told to require tickets but
given no key to check them with turns everyone away rather than letting everyone in.

The browser is told only that its ticket did not work. Which of "expired" and "forged" it was is not
the browser's business; the reason is logged on the server, without the ticket or the key.

## Security notes

- **HTTPS, as everywhere else.** The ticket is a credential in a URL.
- **One key per office**, issued at runtime (`fly secrets set` or equivalent), never baked into an
  image.
- Tickets are **short-lived and cannot be withdrawn**. To cut someone off sooner than their ticket
  expires, rotate that office's `CONTROL_PLANE_TOKEN` — which invalidates every outstanding ticket
  for that office at once.
- Signature checks are **constant-time**, and a wrong-length signature is an ordinary rejection
  rather than an error.
- **Nothing about a ticket or the key is logged** — not on success, not on rejection.
- A ticket says who may enter, not what they may do. engawa has one kind of participant; roles and
  permissions, if you need them, live in the control plane.
