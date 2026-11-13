// Cmail — admin: overview, users, settings, deep health report
import { Hono } from 'hono';
import type { Env, AppEnv, SessionUser } from '../util';
import { uid, now, clean, getSettings, setSetting, hashPassword, passwordStrong, RE_LOCAL_PART, randomLocalPart } from '../util';
import { requireAdmin, tokenFrom } from '../auth';
import { testProvider } from '../emailout';
import { TABLES, EXPECTED } from '../tables';

const app = new Hono<AppEnv>();

app.get('/overview', requireAdmin, async (c) => {
  const [users, addresses, emails, temp, storage, domains, notes, totp] = await Promise.all([
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM addresses').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM emails').first<{ n: number }>(),
    c.env.DB.prepare("SELECT COUNT(*) AS n FROM addresses WHERE kind='temp'").first<{ n: number }>(),
    c.env.DB.prepare('SELECT COALESCE(SUM(size),0) AS n FROM emails').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM domains WHERE active=1').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM email_notes').first<{ n: number }>(),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM totp_entries').first<{ n: number }>(),
  ]);
  return c.json({
    ok: true,
    overview: {
      users: users?.n ?? 0, addresses: addresses?.n ?? 0, emails: emails?.n ?? 0,
      temp_addresses: temp?.n ?? 0, storage_bytes: storage?.n ?? 0,
      domains: domains?.n ?? 0, notes: notes?.n ?? 0, totp_entries: totp?.n ?? 0,
    },
  });
});

