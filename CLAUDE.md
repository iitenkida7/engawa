# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

このリポジトリで Claude が守るべきルールと、コードベースの全体像をまとめる。
**Claude の出力（会話・説明・質問）はすべて日本語。コミットメッセージ・コード中のコメントは英語。
PR のタイトル・本文（メッセージ）は日本語で書く。**

## プロジェクト概要
engawa（縁側）はブラウザだけで使える社内向けの仮想オフィス。2D マップ上でアバターを動かし、
他のアバターに近づくと自動で音声・映像・画面共有がつながる（離れると自動切断）。
Slack のハドルや Gather.town のような「ばったり話す」体験を軽量・低コストで実現することが狙い。

## 技術スタック
- **サーバー**: Bun + 標準 WebSocket（外部依存ほぼなし）
- **クライアント**: TypeScript + Vite + Canvas 2D（UI フレームワークなし）+ simple-peer（WebRTC）
- **STUN/TURN**: Google 公開 STUN / Cloudflare Realtime TURN（NAT 越え不可時のみ経由）
- **SFU**: Cloudflare Realtime SFU（大人数の近接グループ・会議室ゾーンの通話。未設定なら全メッシュにフォールバック）

## リポジトリ構成の注意（重要）
ソースコードは **リポジトリ直下ではなく `engawa/` サブディレクトリ配下** にある。
`docker-compose.yml` / `Makefile` / `README.md` / この `CLAUDE.md` はリポジトリ最上位。
**README は英語の `README.md` が本体、日本語は `README.ja.md`**（相互にリンク）。中身を変えるときは**両方**を更新する。

```
/ (リポジトリ最上位)
├ docker-compose.yml      # server(3000) / client(5173) を定義
├ Makefile                # 主要操作の入口（すべて Docker 経由）
├ .env.example
├ docs/webhook{,.ja}.md   # イベント Webhook の API 仕様（英語 / 日本語）
├ docs/control-plane{,.ja}.md  # 設定を外部エンドポイントから受け取る仕様（英語 / 日本語）
├ docs/entry-token{,.ja}.md    # 入室券（コントロールプレーン発行）の仕様（英語 / 日本語）
├ examples/webhook-gas/   # Webhook 受信サンプル（Google Apps Script。本体の関心事外）
└ engawa/
   ├ client/src/          # フロントエンド
   ├ server/src/          # シグナリングサーバー
   └ maps/                # マップ形式（map-def.ts）と同梱マップ（*.json）。server/client 共有
```

## コマンド（すべて Docker 経由）
アプリに関する操作（ビルド・テスト・依存追加・実行）は**ホストで直接行わず必ず Docker 経由**で行う。
主要操作は最上位の Makefile を入口にする。Makefile のコマンドと `gh` コマンドは確認なしで実行してよい。

| 目的 | コマンド |
|---|---|
| 起動（バックグラウンド） | `make up` |
| 停止 | `make down` |
| 再起動 | `make restart` |
| コンテナ状態 | `make ps` |
| Lint（server + client / Biome） | `make lint` |
| テスト（server + client 両方） | `make test` |
| 本番ビルド（型チェック + バンドル） | `make build` |
| 依存インストール | `make install` |
| ボリュームごと削除 | `make clean` |

- クライアント: http://localhost:5173 / サーバー: http://localhost:3000
- サーバーは `bun --watch`、クライアントは Vite HMR で自動リロード。
- `make build` は **server 側で `tsc --noEmit`（型チェック）→ client 側で `tsc --noEmit` → `vite build`** を実行する。
  **server / client とも型チェックがビルドの一部**（サーバーも型エラーで CI が落ちる）。
- `make lint` は **Biome** を server / client それぞれに対し `biome ci src` で実行する（`no-floating-promises`・
  未使用変数・スタイル統一などを検出）。設定は各パッケージ直下の `biome.json`（共通内容）。
- **品質ゲートは「型チェック（build）＋ lint ＋ テスト」**。push 前にこの 3 つ（`make build` / `make lint` /
  `make test`）を必ず通す。
- `npm install` / `bun install` を勝手に実行しない。依存追加が必要なときはユーザーに確認する。

### 単一テストの実行
テストは server / client とも `bun test`。Docker 経由で個別実行する場合:

