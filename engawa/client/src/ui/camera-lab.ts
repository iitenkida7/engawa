// Camera quality lab (standalone page, opened from the "⋯" menu). Encodes the
// camera through an in-browser loopback RTCPeerConnection pair per preset so the
// real encoder output of each SFU simulcast layer can be compared side by side.
// Presets come straight from SFU_CAM_LAYERS, so the lab always shows what is
// shipped. Each preset is a single encoding (an approximation of the 3-layer
// simulcast send) and nothing leaves the browser.
import { CAM_FPS, SFU_CAM_LAYERS } from '@/rtc/cam-bitrate';

type Cfg = { label: string; scale: number; kbps: number; fps: number; editable?: boolean };

type Lane = {
  cfg: Cfg;
  a: RTCPeerConnection;
  b: RTCPeerConnection;
  sender: RTCRtpSender;
  video: HTMLVideoElement;
  statsEl: HTMLElement;
  last: { bytes: number; ts: number } | null;
};

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const layers: Cfg[] = SFU_CAM_LAYERS.map((l) => ({
  label: `${l.rid} レイヤ`,
  scale: l.scaleResolutionDownBy,
  kbps: l.maxBitrate / 1000,
  fps: l.maxFramerate,
}));
const quarter = layers[layers.length - 1];
const custom: Cfg = { ...quarter, label: 'カスタム', editable: true };

let source: MediaStream | null = null;
let lanes: Lane[] = [];
let cards: { video: HTMLVideoElement; scale: number | (() => number) }[] = [];

function patternStream(): MediaStream {
  const c = document.createElement('canvas');
  c.width = 960;
  c.height = 540;
  const g = c.getContext('2d')!;
  let t = 0;
  // setInterval (not rAF) so frames keep flowing while the tab is in the background.
  setInterval(() => {
    t++;
    g.fillStyle = '#334';
    g.fillRect(0, 0, 960, 540);
    for (let i = 0; i < 12; i++) {
      g.fillStyle = `hsl(${i * 30},70%,55%)`;
      g.fillRect(i * 80, 0, 80, 120);
    }
    g.fillStyle = '#fff';
    g.font = 'bold 64px sans-serif';
    g.fillText('engawa 縁側', 60, 260);
    g.font = '24px sans-serif';
    g.fillText('細かい文字 small text 0123456789', 60, 320);
    g.font = '14px sans-serif';
    g.fillText('もっと細かい文字 tiny text abcdefghijklmnopqrstuvwxyz', 60, 360);
    g.beginPath();
    g.arc(480 + Math.sin(t / 20) * 300, 450, 50, 0, 7);
    g.fillStyle = '#f0a050';
    g.fill();
  }, 1000 / 30);
  return c.captureStream(30);
}

function getSource(): Promise<MediaStream> {
  if ($<HTMLSelectElement>('#src').value === 'pattern') return Promise.resolve(patternStream());
  // Same capture constraints as media.ts so the layers start from the real input.
  return navigator.mediaDevices.getUserMedia({
    video: {
      width: { ideal: 960 },
      height: { ideal: 540 },
      aspectRatio: { ideal: 16 / 9 },
      frameRate: { ideal: CAM_FPS, max: CAM_FPS },
    },
    audio: false,
  });
}

function preferCodec(pc: RTCPeerConnection, name: string) {
  const caps = RTCRtpReceiver.getCapabilities('video')?.codecs ?? [];
  const pick = caps.filter((c) => c.mimeType.toLowerCase() === `video/${name.toLowerCase()}`);
  if (!pick.length) return;
  const rest = caps.filter((c) => !pick.includes(c));
  for (const tr of pc.getTransceivers()) tr.setCodecPreferences([...pick, ...rest]);
}

async function applyParams(lane: Lane) {
  const p = lane.sender.getParameters();
  if (!p.encodings.length) p.encodings = [{}];
  Object.assign(p.encodings[0], {
    scaleResolutionDownBy: lane.cfg.scale,
    maxBitrate: lane.cfg.kbps * 1000,
    maxFramerate: lane.cfg.fps,
  });
  // Keep the layer's resolution fixed like simulcast does; congestion drops fps.
  (p as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
    'maintain-resolution';
  await lane.sender.setParameters(p);
}

function gathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((r) =>
    pc.addEventListener('icegatheringstatechange', () => {
      if (pc.iceGatheringState === 'complete') r();
    }),
  );
}

async function makeLane(cfg: Cfg, video: HTMLVideoElement, statsEl: HTMLElement): Promise<Lane> {
  const a = new RTCPeerConnection();
  const b = new RTCPeerConnection();
  b.ontrack = (e) => {
    video.srcObject = new MediaStream([e.track]);
  };
  const tr = a.addTransceiver(source!.getVideoTracks()[0], { direction: 'sendonly' });
  preferCodec(a, $<HTMLSelectElement>('#codec').value);
  // Non-trickle: exchange full SDPs once gathering completes.
  await a.setLocalDescription();
  await gathered(a);
  await b.setRemoteDescription(a.localDescription!);
  await b.setLocalDescription();
  await gathered(b);
  await a.setRemoteDescription(b.localDescription!);
  const lane: Lane = { cfg, a, b, sender: tr.sender, video, statsEl, last: null };
  await applyParams(lane);
  return lane;
}

