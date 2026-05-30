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
| テスト（server + client 両方） | `make test` |
| 本番ビルド（型チェック + バンドル） | `make build` |
| 依存インストール | `make install` |
| ボリュームごと削除 | `make clean` |

- クライアント: http://localhost:5173 / サーバー: http://localhost:3000
- サーバーは `bun --watch`、クライアントは Vite HMR で自動リロード。
- `make build` は client 側で `tsc --noEmit`（型チェック）→ `vite build` を実行する。**型チェックがビルドの一部**。
- 専用の lint コマンドはない。品質ゲートは「型チェック（build）＋ テスト」。
- `npm install` / `bun install` を勝手に実行しない。依存追加が必要なときはユーザーに確認する。

### 単一テストの実行
テストは server / client とも `bun test`。Docker 経由で個別実行する場合:

```bash
# 特定ファイルだけ
docker compose run --rm --no-deps server bun test src/__tests__/logic.test.ts
docker compose run --rm --no-deps client bun test src/__tests__/proximity.test.ts

# テスト名で絞り込み（-t）
docker compose run --rm --no-deps server bun test -t 'verifyWorkspacePassword'
```

### CI
`.github/workflows/ci.yml` は main への push / PR で **ローカルと同じ Makefile ターゲット**
（`make install` → `make build` → `make test`）を Docker 上で実行する。CI とローカルを一致させるため、
新しい検証手順を足すときも Makefile 経由にする。

## アーキテクチャ（全体像）
メディア（音声・映像・画面共有）は **P2P で直接** 流れ、サーバーを経由しない。
サーバーは「出会いの仲介」と「位置同期」だけを行う。

```
[ブラウザA] ──WebSocket──> [Bun サーバー] <──WebSocket── [ブラウザB]
   │                       ├ 位置のブロードキャスト           │
   │                       ├ WebRTC シグナリング中継           │
   │                       └ /api/turn-credentials             │
   └────────── WebRTC P2P（音声/映像/画面共有）───────────────┘
              ※ NAT 越え不可のときだけ Cloudflare TURN 経由
```

### サーバー（`engawa/server/src/`）
- `index.ts` — Bun.serve エントリ。ルーティングは手書き:
  `/ws`（WebSocket 升級, userId を UUID で発行）, `/api/turn-credentials`,
  `/api/health`, それ以外は `./public` の静的配信（SPA フォールバックあり）。
  接続中クライアントは単一の in-memory `Map<userId, ws>` で管理。
- `websocket.ts` — WS メッセージハンドラ。入室・位置更新・シグナリング転送・退室をさばく。
  `broadcast` は**同一 workspace かつ join 済み**のクライアントにのみ配信する。
- `logic.ts` — **副作用のない純粋関数**（座標クランプ、スポーン生成、名前/workspace 正規化、
  パスワード検証/パース）。WS ハンドラから切り出してユニットテスト可能にしている。
- `turn.ts` — Cloudflare API を叩いて短期 ICE クレデンシャルを発行。**API キーはサーバーのみ保持**。
- `types.ts` — `WsData`（接続ごとの状態）, `ClientMessage` / `ServerMessage`。

### クライアント（`engawa/client/src/`）
`app.ts`（旧 `game.ts`。クラス名 `App`）が中心のオーケストレータで、ゲームループ・移動・近接判定・
サーバーメッセージのルーティング・各サブシステムの配線を担う。サブシステム同士は直接参照せず
App が仲介する（既存の Manager-callback パターン）。責務ごとのモジュールを束ねる:
- `network.ts` — WebSocket。**dev では Vite プロキシが Bun の 101 升級を正しく中継できない**ため
  Bun サーバーへ直結し、prod では `window.location.host` を使う（コード中コメント参照）。
- `webrtc.ts` — simple-peer のラッパ。kind（mic/cam/screen）ごとの送信ビットレート上限、
  受信ジッタバッファ下限などを調整。
