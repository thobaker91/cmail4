// Cmail — setup wizard routes
import { Hono } from 'hono';
import type { Env, AppEnv, SessionUser } from '../util';
import { createSession, setSessionCookie, clientIp, rateLimit, requireUser } from '../auth';
import { usernameValid, passwordStrong, hashPassword, uid, now, getSettings, setSetting, RE_DOMAIN } from '../util';
import { SCHEMA } from '../generated/schema';
import { TABLES, EXPECTED } from '../tables';

const app = new Hono<AppEnv>();

// --------------------------------------------------------------------------
//  The table registry lives in src/tables.ts (shared with the Health panel)
//  so the Setup screen shows exactly what exists, builds what's missing and
//  offers to drop what isn't ours — and the heal_* ALTERs ride along with
//  their table so legacy databases get repaired by the same buttons.
// --------------------------------------------------------------------------

// a fresh install has no accounts yet — table tooling stays public until the
// first admin exists, then it locks to admins only
async function freshInstall(env: Env): Promise<boolean> {
  try {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    return (n?.n ?? 0) === 0;
  } catch { return true; } // users table itself missing → definitely fresh
}

async function tableGuard(c: any): Promise<{ env: Env } | null> {
  const env = c.env as Env;
  if (!env.DB) return null;
  if (await freshInstall(env)) return { env };
  const u = c.get('user');
  if (u && u.role === 'admin') return { env };
  return null;
}

// public bootstrap: what still needs configuration
app.get('/status', async (c) => {
  const env = c.env;

  // 1) D1 binding present at all?
  const db_binding = !!env.DB;

  // 2) database reachable?
  let database = false;
  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1').first();
      database = true;
    } catch { database = false; }
  }

  // 3) schema initialized?
  let tables = false;
  if (database && env.DB) {
    try {
      await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
      tables = true;
    } catch { tables = false; }
  }

  let admin_created = false;
  let domain = false;
  const settings: Record<string, string> = {};

  if (tables && env.DB) {
    try {
      // self-heal: this panel belongs to a single user — the only account in
      // the table IS the admin. Installs migrated from older builds may carry
      // role='user' (the column default), which silently locked them out of
      // the health panel, domains and every admin API. Promote without asking.
      const first = await env.DB.prepare('SELECT id, role FROM users ORDER BY created_at LIMIT 1').first<{ id: string; role: string }>();
      const total = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
      if (first && (total?.n ?? 0) === 1 && first.role !== 'admin') {
        await env.DB.prepare("UPDATE users SET role = 'admin' WHERE id = ?").bind(first.id).run();
      }

      const [adminCount, domainCount, s] = await Promise.all([
        env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>(),
        // only a domain that finished its registration proves the routing path
        env.DB.prepare("SELECT COUNT(*) AS n FROM domains WHERE active = 1 AND status IN ('verified', 'unverified')").first<{ n: number }>(),
        getSettings(env, ['sending_provider', 'sending_api_key', 'sending_from_email', 'login_username', 'app_name']),
      ]);
      admin_created = (adminCount?.n ?? 0) > 0;
      domain = (domainCount?.n ?? 0) > 0;
      Object.assign(settings, s);
    } catch { /* tables may be half-migrated */ }
  }

  const sendingProvider = settings.sending_provider || 'none';
  const sending = (sendingProvider === 'brevo' || sendingProvider === 'resend')
    && !!settings.sending_api_key
    && !!settings.sending_from_email;

  // outbound mail is a bonus, not a gate: receiving works without it, so it
  // must never block someone from reaching their inbox
  const checks = [
    { id: 'database', ok: db_binding && database && tables, optional: false },
    { id: 'admin', ok: admin_created, optional: false },
    { id: 'domain', ok: domain, optional: false },
    { id: 'sending', ok: sending, optional: true },
  ];
  const ready = checks.filter((x) => !x.optional).every((x) => x.ok);

  return c.json({
    ok: true,
    ready,
    checks,
    sending_optional: true,
    db_binding,
    database,
    tables,
    admin_created,
    login_username: (settings.login_username ?? '1') !== '0',
    domains_configured: domain,
    sending_provider: sendingProvider,
    sending_from: settings.sending_from_email || '',
    sending_ready: sending,
    app_name: settings.app_name || 'Cmail',
    version: c.env.APP_VERSION || '',
  });
});

