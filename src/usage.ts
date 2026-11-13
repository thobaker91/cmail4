// Cmail — D1 usage self-reporting (issue #1, §5).
// The health panel used to report correctness but not consumption. Cloudflare
// exposes rows_read / rows_written on every D1 result's meta, so the binding
// is wrapped once per request and every query's cost lands in a small
// isolate-level accumulator. It flushes into a `usage_daily` row at most
// once a minute per isolate (one tiny UPSERT), plus on the health read and
// the cron pass — so tracking never becomes its own quota problem.
import type { Env } from './util';

type Counters = { rowsRead: number; rowsWritten: number; queries: number };

const g = globalThis as typeof globalThis & { __cmailUsage?: Counters; __cmailUsageFlushAt?: number };
const counters = (): Counters => (g.__cmailUsage ??= { rowsRead: 0, rowsWritten: 0, queries: 0 });

const today = () => new Date().toISOString().slice(0, 10);

// ---- the tracking D1 wrapper ----
// Reads meta.stats off every result (Workers D1 binding exposes
// rows_read / rows_written there). The original DB object is kept aside so
// the flush itself stays untracked — otherwise counting the counter would
// grow forever.
export function trackedDb(db: NonNullable<Env['DB']>): { db: NonNullable<Env['DB']>; flush: (env: Env) => Promise<void> } {
  const raw = db;

  const note = (meta: unknown) => {
    const m = meta as { stats?: { rows_read?: number; rows_written?: number } } | undefined;
    const c = counters();
    c.rowsRead += m?.stats?.rows_read ?? 0;
    c.rowsWritten += m?.stats?.rows_written ?? 0;
    c.queries += 1;
  };

  const wrapStmt = <T extends { bind: (...v: unknown[]) => T }>(stmt: T): T => {
    const bound: Record<string, unknown> = {};
    for (const k of ['first', 'run', 'all', 'raw']) {
      const orig = (stmt as unknown as Record<string, unknown>)[k];
      if (typeof orig !== 'function') continue;
      bound[k] = async (...args: unknown[]) => {
        const res = await (orig as (...a: unknown[]) => Promise<unknown>).apply(stmt, args);
        note((res as { meta?: unknown })?.meta ?? res);
        return res;
      };
    }
    return new Proxy(stmt, {
      get(target, prop) {
        if (prop in bound) return bound[prop as string];
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as T;
  };

  const wrapped = {
    prepare(sql: string) {
      return wrapStmt(raw.prepare(sql));
    },
    async batch<T>(stmts: unknown[]) {
      const res = await raw.batch(stmts as never);
      note((res as unknown as { meta?: unknown })?.meta ?? null);
      return res;
    },
  } as unknown as NonNullable<Env['DB']>;

  return {
    db: new Proxy(wrapped, {
      get(target, prop) {
        if (prop === 'prepare' || prop === 'batch') return (target as unknown as Record<string | symbol, unknown>)[prop];
        const v = (raw as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === 'function' ? v.bind(raw) : v;
      },
    }) as NonNullable<Env['DB']>,
    flush: flushUsage,
  };
}

// Write the accumulated numbers into usage_daily (idempotent per day).
// Called: at most once a minute per isolate from the request middleware,
// right before the health report reads the tile, and by the hourly cron.
export async function flushUsage(env: Env): Promise<void> {
  const c = counters();
  if (!c.queries && !c.rowsRead && !c.rowsWritten) return;
  const { rowsRead, rowsWritten, queries } = c;
  g.__cmailUsage = { rowsRead: 0, rowsWritten: 0, queries: 0 };
  try {
    await env.DB.prepare(
      `INSERT INTO usage_daily (day, rows_read, rows_written, requests, queries)
       VALUES (?, ?, ?, 1, ?)
       ON CONFLICT(day) DO UPDATE SET
         rows_read   = rows_read   + ?,
         rows_written = rows_written + ?,
         requests    = requests + 1,
         queries     = queries + ?`
    ).bind(today(), rowsRead, rowsWritten, queries, rowsRead, rowsWritten, queries).run();
  } catch { /* pre-0009 schema — the tile simply stays empty */ }
}

// enough time passed since the last flush? (cheap, in-memory)
export function usageFlushDue(): boolean {
  const last = g.__cmailUsageFlushAt ?? 0;
  if (Date.now() - last < 60_000) return false;
  g.__cmailUsageFlushAt = Date.now();
  return true;
}

// the tile's numbers (after a flush so nothing accumulated is missing)
export async function usageToday(env: Env): Promise<{ day: string; rows_read: number; rows_written: number; requests: number; queries: number } | null> {
  try {
    return await env.DB.prepare(
      'SELECT day, rows_read, rows_written, requests, queries FROM usage_daily WHERE day = ?'
    ).bind(today()).first();
  } catch { return null; }
}

// cron housekeeping: keep the last 14 days only
export async function pruneUsage(env: Env): Promise<void> {
  try {
    const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
    await env.DB.prepare('DELETE FROM usage_daily WHERE day < ?').bind(cutoff).run();
  } catch { /* cosmetic */ }
}
