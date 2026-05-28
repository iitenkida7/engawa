const FALLBACK_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
];

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
        body: JSON.stringify({ ttl: 3600 }),
      },
    );

    if (!res.ok) {
      console.error('TURN credential request failed:', res.status, await res.text());
      return FALLBACK_ICE_SERVERS;
    }

    const data = (await res.json()) as { iceServers?: unknown };
    if (!data.iceServers) return FALLBACK_ICE_SERVERS;
    return data.iceServers;
  } catch (err) {
    console.error('TURN credential fetch error:', err);
    return FALLBACK_ICE_SERVERS;
  }
}