```bash
# 特定ファイルだけ
docker compose run --rm --no-deps server bun test src/__tests__/logic.test.ts
docker compose run --rm --no-deps client bun test src/__tests__/proximity.test.ts

# テスト名で絞り込み（-t）
docker compose run --rm --no-deps server bun test -t 'verifyAccessPassword'
```

### CI
`.github/workflows/ci.yml` は main への push / PR で **ローカルと同じ Makefile ターゲット**
（`make install` → `make build` → `make lint` → `make test`）を Docker 上で実行する。CI とローカルを一致させるため、
新しい検証手順を足すときも Makefile 経由にする。

## アーキテクチャ（全体像）
メディア（音声・映像・画面共有）は **engawa のサーバーを絶対に経由しない**。既定では 2 人以上の
グループはすべて Cloudflare Realtime SFU 経由（#77/#78/#309。`SFU_PROMOTE_AT` で閾値を上げると
少人数は P2P メッシュ）。SFU 未設定なら全グループが P2P メッシュ。どちらでもメディアは自前サーバーを通らない。サーバーは「出会いの仲介」「位置同期」「グループ方式
（mesh/SFU）の判定・配信」「SFU 制御のプロキシ」を行う。

```
[ブラウザA] ──WebSocket──> [Bun サーバー] <──WebSocket── [ブラウザB]
   │                       ├ 位置のブロードキャスト           │
   │                       ├ WebRTC シグナリング中継（mesh）    │
   │                       ├ グループ判定（mesh/SFU）の配信     │
   │                       ├ /api/turn-credentials             │
   │                       └ /api/sfu/*（SFU 制御をプロキシ）   │
   │                                                           │
   ├─ 2 人以上の通話（既定）: Cloudflare Realtime SFU 経由 ────┤
   └─ SFU 未設定 / 閾値未満: WebRTC P2P メッシュ ──────────────┘
        ※ メディアは engawa を経由しない（P2P / Cloudflare のみ）
```

### サーバー（`engawa/server/src/`）
- `index.ts` — Bun.serve エントリ。ルーティングは手書き:
  `/ws`（WebSocket 升級, userId を UUID で発行）, `/api/turn-credentials`,
  `/api/sfu/*`（SFU 制御プロキシ）, `/api/map`（マップ JSON）, `/api/health`, それ以外は `./public` の静的配信
  （SPA フォールバックあり）。接続中クライアントは単一の in-memory `Map<userId, ws>` で管理。
- `websocket.ts` — WS メッセージハンドラ。入室・位置更新・シグナリング転送・退室に加え、
  **グループ方式の算出・配信（`group-update`）と SFU トラックディレクトリの中継（`sfu-publish`
  → `sfu-peer-tracks`）** をさばく。`broadcast` は**同一 workspace かつ join 済み**のみ配信。
- `logic.ts` — **副作用のない純粋関数**（座標クランプ、スポーン生成、名前/workspace 正規化、
  パスワード検証/パース、**近接グループ判定 `computeProximityGroups`**）。グループ判定は位置＋zone
  から連結成分を求め、会議室=常時 SFU・屋外は `SFU_PROMOTE_AT` 人で SFU 昇格（既定 2＝実質すべて SFU。
  一方向ラッチ）を割り当てる純粋関数。**開放フロアで新しく会話が始まるには双方が静止している（直近
  `PROXIMITY_STILL_MS`=700ms 位置が変わっていない）ことが必要**（すれ違いで通知音が鳴らないように。既存グループの維持・
  会議室は対象外）。停止後はサーバーのタイマー（`scheduleStillRegroup`）が再判定する。閾値の正規化も純粋関数 `normalizeSfuPromoteAt`。
- `map.ts` — 起動時に `MAP`（同梱プリセット名、または外部 JSON の URL）からマップを読み込み `assertMapDef` で検証する
  （不正なら**起動を拒否**）。`/api/map` で配信し、座標クランプの範囲とスポーン範囲（`mapWorld`）もマップから導出する。
- `turn.ts` — Cloudflare API を叩いて短期 ICE クレデンシャルを発行。**API キーはサーバーのみ保持**。
- `sfu.ts` — Cloudflare Realtime SFU の制御プレーン（セッション/トラック）を**プロキシ**する。
  App ID/Token はサーバーのみ保持しブラウザに渡さない（turn.ts と同じ作法）。転送先パスはホワイト
  リスト化（SSRF 対策）。メディアは通さずシグナリングのみ。
