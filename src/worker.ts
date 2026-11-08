/**
 * Pomodoro → Notion. Cloudflare Worker.
 *
 *  - Static files (public/) are served by Workers Assets (ASSETS binding).
 *  - This Worker handles /api/*:
 *      POST /api/sessions  — write a session to the Notion database (idempotent by UUID)
 *      GET  /api/today     — number of focus sessions and minutes for today (Europe/Berlin)
 *
 * Secrets (wrangler secret put): NOTION_TOKEN, NOTION_DB_ID, ACCESS_KEY.
 */

export interface Env {
  NOTION_TOKEN: string;
  NOTION_DB_ID: string;
  ACCESS_KEY: string;
  ASSETS: Fetcher;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const NOTION_API = 'https://api.notion.com/v1';
// Version with data sources. Notion's docs already list a newer one (2026-03-11),
// but this one is pinned and matches the "database → data source" model used below.
const NOTION_VERSION = '2025-09-03';

const TZ = 'Europe/Berlin';
const RATE_LIMIT_PER_HOUR = 30;
const MAX_BODY_BYTES = 10_000;
const MAX_TASK_LEN = 200;
const MAX_NOTES_LEN = 1_900; // Notion's rich_text limit is 2000 characters
const MIN_DURATION = 1;
const MAX_DURATION = 180;
const CLOCK_SKEW_MS = 2 * 60_000; // tolerance for client/server clock drift

const SESSION_TYPES = ['Focus', 'Short break', 'Long break'] as const;
const SESSION_STATUSES = ['Completed', 'Interrupted'] as const;
type SessionType = (typeof SESSION_TYPES)[number];
type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Expected database schema: property name → type. */
const REQUIRED_PROPS: Record<string, string> = {
  Task: 'title',
  Start: 'date',
  End: 'date',
  Duration: 'number',
  Type: 'select',
  Status: 'select',
  Notes: 'rich_text',
  'Session ID': 'rich_text',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------
// Errors and responses
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

function json(data: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // Anything that is not the API is static (in case run_worker_first is broader).
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);

    try {
      return await handleApi(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ error: e.code, message: e.message }, e.status, e.headers);
      console.error('Unhandled error', e);
      return json({ error: 'internal', message: 'Internal Worker error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;

async function handleApi(req: Request, env: Env, url: URL): Promise<Response> {
  if (!env.NOTION_TOKEN || !env.NOTION_DB_ID || !env.ACCESS_KEY) {
    throw new HttpError(500, 'config', 'Secrets NOTION_TOKEN / NOTION_DB_ID / ACCESS_KEY are not set');
  }

  // 1. Authorization — before anything else.
  const provided = req.headers.get('X-Access-Key') ?? '';
  if (!(await keysEqual(provided, env.ACCESS_KEY))) {
    throw new HttpError(401, 'unauthorized', 'Access denied');
  }

  // 2. Routing.
  if (url.pathname === '/api/sessions') {
    if (req.method !== 'POST') throw new HttpError(405, 'method', 'POST only', { Allow: 'POST' });
    return createSession(req, env);
  }
  if (url.pathname === '/api/today') {
    if (req.method !== 'GET') throw new HttpError(405, 'method', 'GET only', { Allow: 'GET' });
    return today(env);
  }
  throw new HttpError(404, 'not_found', 'Not found');
}

/**
 * Constant-time key comparison. Both values are hashed with SHA-256 first so the
 * buffers have equal length (otherwise the key length would leak through timing).
 */
async function keysEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}

// ---------------------------------------------------------------------------
// POST /api/sessions
// ---------------------------------------------------------------------------

interface SessionInput {
  id: string;
  task: string;
  notes: string;
  type: SessionType;
  status: SessionStatus;
  startMs: number;
  endMs: number;
  durationMin: number;
}

async function createSession(req: Request, env: Env): Promise<Response> {
  const input = validateSession(await readJsonBody(req));
  const dataSourceId = await ensureSchema(env);

  // Idempotency: if a page with this Session ID already exists, create nothing.
  const existing = await notion<QueryResult>(env, 'POST', `/data_sources/${dataSourceId}/query`, {
    filter: { property: 'Session ID', rich_text: { equals: input.id } },
    page_size: 1,
  });
  if (existing.results.length > 0) return json({ ok: true, duplicate: true, id: input.id });

  // Stateless rate limit: count pages created in the last hour.
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const recent = await notion<QueryResult>(env, 'POST', `/data_sources/${dataSourceId}/query`, {
    filter: { timestamp: 'created_time', created_time: { on_or_after: hourAgo } },
    page_size: RATE_LIMIT_PER_HOUR,
  });
  if (recent.results.length >= RATE_LIMIT_PER_HOUR) {
    throw new HttpError(429, 'rate_limited', `At most ${RATE_LIMIT_PER_HOUR} records per hour`, {
      'Retry-After': '120',
    });
  }

  await notion(env, 'POST', '/pages', {
    parent: { type: 'data_source_id', data_source_id: dataSourceId },
    properties: {
      Task: { title: [{ text: { content: input.task } }] },
      // Berlin wall-clock time plus an explicit time_zone.
      Start: { date: { start: toBerlinLocalIso(input.startMs), time_zone: TZ } },
      End: { date: { start: toBerlinLocalIso(input.endMs), time_zone: TZ } },
      Duration: { number: input.durationMin },
      Type: { select: { name: input.type } },
      Status: { select: { name: input.status } },
      Notes: { rich_text: input.notes ? [{ text: { content: input.notes } }] : [] },
      'Session ID': { rich_text: [{ text: { content: input.id } }] },
    },
  });

  return json({ ok: true, duplicate: false, id: input.id }, 201);
}

async function readJsonBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'too_large', 'Request body is too large');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'validation', 'Invalid JSON');
  }
}

