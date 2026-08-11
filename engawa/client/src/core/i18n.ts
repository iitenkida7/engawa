// Minimal i18n for the app UI (issue #172). No framework: a flat dictionary
// keyed by dot-namespaced ids, a language resolved once at load from a stored
// choice or the browser/OS language (navigator.language), and a tiny t() with
// {var} interpolation. Switching language persists the choice and reloads —
// the simplest way to re-apply strings uniformly across static HTML, the
// dynamically-built DOM, and canvas-drawn text.

export type Lang = 'ja' | 'en';

const STORAGE_KEY = 'engawa-lang';
const LANGS: Lang[] = ['ja', 'en'];

/**
 * Decide the active language (pure, so it is unit-tested): a valid stored
 * choice wins; otherwise fall back to the browser/OS language — Japanese only
 * when it starts with "ja", English for everything else.
 */
export function resolveLang(stored: string | null, navLang: string | undefined): Lang {
  if (stored === 'ja' || stored === 'en') return stored;
  return (navLang ?? '').toLowerCase().startsWith('ja') ? 'ja' : 'en';
}

const current: Lang = resolveLang(
  typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null,
  typeof navigator !== 'undefined' ? navigator.language : undefined,
);

export function getLang(): Lang {
  return current;
}

/** Persist the chosen language and reload so every layer re-renders in it. */
export function setLang(lang: Lang): void {
  if (lang === current) return;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    /* ignore private-mode storage errors */
  }
  if (typeof location !== 'undefined') location.reload();
}

