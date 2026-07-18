# 本番サンプル: docker compose + Caddy

VPS などにこのディレクトリごと置いて、そのまま起動できる本番構成のサンプルです。
**Caddy が Let's Encrypt で HTTPS を自動終端**し、GHCR で公開されている engawa
イメージへリバースプロキシします。イメージは静的ファイル・`/ws`・`/api` を
**単一オリジン（3000 番）**で配信するため、Caddy の upstream は 1 つだけです。

## 前提

- 実ドメインの DNS（A / AAAA）がこのホストを指していること。
- ポート **80 / 443** がインターネットから到達できること（Let's Encrypt の検証に必要）。
- GHCR の `ghcr.io/iitenkida7/engawa` が public、もしくはホストで `docker login ghcr.io` 済みであること。

## 起動

```bash
cd production_sample/docker_compose
cp .env.example .env   # ENGAWA_DOMAIN / ACME_EMAIL / TURN などを設定
docker compose up -d
```

`https://<ENGAWA_DOMAIN>/` で開けます。証明書は Caddy が自動取得・更新します
（`caddy_data` ボリュームに永続化されるため、再起動しても再取得しません）。

## 構成

| ファイル | 役割 |
|---|---|
| `docker-compose.yml` | Caddy + server（GHCR pull）。server はホストにポート公開せず Caddy 経由のみ |
| `Caddyfile` | ドメイン / ACME メールを env で受け取り自動 HTTPS。WebSocket 101 を透過 |
| `.env.example` | ドメイン / メール / イメージ / TURN / `ACCESS_PASSWORD` のテンプレート |

## 注意

- ⚠️ **必ず 1 インスタンスで動かす**。位置同期・シグナリングはインメモリの単一プロセスで、
  水平スケールすると別インスタンスのユーザーが見えなくなります（メディアは P2P なので台数に非依存）。
- 本番では `ENGAWA_IMAGE` を `:vX.Y.Z` のように**バージョンタグ固定**するのを推奨します。
- TURN トークンや `ACCESS_PASSWORD` はイメージに焼かず、`.env`（= 実行時の環境変数）で渡します。
- 開発用の `docker-compose.yml` / `Caddyfile`（リポジトリ最上位。`tls internal` / `engawa.localhost`）とは別物です。