app.get('/users', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.display_name, u.created_at, u.last_login_at, u.totp_enabled,
       (SELECT COUNT(*) FROM addresses a WHERE a.user_id = u.id) AS addresses,
       (SELECT COUNT(*) FROM emails e WHERE e.user_id = u.id) AS emails
     FROM users u ORDER BY u.created_at`
  ).all();
  return c.json({ ok: true, users: results ?? [] });
});

app.patch('/users/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ role?: string; password?: string; display_name?: string }>().catch(() => null);
  const row = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  if (body?.role && ['admin', 'user'].includes(body.role)) {
    await c.env.DB.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id).run();
  }
  if (body?.password) {
    if (!passwordStrong(body.password)) return c.json({ ok: false, error: 'weak_password' }, 400);
    await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(await hashPassword(body.password), id).run();
    await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
  }
  if (body?.display_name !== undefined) await c.env.DB.prepare('UPDATE users SET display_name = ? WHERE id = ?').bind(clean(body.display_name, 60) || null, id).run();
  return c.json({ ok: true });
});

app.delete('/users/:id', requireAdmin, async (c) => {
  const me = c.get('user') as { id: string };
  const id = c.req.param('id');
  if (id === me.id) return c.json({ ok: false, error: 'cannot_delete_self' }, 400);
  const admins = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").first<{ n: number }>();
  const target = await c.env.DB.prepare("SELECT role FROM users WHERE id = ?").bind(id).first<{ role: string }>();
  if (target?.role === 'admin' && (admins?.n ?? 0) <= 1) return c.json({ ok: false, error: 'last_admin' }, 400);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

app.get('/settings', requireAdmin, async (c) => {
  const s = await getSettings(c.env, [
    'app_name', 'login_username', 'temp_ttl_default', 'max_addresses', 'session_days',
    'sending_provider', 'sending_api_key', 'sending_from_email', 'sending_from_name', 'retention_days',
    'totp_grace_min', 'lock_mode',
  ]);
  return c.json({
    ok: true,
    settings: {
      app_name: s.app_name || 'Cmail',
      login_username: (s.login_username ?? '1') !== '0',
      temp_ttl_default: parseInt(s.temp_ttl_default ?? '24', 10) || 24,
      max_addresses: parseInt(s.max_addresses ?? '50', 10) || 50,
      session_days: parseInt(s.session_days ?? '30', 10) || 30,
      sending_provider: s.sending_provider || 'none',
      sending_api_key_set: !!s.sending_api_key,
      sending_from_email: s.sending_from_email || '',
      sending_from_name: s.sending_from_name || 'Cmail',
      retention_days: parseInt(s.retention_days ?? '0', 10) || 0,
      totp_grace_min: parseInt(s.totp_grace_min ?? '0', 10) || 0,
      lock_mode: s.lock_mode === 'password' ? 'password' : 'totp',
    },
  });
});

app.put('/settings', requireAdmin, async (c) => {
  const body = await c.req.json<Record<string, unknown>>().catch(() => null);
  if (!body) return c.json({ ok: false, error: 'bad_request' }, 400);

  if (body.app_name !== undefined) await setSetting(c.env, 'app_name', clean(String(body.app_name), 40) || 'Cmail');
  if (body.login_username !== undefined) await setSetting(c.env, 'login_username', body.login_username ? '1' : '0');
  if (body.temp_ttl_default !== undefined) await setSetting(c.env, 'temp_ttl_default', String(Math.min(8760, Math.max(1, parseInt(String(body.temp_ttl_default), 10) || 24))));
  if (body.max_addresses !== undefined) await setSetting(c.env, 'max_addresses', String(Math.min(1000, Math.max(1, parseInt(String(body.max_addresses), 10) || 50))));
  if (body.session_days !== undefined) await setSetting(c.env, 'session_days', String(Math.min(365, Math.max(1, parseInt(String(body.session_days), 10) || 30))));
  if (body.retention_days !== undefined) await setSetting(c.env, 'retention_days', String(Math.min(3650, Math.max(0, parseInt(String(body.retention_days), 10) || 0))));
  // re-ask timer for the second factor: minutes after the last verified code
  // during which a fresh password sign-in skips the TOTP step (0 = always ask)
  if (body.totp_grace_min !== undefined) await setSetting(c.env, 'totp_grace_min', String(Math.min(1440, Math.max(0, parseInt(String(body.totp_grace_min), 10) || 0))));
  // the padlock at the top: what it asks for when the owner presses it —
  // the second factor (default, needs 2FA on) or the panel password (works
  // with 2FA off, so the padlock can live on the toolbar either way)
  if (body.lock_mode !== undefined) {
    await setSetting(c.env, 'lock_mode', body.lock_mode === 'password' ? 'password' : 'totp');
  }

  if (body.sending_provider !== undefined) {
    const provider = String(body.sending_provider);
    if (['none', 'brevo', 'resend'].includes(provider)) await setSetting(c.env, 'sending_provider', provider);
  }
  if (body.sending_api_key) await setSetting(c.env, 'sending_api_key', clean(String(body.sending_api_key), 200));
  if (body.sending_from_email !== undefined) await setSetting(c.env, 'sending_from_email', clean(String(body.sending_from_email), 120));
  if (body.sending_from_name !== undefined) await setSetting(c.env, 'sending_from_name', clean(String(body.sending_from_name), 60) || 'Cmail');

  return c.json({ ok: true });
});

app.post('/test-send', requireAdmin, async (c) => {
  const body = await c.req.json<{ to?: string }>().catch(() => null);
  const to = clean(body?.to, 120);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return c.json({ ok: false, error: 'invalid_email' }, 400);
  const res = await testProvider(c.env, to);
  if (!res.ok) return c.json({ ok: false, error: res.error }, 502);
  return c.json({ ok: true });
});

// maintenance: purge everything older than retention now
app.post('/cleanup', requireAdmin, async (c) => {
  const { scheduledCleanup } = await import('../emailin');
  await scheduledCleanup(c.env);
  return c.json({ ok: true });
});

// --------------------------------------------------------------------------
//  Devices & sessions — the admin's remote kill switch. Every signed-in
//  device is listed with its browser/platform/IP, the current one is marked,
//  and any of them (or all the others at once) can be forced offline:
//  the session row is deleted, so its very next request answers 401.
// --------------------------------------------------------------------------
app.get('/sessions', requireAdmin, async (c) => {
  const cur = tokenFrom(c);
  const { results } = await c.env.DB.prepare(
    `SELECT s.token, s.user_id, s.created_at, s.expires_at, s.ua, s.ip, s.share_id, u.username, sl.username AS share_username
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN share_links sl ON sl.id = s.share_id
      WHERE s.expires_at > ? ORDER BY s.created_at DESC LIMIT 100`
  ).bind(now()).all<{ token: string; user_id: string; created_at: number; expires_at: number; ua: string; ip: string; share_id: string | null; username: string; share_username: string | null }>();
  // the raw token never leaves the worker — each row carries a short
  // fingerprint instead, and the current browser is flagged exactly
  const rows = (results ?? []).map((r) => ({
    fingerprint: (r.token.slice(0, 6) + '…'),
    user_id: r.user_id, username: r.share_username ? `${r.username} ⇐ ${r.share_username}` : r.username,
    share: !!r.share_id,
    created_at: r.created_at, expires_at: r.expires_at, ua: r.ua, ip: r.ip,
    current: !!cur && r.token === cur,
  }));
  return c.json({ ok: true, sessions: rows });
});

app.post('/sessions/revoke', requireAdmin, async (c) => {
  const body = await c.req.json<{ created_at?: number; ip?: string; ua?: string }>().catch(() => null);
  if (typeof body?.created_at !== 'number' || !body?.ip) return c.json({ ok: false, error: 'bad_request' }, 400);
  // sessions are identified by (created_at, ip) — a millisecond-precise login
  // moment from one IP; the raw token never travels through the API
  const r = await c.env.DB.prepare('DELETE FROM sessions WHERE created_at = ? AND ip = ?')
    .bind(body.created_at, body.ip).run();
  return c.json({ ok: true, removed: r.meta?.changes ?? 0 });
});

app.post('/sessions/revoke-others', requireAdmin, async (c) => {
  const cur = tokenFrom(c);
  if (!cur) return c.json({ ok: false, error: 'bad_request' }, 400);
  // every session of this account except the browser holding the panel dies
  const r = await c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?')
    .bind((c.get('user') as SessionUser).id, cur).run();
  return c.json({ ok: true, removed: r.meta?.changes ?? 0 });
});

// --------------------------------------------------------------------------
//  Deep health report — the single source the Health tab and the top-of-page
//  alert banners both read. Every check maps to a fix the UI can offer:
//  missing tables get a build button, old columns get a repair button, a
//  silent cron or a stalled mail flow gets named in plain language.
// --------------------------------------------------------------------------
type Issue = { code: string; severity: 'err' | 'warn'; detail?: string };

app.get('/health', requireAdmin, async (c) => {
  const env = c.env;
  const t0 = Date.now();
  const issues: Issue[] = [];

  // ---- 1) D1 binding + connectivity ----
  const db_binding = !!env.DB;
  let connected = false;
  let latency_ms: number | null = null;
  if (env.DB) {
    try {
      await env.DB.prepare('SELECT 1').first();
      connected = true;
      latency_ms = Date.now() - t0;
    } catch { connected = false; }
  }
  if (!db_binding) issues.push({ code: 'db_binding', severity: 'err' });
  else if (!connected) issues.push({ code: 'db_down', severity: 'err' });

  // ---- 2) tables + expected columns ----
  type TableRow = { name: string; exists: boolean; rows: number | null; missing_cols: string[] };
  const tables: TableRow[] = [];
  const extras: string[] = [];
  let missingTables = 0;
  let missingCols = 0;
  if (connected) {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).all<{ name: string }>();
    const existing = new Set((results ?? []).map((r) => r.name));
    // every table answers in parallel — the report arrives in the time of
    // its slowest single query, not the sum of all of them
    const probed = await Promise.all(TABLES.map(async (t) => {
      const exists = existing.has(t.name);
      let rows: number | null = null;
      let missing_cols: string[] = [];
      if (exists) {
        const [cnt, cols] = await Promise.all([
          env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).first<{ n: number }>().catch(() => null),
          env.DB.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>().catch(() => ({ results: [] as { name: string }[] })),
        ]);
        rows = cnt?.n ?? null;
        const have = new Set((cols.results ?? []).map((r) => r.name));
        missing_cols = t.columns.filter((col) => !have.has(col));
      }
      return { name: t.name, exists, rows, missing_cols } as TableRow;
    }));
    for (const r of probed) {
      tables.push(r);
      if (!r.exists) missingTables++;
      missingCols += r.missing_cols.length;
    }
    for (const n of existing) if (!EXPECTED.has(n)) extras.push(n);
  }
  if (missingTables > 0) issues.push({ code: 'tables_missing', severity: 'err', detail: String(missingTables) });
  if (missingCols > 0) issues.push({ code: 'schema_outdated', severity: 'err', detail: String(missingCols) });

  // ---- 3) background cleanup (cron) heartbeat ----
  let cron_last: number | null = null;
  let install_age_h: number | null = null;
  try {
    const s = await getSettings(env, ['last_cron_run']);
    cron_last = s.last_cron_run ? parseInt(s.last_cron_run, 10) : null;
    const first = await env.DB.prepare('SELECT MIN(created_at) AS t FROM users').first<{ t: number | null }>();
    if (first?.t) install_age_h = (now() - first.t) / 3600_000;
  } catch { /* tables may not exist yet */ }
  const cron_age_h = cron_last ? (now() - cron_last) / 3600_000 : null;
  const cron_dead = tables_ok() && install_age_h !== null && install_age_h > 26
    && (cron_last === null || cron_age_h === null || cron_age_h > 26);
  if (cron_dead) issues.push({ code: 'cron_dead', severity: 'warn' });

  // ---- 3b) expired share credentials the cron has not reached yet ----
  // the hourly cleanup deletes expired shares + their sessions; when the cron
  // is missing or has not fired, the leftovers must be named for the admin.
  // A share with a FROZEN countdown is not expired — its clock stands at
  // frozen_at while suspended (0011).
  let expired_shares = 0;
  if (connected) {
    try {
      const r = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM share_links
          WHERE expires_at IS NOT NULL AND (
            (time_frozen = 1 AND frozen_at IS NOT NULL AND expires_at < frozen_at)
            OR ((time_frozen IS NULL OR time_frozen = 0) AND expires_at < ?)
          )`
      ).bind(now()).first<{ n: number }>();
      expired_shares = r?.n ?? 0;
    } catch { /* share tables missing — nothing to count */ }
    if (expired_shares > 0) issues.push({ code: 'expired_shares', severity: 'warn', detail: String(expired_shares) });
  }

  // ---- 4) mail flow ----
  let emails_total = 0, addresses_total = 0, temp_active = 0;
  let last_mail: number | null = null;
  const ready_domains: string[] = [];
  const stuck_domains: { name: string; status: string }[] = [];
  if (connected) {
    try {
      const [em, ad, tp, lm] = await Promise.all([
        env.DB.prepare('SELECT COUNT(*) AS n FROM emails').first<{ n: number }>(),
        env.DB.prepare('SELECT COUNT(*) AS n FROM addresses').first<{ n: number }>(),
        env.DB.prepare("SELECT COUNT(*) AS n FROM addresses WHERE kind='temp' AND expires_at > ?").bind(now()).first<{ n: number }>(),
        env.DB.prepare('SELECT MAX(received_at) AS m FROM emails').first<{ m: number | null }>(),
      ]);
      emails_total = em?.n ?? 0;
      addresses_total = ad?.n ?? 0;
      temp_active = tp?.n ?? 0;
      last_mail = lm?.m ?? null;
    } catch { /* half-migrated db — leave zeros */ }
    try {
      const { results } = await env.DB.prepare('SELECT name, status FROM domains').all<{ name: string; status: string }>();
      for (const d of results ?? []) {
        if (d.status === 'verified' || d.status === 'unverified') ready_domains.push(d.name);
        else stuck_domains.push({ name: d.name, status: d.status });
      }
    } catch { /* domains table missing */ }
  }
  // no mail ever, past the install grace window, while an inbox exists → nudge
  const mail_stalled = ready_domains.length > 0 && addresses_total > 0
    && last_mail === null && install_age_h !== null && install_age_h > 6;
  if (mail_stalled) issues.push({ code: 'mail_stalled', severity: 'warn' });
  if (stuck_domains.length > 0) issues.push({ code: 'domains_stuck', severity: 'warn', detail: String(stuck_domains.length) });

  // ---- 5) sending provider (informational) ----
  let sending = { provider: 'none', ready: false };
  try {
    const s = await getSettings(env, ['sending_provider', 'sending_api_key', 'sending_from_email']);
    const provider = s.sending_provider || 'none';
    sending = { provider, ready: provider !== 'none' && !!s.sending_api_key && !!s.sending_from_email };
  } catch { /* settings table missing */ }

  const status = issues.some((i) => i.severity === 'err') ? 'err' : issues.length ? 'warn' : 'ok';
  return c.json({
    ok: true,
    version: env.APP_VERSION ?? '',
    time: now(),
    status,
    issues,
    db: { binding: db_binding, connected, latency_ms },
    tables,
    extras,
    cron: { last_run: cron_last, age_hours: cron_age_h === null ? null : Math.round(cron_age_h * 10) / 10, dead: cron_dead },
    mail: {
      emails_total, addresses_total, temp_active,
      last_mail, last_mail_age_h: last_mail ? Math.round(((now() - last_mail) / 3600_000) * 10) / 10 : null,
      ready_domains, stuck_domains,
    },
    sending,
  });

  function tables_ok(): boolean { return connected && missingTables === 0; }
});

