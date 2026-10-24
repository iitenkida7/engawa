# Event webhook receiver sample (Google Apps Script)

English | [日本語](./README.ja.md)

Receives engawa's [event webhook](../../docs/webhook.md) with Google Apps Script (GAS) and appends one row per
event to a Google Sheet. It costs nothing to run.

> This is **one example of a receiver**. engawa itself only sends events; building and running the receiver is
> up to you.

## What gets stored

| Sheet | One row = | Source event |
|---|---|---|
| `conversations` | one conversation | `conversation.ended` |
| `presence` | one stay | `presence.ended` |

`*.started` events are not stored, because the matching `*.ended` carries everything needed. Each sheet is created
with a header row when its first event arrives. Open-floor conversations are recorded with `zone` = `floor`.

## Setup

1. Create a new Google Sheet and open **Extensions → Apps Script**.
2. Replace the contents of `Code.gs` with this directory's [`Code.gs`](./Code.gs) and save.
3. Under **Project Settings → Script Properties**, add `TOKEN` with a hard-to-guess value.
4. **Deploy → New deployment → Type: Web app**, with these settings:
   - Execute as: **Me**
   - Who has access: **Anyone** (the engawa server POSTs without signing in; the `TOKEN` check protects it)
5. Append `?token=<the value from step 3>` to the web app URL and set it in engawa's `.env`:

   ```bash
   EVENT_WEBHOOK_URL=https://script.google.com/macros/s/XXXXXXXX/exec?token=YYYYYYYY
   ```

6. Restart the engawa server. When two people talk and then walk apart, a row appears in the `conversations` sheet.

## Notes

- GAS cannot read request headers, so the `EVENT_WEBHOOK_SECRET` signature cannot be verified. The `token` in
  the URL is checked instead, so treat the URL as a secret.
- After changing `Code.gs`, redeploy with **Manage deployments → Edit → Version: New version**, or the change
  will not take effect.
- Times arrive as UTC ISO strings and are shown in the spreadsheet's time zone (File → Settings).
- To visualise the data, use the sheet as a Looker Studio data source, or use the spreadsheet's own charts and
  pivot tables.
