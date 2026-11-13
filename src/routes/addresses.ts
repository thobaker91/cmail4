// Cmail — mailbox addresses (permanent + temporary) & domains
import { Hono } from 'hono';
import type { Env, AppEnv, SessionUser } from '../util';
import {
  uid, now, clean, RE_LOCAL_PART, RE_DOMAIN, randomLocalPart, getSetting,
} from '../util';
import { requireUser, requireOwner, requireAdmin } from '../auth';

const app = new Hono<AppEnv>();

// ---------- domains ----------

app.get('/domains', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const admin = u.role === 'admin';
  const { results } = admin
    ? await c.env.DB.prepare('SELECT * FROM domains ORDER BY created_at DESC').all<{ id: string; name: string; label: string | null; active: number; catch_all: number; created_at: number }>()
    // members only ever see domains that finished registration — drafts and
    // verifying ones are the admin's construction site
    : await c.env.DB.prepare("SELECT id, name, label FROM domains WHERE active = 1 AND status IN ('verified', 'unverified') ORDER BY created_at").all<{ id: string; name: string; label: string | null }>();
  const counts = await c.env.DB.prepare(
    `SELECT d.id, COUNT(a.id) AS n FROM domains d LEFT JOIN addresses a ON a.domain_id = d.id GROUP BY d.id`
  ).all<{ id: string; n: number }>();
  const countMap = new Map((counts.results ?? []).map((r) => [r.id, r.n]));
  // setup health: when the last inbound mail landed on each domain (null = nothing ever arrived)
  const lasts = await c.env.DB.prepare(
    `SELECT d.id AS id, MAX(e.received_at) AS last_mail
     FROM domains d
     LEFT JOIN addresses a ON a.domain_id = d.id
     LEFT JOIN emails e ON e.address_id = a.id
     GROUP BY d.id`
  ).all<{ id: string; last_mail: number | null }>();
  const lastMap = new Map((lasts.results ?? []).map((r) => [r.id, r.last_mail]));
  return c.json({ ok: true, domains: (results ?? []).map((d) => ({ ...d, address_count: countMap.get(d.id) ?? 0, last_mail: lastMap.get(d.id) ?? null })) });
});

app.post('/domains', requireAdmin, async (c) => {
  const body = await c.req.json<{ name?: string; label?: string; catch_all?: boolean }>().catch(() => null);
  const name = (body?.name ?? '').toLowerCase().trim();
  if (!RE_DOMAIN.test(name)) return c.json({ ok: false, error: 'invalid_domain' }, 400);
  const exists = await c.env.DB.prepare('SELECT id FROM domains WHERE name = ?').bind(name).first();
  if (exists) return c.json({ ok: false, error: 'domain_exists' }, 409);
  const id = uid('dom_');
  // every domain enters as a draft at stage 1 — the connect wizard unlocks it
  await c.env.DB.prepare('INSERT INTO domains (id, name, label, catch_all, status, stage, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, name, clean(body?.label, 80) || null, body?.catch_all === false ? 0 : 1, 'draft', 1, now()).run();
  return c.json({ ok: true, domain: { id, name, status: 'draft', stage: 1 } });
});

// lightweight poll for the verification loop — the wizard hits this every few
// seconds while waiting for the code mail to arrive
app.get('/domains/:id/verify', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const d = await c.env.DB.prepare('SELECT id, name, status, stage, verify_code, verify_expires FROM domains WHERE id = ?')
    .bind(id).first<{ id: string; name: string; status: string; stage: number; verify_code: string | null; verify_expires: number | null }>();
  if (!d) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({
    ok: true,
    domain: {
      id: d.id, name: d.name, status: d.status, stage: d.stage,
      verify_code: d.status === 'verifying' ? d.verify_code : null,
      verify_expires: d.verify_expires,
      code_expired: !!(d.verify_expires && d.verify_expires < now()),
      verify_address: d.status === 'verifying' && d.verify_code ? `${d.verify_code}@${d.name}` : null,
    },
  });
});

