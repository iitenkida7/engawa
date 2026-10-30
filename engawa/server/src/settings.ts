import { createHmac, timingSafeEqual } from 'node:crypto';

// Runtime settings, from the environment or from a control plane.
//
// A self-hosted engawa configures itself with environment variables and that is
// the whole story. A hosted one is run by something else — a control plane that
// knows about customers, their Cloudflare keys and their access password — and
// for it, env alone is a poor fit: changing a variable means restarting the
// process, and restarting drops every websocket in the office.
//
// So: when CONTROL_PLANE_URL is set the server also fetches its settings from
// there, periodically, and those win over the environment. The control plane
// speaks the same vocabulary the .env does, so there is one mental model rather
// than two. Nothing changes for a deployment that doesn't set it.
//
// What is live and what needs a restart is deliberate, not accidental — see
// docs/control-plane.md.
//
// Both directions are authenticated when a token is configured. The request
// carries it as a bearer so the control plane knows which office is asking; the
// response must carry an HMAC of its body so the office knows the answer came
// from the control plane and not from whatever else the URL now resolves to.
// Settings include credentials — accepting them from an unauthenticated
// responder would be worse than having no control plane at all.

// Header carrying the HMAC-SHA256 of the response body, hex, prefixed `sha256=`.
// Same scheme as the outbound event webhook (docs/webhook.md) — one idea, used
// in both directions, rather than two things to learn.
export const SETTINGS_SIGNATURE_HEADER = 'x-engawa-signature';

// Settings a control plane may supply. Deliberately a whitelist: PORT and MAP
// shape the process and the world at boot, and letting a remote endpoint set
// arbitrary variables would be a much larger thing to trust.
export const CONTROL_PLANE_KEYS = [
  'ACCESS_PASSWORD',
  'ENTRY_MODE',
  'CLOUDFLARE_TURN_TOKEN_ID',
  'CLOUDFLARE_TURN_TOKEN_SECRET',
  'CLOUDFLARE_REALTIME_APP_ID',
  'CLOUDFLARE_REALTIME_APP_TOKEN',
  'SFU_PROMOTE_AT',
  'GROQ_API_KEY',
  'EVENT_WEBHOOK_URL',
  'EVENT_WEBHOOK_SECRET',
  'EVENT_INCLUDE_NAMES',
] as const;

export type ControlPlaneKey = (typeof CONTROL_PLANE_KEYS)[number];

// null means "the control plane says this is unset" — distinct from a key it
// didn't mention, which falls through to the environment. Without that
// distinction an operator could never clear a setting that the image still has
// an env var for.
export type Overrides = Partial<Record<ControlPlaneKey, string | null>>;

const KEY_SET = new Set<string>(CONTROL_PLANE_KEYS);

// How long to wait for the control plane before giving up on one attempt. Short:
// at boot it delays the server coming up, and on refresh a hung endpoint must
// not pile up requests.
const FETCH_TIMEOUT_MS = 5000;

const DEFAULT_INTERVAL_S = 60;
const MIN_INTERVAL_S = 10;

let overrides: Overrides = {};

/**
 * Validate a control-plane response into overrides. Unknown keys are dropped
 * rather than rejected, so an older server stays compatible with a newer
 * control plane. Values arrive as strings (numbers and booleans are coerced,
 * since JSON makes it easy to send `true` where the env would say "true");
 * null and "" both mean explicitly unset.
 */
export function parseSettings(raw: unknown): Overrides {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const parsed: Overrides = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_SET.has(key)) continue;
    const typed = key as ControlPlaneKey;

    if (value === null || value === '') {
      parsed[typed] = null;
      continue;
    }
    if (typeof value === 'string') {
      parsed[typed] = value;
      continue;
    }
    if (typeof value === 'number' && Number.isFinite(value)) {
      parsed[typed] = String(value);
      continue;
    }
    if (typeof value === 'boolean') {
      parsed[typed] = String(value);
    }
    // Anything else (objects, arrays, NaN) is ignored: a malformed field must
    // not take the whole response down with it.
  }

  return parsed;
}

/** Replace the current overrides wholesale (the response is the full picture). */
export function applySettings(next: Overrides): void {
  overrides = next;
}

/** Test seam: forget everything the control plane said. */
export function resetSettings(): void {
  overrides = {};
}

