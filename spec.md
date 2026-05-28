# 社内向け Gather クローン 仕様書

## プロジェクト概要

社内コミュニケーション用に、Gather.town のような **2D空間内でアバターが近づくと音声/映像/画面共有で会話できるWebアプリ** を構築する。

### 要件

- 利用者: 社員20名弱（同時接続も最大20人想定）
- 最低限の機能のみ。見た目はシンプルでOK（「誰か」が一目で識別できれば十分）
- できるだけ**中央サーバーが通信経路に介在しない**設計（コスト最小化）
- WebRTC P2P 中心、中央サーバーはシグナリングと位置同期のみ

### MVP機能

1. アバター（円 + 名前 or 顔写真）でマップ上を移動できる
2. 他の参加者のアバターも見える
3. 一定距離以内に近づくと**音声通話**が自動で開始
4. 同様に **ビデオ通話** ができる
5. **画面共有** ができる

### 機能外（やらないこと）

- 凝ったマップエディタ
- 部屋（ルーム）切り替え機能（最初は単一の広場のみ）
- チャット機能（必要になったら後で追加）
- 認証（最初は名前入力のみ、社内VPN/SSO等は後付け）
- 永続化（DB不要、再起動でリセットしてOK）

---

## 技術スタック

### サーバー

| 項目 | 採用 |
|---|---|
| ランタイム | **Bun** |
| 言語 | TypeScript |
| HTTPサーバー | `Bun.serve()`（標準搭載） |
| WebSocket | `Bun.serve()` の websocket 機能（標準搭載） |
| 静的ファイル配信 | `Bun.serve()`（標準搭載） |
| 依存ライブラリ | **なし**（標準APIのみで完結） |

### クライアント

| 項目 | 採用 |
|---|---|
| 言語 | TypeScript |
| ビルドツール | **Vite** |
| 描画 | **素のCanvas 2D API**（フレームワークなし） |
| WebRTC | **simple-peer** |
| UIフレームワーク | **なし**（将来必要になれば Preact を部分導入） |

### インフラ / 外部サービス

| 用途 | 採用 |
|---|---|
| デプロイ先 | 未確定（候補: Fly.io 無料枠 / Hetzner Cloud €3.79〜） |
| STUN | Google公開STUN（`stun:stun.l.google.com:19302`） |
| TURN | **Cloudflare Calls (Realtime) の TURN サービス**（月1TB無料、超過 $0.05/GB） |
| HTTPS | 必須（WebRTCは https or localhost でないと動かない） |

---

## アーキテクチャ

```
[ブラウザA]                    [サーバー (Bun)]                    [ブラウザB]
  ├ Canvas描画                   ├ 静的ファイル配信                 ├ Canvas描画
  ├ WebSocket  ←──────────────→  ├ WebSocketサーバー  ←──────────→  ├ WebSocket
  │                              │  - 位置のブロードキャスト         │
  │                              │  - WebRTCシグナリング中継         │
  │                              └ /api/turn-credentials             │
  │                                 (Cloudflare APIから短期トークン)  │
  │                                                                  │
  └ WebRTC P2P  ←───────────────────────────────────────────────→  ┘
       (音声/映像/画面共有 — サーバーを経由しない)
       (NAT越えできない場合のみ Cloudflare TURN 経由)
```

### サーバーの責務（3つだけ）

1. **静的ファイル配信** （HTML/JS/CSS/画像）
2. **位置同期**: クライアントから `{x, y, userId}` を受け取り、全員にブロードキャスト
3. **WebRTCシグナリング中継**: `offer` / `answer` / `iceCandidate` を相手に転送
4. **TURN credentials 発行**: Cloudflare API を叩いて短期トークンをクライアントに返す（生のAPIキーはサーバーのみ保持）

---

## ディレクトリ構成

