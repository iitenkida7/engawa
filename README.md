# engawa（縁側）

**ブラウザだけで使える、社内向けの仮想オフィス。**

2D マップ上でアバターを動かし、誰かに近づくと自動で音声・映像・画面共有がつながります。
Slack のハドルや Gather.town のような「ちょっと話しかける」体験を、軽量・低コストで実現することを目指したツールです。

```
        ┌─────────────────────────────────────────┐
        │   . . . . . . . . . . . . . . . . . . .   │
        │        (•‿•) ───近づくと通話──→ (^_^)      │
        │         あなた                  田中さん    │
        │   . . . . . . . . . . . . . . . . . . .   │
        └─────────────────────────────────────────┘
```

---

## 🍵 名前の由来

> 縁側は、家の内と外のあいだにある板の間。
> 用がなくても腰掛けられて、通りかかった人となんとなく言葉を交わす——そんな場所でした。
>
> リモートワークで失われがちな「ばったり会って、ちょっと話す」を、画面の中に取り戻したい。
> engawa は、誰かのとなりに気軽に居られる、オフィスの縁側です。

---

## ✨ 主な機能

| | 機能 | 説明 |
|---|---|---|
| 🚶 | アバター移動 | 矢印キー / WASD でマップ上を歩く |
| 🔊 | 近接音声通話 | 一定距離まで近づくと自動で音声がつながる（離れると自動で切断） |
| 📷 | ビデオ通話 | カメラ ON で顔出し。話している人は枠が光る |
| 🖥 | 画面共有 | ワンクリックで共有。小窓 / サイドパネル / 全画面を切り替え可能 |
| ⏺ | 録画 | 画面全体（フロア＋画面共有＋全カメラ）と全員の音声を合成してブラウザ上で録画 |
| 🟢 | ステータス表示 | オンライン / 取り込み中 / 離席中 を切り替え |
| 🔔 | 近接チャイム | 人が近づいた / 離れたときに軽い効果音 |
| 🚪 | ワークスペース | URL の `?workspace=` で部屋を分離。任意でパスワード保護 |

---

## 🎮 使い方

1. ブラウザでアプリを開く
2. 名前（と、必要ならパスワード）を入力して入室
3. **矢印キー / WASD** でアバターを動かす
4. 話したい相手に**近づくだけ**で通話が始まります

ツールバーからマイク・カメラ・画面共有・録画・ステータスを操作できます。

> 別のワークスペースに入るには URL に `?workspace=営業部` のように付けてアクセスします。

---

## 🚀 動かす（開発環境）

アプリの操作はすべて Docker 経由で行います。`docker-compose.yml` と `Makefile` はリポジトリ最上位にあります。

```bash
cp .env.example .env   # （任意）TURN やパスワードを使う場合のみ編集
make up                # 起動（バックグラウンド）
```

開発環境は **Caddy リバースプロキシが HTTPS を終端** します。次の URL で開きます:

- **アプリ: https://engawa.localhost** ← これが開発の入口
- 初回は Caddy のローカル CA を信頼していないため証明書警告が出ます。下記「ローカル CA を信頼する」を参照。

> `.localhost` ドメインは OS が自動で `127.0.0.1` に解決するため、hosts ファイルの編集は不要です。

| コマンド | 内容 |
|---|---|
| `make up` | 起動（`docker compose up -d`） |
| `make down` | 停止 |
| `make restart` | 再起動 |
| `make test` | テスト実行（server / client 両方） |
| `make build` | クライアントの本番ビルド |

> WebRTC は **HTTPS または localhost でのみ** 動作します。アプリ自身は TLS を持たず、**TLS 終端はリバースプロキシの責務** です。本番でも各自のリバースプロキシ（Caddy / nginx / クラウドの LB など）で HTTPS（`wss://` を含む）を終端してください。

### ローカル CA を信頼する

`tls internal` が発行する証明書はローカル CA 署名です。警告を消すには CA ルート証明書を OS に取り込みます:

