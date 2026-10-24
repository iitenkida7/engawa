# イベント Webhook API 仕様

[English](./webhook.md) | 日本語

engawa サーバーは、入退室と会話の始まり・終わりを **JSON の HTTP POST** で外部に通知できます（任意機能）。
サーバー自身は何も保存しません（不変条件 #2）。受け取ったイベントの保存・集計・可視化は受信側の関心事です。
受信側の一例として Google Apps Script のサンプルを [`examples/webhook-gas/`](../examples/webhook-gas/README.ja.md) に置いています。

## 設定（環境変数）

| 変数 | 既定 | 説明 |
|---|---|---|
| `EVENT_WEBHOOK_URL` | 未設定 | 送信先 URL（`http://` または `https://`）。**未設定なら機能ごと無効**で、何も送りません。 |
| `EVENT_WEBHOOK_SECRET` | 未設定 | 設定すると、リクエストボディの HMAC-SHA256 署名を `X-Engawa-Signature` ヘッダーに付けます。 |
| `EVENT_INCLUDE_NAMES` | `false` | `true` のときだけ参加者を**表示名**で送ります。それ以外は匿名 ID（後述）。 |

## リクエスト

イベント 1 件につき 1 回 POST します。

```
POST {EVENT_WEBHOOK_URL}
Content-Type: application/json
User-Agent: engawa-webhook
X-Engawa-Event: conversation.ended
X-Engawa-Signature: sha256=<16 進の HMAC-SHA256>   ← EVENT_WEBHOOK_SECRET 設定時のみ
```

### ボディ（共通の封筒）

```json
{
  "id": "6f1c1f0e-3b0a-4c55-9a8e-2a7d5f0f6c11",
  "type": "conversation.ended",
  "at": "2026-10-24T01:05:00.000Z",
  "data": { }
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `id` | string (UUID) | イベントごとに一意。重複排除に使えます。 |
| `type` | string | イベント種別（下表）。`X-Engawa-Event` ヘッダーと同じ値。 |
| `at` | string (ISO 8601, UTC) | サーバーがイベントを発行した時刻。 |
| `data` | object | 種別ごとの中身（下記）。 |

### 署名の検証

`EVENT_WEBHOOK_SECRET` を設定すると `X-Engawa-Signature: sha256=<hex>` が付きます。`<hex>` は
**受信したボディの生バイト列**を秘密鍵で HMAC-SHA256 した 16 進文字列です。受信側で同じ計算をし、
定数時間比較で一致を確かめてください（JSON をパースし直したものではなく、生のボディで計算します）。

```js
// Node.js での検証例
const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.headers['x-engawa-signature'] ?? ''));
```

ヘッダーを読めない受信先（Google Apps Script など）では、URL のクエリにトークンを含めて照合する方法も使えます
（例: `https://script.google.com/macros/s/.../exec?token=...`）。

## イベント一覧

| `type` | いつ |
|---|---|
| `presence.started` | 誰かが入室した（再接続によるセッション再開では出ません） |
| `presence.ended` | 誰かが退室した（タブを閉じた・通信が切れて 15 秒戻らなかった・同じブラウザの新しいタブに置き換わった） |
| `conversation.started` | 2 人以上の会話が始まった |
| `conversation.ended` | 会話が終わった（全員が離れた・1 人になった・別のゾーンへ移った） |

### `presence.started`

```json
{ "presenceId": "0b6c6f2e-...", "participant": "3f9a1c0d2b7e4a51" }
```

### `presence.ended`

```json
{
  "presenceId": "0b6c6f2e-...",
  "participant": "3f9a1c0d2b7e4a51",
  "joinedAt": "2026-10-24T00:10:00.000Z",
  "leftAt": "2026-10-24T03:40:12.000Z",
  "durationSec": 12612
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `presenceId` | string | 1 回の滞在の ID。`started` と `ended` で同じ値。 |
| `participant` | string | 参加者（「参加者の表し方」参照）。 |
| `joinedAt` / `leftAt` | string (ISO 8601, UTC) | 入室・退室の時刻。 |
| `durationSec` | number | 滞在時間（秒、四捨五入）。 |

### `conversation.started`

```json
{
  "conversationId": "c2a8d7a4-...",
  "zone": "meeting-1",
  "transport": "sfu",
  "participants": ["3f9a1c0d2b7e4a51", "a07b55e9c1d24f80"],
  "participantCount": 2
}
```

### `conversation.ended`

```json
{
  "conversationId": "c2a8d7a4-...",
  "zone": "meeting-1",
  "transport": "sfu",
  "startedAt": "2026-10-24T01:00:00.000Z",
  "endedAt": "2026-10-24T01:05:00.000Z",
  "durationSec": 300,
  "participants": ["3f9a1c0d2b7e4a51", "a07b55e9c1d24f80", "9e0d3b7c4a1f2e68"],
  "participantCount": 3,
  "maxConcurrent": 2
}
```

| フィールド | 型 | 説明 |
|---|---|---|
| `conversationId` | string | 会話の ID。`started` と `ended` で同じ値。 |
| `zone` | string \| null | 会議室などのゾーン ID（例: `all-hands`, `meeting-1`, `1on1-1`, `booth-1`）。**屋外（開放フロア）は `null`**。 |
| `transport` | `"sfu"` \| `"mesh"` | 通話の経路（`ended` では最後の状態）。 |
| `startedAt` / `endedAt` | string (ISO 8601, UTC) | 会話の開始・終了時刻。 |
| `durationSec` | number | 会話の長さ（秒、四捨五入）。 |
| `participants` | string[] | 途中で抜けた人も含め、**一度でも参加した全員**。`started` では開始時点の顔ぶれ。 |
| `participantCount` | number | `participants` の人数（接続単位で数えるため、同じ名前の別人は別に数えます）。 |
| `maxConcurrent` | number | 同時に話していた最大人数。 |

## 会話の定義

- サーバーが通話のつながりを決める「近接グループ」のうち、**2 人以上のもの**を会話とみなします。
- 人の出入りがあっても、**同じゾーンで前の会話と最も多くのメンバーが重なる**グループは同じ会話として続きます。
  - 分かれたときは、重なりの大きい側が会話を引き継ぎ、残りは新しい会話として始まります。
  - 合流したときは、片方が続き、もう片方は終わります。
- 屋外から会議室に入るなど**ゾーンが変わると、別の会話**として数えます。
- 屋外ですれ違っただけでは会話にはなりません（双方が立ち止まったときだけ会話が始まるサーバーの仕様どおり）。
- 一時的な通信断（15 秒以内の再接続）では会話も滞在も途切れません。

## 参加者の表し方

- `EVENT_INCLUDE_NAMES=true` のとき: 入室時の**表示名**。
- それ以外（既定）: 表示名から作る **16 桁の匿名 ID**。同じサーバープロセス内で、**同じ日（UTC）・同じ名前なら同じ ID**
  になります。日付が変わるとき・サーバーを再起動したときに ID は変わるため、「日ごとの利用人数」は数えられますが、
  日をまたいで個人を追うことはできません。

## 配信の性質

- **ベストエフォート・最大 1 回**です。タイムアウトは 5 秒で、失敗しても再送しません（サーバーのログに警告を出すだけ）。
- **順序は保証しません**。並べ替えには `at`（または `startedAt` / `endedAt`）を使ってください。
- サーバーの再起動・停止時点で続いていた滞在・会話の `ended` は**送られません**（状態はメモリにしか持たないため）。
- 送られないもの: 会話の内容・文字起こし・チャット・位置情報。
