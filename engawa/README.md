# engawa

社内向け Gather.town クローン。2Dマップでアバターを動かし、近づくと WebRTC P2P で音声/映像/画面共有。

## 開発 (Docker)

docker-compose.yml と Makefile はリポジトリ最上位にあります。

```bash
cp .env.example .env  # (任意) Cloudflare TURN を使う場合のみ設定
make up               # = docker compose up -d
```

- クライアント: http://localhost:5173
- サーバー: http://localhost:3000

Vite dev server が `/ws` と `/api/*` をサーバーにプロキシします。

## 本番ビルド

```bash
docker compose -f docker-compose.prod.yml up --build
```

シングルコンテナでクライアントをビルド → サーバーで配信。

## 構成

- `server/` Bun + WebSocket (位置同期 + WebRTC シグナリング + TURN credentials API)
- `client/` Vite + Canvas 2D + simple-peer