// one-click schema creation — the wizard calls this so nobody has to paste
// SQL into a console ever again. Runs the embedded statement list in order;
// "healing" ALTERs on older databases fail harmlessly (duplicate column).
app.post('/init', async (c) => {
  const env = c.env;
  if (!env.DB) return c.json({ ok: false, error: 'db_binding_missing' }, 400);

  const ip = clientIp(c);
  if (!(await rateLimit(env, ip, 'init', 10))) return c.json({ ok: false, error: 'rate_limited' }, 429);

  // refuse once the platform is in use — this is a first-run tool only
  let already = false;
  try {
    const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    already = (n?.n ?? 0) > 0;
  } catch { /* users table missing → fresh, proceed */ }
  if (already) return c.json({ ok: false, error: 'already_setup' }, 409);

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const stmt of SCHEMA) {
    try {
      await env.DB.prepare(stmt.sql).run();
      applied.push(stmt.name);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (stmt.optional || /duplicate column|already exists/i.test(msg)) {
        skipped.push(stmt.name);
      } else {
        return c.json({ ok: false, error: 'init_failed', detail: msg.slice(0, 240), applied, skipped }, 500);
      }
    }
  }
  return c.json({ ok: true, applied: applied.length, skipped: skipped.length });
});

// --------------------------------------------------------------------------
//  D1 inspector — the Setup screen's table step. Shows every expected table
//  (exists? rows?), builds whatever is missing with one button or per-table
//  buttons, and offers to drop tables that aren't part of the schema at all.
// --------------------------------------------------------------------------

// inspect: expected tables + row counts + anything extra
app.get('/tables', async (c) => {
  const g = await tableGuard(c);
  if (!g) return c.json({ ok: false, error: 'forbidden' }, c.get('user') ? 403 : 400);
  const { env } = g;

  const { results } = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  ).all<{ name: string }>();
  const existing = new Set((results ?? []).map((r) => r.name));

  const tables = [] as { name: string; exists: boolean; rows: number | null }[];
  for (const t of TABLES) {
    const exists = existing.has(t.name);
    let rows: number | null = null;
    if (exists) {
      try { rows = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).first<{ n: number }>())?.n ?? 0; }
      catch { rows = null; } // legacy shape — count may fail until healed
    }
    tables.push({ name: t.name, exists, rows });
  }

  const extras = [...existing].filter((n) => !EXPECTED.has(n)).map((n) => ({ name: n }));
  const missing = tables.filter((t) => !t.exists).length;
  return c.json({ ok: true, tables, extras, missing, complete: missing === 0 });
});

// build every missing table in one press
app.post('/tables/missing', async (c) => {
  const g = await tableGuard(c);
  if (!g) return c.json({ ok: false, error: 'forbidden' }, c.get('user') ? 403 : 400);
  const { env } = g;
  const ip = clientIp(c);
  if (!(await rateLimit(env, ip, 'init', 20))) return c.json({ ok: false, error: 'rate_limited' }, 429);

  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
  const existing = new Set((results ?? []).map((r) => r.name));

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const t of TABLES) {
    if (existing.has(t.name) && t.stmts.every((s) => s.name.startsWith('stmt_'))) continue; // whole group already there
    for (const stmt of t.stmts) {
      try { await env.DB.prepare(stmt.sql).run(); applied.push(stmt.name); }
      catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (stmt.optional || /duplicate column|already exists/i.test(msg)) skipped.push(stmt.name);
        else return c.json({ ok: false, error: 'init_failed', detail: msg.slice(0, 240), applied, skipped }, 500);
      }
    }
  }
  return c.json({ ok: true, applied: applied.length, skipped: skipped.length });
});

