// Notification lab (standalone page, opened from the "⋯" menu). Exercises the
// plain Notification API in isolation so "the chime rang but no OS notification
// appeared" can be split into browser-side vs OS-side causes. Also shows what
// engawa's own knockAlertLevel() would decide right now, and can fire a fake
// knock through the real DesktopNotifier path.
import { DesktopNotifier, isBackgrounded, knockAlertLevel } from '@/ui/desktop-notify';

const ICON = '/icons/engawa-logo-192.png';
const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const checked = (id: string) => $<HTMLInputElement>(`#${id}`).checked;

const notifier = new DesktopNotifier();
const t0 = performance.now();
let seq = 0;

function log(msg: string, cls = '') {
  const el = $('#log');
  const line = document.createElement('div');
  if (cls) line.className = cls;
  const sec = ((performance.now() - t0) / 1000).toFixed(1).padStart(6);
  line.textContent = `[${sec}s] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function stateNote(): string {
  return `hidden=${document.hidden} focus=${document.hasFocus()}`;
}

async function renderEnv() {
  const supported = typeof Notification !== 'undefined';
  let queried = '-';
  try {
    const s = await navigator.permissions.query({ name: 'notifications' as PermissionName });
    queried = s.state;
  } catch {
    queried = 'query 不可';
  }
  let storedToggle: string | null = null;
  try {
    storedToggle = localStorage.getItem('engawa-desktop-notify');
  } catch {
    /* ignore */
  }
  const level = knockAlertLevel({
    backgrounded: isBackgrounded(),
    status: 'online',
    enabled: notifier.isEnabled(),
    permission: notifier.permission(),
  });
  const rows: [string, string, boolean | null][] = [
    ['isSecureContext', String(window.isSecureContext), window.isSecureContext],
    ['Notification API', supported ? 'あり' : 'なし', supported],
    ['Notification.permission', notifier.permission(), notifier.permission() === 'granted'],
    ['permissions.query', queried, queried === 'granted'],
    [
      'maxActions',
      supported
        ? String((Notification as unknown as { maxActions?: number }).maxActions ?? '-')
        : '-',
      null,
    ],
    ['serviceWorker', 'serviceWorker' in navigator ? 'あり' : 'なし', null],
    ['document.hidden', String(document.hidden), null],
    ['document.hasFocus()', String(document.hasFocus()), null],
    ['engawa トグル (localStorage)', storedToggle ?? '(未設定=ON)', storedToggle !== '0'],
    ['engawa isEnabled()', String(notifier.isEnabled()), notifier.isEnabled()],
    ['knockAlertLevel (今)', level, null],
    ['userAgent', navigator.userAgent, null],
  ];
  const table = $('#env');
  table.replaceChildren();
  for (const [k, v, ok] of rows) {
    const tr = document.createElement('tr');
    const a = document.createElement('td');
    a.textContent = k;
    const b = document.createElement('td');
    b.textContent = v;
    if (ok !== null) b.className = ok ? 'ok' : 'ng';
    tr.append(a, b);
    table.appendChild(tr);
  }
}

// `force` overrides the requireInteraction checkbox. On macOS Chrome routes
// plain notifications through the main app and persistent (requireInteraction)
// ones through its Alerts helper, which show up as two separate "Google Chrome"
// rows in System Settings › Notifications — the distinct titles tell them apart.
function send(label: string, force?: { persistent: boolean; title: string }) {
  if (typeof Notification === 'undefined') {
    log('Notification API がありません', 'ng');
    return;
  }
  const id = ++seq;
  const opts: NotificationOptions = {
    body: `#${id} ${label} / ${new Date().toLocaleTimeString()}`,
    requireInteraction: force ? force.persistent : checked('requireInteraction'),
    silent: checked('silent'),
  };
  if (checked('icon')) opts.icon = ICON;
  if (checked('tag')) opts.tag = 'notify-lab';
  log(`#${id} new Notification() permission=${Notification.permission} ${stateNote()}`);
  try {
    const n = new Notification(force?.title ?? 'engawa 通知テスト', opts);
    n.onshow = () => log(`#${id} show`, 'ok');
    n.onclick = () => {
      log(`#${id} click`, 'ok');
      window.focus();
      n.close();
    };
    n.onclose = () => log(`#${id} close`);
    n.onerror = () => log(`#${id} error`, 'ng');
  } catch (e) {
    log(`#${id} 例外: ${(e as Error).message}`, 'ng');
  }
}

function later(fn: () => void, what: string) {
  const sec = Number($<HTMLSelectElement>('#delay').value);
  log(`${sec} 秒後に${what}。今のうちに別ウィンドウへ切り替えてください`);
  setTimeout(fn, sec * 1000);
}

function fakeKnock() {
  const level = knockAlertLevel({
    backgrounded: isBackgrounded(),
    status: 'online',
    enabled: notifier.isEnabled(),
    permission: notifier.permission(),
  });
  log(`疑似ノック level=${level} ${stateNote()}`, level === 'desktop' ? 'ok' : 'ng');
  notifier.knock(level, 'notify-lab', 'engawa 疑似ノック', 'DesktopNotifier.knock() 経由');
}

$('#perm').addEventListener('click', async () => {
  if (typeof Notification === 'undefined') return;
  log(`requestPermission() 前: ${Notification.permission}`);
  const r = await Notification.requestPermission();
  log(`requestPermission() → ${r}`, r === 'granted' ? 'ok' : 'ng');
  await renderEnv();
});
$('#send').addEventListener('click', () => send('即時'));
$('#sendBanner').addEventListener('click', () =>
  send('バナー型', { persistent: false, title: '🟦 バナー型（Chrome 本体）' }),
);
$('#sendAlert').addEventListener('click', () =>
  send('アラート型', { persistent: true, title: '🟥 アラート型（Chrome Alerts ヘルパー）' }),
);
$('#sendLater').addEventListener('click', () => later(() => send('遅延'), '通知'));
$('#knockLater').addEventListener('click', () => later(fakeKnock, '疑似ノック'));

// Clear the title badge the fake knock adds once we're looked at again, and keep
// the focus/visibility rows live.
const refresh = () => {
  if (!isBackgrounded()) notifier.clearBadge();
  void renderEnv();
};
window.addEventListener('focus', refresh);
window.addEventListener('blur', refresh);
document.addEventListener('visibilitychange', () => {
  log(`visibilitychange ${stateNote()}`);
  refresh();
});

void renderEnv();
log('ready');
