# コントロールプレーン設定 API 仕様

[English](./control-plane.md) | 日本語

engawa サーバーは、設定を**環境変数の代わりに外部の HTTP エンドポイントから受け取る**ことができます（任意機能）。
`CONTROL_PLANE_URL` を設定したときだけ有効になり、設定しなければ従来どおり環境変数だけで動きます。

## なぜあるのか

環境変数を変えるには**プロセスの再起動**が要ります。engawa は位置とシグナリングをプロセス内メモリに持つため、
再起動はそのオフィスにいる**全員の接続を切ります**（不変条件 #2）。

1 台を自分で立てて使う分にはそれで困りません。けれど engawa を**誰かのために運用する**場合
——顧客ごとに Cloudflare の鍵や入室パスワードが違い、それを管理画面から変えたい——
「設定を変えるたびに会議が切れる」のは受け入れられません。

そこで、設定を外部から取りに行き、**定期的に更新する**口を用意します。

## 設定（環境変数）

| 変数 | 既定 | 説明 |
|---|---|---|
| `CONTROL_PLANE_URL` | 未設定 | 設定を取得する URL。**未設定なら機能ごと無効**（環境変数だけを見ます）。 |
| `CONTROL_PLANE_TOKEN` | 未設定 | 設定すると `Authorization: Bearer <token>` を付けて取得します。 |
| `CONTROL_PLANE_INTERVAL_S` | `60` | 再取得の間隔（秒）。最小 10 秒。 |

## リクエスト

```
GET {CONTROL_PLANE_URL}
Accept: application/json
Authorization: Bearer {CONTROL_PLANE_TOKEN}   ← CONTROL_PLANE_TOKEN 設定時のみ
```

起動時に 1 回、その後 `CONTROL_PLANE_INTERVAL_S` ごとに取得します。
**起動時の 1 回は待ち合わせます**（起動時にしか読まない設定があるため）。

## レスポンス

**環境変数と同じ名前**の JSON オブジェクトを返します。学ぶべき語彙を 2 つに増やさないためです。

```json
{
  "ACCESS_PASSWORD": "hunter22",
  "CLOUDFLARE_TURN_TOKEN_ID": "...",
  "CLOUDFLARE_TURN_TOKEN_SECRET": "...",
  "CLOUDFLARE_REALTIME_APP_ID": "...",
  "CLOUDFLARE_REALTIME_APP_TOKEN": "...",
  "SFU_PROMOTE_AT": 4,
  "GROQ_API_KEY": "gsk_...",
  "EVENT_WEBHOOK_URL": "https://hooks.example.com/engawa",
  "EVENT_WEBHOOK_SECRET": "...",
  "EVENT_INCLUDE_NAMES": false
}
```

### 受け付ける設定（ホワイトリスト）

上の 10 個だけです。**`PORT` と `MAP` は受け付けません** — プロセスと世界の形を起動時に決めるものであり、
外部のエンドポイントに任意の環境変数を設定させるのは、ここで求めている信頼より大きな話になるためです。

- 知らないキーは**黙って無視**します（新しいコントロールプレーンと古いサーバーが共存できるように）。
- 数値・真偽値は文字列に変換します（`4` → `"4"`、`false` → `"false"`）。
- **`null` と `""` は「明示的に未設定」**を意味し、イメージに焼かれた環境変数より優先されます。
  （これが無いと、環境変数にパスワードがあるイメージでパスワードを解除できません。）
- キーを**書かなければ**、その設定は環境変数の値が使われます。
- レスポンスは**全体像**として扱われます（前回の応答にあって今回に無いキーは、環境変数に戻ります）。

### 反映のタイミング

| 設定 | いつ効くか |
|---|---|
| `ACCESS_PASSWORD` | **次の入室から**（再起動不要） |
| `CLOUDFLARE_TURN_*` | **次に発行する TURN クレデンシャルから**（確立済みの通話は従来どおり持ち続けます） |
| `CLOUDFLARE_REALTIME_*` | **次のグループ再計算から**（SFU の有効/無効を含む） |
| `SFU_PROMOTE_AT` | **次のグループ再計算から** |
| `GROQ_API_KEY` | **次に取得するクライアントから** |
| `EVENT_WEBHOOK_*` | **起動時のみ**（イベント記録はサーバー起動時に 1 度組み立てられます） |
| `PORT` / `MAP` | 受け付けません（環境変数のみ・起動時） |

## 失敗したとき

- 取得に失敗（到達不能・タイムアウト・2xx 以外）したら、**直前の設定をそのまま使い続けます**。
  正常に動いているオフィスが、コントロールプレーンの数分の不調で TURN クレデンシャルを失うべきではないためです。
- 起動時の 1 回目が失敗した場合は、環境変数だけで起動します。
- ログには**ステータスコードだけ**を出します（本文には設定値が入りうるため）。

## 共通 Groq キー（`GROQ_API_KEY`）

文字起こしの API キーは通常「各自がブラウザに入れる自分の鍵」です。
`GROQ_API_KEY`（または上記の設定）があるときは、**そのスペースの全員が使える共通の鍵**として扱われます。

- クライアントには `GET /api/transcription-credentials` で渡します。
  この口は**入室済みのセッション（media token）でのみ**読めます。課金が発生する鍵なので、
  匿名の HTTP クライアントに収穫させないためです。
- クライアントは受け取った鍵を **localStorage に保存しません**（運用者の鍵であって、ブラウザのものではないため）。
- 共通鍵があるときも、各自が自分の鍵を登録していればそれは残ります（共通鍵が優先されるだけです）。
- 音声は従来どおり**ブラウザから Groq へ直接**送られます（不変条件 #1 は変わりません）。

## 最小の実装例

コントロールプレーン側は「JSON を返す 1 本の GET」だけです。

```js
// Express での例
app.get('/engawa/settings', (req, res) => {
  if (req.get('authorization') !== `Bearer ${process.env.ENGAWA_TOKEN}`) {
    return res.sendStatus(401);
  }
  const tenant = lookupTenant(req);
  res.json({
    ACCESS_PASSWORD: tenant.accessPassword ?? null,
    CLOUDFLARE_TURN_TOKEN_ID: tenant.turnTokenId ?? null,
    CLOUDFLARE_TURN_TOKEN_SECRET: tenant.turnTokenSecret ?? null,
    GROQ_API_KEY: tenant.groqApiKey ?? null,
  });
});
```

## セキュリティ上の注意

- **URL は HTTPS にしてください。** 応答には資格情報が入ります。
- `CONTROL_PLANE_TOKEN` はイメージに焼かず、実行時のシークレットで渡します。
- コントロールプレーンは**このサーバーの設定を変えられる**立場です。到達できる範囲を絞ってください。
