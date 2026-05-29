# CLAUDE.md — プロジェクトルール

## プロジェクト概要
- engawa: ブラウザベースの仮想オフィス（2Dマップ + WebRTC 音声/映像通信）

## 技術スタック
- サーバー: Bun + WebSocket
- クライアント: TypeScript + Vite + Canvas2D + simple-peer (WebRTC)

## 開発ルール

### 言語・コミュニケーション
- コミットメッセージは英語で書く
- コード中のコメントは英語
- Claude の出力（会話・説明・質問等）はすべて日本語
- ユーザーとの会話は日本語

### 作業の進め方
- 仕様はユーザーと一緒に決める。不明点や判断に迷う点があれば実装前に確認する
- 仕様が決まったら `gh issue create` で GitHub Issue に起票してから作業を開始する
- 実装フェーズではユーザーはコードを読まないので、Claude が自律的に進める
- テスト・push・PR 作成まで一貫して完了させる

### Git ワークフロー
- 改修を始める前に必ず `git fetch origin` で最新の remote main を取得する
- `git worktree` で作業環境を分ける（main ブランチ上で直接作業しない）
- 必ずフィーチャーブランチを切ってから作業を開始する
- 改修後は必ずテストを実行し、失敗があれば修正してから進める
- `gh` コマンドを使って push および PR 作成まで行う

### パッケージ管理
- クライアント: `npm install`（client/ ディレクトリ）
- サーバー: `bun install`（server/ ディレクトリ）
- `npm install` や `bun install` を勝手に実行しない。必要な場合はユーザーに確認する

### コマンド実行の権限
- Makefile に記載されたコマンド（`make up`, `make down`, `make test` 等）は確認なしで実行してよい
- `gh` コマンド（issue 作成、push、PR 作成等）も確認なしで実行してよい

### ツール利用方針
- Chrome DevTools MCP は遅いので、できる限り使わない。代替手段（ログ確認、テスト実行等）を優先する

### Docker
- アプリに関するコマンド（ビルド、実行、パッケージインストール、テスト等）はすべて Docker を通して実行する
- ホストで直接 `npm install` / `bun install` / `npm run dev` 等を実行しない
- docker-compose.yml はリポジトリ最上位（ルート）にある
- 主要操作は Makefile（ルート）経由で行う
  - 起動: `make up`（バックグラウンド）
  - 停止: `make down`
  - 再起動: `make restart`
  - テスト: `make test`（server / client 両方）
  - ビルド: `make build`
- 直接実行する場合: `docker compose <command>`（ルートで実行）
  - 例: `docker compose exec server bun install`
  - 例: `docker compose exec client bun install`

### 設計方針
- シンプルイズベスト。機能はできるだけシンプルに保つ
- 過度な抽象化・将来のための設計・不要な機能追加をしない
- 最小限の変更で目的を達成する

### コーディング規約
- TypeScript strict モード
- セミコロンあり
- シングルクォート
- インデント: スペース2つ

### ビルド・実行
- `make up`（= `docker compose up -d`）で server (port 3000) と client (port 5173) が起動する
- サーバー: bun --watch で自動リロード
- クライアント: Vite dev server (HMR)

## ディレクトリ構成
```
engawa/
  client/          # Vite + TypeScript フロントエンド
    src/
      game.ts      # メインゲームループ、UI管理
      canvas.ts    # Canvas描画
      player.ts    # プレイヤー状態
      media.ts     # マイク/カメラ/画面共有管理
      webrtc.ts    # WebRTC接続管理
      network.ts   # WebSocket通信
      sounds.ts    # 効果音
      types.ts     # 共有型定義
      input.ts     # キー入力
    index.html
  server/
    src/
      index.ts     # Bunサーバーエントリ
      websocket.ts # WS メッセージハンドラ
      types.ts     # サーバー側型定義
```
