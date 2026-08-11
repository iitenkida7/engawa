import { normalizeIceServers } from './logic';

const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

// Abort the Cloudflare credential request if it stalls, so a hung upstream
// doesn't pin the request open — on timeout we fall back to STUN-only.
const TURN_FETCH_TIMEOUT_MS = 8000;

// Credential lifetime (seconds). An established RTCPeerConnection keeps the
// credentials it was built with — there is no seamless mid-call refresh — so a
// TURN-relayed call used to die when the old 1h ttl expired (issue #184). 12h
// covers a full workday tab; the client still fetches fresh credentials every
// 30min for NEW connections (client rtc/ice.ts), so a leaked credential's
// usefulness stays bounded by Cloudflare's per-credential accounting.
const TURN_CREDENTIAL_TTL_S = 43200;

export async function getTurnCredentials() {
  const id = process.env.CLOUDFLARE_TURN_TOKEN_ID;
  const secret = process.env.CLOUDFLARE_TURN_TOKEN_SECRET;

  if (!id || !secret) {
    return FALLBACK_ICE_SERVERS;
  }

  try {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${id}/credentials/generate`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: TURN_CREDENTIAL_TTL_S }),
        signal: AbortSignal.timeout(TURN_FETCH_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      console.error('TURN credential request failed:', res.status, await res.text());
      return FALLBACK_ICE_SERVERS;
    }

    const data = (await res.json()) as { iceServers?: unknown };
    if (!data.iceServers) return FALLBACK_ICE_SERVERS;
    // Cloudflare returns `iceServers` as a single object; RTCPeerConnection
    // requires an array, so normalize before handing it to the client.
    return normalizeIceServers(data.iceServers);
  } catch (err) {
    console.error('TURN credential fetch error:', err);
    return FALLBACK_ICE_SERVERS;
  }
}