// the connect-wizard state machine:
//   draft(stage 1) → connect → verifying(stage 2) → mail lands → verified(3)
//                                     ├→ skip  → unverified(3)  owner-responsibility
//                                     └→ draft → draft(stage 2) saved for later
app.post('/domains/:id/wizard', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ action?: string; confirm?: boolean }>().catch(() => null);
  const d = await c.env.DB.prepare('SELECT id, name, status, stage, verify_code, verify_expires FROM domains WHERE id = ?')
    .bind(id).first<{ id: string; name: string; status: string; stage: number; verify_code: string | null; verify_expires: number | null }>();
  if (!d) return c.json({ ok: false, error: 'not_found' }, 404);
  if (d.status === 'verified') return c.json({ ok: false, error: 'already_verified' }, 400);

  const action = body?.action ?? '';

  if (action === 'connect') {
    // "I connected the domain" (or resuming/resending) — arm a fresh loop code
    const code = 'cm-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
    const expires = now() + 24 * 3600_000;
    await c.env.DB.prepare("UPDATE domains SET status = 'verifying', stage = 2, verify_code = ?, verify_expires = ? WHERE id = ?")
      .bind(code, expires, id).run();
    return c.json({ ok: true, status: 'verifying', stage: 2, verify_code: code, verify_expires: expires, verify_address: `${code}@${d.name}` });
  }

  if (action === 'skip') {
    if (!body?.confirm) return c.json({ ok: false, error: 'confirm_required' }, 400);
    await c.env.DB.prepare("UPDATE domains SET status = 'unverified', stage = 3, verify_code = NULL, verify_expires = NULL WHERE id = ?")
      .bind(id).run();
    return c.json({ ok: true, status: 'unverified', stage: 3 });
  }

  if (action === 'draft') {
    // save progress and walk away — stage stays so resume opens the same step
    await c.env.DB.prepare("UPDATE domains SET status = 'draft' WHERE id = ?").bind(id).run();
    return c.json({ ok: true, status: 'draft', stage: d.stage });
  }

  if (action === 'resume') {
    if (d.stage >= 2) {
      const alive = d.verify_code && d.verify_expires && d.verify_expires > now();
      if (alive) {
        await c.env.DB.prepare("UPDATE domains SET status = 'verifying' WHERE id = ?").bind(id).run();
        return c.json({ ok: true, status: 'verifying', stage: 2, verify_code: d.verify_code, verify_expires: d.verify_expires, verify_address: `${d.verify_code}@${d.name}` });
      }
      const code = 'cm-' + crypto.randomUUID().replace(/-/g, '').slice(0, 8);
      const expires = now() + 24 * 3600_000;
      await c.env.DB.prepare("UPDATE domains SET status = 'verifying', verify_code = ?, verify_expires = ? WHERE id = ?")
        .bind(code, expires, id).run();
      return c.json({ ok: true, status: 'verifying', stage: 2, verify_code: code, verify_expires: expires, verify_address: `${code}@${d.name}` });
    }
    return c.json({ ok: true, status: 'draft', stage: d.stage }); // still at the connect guide
  }

  return c.json({ ok: false, error: 'bad_action' }, 400);
});

app.patch('/domains/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ label?: string; active?: boolean; catch_all?: boolean }>().catch(() => null);
  const dom = await c.env.DB.prepare('SELECT id FROM domains WHERE id = ?').bind(id).first();
  if (!dom) return c.json({ ok: false, error: 'not_found' }, 404);
  if (body?.label !== undefined) await c.env.DB.prepare('UPDATE domains SET label = ? WHERE id = ?').bind(clean(body.label, 80) || null, id).run();
  if (body?.active !== undefined) await c.env.DB.prepare('UPDATE domains SET active = ? WHERE id = ?').bind(body.active ? 1 : 0, id).run();
  if (body?.catch_all !== undefined) await c.env.DB.prepare('UPDATE domains SET catch_all = ? WHERE id = ?').bind(body.catch_all ? 1 : 0, id).run();
  return c.json({ ok: true });
});

