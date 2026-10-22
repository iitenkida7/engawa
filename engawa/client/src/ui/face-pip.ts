// Always-on-top camera window for screen sharers (issue #318). On a single
// display the shared app covers engawa, so the remote camera tiles vanish the
// moment a share starts. While sharing, the tiles are mirrored into a Document
// Picture-in-Picture window, which the OS keeps above every other window.
//
// Mirror, not move: the main-window tiles stay where RemoteMediaView laid them
// out, and this view keeps a second <video> per peer bound to the same
// MediaStream (one decode, any number of sinks). That leaves the layout engine,
// focus handling, SFU layer selection and recording untouched, and a PiP window
// the user closes by hand needs nothing restored.
//
// Chrome / Edge desktop only (window.documentPictureInPicture). Elsewhere
// isFacePipSupported() is false, open() reports failure and the toolbar hides
// the toggle, so nothing else changes.

import { t } from '@/core/i18n';

export const FACE_PIP_STORAGE_KEY = 'engawa-face-pip';

// Opt-in, default off: only an explicit '1' enables it.
export function parseFacePipSetting(stored: string | null): boolean {
  return stored === '1';
}

// Minimal typing of the Document PiP API, which lib.dom does not carry yet.
type DocumentPictureInPicture = {
  requestWindow(opts?: { width?: number; height?: number }): Promise<Window>;
};

