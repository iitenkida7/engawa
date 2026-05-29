# CLAUDE.md — プロジェクトルール

## プロジェクト概要
- gather-clone: ブラウザベースの仮想オフィス（2Dマップ + WebRTC 音声/映像通信）

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
- docker-compose.yml は `gather-clone/` 直下にある
- 起動: `docker compose -f gather-clone/docker-compose.yml up`
- コンテナ内でコマンド実行: `docker compose -f gather-clone/docker-compose.yml exec <service> <command>`
  - 例: `docker compose -f gather-clone/docker-compose.yml exec server bun install`
  - 例: `docker compose -f gather-clone/docker-compose.yml exec client bun install`

### コーディング規約
- TypeScript strict モード
- セミコロンあり
- シングルクォート
- インデント: スペース2つ

### ビルド・実行
- `docker compose -f gather-clone/docker-compose.yml up` で server (port 3000) と client (port 5173) が起動する
- サーバー: bun --watch で自動リロード
- クライアント: Vite dev server (HMR)

## ディレクトリ構成
```
gather-clone/
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
