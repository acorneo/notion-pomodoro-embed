# 🍅 Notion Pomodoro

[![CI](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)

A personal Pomodoro timer you embed into Notion (`/embed`). Every focus session is logged to your Notion database automatically. One Cloudflare Workers project: the Worker serves the page (`public/index.html`) and the API (`/api/sessions`, `/api/today`). It runs on Cloudflare's free plan.

- Vanilla HTML/JS/CSS frontend — no framework, no build step.
- Timer is timestamp-based, so background tabs and iframes don't make it drift; a running session survives page reloads.
- Offline-safe: failed uploads are queued in `localStorage` and retried; a client-generated UUID guarantees no duplicate rows.
- Secrets live only in Worker secrets and never reach the browser. The API is protected by an access key (constant-time comparison).
- Light/dark theme, compact layout for 300–450 px embeds.

```
wrangler.toml          Worker config + static assets
src/worker.ts          API: auth, validation, Notion client
public/index.html      the whole frontend (HTML + CSS + vanilla JS)
scripts/create-db.mjs  creates a Notion database with the expected schema
```

## Notion database schema

| Property     | Type        | Purpose                                          |
|--------------|-------------|--------------------------------------------------|
| `Task`       | title       | task name                                        |
| `Start`      | date        | start (with time, Europe/Berlin)                 |
| `End`        | date        | end (with time, Europe/Berlin)                   |
| `Duration`   | number      | actual minutes, pauses excluded                  |
| `Type`       | select      | Focus / Short break / Long break                 |
| `Status`     | select      | Completed / Interrupted                          |
| `Notes`      | rich_text   | session note                                     |
| `Session ID` | rich_text   | internal UUID used to prevent duplicates         |

If you already have a database, the Worker checks on the first request that all properties exist with the right types, and shows a readable error in the sync indicator if something is missing.

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Create a Notion internal integration
1. Open <https://www.notion.so/profile/integrations> → **New integration**.
2. Type **Internal**, pick your workspace, save.
3. Copy the **Internal Integration Secret** (`ntn_…`). This is `NOTION_TOKEN`.

### 3. Create the database
**Option A — with the script.**
1. Create an empty parent page in Notion (e.g. "Pomodoro").
2. On that page: **⋯ → Connections → Add** → choose your integration.
3. Copy the page link and run:
   ```bash
   NOTION_TOKEN=ntn_xxx PARENT_PAGE_ID="https://www.notion.so/…" npm run create-db
   ```
   The script prints `NOTION_DB_ID`. You can hide the `Session ID` column in the database view (Properties → Hide).

**Option B — existing database.** Create the properties from the table above (exact names and types) and share the database with the integration: **⋯ → Connections → Add**.

### 4. Find the database ID (if you created it manually)
Open the database as a full page. In the URL `https://www.notion.so/<workspace>/<32 characters>?v=…` the ID is the 32 characters before `?v=`.

### 5. Generate an ACCESS_KEY
```bash
openssl rand -hex 24
```
Keep the result: you need it for both the secret and the embed link.

### 6. Deploy to Cloudflare
A free Cloudflare account is enough (no credit card).
```bash
npx wrangler login
npx wrangler secret put NOTION_TOKEN
npx wrangler secret put NOTION_DB_ID
npx wrangler secret put ACCESS_KEY
npx wrangler deploy
```
Wrangler prints an address like `https://notion-pomodoro.<account>.workers.dev`.

### 7. Embed in Notion
On a **private** Notion page type `/embed` and paste:
```
https://notion-pomodoro.<account>.workers.dev/?k=<ACCESS_KEY>
```
Resize the block to roughly 300–450 px tall. Don't share the link with the key. If the key leaks, run `wrangler secret put ACCESS_KEY` with a new value and update the link.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in real NOTION_TOKEN / NOTION_DB_ID and any ACCESS_KEY
npm run dev
```
Open <http://localhost:8787/?k=YOUR_KEY>. Type-check with `npm run typecheck`.

## Manual test checklist

For quick tests set Focus to 1 minute in the settings. Interrupted sessions are logged only if they lasted more than 1 minute.

1. **Completed session.** Enter a task, press Start and wait for the end. You should hear three tones, see the remaining time in the tab title while it runs, and find a `Completed` row in the database with correct Start/End/Duration. The 🍅 counter increases and the timer switches to a break.
2. **Interrupted session.** Start → wait more than 1 minute → Stop. The database gets an `Interrupted` row whose Duration equals the actual minutes. Stopping earlier than 1 minute logs nothing.
3. **Offline → online.** Start a session, switch DevTools → Network to Offline and finish the session. The indicator shows "queued: 1 · offline". Go back online: the queue flushes by itself and the database has exactly one row. Reloading the page while offline keeps the queue. Re-sending never creates a duplicate (same UUID).
4. **Reload mid-session.** Start → reload the page: the timer continues from the right place and the task and note are restored. If you close the tab and reopen it after the session would have ended, it is logged as Completed.
5. **Wrong key.** Open the page without `?k=` (and with cleared localStorage) or with a wrong key. The page shows "Access denied", and `curl -i https://…/api/today` returns `401`.
6. **Extras.** Space toggles start/pause. Breaks are logged only when "Log breaks to Notion" is on. Rate limit: the 31st record within an hour gets `429` and stays in the queue.

## Design notes and limitations

- **Notion API version:** `2025-09-03` (data sources). The Worker resolves the data source from `NOTION_DB_ID` itself. Notion's docs already list `2026-03-11`; update the `NOTION_VERSION` constant in `src/worker.ts` if you want to move.
- **Rate limit** (30 records/hour) is computed from pages created in the database during the last hour — no KV or Durable Objects needed.
- **Duplicates** are prevented by checking `Session ID` before creating a page. Two simultaneous requests with the same UUID could theoretically both pass the check; the client sends queued items one at a time, so this doesn't happen in practice.
- **Skip on a focus session** logs it as Interrupted (if longer than 1 minute) and doesn't count towards the cycle of 4. The 🍅 counter counts Completed sessions only; minutes include all focus sessions.
- **Sound and notifications** may be blocked inside an embed. Sound is unlocked by pressing Start; the Notification API is best-effort.
- There is no `frame-ancestors` restriction: the page and API are protected by the access key only.

## Contributing

Issues and pull requests are welcome. Run `npm run typecheck` before submitting.

## License

[MIT](LICENSE)
