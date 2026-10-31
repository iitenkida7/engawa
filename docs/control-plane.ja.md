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
| `CONTROL_PLANE_URL` | 未設定 | 設定を取得する URL。**未設定なら機能ごと無効**（環境変数だけを見ます）。**https 必須**（`localhost` のみ http 可）。 |
| `CONTROL_PLANE_TOKEN` | 未設定 | **`CONTROL_PLANE_URL` を設定したときは必須**。リクエストの Bearer と、レスポンス署名の鍵を兼ねます。 |
| `CONTROL_PLANE_INTERVAL_S` | `60` | 再取得の間隔（秒）。最小 10 秒。 |

`CONTROL_PLANE_URL` があるのに `CONTROL_PLANE_TOKEN` が無い、または https でない場合、**サーバーは起動しません**。
認証できないコントロールプレーンは、無いより悪い状態だからです（答えた相手が誰であれ、その資格情報を受け入れてしまう）。

### トークンはサーバー 1 台ごとに別のものを

ホスティングする場合、**トークンはテナント（= サーバー 1 台）ごとに発行**してください。共有しないこと。

- 1 本漏れても影響が 1 テナントに閉じます。
- コントロールプレーン側は**トークンから相手のテナントを決める**設計にしてください。
  URL のクエリやパスでテナントを指定し、トークンは「通しの鍵」として共通にすると、
  1 本のトークンで他社の設定（＝他社の Cloudflare 鍵）を引けてしまいます。

## リクエスト

```
GET {CONTROL_PLANE_URL}
Accept: application/json
Authorization: Bearer {CONTROL_PLANE_TOKEN}
```

起動時に 1 回、その後 `CONTROL_PLANE_INTERVAL_S` ごとに取得します。
**起動時の 1 回は待ち合わせます**（起動時にしか読まない設定があるため）。

## レスポンスの署名（必須）

`CONTROL_PLANE_TOKEN` を設定したとき、**レスポンスには署名が必要**です。無い／合わないものは破棄し、
直前の設定を使い続けます。

```
X-Engawa-Signature: sha256=<hex>
```

`<hex>` は、**送出するボディの生バイト列**を `CONTROL_PLANE_TOKEN` で HMAC-SHA256 した 16 進文字列です。
Webhook の署名（[`webhook.ja.md`](./webhook.ja.md)）と**同じ方式**なので、覚えることは増えません。

### なぜ必要か

Bearer は「engawa → コントロールプレーン」の認証にすぎません。署名が無いと、
**答えた相手が本当にコントロールプレーンなのか**を engawa 側が確かめられません。
設定には Cloudflare の鍵が含まれるため、**正しそうに見える設定を誰からでも受け取る**状態は、
コントロールプレーンを使わないより危険です。

```js
// 署名の付け方（Node.js）
const body = JSON.stringify(settings);
res.set('X-Engawa-Signature',
  'sha256=' + crypto.createHmac('sha256', tenantToken).update(body).digest('hex'));
res.type('application/json').send(body);   // ← 同じバイト列を送ること
```

> JSON を組み立て直すと**別のバイト列**になり、署名が合いません。署名した文字列をそのまま送ってください。

## レスポンス

**環境変数と同じ名前**の JSON オブジェクトを返します。学ぶべき語彙を 2 つに増やさないためです。

```json
{
  "ACCESS_PASSWORD": "hunter22",
  "ENTRY_MODE": "password",
  "CLOUDFLARE_TURN_TOKEN_ID": "...",
  "CLOUDFLARE_TURN_TOKEN_SECRET": "...",
  "CLOUDFLARE_REALTIME_APP_ID": "...",
  "CLOUDFLARE_REALTIME_APP_TOKEN": "...",
  "SFU_PROMOTE_AT": 4,
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
| `ENTRY_MODE` | **次の入室から**（再起動不要）。[`entry-token.ja.md`](./entry-token.ja.md) 参照 |
| `CLOUDFLARE_TURN_*` | **次に発行する TURN クレデンシャルから**（確立済みの通話は従来どおり持ち続けます） |
| `CLOUDFLARE_REALTIME_*` | **次のグループ再計算から**（SFU の有効/無効を含む） |
| `SFU_PROMOTE_AT` | **次のグループ再計算から** |
| `EVENT_WEBHOOK_*` | **起動時のみ**（イベント記録はサーバー起動時に 1 度組み立てられます） |
| `PORT` / `MAP` | 受け付けません（環境変数のみ・起動時） |

## 失敗したとき

- 取得に失敗（到達不能・タイムアウト・2xx 以外）したら、**直前の設定をそのまま使い続けます**。
  正常に動いているオフィスが、コントロールプレーンの数分の不調で TURN クレデンシャルを失うべきではないためです。
- 起動時の 1 回目が失敗した場合は、環境変数だけで起動します。
- ログには**ステータスコードだけ**を出します（本文には設定値が入りうるため）。

## 文字起こしの鍵は受け付けません

`GROQ_API_KEY` という設定は**意図的にありません**。文字起こしの API キーは常に「各自がブラウザに入れる自分の鍵」です。
スペースの運用者が鍵を配ると、運用者は自分の Groq アカウントから**参加者全員の文字起こし履歴を見られてしまいます**。
会話の中身はその場にいた人のものであって、運用者のものではありません。

## 最小の実装例

コントロールプレーン側は「JSON を返す 1 本の GET」だけです。

```js
// Express での例。テナントは「トークンから」決めること。
app.get('/engawa/settings', (req, res) => {
  const token = (req.get('authorization') ?? '').replace(/^Bearer /, '');
  const tenant = token ? findTenantByToken(token) : null;   // ← 定数時間比較で照合する
  if (!tenant) return res.sendStatus(401);

  const body = JSON.stringify({
    ACCESS_PASSWORD: tenant.accessPassword ?? null,
    CLOUDFLARE_TURN_TOKEN_ID: tenant.turnTokenId ?? null,
    CLOUDFLARE_TURN_TOKEN_SECRET: tenant.turnTokenSecret ?? null,
  });

  res.set('X-Engawa-Signature',
    'sha256=' + crypto.createHmac('sha256', token).update(body).digest('hex'));
  res.type('application/json').send(body);
});
```

## セキュリティ上の注意

- **HTTPS は強制**です（`localhost` を除く）。応答には資格情報が入ります。
- **トークンはテナントごとに発行**し、コントロールプレーン側は**トークンからテナントを決める**。
- トークンの照合は**定数時間比較**で（`crypto.timingSafeEqual` 等）。
- `CONTROL_PLANE_TOKEN` はイメージに焼かず、**実行時のシークレット**で渡します（fly なら `fly secrets set`）。
- **ログに設定値を出さない。** engawa 側はステータスコードしか記録しません。
- コントロールプレーンは**このサーバーの設定を変えられる**立場です。到達できる範囲を絞ってください。
- トークンを入れ替えるときは、コントロールプレーン側で新旧 2 本を一時的に受け付け、
  各オフィスのシークレットを更新してから旧トークンを無効化します。