function sizeVideo(video: HTMLVideoElement, scale: number) {
  const tile = $<HTMLSelectElement>('#tile').value;
  if (tile === 'native') {
    const w = source?.getVideoTracks()[0].getSettings().width ?? 960;
    video.style.width = `${Math.round(w / scale)}px`;
  } else video.style.width = `${tile}px`;
}

function resizeAll() {
  for (const c of cards) sizeVideo(c.video, typeof c.scale === 'function' ? c.scale() : c.scale);
}

function card(title: string, badge: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  const h = document.createElement('h2');
  h.textContent = title;
  const span = document.createElement('span');
  span.textContent = badge;
  h.appendChild(span);
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  const stats = document.createElement('div');
  stats.className = 'stats';
  stats.textContent = '—';
  el.append(h, video, stats);
  $('#grid').appendChild(el);
  return el;
}

function addSliders(el: HTMLElement, lane: Lane) {
  const ctl = document.createElement('div');
  ctl.className = 'ctl';
  const rows: [keyof Cfg, string, number, number, number][] = [
    ['scale', '縮小', 1, 8, 0.5],
    ['kbps', 'kbps', 30, 1500, 10],
    ['fps', 'fps', 5, 30, 1],
  ];
  for (const [key, label, min, max, step] of rows) {
    const name = document.createElement('span');
    name.textContent = label;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(lane.cfg[key]);
    const val = document.createElement('b');
    val.textContent = input.value;
    input.addEventListener('input', () => {
      (lane.cfg[key] as number) = Number(input.value);
      val.textContent = input.value;
      el.querySelector('h2 span')!.textContent = `${lane.cfg.kbps}kbps`;
      applyParams(lane).catch(() => {});
      sizeVideo(lane.video, lane.cfg.scale);
    });
    ctl.append(name, input, val);
  }
  el.appendChild(ctl);
}

async function start() {
  for (const l of lanes) {
    l.a.close();
    l.b.close();
  }
  lanes = [];
  cards = [];
  for (const t of source?.getTracks() ?? []) t.stop();
  $('#grid').replaceChildren();
  source = await getSource();

  const raw = card('ローカル（無加工）', '');
  const rawVideo = raw.querySelector('video')!;
  rawVideo.srcObject = source;
  cards.push({ video: rawVideo, scale: 1 });
  const s = source.getVideoTracks()[0].getSettings();
  raw.querySelector('.stats')!.textContent =
    `${s.width}×${s.height} @ ${Math.round(s.frameRate ?? 0)}fps\n入力そのまま`;

  for (const cfg of [...layers, custom]) {
    const el = card(cfg.label, `${cfg.kbps}kbps`);
    const video = el.querySelector('video')!;
    const lane = await makeLane(cfg, video, el.querySelector('.stats')!);
    lanes.push(lane);
    cards.push({ video, scale: () => cfg.scale });
    if (cfg.editable) addSliders(el, lane);
  }
  resizeAll();
  $('#start').textContent = '再開始';
}

async function pollStats() {
  for (const l of lanes) {
    const rep = await l.a.getStats();
    let out: RTCOutboundRtpStreamStats | undefined;
    rep.forEach((st) => {
      if (st.type === 'outbound-rtp' && st.kind === 'video') out = st;
    });
    if (!out) continue;
    const codec = out.codecId ? rep.get(out.codecId)?.mimeType?.split('/')[1] : undefined;
    const bytes = out.bytesSent ?? 0;
    const prev = l.last;
    l.last = { bytes, ts: out.timestamp };
    const kbps = prev ? (((bytes - prev.bytes) * 8) / (out.timestamp - prev.ts)).toFixed(0) : '…';
    const limit = out.qualityLimitationReason;
    l.statsEl.textContent =
      `${out.frameWidth ?? '?'}×${out.frameHeight ?? '?'} @ ${out.framesPerSecond ?? '?'}fps\n` +
      `${kbps} kbps 実測 / ${codec ?? '?'}` +
      (limit && limit !== 'none' ? `\n制限: ${limit}` : '');
  }
}

function restart() {
  $('#err').textContent = '';
  start().catch((e: Error) => {
    $('#err').textContent = e.message;
  });
}

$('#note').textContent =
  `現行の SFU_CAM_LAYERS: ${layers.map((l) => `${l.label} = 1/${l.scale}・${l.kbps}kbps・${l.fps}fps`).join(' / ')}。` +
  '各レイヤは単一エンコーディングでの近似（本番は 3 レイヤ同時の simulcast）。';
$('#start').addEventListener('click', restart);
$('#codec').addEventListener('change', () => source && restart());
$('#src').addEventListener('change', () => source && restart());
$('#tile').addEventListener('change', resizeAll);
setInterval(() => void pollStats(), 1000);