/**
 * The effective value of a setting: what the control plane said, otherwise the
 * environment. Read at the point of use, never cached at module load, so a
 * refreshed setting takes effect without a restart.
 */
export function setting(
  key: ControlPlaneKey,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (key in overrides) {
    return overrides[key] ?? undefined;
  }

  return env[key];
}

/**
 * The merged environment, for the few places that take a whole env object
 * rather than asking key by key (events.ts).
 */
export function settingsEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...env };
  for (const key of CONTROL_PLANE_KEYS) {
    if (key in overrides) merged[key] = overrides[key] ?? undefined;
  }

  return merged;
}

export function isControlPlaneConfigured(env = process.env): boolean {
  return Boolean(env.CONTROL_PLANE_URL);
}

/**
 * Is this a URL we're willing to take credentials from? Plain HTTP would put
 * the office's Cloudflare and transcription keys on the wire in the clear, so
 * only HTTPS is allowed — except against localhost, where there is no wire and
 * a developer should not have to mint a certificate.
 */
export function isAcceptableControlPlaneUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }

  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;

  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * Does this body carry a signature made with our token? Constant-time, and
 * false for a missing or malformed header rather than throwing — a bad
 * signature and no signature deserve the same answer.
 */
export function verifySettingsSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;

  const expected = `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);

  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length; compare lengths first and only then in constant time.
  if (a.length !== b.length) return false;

  return timingSafeEqual(a, b);
}

/** Refresh interval in seconds, floored so a misconfiguration can't hammer. */
export function normalizeIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_INTERVAL_S;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_INTERVAL_S;

  return Math.max(MIN_INTERVAL_S, Math.round(n));
}

/**
 * Fetch settings once. Returns whether they were applied: a failure leaves the
 * previous settings in place, because an office that is running correctly must
 * not lose its TURN credentials because the control plane had a bad minute.
 */
export async function fetchSettings(env = process.env): Promise<boolean> {
  const url = env.CONTROL_PLANE_URL;
  if (!url) return false;

  if (!isAcceptableControlPlaneUrl(url)) {
    console.warn('[settings] CONTROL_PLANE_URL must be https (or localhost); settings not fetched');
    return false;
  }

  const token = env.CONTROL_PLANE_TOKEN;

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Status only: the body may name settings, and this goes to the log.
      console.warn(`[settings] control plane responded ${res.status}; keeping previous settings`);
      return false;
    }

    // Read as text so the signature covers the exact bytes that were sent —
    // re-serialising parsed JSON would check a different document.
    const rawBody = await res.text();

    if (
      token &&
      !verifySettingsSignature(rawBody, res.headers.get(SETTINGS_SIGNATURE_HEADER), token)
    ) {
      // Whoever answered could not prove they hold the token. The body may well
      // be valid settings; that is exactly what makes accepting it dangerous.
      console.warn('[settings] response signature did not verify; keeping previous settings');
      return false;
    }

    applySettings(parseSettings(JSON.parse(rawBody)));
    return true;
  } catch (err) {
    console.warn(`[settings] control plane fetch failed: ${err}; keeping previous settings`);
    return false;
  }
}

/**
 * Fetch now, then keep refreshing. Awaiting the first fetch matters: the
 * settings read once at boot (the event webhook) would otherwise miss
 * everything the control plane has to say.
 */
export async function startSettingsSync(env = process.env): Promise<void> {
  if (!isControlPlaneConfigured(env)) return;

  // A control plane that cannot be authenticated is a worse position than none:
  // the office would take its credentials from whoever answers. Refuse to boot
  // rather than quietly run unprotected.
  if (!isAcceptableControlPlaneUrl(env.CONTROL_PLANE_URL ?? '')) {
    throw new Error(
      'CONTROL_PLANE_URL must be an https:// URL (http:// is allowed only for localhost)',
    );
  }
  if (!env.CONTROL_PLANE_TOKEN) {
    throw new Error('CONTROL_PLANE_TOKEN is required when CONTROL_PLANE_URL is set');
  }

  await fetchSettings(env);

  const intervalS = normalizeIntervalSeconds(env.CONTROL_PLANE_INTERVAL_S);
  const timer = setInterval(() => void fetchSettings(env), intervalS * 1000);
  // Don't hold the process open on this alone.
  timer.unref?.();

  console.log(`[settings] control plane sync every ${intervalS}s`);
}