- `sdp.ts` — Opus を低レイテンシ寄りにチューニングする offer/answer 変換（ptime=10, in-band FEC など）。
- `media.ts` — マイク/カメラ/画面共有ストリーム管理。`recorder.ts` — ブラウザ内録画。
- `proximity.ts` — 接続/切断の判定（純粋関数。`CONNECT_RADIUS`/`DISCONNECT_RADIUS` のヒステリシス、
  どちらが initiator かの決定）。テスト容易性のため `app.ts` から切り出している。
- `toolbar.ts`（`ToolbarController`）— マイク/カメラ/画面共有/録画ボタンとデバイス/ステータスメニュー。
  サブシステムをまたぐ変更はコールバックで App に戻す。
- `remote-media.ts`（`RemoteMediaView`）— リモートのビデオタイル/マイク音声/画面共有ステージ/
  自分のプレビューの DOM 管理。発話検出器を保持する。
- `panels.ts` — フローティングパネルのプリセットと純粋関数 `computePanelPreset()`。
  `speaking.ts` — `SpeakingDetector` と純粋なしきい値判定 `isLoud()`。
- `tilemap.ts` — オフィスのタイルマップと `canOccupy`（衝突判定）。`pathfind.ts` — タイル上の A*（クリック移動の経路探索, 純粋関数）。
- `canvas.ts` — Canvas 2D 描画。`input.ts` — キー入力。`player.ts` — プレイヤー状態。
  `draggable.ts` — ビデオ/画面共有パネルのドラッグ。`compositor.ts` — 録画用の映像合成。`sounds.ts` — 効果音。
- `types.ts` — クライアント側の共有定数/型。`main.ts` — エントリ。

**「純粋ロジックをモジュールに切り出してテストする」パターン**が server(`logic.ts`)/client(`proximity.ts`,
`pathfind.ts`, `sdp.ts`, `speaking.ts` の `isLoud()`, `panels.ts` の `computePanelPreset()`) の両方で
採られている。挙動を変えずにテストしやすくするのが目的なので、
ロジックを触るときはこの分離を保ち、対応するテストも更新する。

## 設計の指針（変えるときに外さない不変条件）
1. **音声/映像/画面共有は絶対にサーバーを経由しない** — P2P か TURN 経由のみ。
2. **シグナリングサーバーは状態を持たない** — DB 不要。メモリ上で完結し再起動でリセットして良い。
3. **Cloudflare TURN の API キーはサーバー側のみ** — ブラウザには短期クレデンシャルだけ渡す。
4. **HTTPS 必須**（localhost 開発は例外。WebRTC は https か localhost でのみ動作）。
5. **シンプルイズベスト** — 過度な抽象化・将来のための設計・不要な機能追加をしない。最小限の変更で目的を達成する。

## 環境変数（`.env.example` をコピーして `.env` を作成）
- `PORT`（既定 3000）
- `CLOUDFLARE_TURN_TOKEN_ID` / `CLOUDFLARE_TURN_TOKEN_SECRET` — 未設定なら STUN のみで動作。
- `WORKSPACE_PASSWORDS` — ワークスペースのパスワード保護（任意）。
  **コード上の正しい形式は JSON オブジェクト**: `{"ws1":"pass1","ws2":"pass2"}`（`logic.ts` の `parseWorkspacePasswords` 参照）。
  不正な JSON は警告して無視（全 workspace オープン）。URL の `?workspace=` で部屋を分離する。

## コーディング規約
- TypeScript strict モード / セミコロンあり / シングルクォート / インデント スペース2つ。

## 作業の進め方
- 仕様はユーザーと一緒に決める。不明点や判断に迷う点は実装前に確認する。
- 仕様が決まったら GitHub Issue に起票してから着手する。
- 実装フェーズではユーザーはコードを読まないので Claude が自律的に進め、テスト・push・PR の自動起票まで
  一貫して完了させる（PR の作成にユーザーへの確認は不要）。
- 改修前に `git fetch origin` で最新の remote main を取得し、`git worktree` で作業環境を分け、
  必ずフィーチャーブランチを切ってから作業する（main 上で直接作業しない）。
  改修後は必ずテストを実行し、失敗があれば修正してから進める。

## ツール利用方針
- Chrome DevTools MCP は遅いので極力使わない。代替（ログ確認・テスト実行）を優先する。