// build one specific table (+ its indexes and heal columns)
app.post('/tables/:name/create', async (c) => {
  const g = await tableGuard(c);
  if (!g) return c.json({ ok: false, error: 'forbidden' }, c.get('user') ? 403 : 400);
  const { env } = g;
  const name = c.req.param('name');
  const def = TABLES.find((t) => t.name === name);
  if (!def) return c.json({ ok: false, error: 'unknown_table' }, 404);

  const applied: string[] = [];
  const skipped: string[] = [];
  for (const stmt of def.stmts) {
    try { await env.DB.prepare(stmt.sql).run(); applied.push(stmt.name); }
    catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (stmt.optional || /duplicate column|already exists/i.test(msg)) skipped.push(stmt.name);
      else return c.json({ ok: false, error: 'init_failed', detail: msg.slice(0, 240) }, 500);
    }
  }
  return c.json({ ok: true, table: name, applied: applied.length, skipped: skipped.length });
});

// drop a table that isn't part of the schema (leftovers from experiments).
// expected tables are never droppable — the button only appears for extras.
app.delete('/tables/:name', async (c) => {
  const g = await tableGuard(c);
  if (!g) return c.json({ ok: false, error: 'forbidden' }, c.get('user') ? 403 : 400);
  const { env } = g;
  const name = c.req.param('name');
  if (EXPECTED.has(name)) return c.json({ ok: false, error: 'protected_table' }, 400);
  if (!/^\w+$/.test(name)) return c.json({ ok: false, error: 'bad_name' }, 400);
  try { await env.DB.prepare(`DROP TABLE IF EXISTS ${name}`).run(); }
  catch (e) { return c.json({ ok: false, error: 'drop_failed', detail: String((e as Error)?.message ?? e).slice(0, 240) }, 500); }
  return c.json({ ok: true, dropped: name });
});

// create the one and only account (first visit — choose a username & password)
app.post('/admin', async (c) => {
  const ip = clientIp(c);
  if (!(await rateLimit(c.env, ip, 'setup', 5))) return c.json({ ok: false, error: 'rate_limited' }, 429);

  // Deploy-button flow: the database is provisioned EMPTY (no migrations are
  // applied by the deploy pipeline) until the gate's one-click builder runs.
  // A raw D1_ERROR here used to strand that install on a form that can never
  // succeed — say plainly what is missing instead.
  let existing: { n: number } | null = null;
  try {
    existing = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
  } catch {
    return c.json({ ok: false, error: 'tables_missing' }, 409);
  }
  if ((existing?.n ?? 0) > 0) return c.json({ ok: false, error: 'already_setup' }, 409);

  const body = await c.req.json<{ username?: string; password?: string; display_name?: string }>().catch(() => null);
  const username = (body?.username ?? '').trim();
  const password = body?.password ?? '';
  if (!usernameValid(username)) return c.json({ ok: false, error: 'invalid_username' }, 400);
  if (!passwordStrong(password)) return c.json({ ok: false, error: 'weak_password' }, 400);

  const id = uid('usr_');
  const hash = await hashPassword(password);
  await c.env.DB.prepare(
    'INSERT INTO users (id, username, password_hash, role, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, username, hash, 'admin', (body?.display_name ?? '').slice(0, 60) || null, now()).run();

  await setSetting(c.env, 'setup_done', '1');
  const token = await createSession(c.env, id, c.req.header('User-Agent'), ip);
  setSessionCookie(c, token);
  return c.json({ ok: true, user: { id, username, role: 'admin' } });
});

// add a domain during wizard (admin only, but wizard creates admin first).
// every domain starts as a draft at stage 1 — the connect wizard takes it
// from there, and mailboxes stay locked until the domain proves itself.
app.post('/domain', requireUser, async (c) => {
  const user = c.get('user') as { role: string };
  if (user.role !== 'admin') return c.json({ ok: false, error: 'forbidden' }, 403);
  const body = await c.req.json<{ name?: string; label?: string }>().catch(() => null);
  const name = (body?.name ?? '').toLowerCase().trim();
  if (!RE_DOMAIN.test(name)) return c.json({ ok: false, error: 'invalid_domain' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM domains WHERE name = ?').bind(name).first();
  if (exists) return c.json({ ok: false, error: 'domain_exists' }, 409);
  const id = uid('dom_');
  await c.env.DB.prepare('INSERT INTO domains (id, name, label, status, stage, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, name, (body?.label ?? '').slice(0, 80) || null, 'draft', 1, now()).run();
  return c.json({ ok: true, id, name });
});

export default app;