```
gather-clone/
├ package.json              # ワークスペース定義（bun workspaces）
├ README.md
├ .env.example              # CLOUDFLARE_TURN_TOKEN_ID, CLOUDFLARE_TURN_TOKEN_SECRET
│
├ client/
│  ├ index.html
│  ├ package.json
│  ├ vite.config.ts
│  ├ tsconfig.json
│  └ src/
│     ├ main.ts             # エントリポイント、ゲームループ
│     ├ game.ts             # Gameクラス（状態管理）
│     ├ canvas.ts           # Canvas描画ロジック
│     ├ player.ts           # Playerクラス（自分・他人のアバター）
│     ├ input.ts            # キーボード入力 → 移動
│     ├ network.ts          # WebSocketクライアント
│     ├ webrtc.ts           # P2P接続管理（simple-peer）
│     ├ media.ts            # getUserMedia / getDisplayMedia
│     └ types.ts            # 共有型定義
│
└ server/
   ├ package.json
   ├ tsconfig.json
   └ src/
      ├ index.ts            # Bun.serve() 起動
      ├ websocket.ts        # WebSocketハンドラ
      ├ signaling.ts        # WebRTCシグナリング中継
      ├ turn.ts             # Cloudflare TURN credentials 発行
      └ types.ts            # 共有型定義
```

---

## サーバー実装の指針

### `server/src/index.ts`

```typescript
import { handleWebSocket } from './websocket';
import { getTurnCredentials } from './turn';

const clients = new Map<string, ServerWebSocket>();

Bun.serve({
  port: Number(process.env.PORT ?? 3000),

  async fetch(req, server) {
    const url = new URL(req.url);

    // WebSocketアップグレード
    if (url.pathname === '/ws') {
      const userId = crypto.randomUUID();
      if (server.upgrade(req, { data: { userId } })) return;
      return new Response('Upgrade failed', { status: 500 });
    }

    // TURN credentials API
    if (url.pathname === '/api/turn-credentials') {
      const creds = await getTurnCredentials();
      return Response.json(creds);
    }

    // 静的ファイル配信（client/dist を配る）
    const path = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = Bun.file(`./public${path}`);
    if (await file.exists()) return new Response(file);
    return new Response('Not Found', { status: 404 });
  },

  websocket: handleWebSocket(clients),
});

console.log('Server running on http://localhost:3000');
```

### WebSocket メッセージプロトコル

```typescript
// クライアント → サーバー
type ClientMessage =
  | { type: 'join'; name: string }                            // 入室
  | { type: 'move'; x: number; y: number }                    // 移動
  | { type: 'signal'; to: string; data: SignalData };         // WebRTCシグナリング

// サーバー → クライアント
type ServerMessage =
  | { type: 'welcome'; userId: string; players: Player[] }    // 自分のID + 既存参加者一覧
  | { type: 'player-joined'; player: Player }                 // 新規参加
  | { type: 'player-moved'; userId: string; x: number; y: number }
  | { type: 'player-left'; userId: string }
  | { type: 'signal'; from: string; data: SignalData };       // WebRTCシグナリング転送

type Player = { userId: string; name: string; x: number; y: number };
type SignalData = unknown; // simple-peer の signal データをそのまま転送
```

### 位置同期の頻度

- クライアントは移動中、**10Hz（100msに1回）** 程度で `move` を送信
- サーバーはそれをそのまま全員にブロードキャスト
- 補間はクライアント側で行う（受信した最新位置に向けてスムーズに移動させる）

### Cloudflare TURN credentials 発行（`server/src/turn.ts`）

```typescript
export async function getTurnCredentials() {
  const res = await fetch(
    `https://rtc.live.cloudflare.com/v1/turn/keys/${process.env.CLOUDFLARE_TURN_TOKEN_ID}/credentials/generate`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.CLOUDFLARE_TURN_TOKEN_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ttl: 3600 }), // 1時間
    }
  );
  const data = await res.json();
  // data.iceServers をそのまま返す
  return data.iceServers;
}
```

事前に Cloudflare Dashboard → Calls → TURN で Token を作成し、`.env` に設定する。

---

## クライアント実装の指針

### ゲームループ

```typescript
class Game {
  players: Map<string, Player> = new Map();
  myId: string = '';
  myPlayer: Player | null = null;

  init() {
    this.setupCanvas();
    this.setupInput();
    this.connectWebSocket();
    requestAnimationFrame(this.loop.bind(this));
  }

  loop() {
    this.update();
    this.render();
    requestAnimationFrame(this.loop.bind(this));
  }

