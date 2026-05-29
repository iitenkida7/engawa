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
- ユーザーとの会話は日本語

### パッケージ管理
- クライアント: `npm install`（client/ ディレクトリ）
- サーバー: `bun install`（server/ ディレクトリ）
- `npm install` や `bun install` を勝手に実行しない。必要な場合はユーザーに確認する

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