```bash
# Caddy コンテナから CA ルート証明書を取り出す
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

- **macOS**: `caddy-root.crt` をダブルクリック →「キーチェーンアクセス」で「常に信頼」に設定
- **Windows**: 「信頼されたルート証明機関」ストアにインポート
- **Linux**: `/usr/local/share/ca-certificates/` に置いて `sudo update-ca-certificates`

### LAN 内の別端末（スマホ等）から実機テストする

別端末で WebRTC を試すには HTTPS が必須です。`tls internal` の証明書は他端末では既定で信頼されないため、次の準備が必要です:

1. ホスト PC の LAN IP を調べる（例: `192.168.1.10`）
2. 別端末の hosts に `192.168.1.10 engawa.localhost` を追加する（証明書は `engawa.localhost` 向けに発行されるため、IP 直アクセスではなくこの名前で開く）
   - iOS など hosts を編集できない端末では、社内 DNS で同名を引かせる等の代替が必要です
3. 上記の `caddy-root.crt` をその端末に転送してインストール・信頼する
4. 別端末で **https://engawa.localhost** を開く

> これらの設定（hosts・CA 配布）は端末環境ごとに異なるため、各自の環境に合わせて行ってください。本リポジトリは特定ホスティング前提のデプロイ設定は持ちません。

---

## 🧱 技術スタック

**サーバー**
- [Bun](https://bun.sh/) + 標準の WebSocket（外部依存ほぼなし）
- 役割は「位置同期」「WebRTC シグナリング中継」「TURN クレデンシャル発行」のみ

**クライアント**
- TypeScript + [Vite](https://vitejs.dev/)
- 描画は素の Canvas 2D API（UI フレームワークなし）
- WebRTC は [simple-peer](https://github.com/feross/simple-peer)

**インフラ**
- STUN: Google 公開 STUN
- TURN: Cloudflare Realtime（NAT 越えできない場合のみ経由）

---

## 🏗 アーキテクチャ

メディア（音声・映像・画面共有）は **P2P で直接** 流れ、サーバーを経由しません。サーバーがやるのは、出会いの仲介と位置の同期だけです。

```
[ブラウザA]                 [サーバー (Bun)]                 [ブラウザB]
   │  WebSocket  ←───────→  ├ 位置のブロードキャスト  ←──────→  │  WebSocket
   │                        ├ WebRTC シグナリング中継           │
   │                        └ /api/turn-credentials             │
   │                           (Cloudflare の短期トークン発行)   │
   │                                                            │
   └──────  WebRTC P2P（音声 / 映像 / 画面共有）  ←─────────────┘
            ※ NAT 越え不可のときだけ Cloudflare TURN 経由
```

### サーバーの責務
1. **静的ファイル配信**
2. **位置同期** — クライアントの座標を受け取り全員にブロードキャスト
3. **WebRTC シグナリング中継** — offer / answer / ICE candidate を相手に転送
4. **TURN クレデンシャル発行** — Cloudflare API を叩いて短期トークンを返す（API キーはサーバーのみ保持）

---

## 📁 ディレクトリ構成

```
engawa/
├ client/                # Vite + TypeScript フロントエンド
│  └ src/
│     ├ app.ts           # トップレベルのオーケストレータ（ゲームループ・各サブシステムの配線）
│     ├ toolbar.ts       # マイク / カメラ / 画面共有 / 録画ボタンと各種メニュー
│     ├ remote-media.ts  # リモートのビデオ / 音声 / 画面共有タイルの DOM 管理
│     ├ panels.ts        # フローティングパネルの配置
│     ├ speaking.ts      # 発話検出
│     ├ canvas.ts        # Canvas 描画
│     ├ player.ts        # プレイヤー状態
│     ├ media.ts         # マイク / カメラ / 画面共有
│     ├ webrtc.ts        # WebRTC 接続管理
│     ├ network.ts       # WebSocket 通信
│     ├ proximity.ts     # 近接判定（接続 / 切断のしきい値）
│     ├ recorder.ts      # 録画
│     ├ sounds.ts        # 効果音
│     ├ tilemap.ts       # マップ
│     ├ input.ts         # キー入力
│     └ types.ts         # 共有型定義
└ server/
   └ src/
      ├ index.ts         # Bun サーバーエントリ
      ├ websocket.ts     # WS メッセージハンドラ
      ├ logic.ts         # 入室・位置同期などのロジック
      ├ turn.ts          # Cloudflare TURN クレデンシャル発行
      └ types.ts         # サーバー側型定義