- `events.ts` — **任意のイベント Webhook**（`EVENT_WEBHOOK_URL`。仕様は `docs/webhook.md`）。入退室と会話の
  開始/終了を JSON で POST するだけで、保存・集計は受信側の関心事（受信サンプルは `examples/webhook-gas/`）。
  会話の追跡は純粋関数 `trackConversations`（近接グループの差分から開始/継続/終了を判定）。開いている滞在・会話は
  一時メモリのみ（不変条件 #2）。**API 仕様（イベントの型・フィールド）を変えたら `docs/webhook.md`（英語）と `docs/webhook.ja.md`（日本語）の両方を更新する。**
- `entry.ts` — **入室券**（任意。`ENTRY_MODE=token`。仕様は `docs/entry-token.md`）。コントロールプレーンが
  `CONTROL_PLANE_TOKEN` から派生させた鍵（`HMAC(token, "engawa-entry-ticket-v1")`。Bearer で送るトークン自体では署名しない）で HMAC-SHA256 署名した券を**ローカルで検証**するだけの純粋関数（`verifyEntryToken` /
  `signEntryToken` / `normalizeEntryMode`）。外部に問い合わせない・状態を持たない。署名照合は定数時間で、
  長さ不一致も通常の拒否にする。券の `name` を表示名に使うので**クライアントの自己申告は信じない**。
- `types.ts` — `WsData`（接続ごとの状態）, `ClientMessage` / `ServerMessage`。

### クライアント（`engawa/client/src/`）
ファイルは責務ごとに **5 フォルダ**へ分割し、import は **`@/` エイリアス**（`@/<folder>/<name>` 形式。
`tsconfig.json` の `paths` と `vite.config.ts` の `resolve.alias` で定義。Bun test も `paths` を解決する）で
参照する。エントリは `core/boot.ts`（`index.html` が読む。`/api/map` を取得して `world/map-data.ts` に入れてから `core/main.ts` を動的 import する）。
共有のマップ形式は `@maps/` エイリアス（`../maps`）で参照する。同一フォルダ内でも `@/` で参照し位置非依存にしてある。
- **`core/`** — オーケストレーションと基盤: `app.ts`, `boot.ts`, `main.ts`, `types.ts`, `lifecycle.ts`, `network.ts`, `proximity.ts`, `reload.ts`, `background-ticker.ts`, `entry-token.ts`（入室券の取り回し: リンクから取る・アドレスバーから消す・保持。純粋関数）
- **`rtc/`** — メディアトランスポート（不変条件 #1 の経路）: `webrtc.ts`, `sfu.ts`, `mesh-recovery.ts`（mesh ピア再構築 #184）, `sfu-recovery.ts`（SFU 作り直しのバックオフ #254）, `sdp.ts`, `cam-bitrate.ts`, `rtcstats.ts`, `diag.ts`（デバッグコンソールの接続判定・原因推定・Claude 用診断レポート。純粋関数）
- **`media/`** — 取得・加工・録画: `media.ts`, `recorder.ts`, `compositor.ts`, `vbg.ts`, `speaking.ts`, `noise.ts`, `noise-worklet.ts`, `rnnoise-wasm.ts`, `voice-gate.ts`, `lowpass.ts`
- **`world/`** — 2D マップ描画・移動: `canvas.ts`, `tilemap.ts`, `map-data.ts`（取得したマップの受け渡し）, `floor-styles.ts`（床柄・色のパレット）, `pathfind.ts`, `sprites.ts`, `decor.ts`, `player.ts`, `input.ts`, `movement.ts`（自分のグリッド移動・クリック移動）
- **`ui/`** — DOM パネル・コントロール: `toolbar.ts`, `remote-media.ts`, `panels.ts`, `draggable.ts`, `roster.ts`, `chat.ts`, `notify.ts`, `rec-indicator.ts`, `debug-console.ts`, `sounds.ts`, `video-stall.ts`（映像停止の理由判定。純粋関数）, `face-pip.ts`, `camera-lab.ts`（⋯メニューから別タブで開く `camera-lab.html` のロジック。`SFU_CAM_LAYERS` をループバック接続で実エンコードして見比べる画質ラボ）

