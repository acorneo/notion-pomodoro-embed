#!/usr/bin/env node
/**
 * Creates a "Pomodoro" database in Notion with the exact schema the Worker expects.
 *
 * Usage:
 *   NOTION_TOKEN=ntn_... PARENT_PAGE_ID=<page id or URL> node scripts/create-db.mjs
 *
 * The parent page must be shared with your integration (… → Connections → Add).
 * The script prints NOTION_DB_ID — store it with `wrangler secret put NOTION_DB_ID`.
 */

const NOTION_VERSION = '2025-09-03';
const token = process.env.NOTION_TOKEN;
const parentRaw = process.env.PARENT_PAGE_ID ?? process.argv[2] ?? '';

// Accept a bare ID or a full page URL: take the last 32 hex characters.
const parentId = (parentRaw.replace(/-/g, '').match(/[0-9a-f]{32}(?![0-9a-f])/i) ?? [])[0];

if (!token || !parentId) {
  console.error('Required: NOTION_TOKEN and PARENT_PAGE_ID (parent page ID or URL).');
  process.exit(1);
}

const opt = (name, color) => ({ name, color });

const body = {
  parent: { type: 'page_id', page_id: parentId },
  title: [{ type: 'text', text: { content: 'Pomodoro' } }],
  icon: { type: 'emoji', emoji: '🍅' },
  initial_data_source: {
    properties: {
      Task: { title: {} },
      Start: { date: {} },
      End: { date: {} },
      Duration: { number: { format: 'number' } },
      Type: { select: { options: [opt('Focus', 'red'), opt('Short break', 'green'), opt('Long break', 'blue')] } },
      Status: { select: { options: [opt('Completed', 'green'), opt('Interrupted', 'orange')] } },
      Notes: { rich_text: {} },
      'Session ID': { rich_text: {} },
    },
  },
};

const res = await fetch('https://api.notion.com/v1/databases', {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
});
const data = await res.json();

if (!res.ok) {
  console.error(`Notion responded with ${res.status}: ${data.message ?? JSON.stringify(data)}`);
  if (res.status === 404) console.error('Hint: share the parent page with your integration (… → Connections).');
  process.exit(1);
}

console.log('Database created ✅');
console.log('NOTION_DB_ID =', data.id.replace(/-/g, ''));
console.log('URL:', data.url);
console.log('\nTip: hide the "Session ID" column in the database view (it is internal).');
