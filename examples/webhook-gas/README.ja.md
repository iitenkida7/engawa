# イベント Webhook の受信サンプル（Google Apps Script）

[English](./README.md) | 日本語

engawa の [イベント Webhook](../../docs/webhook.ja.md) を Google Apps Script（GAS）で受け取り、
Google スプレッドシートに 1 イベント 1 行で追記するサンプルです。費用はかかりません。

> これは**受信側の一例**です。engawa 本体は送信するだけで、受信側の実装や運用は利用者の関心事です。

## 保存される内容

| シート | 1 行 = | 元イベント |
|---|---|---|
| `conversations` | 1 回の会話 | `conversation.ended` |
| `presence` | 1 回の滞在 | `presence.ended` |

`*.started` は保存しません（対応する `*.ended` に必要な情報がすべて入っているため）。
シートは最初のイベントが届いたときにヘッダー付きで自動で作られます。屋外の会話の `zone` は `floor` と記録します。

## セットアップ

1. Google スプレッドシートを新規作成し、**拡張機能 → Apps Script** を開く。
2. `コード.gs`（`Code.gs`）の中身を、このディレクトリの [`Code.gs`](./Code.gs) で置き換えて保存する。
3. **プロジェクトの設定 → スクリプト プロパティ** に `TOKEN` を追加し、推測されにくい文字列を設定する。
4. **デプロイ → 新しいデプロイ → 種類: ウェブアプリ** で次のように設定してデプロイする。
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**（engawa サーバーはログインせずに POST するため。`TOKEN` で照合します）
5. 表示されたウェブアプリの URL の末尾に `?token=<3 で設定した値>` を付けて、engawa の `.env` に設定する。

   ```bash
   EVENT_WEBHOOK_URL=https://script.google.com/macros/s/XXXXXXXX/exec?token=YYYYYYYY
   ```

6. engawa サーバーを再起動する。2 人で会話して離れると、`conversations` シートに行が増えます。

## 注意

- GAS はリクエストヘッダーを読めないため、`EVENT_WEBHOOK_SECRET` の署名は検証できません。URL の `token` で照合します
  （URL は秘密として扱ってください）。
- `Code.gs` を変更したら、**デプロイを管理 → 編集 → バージョン: 新バージョン** で再デプロイしないと反映されません。
- 時刻は UTC の ISO 文字列で届き、スプレッドシートのタイムゾーン（ファイル → 設定）で表示されます。
- 可視化は、このスプレッドシートを Looker Studio のデータソースにする、スプレッドシートのグラフやピボットテーブルを
  使う、などで行えます。