`core/app.ts`（旧 `game.ts`。クラス名 `App`）が中心のオーケストレータで、ゲームループ・移動・近接判定・
サーバーメッセージのルーティング・各サブシステムの配線を担う。サブシステム同士は直接参照せず
App が仲介する（既存の Manager-callback パターン）。主なモジュール:
- `core/network.ts` — WebSocket。**dev では Vite プロキシが Bun の 101 升級を正しく中継できない**ため
  Bun サーバーへ直結し、prod では `window.location.host` を使う（コード中コメント参照）。
- `rtc/webrtc.ts` — simple-peer のラッパ（**mesh 経路**）。kind（mic/cam/screen）ごとの送信ビットレート
  上限、受信ジッタバッファ下限などを調整。
- `rtc/sfu.ts`（`SfuManager`）— **SFU 経路**。単一 RTCPeerConnection で自分のトラックを push（カメラは
  simulcast 多レイヤ）＋他者を pull。`rtc/webrtc.ts` と同じイベント面（`onRemoteStream` 等）に乗せるので
  下流（`ui/remote-media`・録画）は無変更。App が mesh と排他的に切り替える（`/api/sfu/*` プロキシ経由）。
  SFU が失敗しても**メッシュには落とさず**、タイルを残したままバックオフ付きで SFU セッションを作り直し続ける（#254）。
- `rtc/cam-bitrate.ts` — mesh のピア数連動ビットレート throttle に加え、**SFU の simulcast
  レイヤ構成 `SFU_CAM_LAYERS`（カメラは意図的に軽め: 全レイヤ 15fps で f 500kbps・h 150kbps・q 50kbps #314）・
  受信タイルサイズ→レイヤ選択 `computePreferredRid`（640px 以上で f・320px 以上で h）・
  受信開始時のレイヤ `initialSfuCamRid`（会議室=all-hands/meeting-N は q から、他は f から）**（純粋関数）。
  画面共有は SFU でも単一レイヤ（2Mbps / 長辺 1920px / 15fps #324）で simulcast しない。取り込み（`getDisplayMedia`）自体も
  `SCREEN_CAPTURE_CONSTRAINTS` で長辺 1920px・15fps に抑え、高解像度ディスプレイの無駄な取り込み・縮小を避ける。
- `rtc/sdp.ts` — Opus を低レイテンシ寄りにチューニングする offer/answer 変換（ptime=20, in-band FEC など）。
- `media/media.ts` — マイク/カメラ/画面共有ストリーム管理。`media/recorder.ts` — ブラウザ内録画。
- `media/noise.ts` — マイクのノイズ除去（既定オン）。自前の AudioWorklet（`media/noise-worklet.ts`）で RNNoise の WASM
  （`@sapphi-red/web-noise-suppressor` 同梱のビルドを `media/rnnoise-wasm.ts` で直接駆動）を回し、RNNoise が毎フレーム返す
  **発話確率（VAD）で話していない間を完全に無音にするボイスゲート**（`media/voice-gate.ts`。純粋ロジック）をかける。
  RNNoise の出力には **7kHz ローパス**（`media/lowpass.ts`。8 次バターワース＝biquad 4 段の純粋ロジック）をかけ、PC の
  コイル鳴きなど声と一緒にゲートを抜ける高い音を落とす。
  追加モデルなしで CPU 負荷は従来と同等。遅延はバッファ込み 30ms（先読み 2 フレームで語頭を欠かさない）。
- `core/proximity.ts` — 接続/切断の判定（純粋関数。`CONNECT_RADIUS`/`DISCONNECT_RADIUS` のヒステリシス、
  どちらが initiator かの決定）。テスト容易性のため `core/app.ts` から切り出している。
- `ui/toolbar.ts`（`ToolbarController`）— マイク/カメラ/画面共有/録画ボタンとデバイス/ステータスメニュー。
  サブシステムをまたぐ変更はコールバックで App に戻す。
- `ui/remote-media.ts`（`RemoteMediaView`）— リモートのビデオタイル/マイク音声/画面共有ステージ/
  自分のプレビューの DOM 管理。発話検出器を保持する。
- `ui/peer-volume.ts` — **相手ごとの音量**（純粋関数: gain の範囲・変換・保存値のパース）。リモートタイルのヘッダーのスライダー（0〜200%）が
  `RemoteMediaView` 経由で適用する。**既定の 100% では `<audio>` をそのまま再生**し、変更時だけ Web Audio の GainNode
  経由にする（このとき要素は muted のまま流しておく）。値は**表示名キー**で localStorage（`engawa-peer-volume`）に保存（userId は接続ごとに変わるため）。
