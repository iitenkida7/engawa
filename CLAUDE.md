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

```
/ (リポジトリ最上位)
├ docker-compose.yml      # server(3000) / client(5173) を定義
├ Makefile                # 主要操作の入口（すべて Docker 経由）
├ .env.example
└ engawa/
   ├ client/src/          # フロントエンド
   └ server/src/          # シグナリングサーバー
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
メディア（音声・映像・画面共有）は **engawa のサーバーを絶対に経由しない**。屋外の少人数近接は
P2P メッシュ、会議室ゾーンと 5 人以上の屋外クラスタは Cloudflare Realtime SFU 経由（#77/#78）。
どちらでもメディアは自前サーバーを通らない。サーバーは「出会いの仲介」「位置同期」「グループ方式
（mesh/SFU）の判定・配信」「SFU 制御のプロキシ」を行う。

```
[ブラウザA] ──WebSocket──> [Bun サーバー] <──WebSocket── [ブラウザB]
   │                       ├ 位置のブロードキャスト           │
   │                       ├ WebRTC シグナリング中継（mesh）    │
   │                       ├ グループ判定（mesh/SFU）の配信     │
   │                       ├ /api/turn-credentials             │
   │                       └ /api/sfu/*（SFU 制御をプロキシ）   │
   │                                                           │
   ├─ 屋外・少人数: WebRTC P2P メッシュ ───────────────────────┤
   └─ 会議室 / 5 人以上: Cloudflare Realtime SFU 経由 ──────────┘
        ※ メディアは engawa を経由しない（P2P / Cloudflare のみ）
```

### サーバー（`engawa/server/src/`）
- `index.ts` — Bun.serve エントリ。ルーティングは手書き:
  `/ws`（WebSocket 升級, userId を UUID で発行）, `/api/turn-credentials`,
  `/api/sfu/*`（SFU 制御プロキシ）, `/api/health`, それ以外は `./public` の静的配信
  （SPA フォールバックあり）。接続中クライアントは単一の in-memory `Map<userId, ws>` で管理。
- `websocket.ts` — WS メッセージハンドラ。入室・位置更新・シグナリング転送・退室に加え、
  **グループ方式の算出・配信（`group-update`）と SFU トラックディレクトリの中継（`sfu-publish`
  → `sfu-peer-tracks`）** をさばく。`broadcast` は**同一 workspace かつ join 済み**のみ配信。
- `logic.ts` — **副作用のない純粋関数**（座標クランプ、スポーン生成、名前/workspace 正規化、
  パスワード検証/パース、**近接グループ判定 `computeProximityGroups`**）。グループ判定は位置＋zone
  から連結成分を求め、会議室=常時 SFU・屋外は 5 人で SFU 昇格（一方向ラッチ）を割り当てる純粋関数。
- `turn.ts` — Cloudflare API を叩いて短期 ICE クレデンシャルを発行。**API キーはサーバーのみ保持**。
- `sfu.ts` — Cloudflare Realtime SFU の制御プレーン（セッション/トラック）を**プロキシ**する。
  App ID/Token はサーバーのみ保持しブラウザに渡さない（turn.ts と同じ作法）。転送先パスはホワイト
  リスト化（SSRF 対策）。メディアは通さずシグナリングのみ。
- `types.ts` — `WsData`（接続ごとの状態）, `ClientMessage` / `ServerMessage`。

### クライアント（`engawa/client/src/`）
ファイルは責務ごとに **5 フォルダ**へ分割し、import は **`@/` エイリアス**（`@/<folder>/<name>` 形式。
`tsconfig.json` の `paths` と `vite.config.ts` の `resolve.alias` で定義。Bun test も `paths` を解決する）で
参照する。エントリは `core/main.ts`（`index.html` が読む）。同一フォルダ内でも `@/` で参照し位置非依存にしてある。
- **`core/`** — オーケストレーションと基盤: `app.ts`, `main.ts`, `types.ts`, `lifecycle.ts`, `network.ts`, `proximity.ts`, `reload.ts`, `background-ticker.ts`
- **`rtc/`** — メディアトランスポート（不変条件 #1 の経路）: `webrtc.ts`, `sfu.ts`, `sdp.ts`, `cam-bitrate.ts`, `rtcstats.ts`
- **`media/`** — 取得・加工・録画: `media.ts`, `recorder.ts`, `compositor.ts`, `vbg.ts`, `speaking.ts`
- **`world/`** — 2D マップ描画・移動: `canvas.ts`, `tilemap.ts`, `pathfind.ts`, `sprites.ts`, `decor.ts`, `player.ts`, `input.ts`
- **`ui/`** — DOM パネル・コントロール: `toolbar.ts`, `remote-media.ts`, `panels.ts`, `draggable.ts`, `roster.ts`, `chat.ts`, `notify.ts`, `debug-console.ts`, `sounds.ts`

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
- `rtc/cam-bitrate.ts` — mesh のピア数連動ビットレート throttle に加え、**SFU の画質フロア／simulcast
  レイヤ構成 `SFU_CAM_LAYERS`・受信タイルサイズ→レイヤ選択 `computePreferredRid`**（純粋関数）。
- `rtc/sdp.ts` — Opus を低レイテンシ寄りにチューニングする offer/answer 変換（ptime=20, in-band FEC など）。
- `media/media.ts` — マイク/カメラ/画面共有ストリーム管理。`media/recorder.ts` — ブラウザ内録画。
- `core/proximity.ts` — 接続/切断の判定（純粋関数。`CONNECT_RADIUS`/`DISCONNECT_RADIUS` のヒステリシス、
  どちらが initiator かの決定）。テスト容易性のため `core/app.ts` から切り出している。
- `ui/toolbar.ts`（`ToolbarController`）— マイク/カメラ/画面共有/録画ボタンとデバイス/ステータスメニュー。
  サブシステムをまたぐ変更はコールバックで App に戻す。
- `ui/remote-media.ts`（`RemoteMediaView`）— リモートのビデオタイル/マイク音声/画面共有ステージ/
  自分のプレビューの DOM 管理。発話検出器を保持する。
- `ui/panels.ts` — フローティングパネルのプリセットと純粋関数 `computePanelPreset()`。
  `media/speaking.ts` — `SpeakingDetector` と純粋なしきい値判定 `isLoud()`。
- `world/tilemap.ts` — オフィスのタイルマップと `canOccupy`（衝突判定）。`world/pathfind.ts` — タイル上の A*（クリック移動の経路探索, 純粋関数）。
- `world/canvas.ts` — Canvas 2D 描画。`world/input.ts` — キー入力。`world/player.ts` — プレイヤー状態。
  `ui/draggable.ts` — ビデオ/画面共有パネルのドラッグ。`media/compositor.ts` — 録画用の映像合成。`ui/sounds.ts` — 効果音。
- `core/types.ts` — クライアント側の共有定数/型。`core/main.ts` — エントリ。

**「純粋ロジックをモジュールに切り出してテストする」パターン**が server(`logic.ts` の各正規化関数と
`computeProximityGroups`)/client(`core/proximity.ts`, `world/pathfind.ts`, `rtc/sdp.ts`, `media/speaking.ts` の `isLoud()`,
`ui/panels.ts` の `computePanelPreset()`, `rtc/cam-bitrate.ts` の `computePreferredRid()`) の両方で採られている。
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
- `ACCESS_PASSWORD` — 単一の入室パスワード（任意）。未設定なら**オープン**で、ログイン時に
  パスワードは一切求めない。設定すると、クライアントは `GET /api/config` で要否を知り、
  **名前入力の前**にパスワードゲートを表示（`POST /api/verify-password` で照合）。join でも
  再検証する（`logic.ts` の `verifyAccessPassword` / `isPasswordRequired` 参照）。
  ※複数ワークスペース（`?workspace=`）は廃止。全員が単一スペースに入る。

## コーディング規約
- TypeScript strict モード / セミコロンあり / シングルクォート / インデント スペース2つ。

## 素材ライセンス（重要）
- **マップタイル**: Kenney「Roguelike Indoors」= **CC0**（`engawa/client/src/assets/`）。
- **アバター（キャラメイク #141）**: LPC（Universal-LPC-Spritesheet-Character-Generator）。
  アートは **CC-BY-SA 3.0 / OGA-BY 3.0 / CC-BY 3.0 / GPL 3.0 / CC0 がパーツごとに混在**する。
  **CC-BY-SA 3.0 は ShareAlike**（合成・色変えなどの派生も同ライセンス）。
  - 取り込んだパーツの作者・ライセンス・出典は `engawa/client/src/assets/lpc/CREDITS.csv` に**個別に**記録する。
    各ライセンス全文も同ディレクトリに同梱（`LICENSE-*.txt`）。新しいパーツを足すときは CREDITS.csv も必ず更新する。
  - 帰属表示は **3 箇所**で行う: ①`assets/lpc/CREDITS.csv`＋ライセンス全文の同梱、②README の「クレジット」節、
    ③キャラメイク画面（avatar-editor）下部のクレジットリンク。
- **素材のライセンスと engawa 本体コードのライセンスは分離して扱う。** CC0 以外の素材を増やすときはこの方針に従う。

## 作業の進め方
- 仕様はユーザーと一緒に決める。不明点や判断に迷う点は実装前に確認する。
- 仕様が決まったら GitHub Issue に起票してから着手する。
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

**新機能はマイナー（vX.Y+1.0）、バグ修正はパッチ（vX.Y.Z+1）**。バージョンはユーザーに確認してから打つ。
通常どおりフィーチャーブランチ→PR で進める。GHCR publish 後の本番反映は OSS の外（デプロイ専用の別環境）が GHCR の成果物を引いて行う。

## ツール利用方針
- Chrome DevTools MCP は遅いので極力使わない。代替（ログ確認・テスト実行）を優先する。