/** Strict validation of an incoming session. Anything off → 400. */
function validateSession(raw: unknown): SessionInput {
  const bad = (msg: string): never => {
    throw new HttpError(400, 'validation', msg);
  };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return bad('Expected a JSON object');
  const o = raw as Record<string, unknown>;

  if (typeof o.id !== 'string' || !UUID_RE.test(o.id)) bad('id must be a UUID');
  const id = (o.id as string).toLowerCase();

  if (typeof o.task !== 'string') bad('task must be a string');
  const task = (o.task as string).trim();
  if (task.length < 1 || task.length > MAX_TASK_LEN) bad(`task: 1 to ${MAX_TASK_LEN} characters`);

  const notesRaw = o.notes ?? '';
  if (typeof notesRaw !== 'string') bad('notes must be a string');
  const notes = (notesRaw as string).trim();
  if (notes.length > MAX_NOTES_LEN) bad(`notes: at most ${MAX_NOTES_LEN} characters`);

  if (!SESSION_TYPES.includes(o.type as SessionType)) bad(`type: one of ${SESSION_TYPES.join(', ')}`);
  if (!SESSION_STATUSES.includes(o.status as SessionStatus)) bad(`status: one of ${SESSION_STATUSES.join(', ')}`);

  const startMs = parseIso(o.start, 'start');
  const endMs = parseIso(o.end, 'end');
  const now = Date.now();
  if (startMs > now + CLOCK_SKEW_MS) bad('Session start cannot be in the future');
  if (endMs > now + CLOCK_SKEW_MS) bad('Session end cannot be in the future');
  if (endMs <= startMs) bad('end must be after start');

  if (typeof o.durationMin !== 'number' || !Number.isFinite(o.durationMin)) bad('durationMin must be a number');
  const durationMin = Math.round(o.durationMin as number);
  if (durationMin < MIN_DURATION || durationMin > MAX_DURATION) {
    bad(`durationMin: ${MIN_DURATION} to ${MAX_DURATION}`);
  }
  // Active time cannot exceed the start..end interval (+1 min for rounding).
  if (durationMin > (endMs - startMs) / 60_000 + 1) bad('durationMin exceeds the start–end interval');

  return {
    id,
    task,
    notes,
    type: o.type as SessionType,
    status: o.status as SessionStatus,
    startMs,
    endMs,
    durationMin,
  };
}

function parseIso(v: unknown, name: string): number {
  if (typeof v !== 'string' || v.length > 40) throw new HttpError(400, 'validation', `${name}: expected an ISO string`);
  const ms = Date.parse(v);
  if (Number.isNaN(ms)) throw new HttpError(400, 'validation', `${name}: invalid date`);
  return ms;
}

// ---------------------------------------------------------------------------
// GET /api/today
// ---------------------------------------------------------------------------