```

---

## ⚙️ 設定（環境変数）

`.env`（`.env.example` をコピーして作成）:

```bash
PORT=3000

# Cloudflare TURN（任意 — 設定しなければ STUN のみで動作）
CLOUDFLARE_TURN_TOKEN_ID=
CLOUDFLARE_TURN_TOKEN_SECRET=

# ワークスペースのパスワード保護（任意）
# 例: WORKSPACE_PASSWORDS=営業部:secret123,開発部:pass456
WORKSPACE_PASSWORDS=
```

- **TURN** を使う場合は Cloudflare Dashboard → Realtime → TURN で Token を作成して設定します。
- **WORKSPACE_PASSWORDS** を設定すると、該当ワークスペースへの入室にパスワードが必要になります。

---

## 🐳 本番デプロイ（コンテナ）

本番用の **host 非依存なコンテナイメージ** を同梱しています（`Dockerfile`）。Bun サーバーがクライアントのビルド成果物を `./public` から配信し、静的ファイル・`/ws`・`/api` を**単一ポート / 同一オリジン**で提供します。

```bash
docker build -t engawa .
docker run -p 3000:3000 \
  -e CLOUDFLARE_TURN_TOKEN_ID=xxx -e CLOUDFLARE_TURN_TOKEN_SECRET=yyy \
  engawa
```

`v*` タグを push すると GitHub Actions（`.github/workflows/release.yml`）が **GHCR** にイメージを公開します: `ghcr.io/<owner>/engawa`。

### Caddy 付きの本番サンプル（`docker-compose.prod.yml`）

VPS などにそのまま置いて動かせるサンプルを同梱しています。**Caddy が Let's Encrypt で HTTPS を自動終端**し、GHCR の公開イメージへリバースプロキシします。

```bash
# 実ドメインが解決でき、80/443 がインターネットから到達できるホストで:
cp .env.prod.example .env   # ENGAWA_DOMAIN / ACME_EMAIL / TURN などを設定
docker compose -f docker-compose.prod.yml up -d
```

- `ENGAWA_DOMAIN` の DNS を当ホストに向け、ポート **80/443** を開けておくと、Caddy が証明書を自動取得・更新します。
- イメージは `ENGAWA_IMAGE` で指定（既定 `ghcr.io/iitenkida7/engawa:latest`）。本番では `:vX.Y.Z` のように**バージョンタグを固定**するのを推奨。
- server コンテナはホストにポート公開せず、**Caddy 経由のみ**で到達します（単一オリジンで static・`/ws`・`/api` を配信）。
- 開発用の `docker-compose.yml` / `Caddyfile`（`tls internal` / `engawa.localhost`）とは別物です。

注意点:

- **TLS 終端はリバースプロキシ / プラットフォームのエッジの責務**。アプリ自身は TLS を持ちません。`fly.toml` などの**特定ホスティング向け設定は本リポジトリに含めません**（各自の環境側で管理）。
- ⚠️ **必ず 1 インスタンスで動かす**。位置同期・シグナリングはインメモリの単一プロセスで、水平スケールすると別インスタンスのユーザーが見えなくなります（メディアは P2P なので台数に依存しません）。
- TURN トークンや `WORKSPACE_PASSWORDS` はイメージに焼かず、**実行時の環境変数 / シークレット**で渡します。

---

## 🧭 設計の指針（変えるときに外さないでほしい点）

1. **音声 / 映像 / 画面共有は絶対にサーバーを経由しない** — P2P、または TURN 経由のみ。
2. **シグナリングサーバーは状態を持たない** — DB 不要。メモリ上で完結し、再起動でリセットして良い。
3. **Cloudflare TURN の API キーはサーバー側のみ保持** — ブラウザには短期クレデンシャルだけを渡す。
4. **HTTPS 必須**（localhost 開発を除く）。

---

## 🤝 開発に参加する

- コミットメッセージ・コード中のコメントは英語で書きます。
- TypeScript strict モード / セミコロンあり / シングルクォート / インデント 2 スペース。
- アプリに関する操作（ビルド・テスト・依存追加など）はすべて Docker 経由で行います。

詳しいルールは [`CLAUDE.md`](./CLAUDE.md) を参照してください。