// one-press repair from the Health panel: recreate missing tables and add
// columns that older installs never got — safe to run any time (every
// statement is IF NOT EXISTS or tolerates a duplicate-column error)
app.post('/health/repair', requireAdmin, async (c) => {
  if (!c.env.DB) return c.json({ ok: false, error: 'db_binding_missing' }, 400);
  const env = c.env;
  const applied: string[] = [];
  const skipped: string[] = [];

  const { results } = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{ name: string }>();
  const existing = new Set((results ?? []).map((r) => r.name));

  for (const t of TABLES) {
    const wholeMissing = !existing.has(t.name);
    if (!wholeMissing && !t.columns.length) continue; // nothing to compare
    let needsHelp = wholeMissing;
    if (!wholeMissing && t.columns.length) {
      try {
        const info = await env.DB.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>();
        const have = new Set((info.results ?? []).map((r) => r.name));
        needsHelp = t.columns.some((col) => !have.has(col));
      } catch { needsHelp = true; }
    }
    if (!needsHelp) continue;
    for (const stmt of t.stmts) {
      try { await env.DB.prepare(stmt.sql).run(); applied.push(stmt.name); }
      catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (stmt.optional || /duplicate column|already exists/i.test(msg)) skipped.push(stmt.name);
        else return c.json({ ok: false, error: 'repair_failed', detail: msg.slice(0, 240), applied, skipped }, 500);
      }
    }
  }
  return c.json({ ok: true, applied: applied.length, skipped: skipped.length });
});

export default app;
