# Control-plane settings API

English | [日本語](./control-plane.ja.md)

Optionally, the engawa server can take its settings from an **HTTP endpoint instead of the
environment**. It is active only when `CONTROL_PLANE_URL` is set; without it nothing changes and
the environment remains the only source.

## Why this exists

Changing an environment variable means **restarting the process**. engawa keeps positions and
signaling in process memory, so a restart **disconnects everyone in the office** (invariant #2).

For a server you run for yourself, that's fine. But when you run engawa **on someone else's
behalf** — each customer with their own Cloudflare keys and access password, changed from an admin
screen — "every settings change hangs up a meeting" is not an acceptable trade.

So: a place to fetch settings from, re-read periodically.

## Configuration (environment)

| Variable | Default | Description |
|---|---|---|
| `CONTROL_PLANE_URL` | unset | Where to GET settings. **Unset disables the feature** (environment only). **HTTPS required** (plain http only for `localhost`). |
| `CONTROL_PLANE_TOKEN` | unset | **Required whenever `CONTROL_PLANE_URL` is set.** Serves as both the request bearer and the key the response is signed with. |
| `CONTROL_PLANE_INTERVAL_S` | `60` | Refresh interval in seconds. Floored at 10. |

If `CONTROL_PLANE_URL` is set without a token, or over plain http, **the server refuses to start**.
A control plane that cannot be authenticated is a worse position than none: the office would take
its credentials from whoever answers.

### One token per server, not one per fleet

When hosting, **issue a token per tenant** — that is, per office — and never share one.

- A leaked token is then confined to a single tenant.
- Have the control plane **derive the tenant from the token**. Naming the tenant in the URL and
  using one shared token as a gate means that single token can read any customer's settings, which
  is to say any customer's Cloudflare keys.

## Request

```
GET {CONTROL_PLANE_URL}
Accept: application/json
Authorization: Bearer {CONTROL_PLANE_TOKEN}
```

Fetched once at boot and then every `CONTROL_PLANE_INTERVAL_S`. **The boot fetch is awaited**,
because some settings are read only once at startup.

## Response signature (required)

With `CONTROL_PLANE_TOKEN` set, **the response must be signed**. One that isn't, or doesn't verify,
is discarded and the previous settings stay in place.

```
X-Engawa-Signature: sha256=<hex>
```

`<hex>` is the HMAC-SHA256 of the **exact bytes of the response body**, keyed with
`CONTROL_PLANE_TOKEN`. It is the **same scheme as the outbound event webhook**
([`webhook.md`](./webhook.md)) — one idea, used in both directions.

### Why it is required

The bearer authenticates engawa *to* the control plane. Without a signature the office has no way
to know that whoever answered **is** the control plane. Settings carry Cloudflare
credentials, so accepting plausible-looking settings from an unauthenticated responder is worse
than running with no control plane at all.

```js
// Signing (Node.js)
const body = JSON.stringify(settings);
res.set('X-Engawa-Signature',
  'sha256=' + crypto.createHmac('sha256', tenantToken).update(body).digest('hex'));
res.type('application/json').send(body);   // send the same bytes you signed
```

> Re-serialising the JSON produces **different bytes** and the signature won't match. Send the
> string you signed.

## Response

A JSON object keyed by **the same names the environment uses**, so there is one vocabulary to learn
rather than two.

```json
{
  "ACCESS_PASSWORD": "hunter22",
  "ENTRY_MODE": "password",
  "CLOUDFLARE_TURN_TOKEN_ID": "...",
  "CLOUDFLARE_TURN_TOKEN_SECRET": "...",
  "CLOUDFLARE_REALTIME_APP_ID": "...",
  "CLOUDFLARE_REALTIME_APP_TOKEN": "...",
  "SFU_PROMOTE_AT": 4,
  "EVENT_WEBHOOK_URL": "https://hooks.example.com/engawa",
  "EVENT_WEBHOOK_SECRET": "...",
  "EVENT_INCLUDE_NAMES": false
}
```

### What may be set (a whitelist)

Only the ten keys above. **`PORT` and `MAP` are not accepted** — they shape the process and the
world at boot, and letting a remote endpoint set arbitrary environment variables would be a much
larger thing to trust than this feature asks for.

- Unknown keys are **ignored silently**, so an older server stays compatible with a newer control
  plane.
- Numbers and booleans are coerced to strings (`4` → `"4"`, `false` → `"false"`).
- **`null` and `""` mean "explicitly unset"**, overriding a variable baked into the image. (Without
  that, an image shipping `ACCESS_PASSWORD` could never have its password turned off.)
- A key you **omit** keeps whatever the environment says.
- Each response is the **whole picture**: a key present last time and absent now falls back to the
  environment.

### When a change takes effect

| Setting | Effective |
|---|---|
| `ACCESS_PASSWORD` | **From the next join** (no restart) |
| `ENTRY_MODE` | **From the next join** (no restart). See [`entry-token.md`](./entry-token.md) |
| `CLOUDFLARE_TURN_*` | **From the next credential issued** (established calls keep theirs) |
| `CLOUDFLARE_REALTIME_*` | **From the next group recompute** (including enabling/disabling SFU) |
| `SFU_PROMOTE_AT` | **From the next group recompute** |
| `EVENT_WEBHOOK_*` | **At boot only** — the event recorder is built once at startup |
| `PORT` / `MAP` | Not accepted (environment only, at boot) |

## When a fetch fails

- On any failure (unreachable, timeout, non-2xx) the **previous settings stay in place**. An office
  that is running correctly should not lose its TURN credentials because the control plane had a
  bad minute.
- If the boot fetch fails, the server starts on the environment alone.
- Only the **status code** is logged: a response body may contain settings.

## Transcription keys are not accepted

There is deliberately **no** `GROQ_API_KEY` setting. The transcription key is always the user's
own, kept in their browser. A key supplied by whoever runs the space would let that operator read
the transcription history of everyone in it from their Groq account — what was said in a
conversation belongs to the people in it, not to the operator.

## A minimal implementation

The control-plane side is one GET that returns JSON.

```js
// Express. The tenant comes from the token, never from the URL.
app.get('/engawa/settings', (req, res) => {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  const tenant = token ? findTenantByToken(token) : null;   // compare in constant time
  if (!tenant) return res.sendStatus(401);

  const body = JSON.stringify({
    ACCESS_PASSWORD: tenant.accessPassword ?? null,
    CLOUDFLARE_TURN_TOKEN_ID: tenant.turnTokenId ?? null,
    CLOUDFLARE_TURN_TOKEN_SECRET: tenant.turnTokenSecret ?? null,
  });

  res.set('X-Engawa-Signature',
    'sha256=' + crypto.createHmac('sha256', token).update(body).digest('hex'));
  res.type('application/json').send(body);
});
```

## Security notes

- **HTTPS is enforced** (except `localhost`). The response carries credentials.
- **Issue a token per tenant**, and derive the tenant from the token.
- Compare tokens in **constant time** (`crypto.timingSafeEqual` or equivalent).
- Keep `CONTROL_PLANE_TOKEN` out of the image; pass it as a **runtime secret**.
- **Never log settings values.** engawa logs only status codes for this reason.
- The control plane can **change this server's settings**. Keep it reachable only to the server.
- To rotate, accept both the old and new token on the control plane, update each office's secret,
  then retire the old one.