app.delete('/domains/:id', requireAdmin, async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM domains WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

// live DNS reality-check, straight from the resolver (DNS-over-HTTPS).
// MX answers "can this domain receive mail", TXT answers "is SPF published".
// The worker does the lookup — the browser never leaves our origin (CSP-safe).
app.get('/domains/:id/dns-check', requireAdmin, async (c) => {
  const id = c.req.param('id');
  const dom = await c.env.DB.prepare('SELECT id, name FROM domains WHERE id = ?').bind(id)
    .first<{ id: string; name: string }>();
  if (!dom) return c.json({ ok: false, error: 'not_found' }, 404);

  const doh = async (type: string): Promise<{ Status: number; Answer?: { name: string; type: number; data: string }[] }> => {
    const res = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(dom!.name)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
    });
    if (!res.ok) throw new Error(`dns_${res.status}`);
    return res.json();
  };

  try {
    const [mx, txt] = await Promise.all([doh('MX'), doh('TXT')]);
    const mxRecords = (mx.Answer ?? []).filter((a) => a.type === 15).map((a) => a.data.replace(/^\d+\s+/, ''));
    const txtRecords = (txt.Answer ?? []).filter((a) => a.type === 16).map((a) => a.data.replace(/^"|"$/g, ''));
    const cfMx = mxRecords.some((r) => /\.mx\.cloudflare\.net\.?$/i.test(r) || /mx\.cloudflare\.net/i.test(r));
    const spf = txtRecords.find((r) => /^v=spf1/i.test(r.trim())) ?? null;
    const spfCf = !!spf && /_spf\.mx\.cloudflare\.net/i.test(spf);
    return c.json({
      ok: true,
      check: {
        domain: dom.name,
        mx_ok: mxRecords.length > 0,
        mx_cloudflare: cfMx,
        mx_records: mxRecords.slice(0, 6),
        spf_ok: !!spf,
        spf_cloudflare: spfCf,
        spf_record: spf,
        checked_at: now(),
      },
    });
  } catch (e) {
    return c.json({ ok: false, error: 'dns_check_failed', detail: String((e as Error)?.message ?? e).slice(0, 120) }, 502);
  }
});

// ---------- addresses ----------

app.get('/', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  // a share guest owns the shared mailbox SET — their list is those rows
  const guestIds = u.share
    ? (u.share.address_ids?.length ? u.share.address_ids : [u.share.address_id]).filter(Boolean)
    : [];
  const { results } = guestIds.length
    ? await c.env.DB.prepare(
      `SELECT a.id, a.address, a.label, a.kind, a.expires_at, a.forward_to, a.notes, a.created_at, a.last_mail_at, d.name AS domain,
         (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.is_read = 0) AS unread,
         (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id) AS total
       FROM addresses a LEFT JOIN domains d ON d.id = a.domain_id
       WHERE a.id IN (${guestIds.map(() => '?').join(',')}) ORDER BY a.created_at DESC`
    ).bind(...guestIds).all()
    : await c.env.DB.prepare(
      `SELECT a.id, a.address, a.label, a.kind, a.expires_at, a.forward_to, a.notes, a.created_at, a.last_mail_at, d.name AS domain,
         (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.is_read = 0) AS unread,
         (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id) AS total
       FROM addresses a LEFT JOIN domains d ON d.id = a.domain_id
       WHERE a.user_id = ? ORDER BY a.created_at DESC`
    ).bind(u.id).all();
  return c.json({ ok: true, addresses: results ?? [] });
});

