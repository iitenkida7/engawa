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

// Settings a control plane may supply. Deliberately a whitelist: PORT and MAP
// shape the process and the world at boot, and letting a remote endpoint set
// arbitrary variables would be a much larger thing to trust.
export const CONTROL_PLANE_KEYS = [
  'ACCESS_PASSWORD',
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

  try {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (env.CONTROL_PLANE_TOKEN) {
      headers.Authorization = `Bearer ${env.CONTROL_PLANE_TOKEN}`;
    }

    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      // Status only: the body may name settings, and this goes to the log.
      console.warn(`[settings] control plane responded ${res.status}; keeping previous settings`);
      return false;
    }

    applySettings(parseSettings(await res.json()));
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

  await fetchSettings(env);

  const intervalS = normalizeIntervalSeconds(env.CONTROL_PLANE_INTERVAL_S);
  const timer = setInterval(() => void fetchSettings(env), intervalS * 1000);
  // Don't hold the process open on this alone.
  timer.unref?.();

  console.log(`[settings] control plane sync every ${intervalS}s`);
}
