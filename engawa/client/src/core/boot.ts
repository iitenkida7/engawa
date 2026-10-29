// Entry point (index.html). The map is data the server picks (MAP / MAP_URL),
// and every world module builds from it once, at load — so fetch and install it
// first, then load the app (core/main.ts) and with it the world.

import { applyI18n, t } from '@/core/i18n';
import { installMap } from '@/world/map-data';

async function loadMap(): Promise<boolean> {
  try {
    const res = await fetch('/api/map');
    if (!res.ok) throw new Error(`GET /api/map: HTTP ${res.status}`);
    installMap(await res.json());
    return true;
  } catch (err) {
    console.error('[engawa] could not load the map', err);
    return false;
  }
}

async function boot(): Promise<void> {
  if (await loadMap()) {
    await import('@/core/main');
    return;
  }
  // Nothing can be built without a map: say so on the join screen instead of
  // leaving it blank. A reload retries.
  applyI18n();
  const card = document.createElement('div');
  card.className = 'card';
  const msg = document.createElement('h1');
  msg.textContent = t('boot.mapFailed');
  card.appendChild(msg);
  document.getElementById('join-overlay')?.appendChild(card);
}

void boot();
