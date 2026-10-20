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
  'common.cancel': { ja: 'キャンセル', en: 'Cancel' },
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
  'pass.remember': { ja: 'この端末で記憶する', en: 'Remember on this device' },
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
  // Avatar action menu (click an avatar on the map).
  'avatar.goto': { ja: 'そこへ行く', en: 'Go there' },
  'avatar.knock': { ja: '呼ぶ', en: 'Call' },

  // -- status labels --------------------------------------------------------
  'status.online': { ja: '🟢 オンライン', en: '🟢 Online' },
  'status.busy': { ja: '🔴 取り込み中', en: '🔴 Busy' },
  'status.away': { ja: '🟡 離席中', en: '🟡 Away' },
  'status.awayOverlay': {
    ja: '🟡 離席中（オンライン／取り込み中で復帰）',
    en: '🟡 Away — set Online/Busy to return',
  },

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
  // Recording notices (privacy): shown to others in the same call, plus the rec
  // button's "someone else is recording" badge tooltip.
  'rec.started': { ja: '{name} さんが録画を開始しました', en: '{name} started recording' },
  'rec.stopped': { ja: '{name} さんが録画を終了しました', en: '{name} stopped recording' },
  'rec.reminder': {
    ja: '会議室で1分経ちましたが、誰も録画していません。録画しますか？',
    en: 'No one has been recording in this meeting room for a minute. Start recording?',
  },
  'rec.reminderStart': { ja: '録画する', en: 'Record' },
  'rec.reminderSkip': { ja: 'しない', en: 'Not now' },
  'rec.othersTip': { ja: '録画中: {names}', en: 'Recording: {names}' },
  // Our own recording (#315): a persistent indicator stays on screen while it runs.
  'rec.indicator': { ja: '録画中', en: 'REC' },
  'rec.indicatorHint': {
    ja: '■ 停止で保存',
    en: '■ Stop to save',
  },
  'toolbar.reactions': { ja: 'リアクション', en: 'Reactions' },
  'toolbar.more': { ja: 'その他', en: 'More' },
  // -- toolbar menus & toasts -----------------------------------------------
  'toolbar.errMic': { ja: 'マイクを使えません: {msg}', en: "Can't use the microphone: {msg}" },
  'toolbar.errCam': { ja: 'カメラを使えません: {msg}', en: "Can't use the camera: {msg}" },
  'toolbar.micLost': {
    ja: 'マイクが切断されたため、オフにしました',
    en: 'Your microphone was disconnected, so it was turned off',
  },
  'toolbar.camLost': {
    ja: 'カメラが切断されたため、オフにしました',
    en: 'Your camera was disconnected, so it was turned off',
  },
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
  'toolbar.shortcuts': { ja: '⌨ キーバインド一覧', en: '⌨ Keyboard shortcuts' },
  'toolbar.testNotify': { ja: '🔔 通知をテスト', en: '🔔 Test notification' },
  'toolbar.facePip': {
    ja: '🪟 画面共有中に顔を小窓に出す（Chrome / Edge）',
    en: '🪟 Faces in a floating window while sharing (Chrome / Edge)',
  },
  'toolbar.facePipHint': {
    ja: '顔の小窓を開きました。画面全体を共有している場合は小窓も相手に見えます',
    en: 'Opened the faces window. If you share your entire screen, it shows up for others too.',
  },
  'toolbar.facePipRetry': {
    ja: '顔の小窓を自動で開けませんでした',
    en: 'Could not open the faces window automatically',
  },
  'toolbar.facePipOpen': { ja: '小窓を開く', en: 'Open it' },
  'toolbar.ptt': { ja: '🎙 プッシュトーク(SPACEキー)', en: '🎙 Push-to-talk (Space key)' },
  'toolbar.closeDebug': { ja: '🐛 デバッグを閉じる', en: '🐛 Close debug' },
  'toolbar.openDebug': { ja: '🐛 デバッグ（RTC 接続）', en: '🐛 Debug (RTC connections)' },
  'toolbar.cameraLab': { ja: '🎥 カメラ画質ラボ', en: '🎥 Camera quality lab' },

  // -- virtual background presets & button ----------------------------------
  'vbg.office': { ja: '⬛ ダーク', en: '⬛ Dark' },
  'vbg.sky': { ja: '🟦 ブルー', en: '🟦 Blue' },
  'vbg.sunset': { ja: '🟧 サンセット', en: '🟧 Sunset' },
  'vbg.green': { ja: '🟩 グリーン', en: '🟩 Green' },
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
    ja: '{name} さんが応じました。来てくれます',
    en: '{name} accepted — on their way',
  },
  'knock.busy': { ja: '{name} さんは今は手が離せないようです', en: '{name} is tied up right now' },
  'knock.someone': { ja: '相手', en: 'someone' },
  'knock.missed': {
    ja: '{name} さんがノックしました（{minutes} 分前）',
    en: '{name} knocked ({minutes} min ago)',
  },
  'knock.callBack': { ja: '呼び返す', en: 'Call back' },
  'knock.dismiss': { ja: '閉じる', en: 'Dismiss' },

  // -- desktop notifications (#140) ----------------------------------------
  'notify.knockTitle': { ja: '🔔 {name} さんがノック', en: '🔔 {name} is knocking' },
  'notify.knockBody': { ja: '話したがっています', en: 'They would like to talk' },
  'notify.toggleOn': { ja: '🔔 デスクトップ通知: ON', en: '🔔 Desktop notifications: ON' },
  'notify.toggleOff': { ja: '🔕 デスクトップ通知: OFF', en: '🔕 Desktop notifications: OFF' },
  'notify.testTitle': { ja: '🔔 engawa のテスト通知', en: '🔔 engawa test notification' },
  'notify.testBody': {
    ja: 'これが見えていればデスクトップ通知は届きます',
    en: 'If you can see this, desktop notifications work',
  },
  'notify.testAsk': {
    ja: 'テスト通知を送りました。画面の端に届きましたか？',
    en: 'Sent a test notification. Did it show up?',
  },
  'notify.testYes': { ja: '届いた', en: 'Yes' },
  'notify.testNo': { ja: '届かない', en: 'No' },
  'notify.unsupported': {
    ja: 'このブラウザ / 環境ではデスクトップ通知を使えません',
    en: 'Desktop notifications are not available in this browser',
  },
  'notify.help.browserTitle': {
    ja: '🚫 ブラウザが通知をブロックしています',
    en: '🚫 Your browser is blocking notifications',
  },
  'notify.help.browserLead': {
    ja: 'engawa のサイトに通知の許可がありません。ブラウザのサイト設定で許可してください。',
    en: 'engawa is not allowed to notify you. Allow it in the browser site settings.',
  },
  'notify.help.browser1': {
    ja: 'アドレスバー左端のアイコン（🔒 など）をクリック',
    en: 'Click the icon at the left of the address bar (🔒 etc.)',
  },
  'notify.help.browser2': {
    ja: '「通知」を「許可」に変更（なければ「サイトの設定」→「通知」→「許可」）',
    en: 'Set "Notifications" to "Allow" (or Site settings → Notifications → Allow)',
  },
  'notify.help.browser3': {
    ja: 'ページを再読み込みして、⋯ メニューの「通知をテスト」で確認',
    en: 'Reload the page and check again with ⋯ → Test notification',
  },
  'notify.help.osTitle': {
    ja: '🖥 OS の通知設定を確認してください',
    en: '🖥 Check your OS notification settings',
  },
  'notify.help.osLead': {
    ja: 'ブラウザ側は許可済みです。OS がブラウザの通知を止めている可能性があります。',
    en: 'The browser allows it, so the OS is probably holding back browser notifications.',
  },
  'notify.help.mac1': {
    ja: '下のボタンで「システム設定 › 通知」を開く',
    en: 'Open System Settings › Notifications with the button below',
  },
  'notify.help.mac2': {
    ja: '一覧の「Google Chrome」（2 行あれば両方。Edge なら Microsoft Edge）の「通知を許可」をオン',
    en: 'Turn on "Allow notifications" for Google Chrome (both rows if there are two; Microsoft Edge for Edge)',
  },
  'notify.help.mac3': {
    ja: '集中モード（おやすみモードなど）がオフか確認',
    en: 'Make sure a Focus mode (e.g. Do Not Disturb) is off',
  },
  'notify.help.win1': {
    ja: '下のボタンで「設定 › システム › 通知」を開く',
    en: 'Open Settings › System › Notifications with the button below',
  },
  'notify.help.win2': {
    ja: '「通知」をオンにし、アプリ一覧の Google Chrome（または Microsoft Edge）もオン',
    en: 'Turn on "Notifications", and Google Chrome (or Microsoft Edge) in the app list',
  },
  'notify.help.win3': {
    ja: '「応答不可」（集中モード）がオフか確認',
    en: 'Make sure "Do not disturb" (Focus) is off',
  },
  'notify.help.other1': {
    ja: 'OS の通知設定で、使っているブラウザの通知を許可',
    en: "Allow your browser's notifications in the OS notification settings",
  },
  'notify.help.other2': {
    ja: 'おやすみモード / 集中モードがオフか確認',
    en: 'Make sure Do Not Disturb / Focus is off',
  },
  'notify.help.openSettings': { ja: '⚙ 通知設定を開く', en: '⚙ Open notification settings' },
  'notify.help.retest': { ja: 'もう一度テスト', en: 'Test again' },

  // -- transcript (Groq speech-to-text) -------------------------------------
  'toolbar.transcriptStart': { ja: '📝 文字起こしを開始', en: '📝 Start transcribing' },
  'toolbar.transcriptStop': { ja: '⏹ 文字起こしを停止', en: '⏹ Stop transcribing' },
  'toolbar.transcriptSettings': { ja: '📝 文字起こしの設定', en: '📝 Transcription settings' },
  'toolbar.recReminder': {
    ja: '⏺ 会議室で録画を忘れていたら知らせる',
    en: '⏺ Remind me to record in meeting rooms',
  },
  'transcript.title': { ja: '\u{1F4DD} 文字起こし', en: '\u{1F4DD} Transcript' },
  'transcript.copy': { ja: '全文をコピー', en: 'Copy transcript' },
  'transcript.save': { ja: 'テキストで保存', en: 'Save as text' },
  'transcript.started': {
    ja: '{name} さんが文字起こしを開始しました',
    en: '{name} started transcribing',
  },
  'transcript.stopped': {
    ja: '{name} さんが文字起こしを終了しました',
    en: '{name} stopped transcribing',
  },
  'transcript.othersTip': { ja: '文字起こし中: {names}', en: 'Transcribing: {names}' },
  'transcript.confirmClose': {
    ja: '文字起こしを閉じると、保存していない内容は失われます。閉じますか？',
    en: 'Closing the transcript discards it. Anything unsaved will be lost. Close it?',
  },
  'transcript.zoneLeftStopped': {
    ja: '会議室を出たので文字起こしを終了しました',
    en: 'Left the room — transcription stopped',
  },
  'transcript.alreadyRunning': {
    ja: '{name} さんが文字起こし中です。結果はこのパネルに届きます。',
    en: '{name} is already transcribing — their results appear in this panel.',
  },
  'transcript.unsupported': {
    ja: 'このブラウザでは文字起こしを利用できません',
    en: 'Transcription is not supported in this browser',
  },
  'transcript.error': { ja: '文字起こしでエラー: {message}', en: 'Transcription error: {message}' },
  'transcript.authError': {
    ja: 'Groq の API キーが拒否されました。設定し直してください。',
    en: 'Groq rejected the API key. Please set it again.',
  },
  'transcript.summarize': {
    ja: 'ここまでを要約（この端末の AI で処理）',
    en: 'Summarize so far (runs on this device)',
  },
  'transcript.summaryTitle': { ja: '✨ 要約', en: '✨ Summary' },
  'transcript.summaryCopy': { ja: '要約をコピー', en: 'Copy summary' },
  'transcript.summarizing': { ja: '要約しています…', en: 'Summarizing…' },
  'transcript.summaryDownloading': {
    ja: '要約モデルをダウンロード中… {percent}%（初回のみ）',
    en: 'Downloading the summary model… {percent}% (first time only)',
  },
  'transcript.summaryEmpty': {
    ja: 'まだ要約する文字起こしがありません',
    en: 'Nothing to summarize yet',
  },
  'transcript.summaryError': {
    ja: '要約できませんでした: {message}',
    en: 'Could not summarize: {message}',
  },
  'transcript.needsMic': {
    ja: 'マイクか通話相手がいないと文字起こしできません',
    en: 'Turn on your mic or join a call before transcribing',
  },
  // -- transcript setup dialog ----------------------------------------------
  'transcript.setupTitle': { ja: '文字起こしの設定', en: 'Transcription settings' },
  'transcript.setupDesc': {
    ja: '通話中の音声を Groq の Whisper API で文字起こしします。音声はブラウザから Groq へ直接送信され、engawa のサーバーは経由しません。API キーはこのブラウザにのみ保存されます。',
    en: 'Transcribes the call with Groq\u2019s Whisper API. Audio goes from your browser straight to Groq and never passes through the engawa server. The API key is stored only in this browser.',
  },
  'transcript.setupPrivacy': {
    ja: '通話相手の音声も送信されるため、開始すると全員に通知されます。',
    en: 'Your call partners\u2019 audio is sent too, so everyone is notified when you start.',
  },
  'transcript.keyLabel': { ja: 'Groq API キー', en: 'Groq API key' },
  'transcript.keyHelp': { ja: 'console.groq.com で発行', en: 'Create one at console.groq.com' },
  'transcript.modelLabel': { ja: 'モデル', en: 'Model' },
  'transcript.modelTurbo': { ja: '高速・安価（$0.04/時）', en: 'Fast & cheap ($0.04/hr)' },
  'transcript.modelLarge': { ja: '高精度（$0.111/時）', en: 'Most accurate ($0.111/hr)' },
  'transcript.invalidKey': {
    ja: 'キーの形式が正しくないようです（gsk_ で始まります）',
    en: 'That does not look like a Groq key (they start with gsk_)',
  },
  'transcript.setupStart': { ja: '開始', en: 'Start' },
  'transcript.setupSave': { ja: '保存', en: 'Save' },
  'transcript.clearKey': { ja: 'キーを削除', en: 'Remove key' },

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
  'debug.copyReport': {
    ja: '診断レポートをコピー（Claude に貼って分析）',
    en: 'Copy diagnosis report (paste into Claude to analyze)',
  },
  'debug.avail': { ja: '上り推定', en: 'Uplink est.' },
  'debug.history': {
    ja: '直近60秒の品質（緑=良好 / 黄=やや注意 / 橙=不良 / 赤=深刻）',
    en: 'Last 60s quality (green=good / yellow=fair / orange=poor / red=bad)',
  },

  // -- remote media ---------------------------------------------------------
  'media.yourScreen': { ja: 'あなたの画面', en: 'Your screen' },
  'media.screenOf': { ja: '{name} の画面', en: "{name}'s screen" },
  'media.dblClickMain': {
    ja: 'クリックでメイン表示に切り替え',
    en: 'Click to make this the main view',
  },
  'media.volume': { ja: '音量 {pct}%', en: 'Volume {pct}%' },
  'media.focus': { ja: '拡大表示', en: 'Maximize' },
  'media.reconnecting': { ja: '再接続中…', en: 'Reconnecting…' },
  'facePip.empty': { ja: '通話相手がいません', en: 'No one in the call' },
  // Why a camera tile is dark (issue #312): stall overlays and placeholder notes.
  'media.stall.layer-switch': { ja: '画質を切り替え中…', en: 'Switching quality…' },
  'media.stall.my-network': {
    ja: 'あなたの回線が不安定です',
    en: 'Your connection is unstable',
  },
  'media.stall.peer-network': {
    ja: '相手の映像が届いていません（相手側の回線）',
    en: 'Not receiving their video (their connection)',
  },
  'media.recvVideoPaused': {
    ja: '回線節約のため映像受信を停止中',
    en: 'Video receiving paused to save bandwidth',
  },
  'media.peerCamAutoOff': {
    ja: '相手の回線が不安定なためカメラ停止中',
    en: 'Camera paused: their connection is unstable',
  },
  'media.peerPtt': { ja: 'プッシュトーク使用中', en: 'Using push-to-talk' },
  'media.unfocus': { ja: '拡大を解除（Esc）', en: 'Exit maximize (Esc)' },
  'media.filmstripMore': { ja: '他の参加者も表示', en: 'Show more participants' },
  'media.filmstripLess': { ja: '表示を減らす', en: 'Show fewer' },
  'media.filmstripResize': {
    ja: 'ドラッグで表示比率を変更（ダブルクリックで戻す）',
    en: 'Drag to resize (double-click to reset)',
  },
  'media.showMap': { ja: 'マップを表示', en: 'Show map' },
  'media.backToMeeting': { ja: '会議表示', en: 'Meeting view' },

  // -- chat -----------------------------------------------------------------
  'chat.title': { ja: '💬 チャット', en: '💬 Chat' },
  'chat.placeholder': { ja: '近くの人にメッセージ…', en: 'Message people nearby…' },

  // -- keyboard shortcuts (#297, re-laid-out in #302) ------------------------
  'keys.title': { ja: '⌨ キーバインド', en: '⌨ Keyboard shortcuts' },
  'keys.move': { ja: '移動（vim）', en: 'Move (vim)' },
  'keys.moveArrows': { ja: '移動（矢印）', en: 'Move (arrows)' },
  'keys.moveWasd': { ja: '移動（WASD）', en: 'Move (WASD)' },
  'keys.meetingView': { ja: '会議表示 ⇄ マップ表示', en: 'Meeting view ⇄ map' },
  'keys.zoom': { ja: '自分にズーム ⇄ 全体表示', en: 'Zoom to me ⇄ fit map' },
  'keys.mic': { ja: 'マイク ON/OFF', en: 'Mic on/off' },
  'keys.ptt': {
    ja: '押している間だけ話す（プッシュトーク有効時）',
    en: 'Hold to talk (when push-to-talk is on)',
  },
  'keys.cam': { ja: 'カメラ ON/OFF', en: 'Camera on/off' },
  'keys.screen': { ja: '画面共有 ON/OFF', en: 'Screen share on/off' },
  'keys.record': { ja: '録画 開始/停止', en: 'Start/stop recording' },
  'keys.roster': { ja: '参加者リスト 開閉', en: 'Toggle participants' },
  'keys.reaction': { ja: 'リアクション', en: 'Reactions' },
  'keys.help': { ja: 'この一覧 開閉', en: 'Toggle this list' },
  'keys.focusOut': { ja: '最大化を戻す', en: 'Exit maximized view' },
  'keys.note': {
    ja: 'Shift 付きは、ほかの人に見える操作です。入力欄にカーソルがあるときは動きません。',
    en: 'Shift + key is for what others see. Inactive while a text field has focus.',
  },

  // -- layout ---------------------------------------------------------------
  'layout.grid': { ja: 'グリッド整列', en: 'Grid' },
  'layout.sidebar': { ja: 'サイドバー整列', en: 'Sidebar' },
  'zoom.self': { ja: '自分にズーム', en: 'Zoom to me' },
  'zoom.fit': { ja: '全体表示', en: 'Fit whole map' },

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
  'app.autoplayBlocked': {
    ja: 'ブラウザが音声の再生をブロックしています。',
    en: 'Your browser is blocking audio playback.',
  },
  'app.autoplayEnable': { ja: '🔊 音声を有効にする', en: '🔊 Enable audio' },
  'app.sfuReconnecting': {
    ja: '通話サーバーに再接続しています…',
    en: 'Reconnecting to the call server…',
  },
  'app.netCamOff': {
    ja: '回線が不安定なため、音声を優先してカメラを一時停止しました(回復すると自動で再開します)。',
    en: 'Network is struggling — camera paused to protect audio (it will resume automatically).',
  },
  'app.netCamRestore': {
    ja: '回線が回復したため、カメラを再開しました。',
    en: 'Network recovered — camera resumed.',
  },
  'app.netRecvAudioOnly': {
    ja: '回線が不安定なため、映像の受信を一時停止しました(音声のみ)。',
    en: 'Network is struggling — pausing incoming video (audio only).',
  },
  'app.netRecvVideoRestore': {
    ja: '回線が回復したため、映像の受信を再開しました。',
    en: 'Network recovered — incoming video resumed.',
  },
  'app.zoneLeftMediaOff': {
    ja: '部屋を出たので、マイク・カメラ・画面共有をオフにしました。',
    en: 'Left the room — mic, camera and screen share turned off.',
  },

  // -- connection quality dots (issue #188) ----------------------------------
  'quality.q0': { ja: '回線: 良好', en: 'Connection: good' },
  'quality.q1': { ja: '回線: やや不安定', en: 'Connection: fair' },
  'quality.q2': { ja: '回線: 不安定', en: 'Connection: poor' },
  'quality.q3': { ja: '回線: 非常に不安定', en: 'Connection: bad' },

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
  'zone.1on1-4': { ja: '1on1ルーム4', en: '1-on-1 room 4' },
  'zone.booth-1': { ja: '商談ブース1', en: 'Meeting booth 1' },
  'zone.booth-2': { ja: '商談ブース2', en: 'Meeting booth 2' },
  'zone.booth-3': { ja: '商談ブース3', en: 'Meeting booth 3' },
  'zone.booth-4': { ja: '商談ブース4', en: 'Meeting booth 4' },
  'zone.lounge': { ja: 'ラウンジ', en: 'Lounge' },
  'zone.cafe': { ja: 'カフェ', en: 'Café' },
  'zone.lounge-1': { ja: 'ラウンジ1', en: 'Lounge 1' },
  'zone.lounge-2': { ja: 'ラウンジ2', en: 'Lounge 2' },
  'zone.hanare': { ja: '離れ', en: 'Annex' },
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
 *   data-i18n-tip    → data-tip + aria-label (custom CSS hover tooltip)
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
  // Custom hover tooltip (styled, instant) for icon-only buttons. Feeds the CSS
  // `[data-tip]` tooltip and doubles as the aria-label — no native `title`, so
  // the slow default tooltip doesn't show on top of ours.
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-tip]')) {
    const text = t(el.dataset.i18nTip as string);
    el.setAttribute('data-tip', text);
    el.setAttribute('aria-label', text);
  }
  for (const el of root.querySelectorAll<HTMLInputElement>('[data-i18n-ph]')) {
    el.placeholder = t(el.dataset.i18nPh as string);
  }
  for (const el of root.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', t(el.dataset.i18nAria as string));
  }
}

export { LANGS };