app.post('/', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const body = await c.req.json<{ local?: string; domain?: string; kind?: string; ttl_hours?: number; label?: string; notes?: string }>().catch(() => null);

  const kind = body?.kind === 'temp' ? 'temp' : 'permanent';
  const domainName = (body?.domain ?? '').toLowerCase().trim();
  const domain = await c.env.DB.prepare('SELECT id, name, active, status FROM domains WHERE name = ?').bind(domainName)
    .first<{ id: string; name: string; active: number; status: string }>();
  if (!domain || !domain.active) return c.json({ ok: false, error: 'invalid_domain' }, 400);
  // a domain still inside its registration wizard cannot hold mailboxes —
  // 'unverified' (skipped knowingly) is the one exception
  if (domain.status !== 'verified' && domain.status !== 'unverified') {
    return c.json({ ok: false, error: 'domain_not_ready', status: domain.status }, 403);
  }

  let local = (body?.local ?? '').toLowerCase().trim();
  if (local === '__random__' || !local) local = randomLocalPart();
  if (!RE_LOCAL_PART.test(local)) return c.json({ ok: false, error: 'invalid_local_part' }, 400);

  // address cap per user
  const cap = parseInt((await getSetting(c.env, 'max_addresses')) ?? '50', 10) || 50;
  const cnt = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?').bind(u.id).first<{ n: number }>();
  if ((cnt?.n ?? 0) >= cap) return c.json({ ok: false, error: 'address_limit' }, 409);

  const address = `${local}@${domain.name}`;
  const exists = await c.env.DB.prepare('SELECT id FROM addresses WHERE address = ?').bind(address).first();
  if (exists) return c.json({ ok: false, error: 'address_taken' }, 409);

  let expiresAt: number | null = null;
  if (kind === 'temp') {
    const ttl = Math.min(8760, Math.max(1, body?.ttl_hours ?? (parseInt((await getSetting(c.env, 'temp_ttl_default')) ?? '24', 10) || 24)));
    expiresAt = now() + ttl * 3600_000;
  }

  const id = uid('adr_');
  await c.env.DB.prepare(
    'INSERT INTO addresses (id, user_id, domain_id, address, label, notes, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, u.id, domain.id, address, clean(body?.label, 80) || null, clean(body?.notes, 4000) || '', kind, expiresAt, now()).run();

  return c.json({ ok: true, address: { id, address, kind, expires_at: expiresAt, label: clean(body?.label, 80) || null } });
});

app.patch('/:id', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const addr = await c.env.DB.prepare('SELECT id, user_id, kind, expires_at FROM addresses WHERE id = ? AND user_id = ?')
    .bind(id, u.id).first<{ id: string; user_id: string; kind: string; expires_at: number | null }>();
  if (!addr) return c.json({ ok: false, error: 'not_found' }, 404);

  const body = await c.req.json<{ label?: string; forward_to?: string; extend_hours?: number; notes?: string }>().catch(() => null);
  if (body?.label !== undefined) await c.env.DB.prepare('UPDATE addresses SET label = ? WHERE id = ?').bind(clean(body.label, 80) || null, id).run();
  if (body?.notes !== undefined) await c.env.DB.prepare('UPDATE addresses SET notes = ? WHERE id = ?').bind(clean(body.notes, 4000) ?? '', id).run();

  if (body?.forward_to !== undefined) {
    const fwd = clean(body.forward_to, 120);
    if (fwd && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fwd)) return c.json({ ok: false, error: 'invalid_email' }, 400);
    await c.env.DB.prepare('UPDATE addresses SET forward_to = ? WHERE id = ?').bind(fwd || null, id).run();
  }

  if (body?.extend_hours && addr.kind === 'temp') {
    const base = Math.max(now(), addr.expires_at ?? now());
    const hours = Math.min(8760, Math.max(1, body.extend_hours));
    await c.env.DB.prepare('UPDATE addresses SET expires_at = ? WHERE id = ?').bind(base + hours * 3600_000, id).run();
  }
  return c.json({ ok: true });
});

// delete an address — its emails cascade, its 2FA codes die with it, its
// share junction rows cascade: exactly what the delete confirm promises
app.delete('/:id', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const own = await c.env.DB.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?').bind(id, u.id).first();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  // bound vault codes are explicit (their FK is SET NULL, not CASCADE)
  await c.env.DB.prepare('DELETE FROM totp_entries WHERE address_id = ?').bind(id).run().catch(() => { /* older database */ });
  await c.env.DB.prepare('DELETE FROM addresses WHERE id = ? AND user_id = ?').bind(id, u.id).run();
  return c.json({ ok: true });
});

// empty an inbox
app.post('/:id/purge', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const addr = await c.env.DB.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?').bind(id, u.id).first();
  if (!addr) return c.json({ ok: false, error: 'not_found' }, 404);
  await c.env.DB.prepare('DELETE FROM emails WHERE address_id = ?').bind(id).run();
  return c.json({ ok: true });
});

export default app;
