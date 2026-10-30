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
| `CONTROL_PLANE_URL` | unset | Where to GET settings. **Unset disables the feature** (environment only). |
| `CONTROL_PLANE_TOKEN` | unset | When set, sent as `Authorization: Bearer <token>`. |
| `CONTROL_PLANE_INTERVAL_S` | `60` | Refresh interval in seconds. Floored at 10. |

## Request

```
GET {CONTROL_PLANE_URL}
Accept: application/json
Authorization: Bearer {CONTROL_PLANE_TOKEN}   ← only when CONTROL_PLANE_TOKEN is set
```

Fetched once at boot and then every `CONTROL_PLANE_INTERVAL_S`. **The boot fetch is awaited**,
because some settings are read only once at startup.

## Response

A JSON object keyed by **the same names the environment uses**, so there is one vocabulary to learn
rather than two.

```json
{
  "ACCESS_PASSWORD": "hunter22",
  "CLOUDFLARE_TURN_TOKEN_ID": "...",
  "CLOUDFLARE_TURN_TOKEN_SECRET": "...",
  "CLOUDFLARE_REALTIME_APP_ID": "...",
  "CLOUDFLARE_REALTIME_APP_TOKEN": "...",
  "SFU_PROMOTE_AT": 4,
  "GROQ_API_KEY": "gsk_...",
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
| `CLOUDFLARE_TURN_*` | **From the next credential issued** (established calls keep theirs) |
| `CLOUDFLARE_REALTIME_*` | **From the next group recompute** (including enabling/disabling SFU) |
| `SFU_PROMOTE_AT` | **From the next group recompute** |
| `GROQ_API_KEY` | **From the next client that fetches it** |
| `EVENT_WEBHOOK_*` | **At boot only** — the event recorder is built once at startup |
| `PORT` / `MAP` | Not accepted (environment only, at boot) |

## When a fetch fails

- On any failure (unreachable, timeout, non-2xx) the **previous settings stay in place**. An office
  that is running correctly should not lose its TURN credentials because the control plane had a
  bad minute.
- If the boot fetch fails, the server starts on the environment alone.
- Only the **status code** is logged: a response body may contain settings.

## A shared Groq key (`GROQ_API_KEY`)

The transcription key is normally the user's own, entered in their browser. When `GROQ_API_KEY` is
configured (by environment or control plane) it is treated as **one key for everyone in the space**.

- It reaches the browser through `GET /api/transcription-credentials`, readable **only by a joined
  session** (it requires the media token). The key is billable, so an anonymous HTTP client must not
  be able to farm it.
- The client **never writes it to localStorage**: it belongs to whoever runs the space, not to that
  browser.
- A personal key a user has stored still works; the shared one simply outranks it.
- Audio still goes **from the browser straight to Groq** — invariant #1 is unchanged.

## A minimal implementation

The control-plane side is one GET that returns JSON.

```js
// Express
app.get('/engawa/settings', (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ENGAWA_TOKEN}`) {
    return res.sendStatus(401);
  }
  const tenant = lookupTenant(req);
  res.json({
    ACCESS_PASSWORD: tenant.accessPassword ?? null,
    CLOUDFLARE_TURN_TOKEN_ID: tenant.turnTokenId ?? null,
    CLOUDFLARE_TURN_TOKEN_SECRET: tenant.turnTokenSecret ?? null,
    GROQ_API_KEY: tenant.groqApiKey ?? null,
  });
});
```

## Security notes

- **Use HTTPS.** The response carries credentials.
- Keep `CONTROL_PLANE_TOKEN` out of the image; pass it as a runtime secret.
- The control plane can **change this server's settings**. Keep it reachable only to the server.