- `ui/panels.ts` — フローティングパネルのプリセットと純粋関数 `computePanelPreset()`。
- `ui/face-pip.ts`（`FacePipView`）— **画面共有中に相手の顔タイルを Document Picture-in-Picture の常時最前面小窓へミラー**する（#318）。
  タイルは移動せず同じ MediaStream を 2 つ目の `<video>` に流すだけなので、レイアウト・SFU レイヤ選択・録画は無変更。
  Chrome / Edge デスクトップのみ。**既定オフ**: ⋯メニューのトグル（localStorage `engawa-face-pip` が `1` のときだけ有効）で
  チェックした人だけ使う。
  **`requestWindow()` は操作許可を消費する**ため、必ず `getDisplayMedia` の**後**に開く（逆順だと共有自体が失敗しうる）。
  `media/speaking.ts` — `SpeakingDetector` と純粋なしきい値判定 `isLoud()`。
- `engawa/maps/map-def.ts` / `engawa/maps/*.json` — **マップはデータ**（`MapDef`）。server / client 共有（コンテナでは `/maps` にマウント）。建物・部屋（`kind`: exec/meeting/oneonone/booth/private・名前 ja/en・ドア・テーブル。テーブルなしは private＝個室だけ）・
  デスク・チームエリア・カフェ・植木・池・木・家具（`furniture`: ベッド・ソファ・TV・ローテーブル・ダイニング・キッチン・冷蔵庫・本棚・浴槽・トイレ・洗面台。
  向き `facing` で東西に回すと縦横が入れ替わる。ソファとダイニングの椅子だけ座れる歩行可能マス、他は当たり判定あり）の**配置**と、床柄（`FLOOR_PATTERNS`＋色番号）の**選択**だけを持つ。座標はマップ絶対のタイル。
  パーツの見た目はアプリ内包（`map-art.ts`）で、JSON から絵は持ち込めない。部屋の種類は ID の文字列ではなく `kind` で判定する。
  JSON は型だけでは守れないので、読み込み時に `assertMapDef` が version・床柄/色番号・各矩形の範囲に加え、ドアを塞ぐ固形パーツ・部屋外のテーブル・
  芝生以外の木を検査して**壊れたマップは名前付きで即エラー**にし、そのうえで MapDef を**凍結**する（床スタイルは JSON の実体をそのまま配るため）。
  サーバーが起動時に同じ検証をかけ、クライアントは `/api/map` で受け取ったマップから世界を組み立てる（テストは preload で office を入れる）。
  `spawn`（任意）は新規入室者の出現範囲。色テーマ数 `FLOOR_THEME_COUNT` はクライアントの `FLOOR_THEMES` とテストで一致を保証する。
- `world/tilemap.ts` — `MapDef` からタイルグリッド・ゾーン・派生矩形を組み立て、`canOccupy`（衝突判定）などの位置クエリに答える。
  派生結果は `__tests__/tilemap-split.test.ts` のスナップショットで固定している（マップを意図して変えたら `bun test -u` で更新）。**座る姿勢**は位置だけで決まる純粋関数 `seatAt()`（デスクの椅子タイル／カフェのアームチェア → 向き＋`lift`）。`canvas.ts` が静止中のみ座り姿（`CharacterSheet.draw` の `sit`: シートに座りフレームが無いため、立ちフレームをそのまま少し沈めて描く）で描く。`lift` は椅子の絵が机に寄せて描かれるぶんの補正で、**机の下側の椅子（上向き）だけ半タイル持ち上げる**（1タイルだと机に乗って見える）。スプライト・名前ラベル・吹き出しが同じ `lift` で動くので一体のまま。位置から全員が同じ姿を導けるので通信は増えない。`world/pathfind.ts` — タイル上の A*（クリック移動の経路探索, 純粋関数）。
- `world/canvas.ts` — Canvas 2D 描画。**2 層構成**: 背景層（焼き込み済みマップ＋部屋枠。`#canvas` の直前に挿入する別 canvas）はズーム・いる部屋・サイズが変わるか、カメラが余白 `BG_MARGIN` を超えて動いたときだけ描き直し、それ以外は CSS transform で滑らせるだけ。前景の `#canvas` は透明でアバター・ラベルのみを描き、**画面が前フレームと同じなら再描画をスキップ**する（`sceneKey`。取りこぼし対策に 0.5 秒ごとに強制再描画）。アバターの見た目に効く状態を増やしたら `sceneKey` にも足すこと。`world/input.ts` — キー入力。`world/player.ts` — プレイヤー状態。
  `ui/draggable.ts` — ビデオ/画面共有パネルのドラッグ。`media/compositor.ts` — 録画用の映像合成。`ui/sounds.ts` — 効果音。
