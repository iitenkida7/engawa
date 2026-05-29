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
| ⏺ | 録画 | 通話の音声・映像をブラウザ上で録画 |
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

- クライアント: http://localhost:5173
- サーバー: http://localhost:3000

| コマンド | 内容 |
|---|---|
| `make up` | 起動（`docker compose up -d`） |
| `make down` | 停止 |
| `make restart` | 再起動 |
| `make test` | テスト実行（server / client 両方） |
| `make build` | クライアントの本番ビルド |

> WebRTC は HTTPS または localhost でのみ動作します。`localhost:5173` での開発はそのまま動きます。

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
│     ├ game.ts          # メインゲームループ・UI 管理
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