async function today(env: Env): Promise<Response> {
  const dataSourceId = await ensureSchema(env);
  const dayStart = new Date(berlinDayStartMs(Date.now())).toISOString();

  let count = 0; // completed focus sessions (🍅)
  let interrupted = 0;
  let minutes = 0; // minutes of all focus sessions, including interrupted ones

  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const res: QueryResult = await notion<QueryResult>(env, 'POST', `/data_sources/${dataSourceId}/query`, {
      filter: {
        and: [
          { property: 'Type', select: { equals: 'Focus' } },
          { property: 'Start', date: { on_or_after: dayStart } },
        ],
      },
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    for (const p of res.results) {
      const props = p.properties ?? {};
      minutes += props.Duration?.number ?? 0;
      if (props.Status?.select?.name === 'Completed') count++;
      else interrupted++;
    }
    if (!res.has_more || !res.next_cursor) break;
    cursor = res.next_cursor;
  }
  return json({ count, interrupted, minutes: Math.round(minutes) });
}

// ---------------------------------------------------------------------------
// Europe/Berlin time helpers
// ---------------------------------------------------------------------------

const berlinFmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

function berlinParts(ms: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of berlinFmt.formatToParts(new Date(ms))) out[p.type] = p.value;
  return out;
}

/** "2026-11-08T14:05:00" — Berlin wall-clock time (no offset; the zone is passed separately). */
function toBerlinLocalIso(ms: number): string {
  const p = berlinParts(ms);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

/** Berlin's offset from UTC in ms at instant `ms` (+1h or +2h). */
function berlinOffsetMs(ms: number): number {
  const p = berlinParts(ms);
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant (UTC ms) at which today's Berlin day began. Two passes cover DST transitions. */
function berlinDayStartMs(ms: number): number {
  const p = berlinParts(ms);
  const midnightAsUtc = Date.UTC(+p.year, +p.month - 1, +p.day);
  let t = midnightAsUtc - berlinOffsetMs(midnightAsUtc);
  t = midnightAsUtc - berlinOffsetMs(t);
  return t;
}

// ---------------------------------------------------------------------------
// Notion API
// ---------------------------------------------------------------------------

interface QueryResult {
  results: Array<{ properties?: Record<string, any> }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

async function notion<T = unknown>(env: Env, method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(NOTION_API + path, {
      method,
      headers: {
        Authorization: `Bearer ${env.NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    // One retry on a 429 from Notion.
    if (res.status === 429 && attempt < 1) {
      const wait = Math.min(Number(res.headers.get('Retry-After') ?? 1) || 1, 5);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }

    if (!res.ok) {
      const text = await res.text();
      let msg = text;
      try {
        msg = (JSON.parse(text) as { message?: string }).message ?? text;
      } catch {
        /* keep the raw text */
      }
      const hint =
        res.status === 404 || res.status === 403
          ? ' Check NOTION_DB_ID and that the database is shared with the integration (… → Connections).'
          : res.status === 401
            ? ' Check NOTION_TOKEN.'
            : '';
      // The token never ends up in messages: only Notion's own response is returned.
      throw new HttpError(502, 'notion', `Notion ${res.status}: ${msg.slice(0, 300).replace(/\.+$/, '')}.${hint}`);
    }
    return (await res.json()) as T;
  }
}

/** Per-isolate cache: data source id and the fact that the schema check passed. */
let schemaCache: { dbId: string; dataSourceId: string } | null = null;

/**
 * Finds the database's data source and checks that every required property exists
 * with the right type. On problems → a readable error (500, code=schema).
 * A failed check is not cached: fix the database and the next request goes through.
 */
async function ensureSchema(env: Env): Promise<string> {
  if (schemaCache && schemaCache.dbId === env.NOTION_DB_ID) return schemaCache.dataSourceId;

  const db = await notion<{ data_sources?: Array<{ id: string }> }>(env, 'GET', `/databases/${env.NOTION_DB_ID}`);
  const dataSourceId = db.data_sources?.[0]?.id;
  if (!dataSourceId) throw new HttpError(500, 'schema', 'No data source found for the Notion database');

  const ds = await notion<{ properties: Record<string, { type: string }> }>(
    env,
    'GET',
    `/data_sources/${dataSourceId}`,
  );

  const problems: string[] = [];
  for (const [name, type] of Object.entries(REQUIRED_PROPS)) {
    const actual = ds.properties[name];
    if (!actual) problems.push(`missing property "${name}" (${type})`);
    else if (actual.type !== type) problems.push(`"${name}" must be of type ${type}, found ${actual.type}`);
  }
  if (problems.length) {
    throw new HttpError(500, 'schema', `Notion database schema mismatch: ${problems.join('; ')}.`);
  }

  schemaCache = { dbId: env.NOTION_DB_ID, dataSourceId };
  return dataSourceId;
}