  update() {
    // 入力に応じて自分の位置更新
    // 一定間隔でサーバーに位置送信
    // 近接判定 → WebRTC接続の開始/切断
  }

  render() {
    // Canvas に全プレイヤーを描画
  }
}
```

### アバター描画

- 直径 **40px** の円
- 中に顔写真（あれば）or イニシャル
- 円の下に名前を表示
- 自分の円は枠線を別色（例: 青）にする

### 移動

- 矢印キー or WASD で移動
- 1フレームあたりの移動量で速度調整
- マップ境界でブロック

### 近接判定とWebRTC接続

- 全プレイヤーとの距離を毎フレーム計算
- **半径200px以内** に入ったら WebRTC 接続を確立（simple-peer）
- **半径250px** を超えたら切断（ヒステリシス）
- 音声は距離に応じて音量フェード（オプション、後回しでも可）

### simple-peer による P2P 接続

```typescript
import SimplePeer from 'simple-peer';

async function createPeer(remoteUserId: string, initiator: boolean) {
  const iceServers = await fetch('/api/turn-credentials').then(r => r.json());
  const localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });

  const peer = new SimplePeer({
    initiator,
    config: { iceServers },
    stream: localStream,
  });

  peer.on('signal', data => {
    ws.send(JSON.stringify({ type: 'signal', to: remoteUserId, data }));
  });

  peer.on('stream', stream => {
    // 相手の音声/映像を再生
    attachStream(remoteUserId, stream);
  });

  return peer;
}
```

### 画面共有

```typescript
const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
peer.addStream(screenStream); // 既存のpeerに追加トラックとして送る
```

UIとしては「画面共有」ボタンを設置。共有中の人は別途アイコンで表示。

---

## 環境変数（`.env`）

```
PORT=3000
CLOUDFLARE_TURN_TOKEN_ID=xxxxxxxxxxxx
CLOUDFLARE_TURN_TOKEN_SECRET=xxxxxxxxxxxxxxxxxxxxxxxx
```

---

## ビルド & デプロイ

### 開発

```bash
# サーバー
cd server && bun run dev   # bun --watch src/index.ts

# クライアント
cd client && bun run dev   # vite
```

開発時は Vite の dev server が `/api/*` と `/ws` をサーバーにプロキシする（`vite.config.ts` に設定）。

### ビルド

```bash
cd client && bun run build   # client/dist が生成される
# client/dist の中身を server/public/ にコピー or シンボリックリンク
cd server && bun run start   # bun src/index.ts
```

サーバーは `./public/` を静的配信ルートとする。

### デプロイ先候補

| サービス | 料金 | 備考 |
|---|---|---|
| **Fly.io** | 無料枠で十分 | Bun の Dockerfile テンプレあり、HTTPS自動 |
| **Hetzner Cloud (CX22)** | €3.79/月 | 普通のVPS。`curl -fsSL https://bun.sh/install | bash` で導入、systemd で常駐 |

---

## 実装の推奨順序

MVPを段階的に動かす：

1. **真っ白なCanvasに自分の円を描画、矢印キーで動く**（クライアントのみ）
2. **Bunサーバーを起動、WebSocketで接続できる**
3. **複数クライアントで他人の円が表示される、位置同期する**
4. **WebRTCシグナリング経由で音声通話がつながる**（近接判定なし、まず2人で）
5. **近接判定で自動接続/切断**
6. **ビデオ通話を追加**
7. **画面共有を追加**
8. **Cloudflare TURN を組み込む**（最初は STUN のみで開発、後でTURN追加）
9. **デプロイ**

---

## 設計の重要ポイント（受け取った人が外さないでほしい点）

1. **音声/映像/画面共有のメディアトラフィックは絶対にサーバーを経由しない**（P2P or TURN経由のみ）
2. **シグナリングサーバーは状態を持たない**（DB不要、メモリ上のMapで十分、再起動でリセットOK）
3. **Cloudflare TURN のAPIキーはサーバー側のみ保持**、ブラウザには絶対に渡さない（短期credentialのみ渡す）
4. **simple-peer の `config.iceServers` に Cloudflare からもらった iceServers をそのまま渡す**だけで TURN が機能する
5. **HTTPS必須**（localhost 開発時を除く）