- `core/types.ts` — クライアント側の共有定数/型。`core/main.ts` — 入室画面と App の起動（`core/boot.ts` から読まれる）。

**「純粋ロジックをモジュールに切り出してテストする」パターン**が server(`logic.ts` の各正規化関数と
`computeProximityGroups`)/client(`core/proximity.ts`, `world/pathfind.ts`, `rtc/sdp.ts`, `media/speaking.ts` の `isLoud()`,
`ui/panels.ts` の `computePanelPreset()`, `rtc/cam-bitrate.ts` の `computePreferredRid()`, `media/voice-gate.ts` の `GatedDenoiser`) の両方で採られている。
テストは `src/__tests__/`（フラット）に集約し、`@/<folder>/<name>` で対象を import する。
挙動を変えずにテストしやすくするのが目的なので、ロジックを触るときはこの分離を保ち、対応するテストも更新する。

## 設計の指針（変えるときに外さない不変条件）
1. **音声/映像/画面共有は絶対に engawa サーバーを経由しない** — P2P / TURN、または Cloudflare
   Realtime SFU 経由のみ（SFU でも自前サーバーはメディアフリー）。
2. **シグナリングサーバーは状態を持たない** — DB 不要。グループ情報・SFU 昇格ラッチ・トラック
   ディレクトリも**一時メモリ**で完結し、再起動でリセットして良い。
3. **Cloudflare の API キー（TURN / SFU とも）はサーバー側のみ** — ブラウザには短期クレデンシャル、
   または `/api/sfu/*` プロキシ経由のアクセスだけを渡す。
4. **HTTPS 必須**（localhost 開発は例外。WebRTC は https か localhost でのみ動作）。
5. **シンプルイズベスト** — 過度な抽象化・将来のための設計・不要な機能追加をしない。最小限の変更で目的を達成する。

## 環境変数（`.env.example` をコピーして `.env` を作成）
- `PORT`（既定 3000）
- `CLOUDFLARE_TURN_TOKEN_ID` / `CLOUDFLARE_TURN_TOKEN_SECRET` — 未設定なら STUN のみで動作。
- `CLOUDFLARE_REALTIME_APP_ID` / `CLOUDFLARE_REALTIME_APP_TOKEN` — Cloudflare Realtime SFU。
  未設定なら SFU 無効＝全グループがメッシュ（SFU 導入前と同一挙動）。`sfu.ts` がサーバー側のみで保持。
- `SFU_PROMOTE_AT` — 屋外グループが mesh から SFU に切り替わる人数（既定 **2**＝2 人の会話も SFU 経由。
  mesh はピアごとの ICE 交渉で片側だけ失敗しうるのに対し SFU は PeerConnection 1 本で安定するため #309 で
  既定化）。`4` にすると 2〜3 人は P2P のままで遅延 1 ホップぶん有利・SFU 帯域も使わない。2〜32 にクランプ、
  不正値は既定。会議室ゾーンは人数によらず常に SFU。SFU 未設定時は無視。
- `ACCESS_PASSWORD` — 単一の入室パスワード（任意）。未設定なら**オープン**で、ログイン時に
  パスワードは一切求めない。設定すると、クライアントは `GET /api/config` で要否を知り、
  **名前入力の前**にパスワードゲートを表示（`POST /api/verify-password` で照合）。join でも
  再検証する（`logic.ts` の `verifyAccessPassword` / `isPasswordRequired` 参照）。
  ※複数ワークスペース（`?workspace=`）は廃止。全員が単一スペースに入る。
- `ENTRY_MODE` — 入室ゲートの種類（任意）。未設定・`password` なら従来どおり `ACCESS_PASSWORD`。`token` にすると
  **コントロールプレーンが署名した入室券**（`/?t=…`）だけで入室でき、**表示名は券から取る**（クライアントの自己申告を使わない）。
  検証鍵は `CONTROL_PLANE_TOKEN`（ホワイトリストには**入れない** = 遠隔から鍵を差し替えられない）で、検証は
  オフィス内で完結し外部への問い合わせは発生しない。2 つのゲートは排他。純粋ロジックは `server/src/entry.ts`。
  **仕様を変えたら `docs/entry-token.md`（英語）と `docs/entry-token.ja.md`（日本語）の両方を更新する。**