// prettier-ignore
const STR: Record<string, Record<Lang, string>> = {
  // -- shared ---------------------------------------------------------------
  'common.close': { ja: '閉じる', en: 'Close' },
  'common.you': { ja: 'あなた', en: 'You' },
  'common.none': { ja: 'なし', en: 'None' },
  'common.barefoot': { ja: 'はだし', en: 'Barefoot' },

  // -- language toggle ------------------------------------------------------
  'lang.label': { ja: '言語', en: 'Language' },
  'lang.toggleTitle': {
    ja: '言語を切り替え（日本語 / English）',
    en: 'Switch language (日本語 / English)',
  },

  // -- password gate --------------------------------------------------------
  'pass.title': { ja: '合言葉を入力', en: 'Enter the passphrase' },
  'pass.placeholder': { ja: 'パスワード', en: 'Password' },
  'pass.error': { ja: 'パスワードが正しくありません', en: 'Incorrect password' },
  'pass.next': { ja: '次へ', en: 'Next' },

  // -- join screen ----------------------------------------------------------
  'join.title': { ja: 'engawa に参加', en: 'Join engawa' },
  'join.name': { ja: '名前を入力', en: 'Enter your name' },
  'join.editAvatar': { ja: '🎨 アバターを編集', en: '🎨 Edit avatar' },
  'join.enter': { ja: '入室', en: 'Enter' },

  // -- avatar editor --------------------------------------------------------
  'avatar.title': { ja: 'アバターを作る', en: 'Create your avatar' },
  'avatar.random': { ja: '🎲 おまかせ', en: '🎲 Surprise me' },
  'avatar.confirm': { ja: '決定', en: 'Done' },
  'avatar.credit': { ja: '素材: LPC (CC-BY-SA 等)', en: 'Art: LPC (CC-BY-SA, etc.)' },
  'avatar.credits': { ja: 'クレジット', en: 'Credits' },
  'avatar.cat.sex': { ja: '性別', en: 'Gender' },
  'avatar.cat.skin': { ja: '肌の色', en: 'Skin tone' },
  'avatar.cat.hair': { ja: '髪型', en: 'Hairstyle' },
  'avatar.cat.hairColor': { ja: '髪の色', en: 'Hair color' },
  'avatar.cat.top': { ja: '上着', en: 'Top' },
  'avatar.cat.topColor': { ja: '上着の色', en: 'Top color' },
  'avatar.cat.bottom': { ja: '下衣', en: 'Bottom' },
  'avatar.cat.bottomColor': { ja: '下衣の色', en: 'Bottom color' },
  'avatar.cat.shoes': { ja: '靴', en: 'Shoes' },
  'avatar.cat.hat': { ja: '帽子', en: 'Hat' },
  'avatar.cat.glasses': { ja: 'メガネ', en: 'Glasses' },
  'avatar.sex.male': { ja: '男性', en: 'Male' },
  'avatar.sex.female': { ja: '女性', en: 'Female' },

  // -- roster ---------------------------------------------------------------
  'roster.title': { ja: '参加者', en: 'Participants' },
  'roster.chat': { ja: 'チャット', en: 'Chat' },
  'roster.status': { ja: 'ステータス', en: 'Status' },
  'roster.collapse': { ja: '折りたたむ', en: 'Collapse' },
  'roster.expand': { ja: '参加者リストを開く', en: 'Open participant list' },
  'roster.until': { ja: '〜{time}まで', en: 'until ~{time}' },
  'roster.knock': {
    ja: '{name} さんにノック（話したいと伝える）',
    en: "Knock for {name} (let them know you'd like to talk)",
  },
  'roster.goto': { ja: '{name} のそばへ移動', en: 'Move next to {name}' },
  'roster.noteLabel': { ja: '一言メッセージ', en: 'Status message' },
  'roster.notePlaceholder': { ja: '例: ランチ', en: 'e.g. Lunch' },
  'roster.returnLabel': { ja: '戻り時刻', en: 'Back at' },
  'roster.minutes': { ja: '{n}分', en: '{n} min' },

  // -- status labels --------------------------------------------------------
  'status.online': { ja: '🟢 オンライン', en: '🟢 Online' },
  'status.busy': { ja: '🔴 取り込み中', en: '🔴 Busy' },
  'status.away': { ja: '🟡 離席中', en: '🟡 Away' },
  'status.meeting': { ja: '🤝 商談中', en: '🤝 In a meeting' },
  'status.break': { ja: '☕ 休憩中', en: '☕ On a break' },

  // -- toolbar buttons (state-dependent labels) -----------------------------
  'toolbar.micOn': { ja: '🎤 ON', en: '🎤 On' },
  'toolbar.mic': { ja: '🎤 マイク', en: '🎤 Mic' },
  'toolbar.camOn': { ja: '📷 ON', en: '📷 On' },
  'toolbar.cam': { ja: '📷 カメラ', en: '📷 Camera' },
  'toolbar.screenOn': { ja: '🖥 共有中', en: '🖥 Sharing' },
  'toolbar.screen': { ja: '🖥 画面共有', en: '🖥 Share' },
  'toolbar.recOn': { ja: '⏹ 録画停止', en: '⏹ Stop' },
  'toolbar.rec': { ja: '⏺ 録画', en: '⏺ Record' },
  // Mic-menu noise-suppression toggle (issue #180); shows a ✓ prefix when on.
  'toolbar.noise': { ja: '🤫 ノイズ抑制', en: '🤫 Noise suppression' },
  // -- toolbar tooltips (title=) --------------------------------------------
  'toolbar.micTitle': { ja: 'マイク', en: 'Microphone' },
  'toolbar.selectMic': { ja: 'マイクを選択', en: 'Select microphone' },
  'toolbar.camTitle': { ja: 'カメラ', en: 'Camera' },
  'toolbar.selectCam': { ja: 'カメラ・背景を選択', en: 'Select camera / background' },
  'toolbar.screenTitle': { ja: '画面共有', en: 'Screen share' },
  'toolbar.recTitle': { ja: '録画', en: 'Record' },
  'toolbar.reactions': { ja: 'リアクション', en: 'Reactions' },
  'toolbar.more': { ja: 'その他', en: 'More' },
  // -- toolbar menus & toasts -----------------------------------------------
  'toolbar.errMic': { ja: 'マイクを使えません: {msg}', en: "Can't use the microphone: {msg}" },
  'toolbar.errCam': { ja: 'カメラを使えません: {msg}', en: "Can't use the camera: {msg}" },
  'toolbar.errScreen': {
    ja: '画面共有を開始できません: {msg}',
    en: "Couldn't start screen sharing: {msg}",
  },
  'toolbar.errImage': { ja: '画像を読み込めません: {msg}', en: "Couldn't load the image: {msg}" },
  'toolbar.reaction': { ja: 'リアクション ({n})', en: 'Reaction ({n})' },
  'toolbar.noDevices': { ja: 'デバイスが見つかりません', en: 'No devices found' },
  'toolbar.device': { ja: 'デバイス {n}', en: 'Device {n}' },
  'toolbar.bg': { ja: '背景', en: 'Background' },
  'toolbar.bgOff': { ja: '🚫 オフ', en: '🚫 Off' },
  'toolbar.bgBlur': { ja: '🌫 ぼかし', en: '🌫 Blur' },
  'toolbar.bgCustom': { ja: '🖼 カスタム画像', en: '🖼 Custom image' },
  'toolbar.bgUpload': { ja: '📁 画像をアップロード…', en: '📁 Upload image…' },
  'toolbar.editAvatar': { ja: '🧍 アバターを編集', en: '🧍 Edit avatar' },
  'toolbar.closeDebug': { ja: '🐛 デバッグを閉じる', en: '🐛 Close debug' },
  'toolbar.openDebug': { ja: '🐛 デバッグ（RTC 接続）', en: '🐛 Debug (RTC connections)' },

  // -- virtual background presets & button ----------------------------------
  'vbg.office': { ja: '🏢 オフィス', en: '🏢 Office' },
  'vbg.sky': { ja: '🌤 青空', en: '🌤 Blue sky' },
  'vbg.sunset': { ja: '🌇 夕焼け', en: '🌇 Sunset' },
  'vbg.green': { ja: '🌿 グリーン', en: '🌿 Green' },
  'vbg.btnBg': { ja: '🪄 背景', en: '🪄 Background' },
  'vbg.btnBlur': { ja: '🌫 ぼかし', en: '🌫 Blur' },
  'vbg.btnImage': { ja: '🖼 画像', en: '🖼 Image' },

  // -- knock ----------------------------------------------------------------
  'knock.sent': { ja: '{name} さんにノックしました…', en: 'Knocked for {name}…' },
  'knock.noResponse': {
    ja: '{name} さんから返事がありませんでした',
    en: 'No response from {name}',
  },
  'knock.wantsTalk': { ja: '{name} さんが話したがっています', en: '{name} would like to talk' },
  'knock.accept': { ja: '応じる', en: 'Accept' },
  'knock.later': { ja: 'あとで', en: 'Later' },
  'knock.accepted': {
    ja: '{name} さんが応じました。近づきます',
    en: '{name} accepted — heading over',
  },
  'knock.busy': { ja: '{name} さんは今は手が離せないようです', en: '{name} is tied up right now' },
  'knock.someone': { ja: '相手', en: 'someone' },

  // -- debug console --------------------------------------------------------
  'debug.title': { ja: '🐛 デバッグ — RTC 接続', en: '🐛 Debug — RTC connections' },
  'debug.mesh': { ja: 'メッシュ', en: 'Mesh' },
  'debug.connections': { ja: '接続 {n}', en: 'Connections {n}' },
  'debug.noConnections': {
    ja: '接続はありません（近くに誰かがいると表示されます）',
    en: 'No connections (they appear when someone is nearby)',
  },
  'debug.noStreams': { ja: 'ストリームなし', en: 'No streams' },
  'debug.copyLog': { ja: '接続ログをコピー', en: 'Copy connection log' },

  // -- remote media ---------------------------------------------------------
  'media.yourScreen': { ja: 'あなたの画面', en: 'Your screen' },
  'media.screenOf': { ja: '{name} の画面', en: "{name}'s screen" },
  'media.dblClickMain': {
    ja: 'ダブルクリックでメイン表示に切り替え',
    en: 'Double-click to make this the main view',
  },

  // -- chat -----------------------------------------------------------------
  'chat.title': { ja: '💬 チャット', en: '💬 Chat' },
  'chat.placeholder': { ja: '近くの人にメッセージ…', en: 'Message people nearby…' },

  // -- layout ---------------------------------------------------------------
  'layout.grid': { ja: 'グリッド整列', en: 'Grid' },
  'layout.sidebar': { ja: 'サイドバー整列', en: 'Sidebar' },

  // -- app-level toasts -----------------------------------------------------
  'app.cantConnect': {
    ja: 'サーバーに接続できません。自動的に再試行しています…',
    en: "Can't connect to the server. Retrying automatically…",
  },
  'app.reconnect': { ja: '再接続', en: 'Reconnect' },
  'app.reconnecting': {
    ja: '接続が切れました。再接続しています…',
    en: 'Connection lost. Reconnecting…',
  },
  'app.sfuFallback': {
    ja: '通話サーバーに接続できないため、P2P 接続に切り替えました。',
    en: "Couldn't reach the call server — switched to a P2P connection.",
  },

  // -- reload banner --------------------------------------------------------
  'reload.countdown': { ja: '{seconds} 秒後に再読み込みします…', en: 'Reloading in {seconds}s…' },
  'reload.updated': { ja: 'サーバーが更新されました', en: 'The server was updated' },
  'reload.now': { ja: '今すぐ再読み込み', en: 'Reload now' },

  // -- recorder -------------------------------------------------------------
  'recorder.unsupported': {
    ja: 'このブラウザは録画に対応していません',
    en: "This browser doesn't support recording",
  },

  // -- map zones (canvas labels; keyed by room id, not display name) --------
  'zone.ceo': { ja: '社長室', en: "President's office" },
  'zone.all-hands': { ja: '大会議室', en: 'All-hands room' },
  'zone.meeting-1': { ja: '会議室1', en: 'Meeting room 1' },
  'zone.meeting-2': { ja: '会議室2', en: 'Meeting room 2' },
  'zone.meeting-3': { ja: '会議室3', en: 'Meeting room 3' },
  'zone.1on1-1': { ja: '1on1ルーム1', en: '1-on-1 room 1' },
  'zone.1on1-2': { ja: '1on1ルーム2', en: '1-on-1 room 2' },
  'zone.1on1-3': { ja: '1on1ルーム3', en: '1-on-1 room 3' },
  'zone.booth-1': { ja: '商談ブース1', en: 'Meeting booth 1' },
  'zone.booth-2': { ja: '商談ブース2', en: 'Meeting booth 2' },
  'zone.booth-3': { ja: '商談ブース3', en: 'Meeting booth 3' },
};

/**
 * Look up a string for the active language and interpolate {var} params.
 * Falls back to English, then to the key itself, so a missing entry is visible
 * rather than crashing.
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const entry = STR[key];
  let s = entry ? (entry[current] ?? entry.en) : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}

/**
 * Apply translations to a static DOM subtree via data attributes:
 *   data-i18n        → textContent
 *   data-i18n-title  → title
 *   data-i18n-ph     → placeholder
 *   data-i18n-aria   → aria-label
 */
export function applyI18n(root: ParentNode = document): void {
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n as string);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-title]')) {
    el.title = t(el.dataset.i18nTitle as string);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh as string);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as string));
  }
}

export { LANGS };