function pipApi(w: object): DocumentPictureInPicture | undefined {
  return (w as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;
}

export function isFacePipSupported(w: object = window): boolean {
  return pipApi(w) !== undefined;
}

// Tile geometry inside the PiP window (CSS px). The window is sized once at
// open: resizing it later needs another user gesture, so extra tiles that
// arrive mid-share simply wrap below and scroll.
export const FACE_PIP_TILE_W = 160;
// 30px header + a 16:9 body for the 160px width.
export const FACE_PIP_TILE_H = 120;
export const FACE_PIP_GAP = 8;
export const FACE_PIP_PAD = 8;
export const FACE_PIP_MAX_COLS = 3;

// Initial window size for `count` tiles (pure): up to 3 across, then wrap. Zero
// tiles still gets a one-tile window for the "no one in the call" note.
export function computeFacePipWindowSize(count: number): { width: number; height: number } {
  const n = Math.max(1, count);
  const cols = Math.min(n, FACE_PIP_MAX_COLS);
  const rows = Math.ceil(n / cols);
  return {
    width: cols * FACE_PIP_TILE_W + (cols - 1) * FACE_PIP_GAP + 2 * FACE_PIP_PAD,
    height: rows * FACE_PIP_TILE_H + (rows - 1) * FACE_PIP_GAP + 2 * FACE_PIP_PAD,
  };
}

// One participant as the PiP window shows them: the same facts a main window
// tile renders, snapshotted by RemoteMediaView on every reflow. `self` marks the
// sharer's own tile, which comes first and is mirrored like the self preview.
export type FaceEntry = {
  userId: string;
  self?: boolean;
  name: string;
  initials: string;
  stream: MediaStream | null;
  muted: boolean;
  speaking: boolean;
};

type PipTile = {
  el: HTMLDivElement;
  video: HTMLVideoElement;
  name: HTMLSpanElement;
  initials: HTMLSpanElement;
  streamId: string | null;
};

// The PiP document starts blank (no stylesheet is inherited from the opener),
// so the tile chrome is restated here — same dark panel look as index.html.
const PIP_CSS = `
  html, body { margin: 0; background: #0e1014; color: #e6e8ee;
    font: 12px system-ui, -apple-system, sans-serif; }
  body { padding: ${FACE_PIP_PAD}px; }
  .grid { display: flex; flex-wrap: wrap; gap: ${FACE_PIP_GAP}px; }
  .tile { width: ${FACE_PIP_TILE_W}px; display: flex; flex-direction: column; overflow: hidden;
    background: rgba(14, 16, 20, 0.92); border: 1px solid #353a47; border-radius: 12px;
    transition: border-color 0.15s ease; }
  .tile.speaking { border-color: rgba(80, 220, 120, 0.9); box-shadow: 0 0 10px rgba(80, 220, 120, 0.3); }
  .hdr { display: flex; align-items: center; gap: 6px; min-height: 30px; padding: 0 10px;
    border-bottom: 1px solid #2a2f3a; background: rgba(0, 0, 0, 0.25); }
  .hdr .name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .hdr .mic { display: none; color: #e5484d; }
  .tile.muted .hdr .mic { display: inline; }
  .body { position: relative; aspect-ratio: 16 / 9; background: #000; }
  .body video { display: block; width: 100%; height: 100%; object-fit: cover; }
  .tile.self .body video { transform: scaleX(-1); }
  .tile.nocam .body video { display: none; }
  .ph { position: absolute; inset: 0; display: none; align-items: center; justify-content: center;
    background: #1a1d24; }
  .tile.nocam .ph { display: flex; }
  .ph span { width: 40px; height: 40px; border-radius: 50%; background: #3a4050;
    display: flex; align-items: center; justify-content: center; font-weight: bold; }
  .empty { color: #9da3b0; padding: 16px; text-align: center; }
  .empty[hidden] { display: none; }
`;

export class FacePipView {
  private win: Window | null = null;
  private grid: HTMLDivElement | null = null;
  private empty: HTMLDivElement | null = null;
  private tiles = new Map<string, PipTile>();

  isOpen(): boolean {
    return this.win !== null;
  }

  // Opens the window and renders `entries`. Needs a user activation, which
  // requestWindow() consumes — so the caller runs it AFTER getDisplayMedia
  // (which only checks activation) and never before it. Resolves false when
  // the API is missing or the browser refused (the share picker outlived the
  // click's activation window); the caller then offers a button instead.
  async open(entries: FaceEntry[]): Promise<boolean> {
    if (this.win) {
      this.sync(entries);
      return true;
    }
    const api = pipApi(window);
    if (!api) return false;
    let win: Window;
    try {
      win = await api.requestWindow(computeFacePipWindowSize(entries.length));
    } catch {
      return false;
    }
    this.win = win;
    const doc = win.document;
    const style = doc.createElement('style');
    style.textContent = PIP_CSS;
    doc.head.appendChild(style);
    this.grid = doc.createElement('div');
    this.grid.className = 'grid';
    this.empty = doc.createElement('div');
    this.empty.className = 'empty';
    this.empty.textContent = t('facePip.empty');
    doc.body.append(this.grid, this.empty);
    // Closed by the user (the window's own ✕) or by the browser (opener
    // navigated): forget it so the next share opens a fresh one. A close() of
    // our own clears `win` first, so this is a no-op for it.
    win.addEventListener('pagehide', () => {
      if (this.win === win) this.reset();
    });
    this.sync(entries);
    return true;
  }

  close() {
    const win = this.win;
    if (!win) return;
    this.reset();
    win.close();
  }

  private reset() {
    this.win = null;
    this.grid = null;
    this.empty = null;
    this.tiles.clear();
  }

  // Reconciles the window with the current participants: new peers get a tile,
  // departed peers lose theirs, the rest are updated in place (a <video> is only
  // rebound when the stream actually changed, so playback never flickers).
  sync(entries: FaceEntry[]) {
    const grid = this.grid;
    if (!grid || !this.win) return;
    const doc = this.win.document;
    const seen = new Set<string>();
    for (const e of entries) {
      seen.add(e.userId);
      let tile = this.tiles.get(e.userId);
      if (!tile) {
        tile = this.createTile(doc);
        this.tiles.set(e.userId, tile);
        grid.appendChild(tile.el);
      }
      tile.name.textContent = e.name;
      tile.initials.textContent = e.initials;
      tile.el.classList.toggle('self', e.self === true);
      tile.el.classList.toggle('muted', e.muted);
      tile.el.classList.toggle('speaking', e.speaking);
      tile.el.classList.toggle('nocam', e.stream === null);
      const id = e.stream?.id ?? null;
      if (id !== tile.streamId) {
        tile.streamId = id;
        tile.video.srcObject = e.stream;
        if (e.stream) void tile.video.play().catch(() => {});
      }
    }
    for (const [userId, tile] of this.tiles) {
      if (seen.has(userId)) continue;
      tile.video.srcObject = null;
      tile.el.remove();
      this.tiles.delete(userId);
    }
    // The sharer's own tile alone is not a call: keep the note under it.
    if (this.empty) this.empty.hidden = entries.some((e) => !e.self);
  }

  // Per-frame / per-event updates between syncs.
  setSpeaking(userId: string, on: boolean) {
    this.tiles.get(userId)?.el.classList.toggle('speaking', on);
  }

  setMuted(userId: string, on: boolean) {
    this.tiles.get(userId)?.el.classList.toggle('muted', on);
  }

  private createTile(doc: Document): PipTile {
    const el = doc.createElement('div');
    el.className = 'tile nocam';
    const hdr = doc.createElement('div');
    hdr.className = 'hdr';
    const mic = doc.createElement('span');
    mic.className = 'mic';
    mic.textContent = '🔇';
    mic.setAttribute('aria-hidden', 'true');
    const name = doc.createElement('span');
    name.className = 'name';
    hdr.append(mic, name);
    const body = doc.createElement('div');
    body.className = 'body';
    const video = doc.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    // Camera streams carry no audio and mic audio already plays in the main
    // window; muting keeps the autoplay policy from blocking the mirror.
    video.muted = true;
    const ph = doc.createElement('div');
    ph.className = 'ph';
    const initials = doc.createElement('span');
    ph.appendChild(initials);
    body.append(video, ph);
    el.append(hdr, body);
    return { el, video, name, initials, streamId: null };
  }
}