- `MAP` — 使うマップ（任意）。同梱プリセット名（`engawa/maps/<name>.json`。既定 `office_medium`。名前は `<種類>_<規模>` で揃える）か、http(s) の外部 JSON の URL
  （1MB まで）。不正なマップはサーバーが起動を拒否する。読み込みは起動時のみ。
- `EVENT_WEBHOOK_URL` / `EVENT_WEBHOOK_SECRET` / `EVENT_INCLUDE_NAMES` — イベント Webhook（任意）。URL 未設定なら無効。
  SECRET はボディの HMAC-SHA256 署名（`X-Engawa-Signature`）。参加者は既定で日替わりの匿名 ID、`true` で表示名。

## コーディング規約
- TypeScript strict モード / セミコロンあり / シングルクォート / インデント スペース2つ。

## 素材ライセンス（重要）
- **マップタイル**: Kenney「Roguelike Indoors」= **CC0**（`engawa/client/src/assets/`）。
- **アバター（キャラメイク #141）**: LPC（Universal-LPC-Spritesheet-Character-Generator）。
  アートは **CC-BY-SA 3.0 / OGA-BY 3.0 / CC-BY 3.0 / GPL 3.0 / CC0 がパーツごとに混在**する。
  **CC-BY-SA 3.0 は ShareAlike**（合成・色変えなどの派生も同ライセンス）。
  - 取り込んだパーツの作者・ライセンス・出典は `engawa/client/src/assets/lpc/CREDITS.csv` に**個別に**記録する。
    各ライセンス全文も同ディレクトリに同梱（`LICENSE-*.txt`）。新しいパーツを足すときは CREDITS.csv も必ず更新する。
  - 帰属表示は **3 箇所**で行う: ①`assets/lpc/CREDITS.csv`＋ライセンス全文の同梱、②README（`README.md` / `README.ja.md`）の「クレジット」節、
    ③キャラメイク画面（avatar-editor）下部のクレジットリンク。
- **素材のライセンスと engawa 本体コードのライセンスは分離して扱う。** 本体コードは **MIT**（最上位の `LICENSE`）。CC0 以外の素材を増やすときはこの方針に従う。
- LPC の `CREDITS.csv` の `;` 区切りは**マルチライセンス（いずれかを選べる）**。GPL 単独のパーツは無いので、素材が理由で本体が GPL になることはない。README の「ライセンス」節がこの整理を持っているので、素材を増減したら**そこの件数・記述も更新する**。

## 作業の進め方
- 仕様はユーザーと一緒に決める。不明点や判断に迷う点は実装前に確認する。
- 仕様が決まったら **Issue は起票せず**、そのままフィーチャーブランチで実装して PR を出す（PR が仕様と変更の記録を兼ねる）。
- 実装フェーズではユーザーはコードを読まないので Claude が自律的に進め、テスト・push・PR の自動起票まで
  一貫して完了させる（PR の作成にユーザーへの確認は不要）。
- 改修前に `git fetch origin` で最新の remote main を取得し、`git worktree` で作業環境を分け、
  必ずフィーチャーブランチを切ってから作業する（main 上で直接作業しない）。
  改修後は必ずテストを実行し、失敗があれば修正してから進める。

## リリース（GHCR イメージ公開）
engawa は **host 非依存の OSS**。リリースとは「**バージョンタグを打って GHCR にコンテナイメージを publish する**」
ところまでを指す。どの基盤にどうデプロイするか（ホスト固有設定・本番 URL・クレデンシャル）は **OSS リポジトリには一切持ち込まない**。

- `scripts/release.sh`（引数なし）= 未リリースコミット・main CI・次バージョン候補を表示（バージョン決定の材料）。
- `scripts/release.sh vX.Y.Z "subject"` = ガード（clean / origin/main 一致 / CI green / タグ未存在）→
  annotated タグ `vX.Y.Z` を push → `release.yml` が `ghcr.io/<owner>/engawa:vX.Y.Z` を build & push → 完了まで待機。

**バージョンは依頼者の指定に従う。依頼者がバージョンに触れていなければマイナー（vX.Y+1.0）で打ち、確認しない**。
パッチ・メジャーは依頼者が明示したときだけ。ただし Claude が自発的に打つ小さな変更（バグ修正・軽微な修正）の
リリースは従来どおり次のパッチ版（vX.Y.Z+1）で、確認不要。
通常どおりフィーチャーブランチ→PR で進める。GHCR publish 後の本番反映は OSS の外（デプロイ専用の別環境）が GHCR の成果物を引いて行う。

## ランディングページ（LP / GitHub Pages）
紹介用の LP は **`docs/`（リポジトリ最上位）** に置く。**ビルド不要の自己完結した静的ページ**
（英語 `index.html` と日本語 `ja/index.html` + 共通の `styles.css` + 素の `main.js`。フレームワーク・バンドラなし。
不変条件 #5 のシンプル志向）。日英は SEO のため**別 URL**（`/engawa/` と `/engawa/ja/`）で、canonical と hreflang で
対応づける。文言を変えるときは**両方のファイル**を更新する。
- **公開**: `Settings → Pages → Source: Deploy from a branch → main / docs`
  （URL は `https://iitenkida7.github.io/engawa/`）。`docs/.nojekyll` を置き Jekyll を無効化する。
- **デザイン**: 技術読本（`docs/reader/`）と同じテイストに揃える。青みのグレーの地 / 墨色の文字 /
  ティールの「信号線」アクセント（＋補助の暖色）、書体は M PLUS 1（見出し）・IBM Plex Sans JP（本文）・
  IBM Plex Mono（ラベル）。ライト/ダークは `prefers-color-scheme` に追従。日英の切り替えはページ間リンク（選んだ言語を localStorage に保存し、次回は英語ページから `/ja/` へ送る）、
  IntersectionObserver のスクロール演出（`prefers-reduced-motion` 尊重）を素の JS で実装。
- **共通ヘッダー**: LP・技術読本・マップ JSON 仕様の全 6 ページで**同じヘッダーバー**（ブランド / ナビ / 日英トグル / GitHub）を出す。
  ナビは「機能・仕組み・はじめる・技術読本・マップ仕様」。ページを足す・項目を変えるときは**全ページのヘッダーとフッターを揃える**。
  LP は `styles.css`、読本・仕様ページは各ファイル内の `<style>`（自己完結のため規則は意図的に重複）。
- **技術読本**: `docs/reader/index.html`（日本語）と英語版 `docs/reader/en.html`（どちらも自己完結の 1 ファイル）。SFU・simulcast・帯域推定・音声・
  画面共有などを公開ソースと engawa の実装で照合した読み物。実装の数値（レイヤ構成・tier・ノイズ除去の設定など）を
  変えたら、読本の該当箇所も**日英両方**更新する。
- **マップ JSON 仕様**: `docs/map/index.html`（日本語）と英語版 `docs/map/en.html`（どちらも自己完結の 1 ファイル。画像 `office-medium-map.webp` は共用）。アプリの `buildMapCache` で書き出した実物のマップに
  JSON の枠を重ねて MapDef を図解する。画像と埋め込みの office_medium.json は書き出し時点のコピーなので、**`map-def.ts` の形式や `maps/office_medium.json` を変えたら
  このページも日英両方とも更新する**（画像の書き出し手順はページ末尾の運用メモ）。
- **スクショ**は `docs/assets/screens/`。実アプリの撮影は **Caddy 経由 `https://engawa.localhost`** で行う
  （`localhost:5173` は Vite が WS の 101 升級を中継できず入室できない）。MCP ブラウザの自己署名証明書エラーは
  Chrome のエラー画面で `thisisunsafe` とタイプして回避。画像は `sips` で中央クロップ＋縮小。favicon は
  アプリアイコンを流用。
- **クレジットは正確に**（LPC=CC-BY-SA 3.0 ほか / Kenney=CC0）。本体コードは **MIT** なので、LP のフッターでも
  MIT と明記しリポジトリの `LICENSE` に link する（素材のライセンスとは分けて書く）。

## ツール利用方針
- Chrome DevTools MCP は遅いので極力使わない。代替（ログ確認・テスト実行）を優先する。
  （例外: LP のスクショなど画面キャプチャが必須のときは最小限で使う。上記「ランディングページ」節を参照）
