// Cmail — share access, v3.0.0: guest credentials for ANY SET of mailboxes,
// fully owned by the admin. One credential can hold one mailbox or twenty.
// Create (random username/password, shown exactly once), audit (last seen,
// live flag, live browsers), edit (perms + expiry + mailbox set + device cap
// + welcome note), revoke (sessions die the same second), kick, hard-delete.
// r6 adds the full lifecycle controls: manual suspension with an optional
// time freeze, viewable + regenerable credentials, per-device session kill.
import { Hono } from 'hono';
import type { Env, AppEnv, SessionUser } from '../util';
import { uid, now, clean, hashPassword, passwordStrong, usernameValid, sealText, openText,
  shareExpired, shareSuspended } from '../util';
import { requireAdmin } from '../auth';

const app = new Hono<AppEnv>();

const PERMS = ['read', 'star', 'archive', 'delete', 'compose', 'notes'];
const MAX_MAILBOXES = 20;
const MAX_DEVICES_CAP = 10;

function cleanPerms(input: unknown): string {
  const list = Array.isArray(input) ? input : String(input ?? '').split(',');
  const kept = list.map((p) => String(p).trim()).filter((p) => PERMS.includes(p));
  // 'read' is the floor — a share that cannot read shares nothing
  if (!kept.includes('read')) kept.unshift('read');
  return kept.join(',');
}

function cleanMaxDevices(input: unknown): number {
  const v = Math.floor(Number(input ?? 0));
  if (!Number.isFinite(v) || v <= 0) return 0; // 0 = unlimited
  return Math.min(v, MAX_DEVICES_CAP);
}

function cleanNote(input: unknown): string | null {
  const s = clean(input, 240);
  return s || null;
}

// validate the mailbox set: every id must be one of THIS admin's addresses.
// returns the ids in the caller's order, deduped.
async function resolveAddressIds(env: Env, ownerId: string, ids: string[]): Promise<string[]> {
  const wanted: string[] = [];
  for (const id of ids) {
    const v = clean(id, 40);
    if (v && !wanted.includes(v)) wanted.push(v);
    if (wanted.length >= MAX_MAILBOXES) break;
  }
  if (!wanted.length) return [];
  const ph = wanted.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id FROM addresses WHERE user_id = ? AND id IN (${ph})`
  ).bind(ownerId, ...wanted).all<{ id: string }>();
  const ok = new Set((results ?? []).map((r) => r.id));
  return wanted.filter((id) => ok.has(id));
}

// replace the junction rows for one share
async function writeAddressIds(env: Env, shareId: string, ids: string[]): Promise<void> {
  await env.DB.prepare('DELETE FROM share_addresses WHERE share_id = ?').bind(shareId).run();
  for (const addressId of ids) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO share_addresses (share_id, address_id) VALUES (?, ?)'
    ).bind(shareId, addressId).run();
  }
}

// ---------- list (audit) ----------
app.get('/', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const { results } = await c.env.DB.prepare(
    `SELECT sl.id, sl.username, sl.label, sl.perms, sl.expires_at, sl.revoked_at, sl.created_at,
            sl.last_seen_at, sl.max_devices, sl.guest_note, sl.address_id AS primary_id,
            sl.suspended_at, sl.time_frozen, sl.frozen_at, (sl.password_enc IS NOT NULL) AS has_password
       FROM share_links sl
      WHERE sl.owner_id = ?
      ORDER BY sl.created_at DESC LIMIT 200`
  ).bind(u.id).all();
  const t = now();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const shares = ((results ?? []) as any[]).map((r) => {
    const frozen = !!(r.time_frozen && r.frozen_at);
    // effective expiry: a frozen countdown stands still at frozen_at
    const expired = shareExpired({
      suspended_at: r.suspended_at, time_frozen: r.time_frozen, frozen_at: r.frozen_at, expires_at: r.expires_at,
    });
    return {
      ...r,
      active: !r.revoked_at && !expired,
      online: !!r.last_seen_at && t - Number(r.last_seen_at) < 90_000,
      live_sessions: 0,
      address_ids: [r.primary_id].filter(Boolean),
      addresses: [] as string[],
      time_frozen: frozen,
      frozen_at: frozen ? Number(r.frozen_at) : null,
      has_password: !!r.has_password,
    };
  });
  // the mailbox set of every share, one query for the whole page
  const ids = shares.map((s) => String(s.id));
  if (ids.length) {
    const ph = ids.map(() => '?').join(',');
    try {
      const { results: jn } = await c.env.DB.prepare(
        `SELECT sa.share_id, sa.address_id, a.address, a.label
           FROM share_addresses sa JOIN addresses a ON a.id = sa.address_id
          WHERE sa.share_id IN (${ph}) ORDER BY a.created_at`
      ).bind(...ids).all<{ share_id: string; address_id: string; address: string; label: string | null }>();
      const byShare = new Map<string, { address_id: string; address: string; label: string | null }[]>();
      for (const r of jn ?? []) {
        const arr = byShare.get(r.share_id) ?? [];
        arr.push({ address_id: r.address_id, address: r.address, label: r.label });
        byShare.set(r.share_id, arr);
      }
      for (const s of shares) {
        const arr = byShare.get(String(s.id)) ?? [];
        if (arr.length) {
          s.address_ids = arr.map((x) => x.address_id);
          s.addresses = arr.map((x) => x.address);
        }
      }
    } catch { /* pre-0010 database: the primary column still answers */ }
  }
  // how many guest browsers are actually inside right now — the admin sees
  // the takeover, not just the credential
  const counts = await c.env.DB.prepare(
    `SELECT share_id, COUNT(*) AS n FROM sessions WHERE share_id IS NOT NULL AND expires_at > ? GROUP BY share_id`
  ).bind(t).all<{ share_id: string; n: number }>();
  const cmap = new Map((counts.results ?? []).map((r) => [r.share_id, r.n]));
  for (const s of shares) s.live_sessions = cmap.get(String(s.id)) ?? 0;
  // suspension lives here too: manual suspension by the admin, or a share
  // with NO mailbox assigned anymore. The admin sees the chip, the guest
  // sees the frozen page. An inbox merely empty of mail never suspends.
  for (const s of shares) {
    const ids: string[] = s.address_ids ?? [];
    s.suspended = !!s.active && shareSuspended(
      { suspended_at: s.suspended_at, expires_at: s.expires_at }, ids);
  }
  return c.json({ ok: true, shares });
});

// ---------- create ----------
app.post('/', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const body = await c.req.json<{
    address_id?: string; address_ids?: string[]; username?: string; password?: string; label?: string;
    perms?: string[] | string; expires_at?: number | null; max_devices?: number; guest_note?: string;
  }>().catch(() => null);

  // the mailbox set: the array wins, the single field stays for old clients
  const rawIds = Array.isArray(body?.address_ids) && body.address_ids.length
    ? body.address_ids.map(String)
    : [String(body?.address_id ?? '')];
  const addressIds = await resolveAddressIds(c.env, u.id, rawIds);
  if (!addressIds.length) return c.json({ ok: false, error: 'invalid_sender' }, 400);

  const username = clean(body?.username, 32);
  if (!usernameValid(username)) return c.json({ ok: false, error: 'invalid_username' }, 400);
  const dup = await c.env.DB.prepare('SELECT id FROM share_links WHERE username = ?').bind(username).first();
  if (dup) return c.json({ ok: false, error: 'address_taken' }, 409);

  // the password may arrive from the generator or be typed by hand — the
  // same strength bar as the panel itself
  const password = String(body?.password ?? '');
  if (!passwordStrong(password)) return c.json({ ok: false, error: 'weak_password' }, 400);

  let expiresAt: number | null = null;
  if (body?.expires_at != null && Number.isFinite(Number(body.expires_at))) {
    const v = Number(body.expires_at);
    if (v > now()) expiresAt = Math.min(v, now() + 3650 * 86400_000);
  }
  const maxDevices = cleanMaxDevices(body?.max_devices);
  const note = cleanNote(body?.guest_note);

  const id = uid('shr_');
  const primaryId = addressIds[0] ?? '';
  await c.env.DB.prepare(
    `INSERT INTO share_links (id, owner_id, address_id, username, password_hash, password_enc, label, perms,
                              max_devices, guest_note, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, u.id, primaryId, username, await hashPassword(password), await sealText(c.env, password),
    clean(body?.label, 60) || null, cleanPerms(body?.perms), maxDevices, note, expiresAt, now()).run();
  await writeAddressIds(c.env, id, addressIds);

  const addrRows = await c.env.DB.prepare(
    `SELECT address FROM addresses WHERE id IN (${addressIds.map(() => '?').join(',')}) ORDER BY created_at`
  ).bind(...addressIds).all<{ address: string }>();
  return c.json({
    ok: true,
    share: {
      id, username, password,
      address: addrRows.results?.[0]?.address ?? '',
      addresses: (addrRows.results ?? []).map((r) => r.address),
      max_devices: maxDevices, expires_at: expiresAt,
    },
  });
});

// ---------- edit (perms / label / expiry / mailbox set / devices / note) ----------
app.patch('/:id', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id') ?? '';
  const row = await c.env.DB.prepare('SELECT id FROM share_links WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  const body = await c.req.json<{
    perms?: string[] | string; label?: string; expires_at?: number | null; unrevoke?: boolean;
    address_ids?: string[]; max_devices?: number; guest_note?: string | null;
  }>().catch(() => null);

  if (body?.perms !== undefined) {
    await c.env.DB.prepare('UPDATE share_links SET perms = ? WHERE id = ?').bind(cleanPerms(body.perms), id).run();
  }
  if (body?.label !== undefined) {
    await c.env.DB.prepare('UPDATE share_links SET label = ? WHERE id = ?').bind(clean(body.label, 60) || null, id).run();
  }
  if (body?.address_ids !== undefined) {
    const addressIds = await resolveAddressIds(c.env, u.id, Array.isArray(body.address_ids) ? body.address_ids.map(String) : []);
    if (!addressIds.length) return c.json({ ok: false, error: 'invalid_sender' }, 400);
    await writeAddressIds(c.env, id, addressIds);
    // the primary column follows the set so every legacy reader stays honest
    const primaryNext = addressIds[0] ?? '';
    await c.env.DB.prepare('UPDATE share_links SET address_id = ? WHERE id = ?').bind(primaryNext, id).run();
  }
  if (body?.max_devices !== undefined) {
    await c.env.DB.prepare('UPDATE share_links SET max_devices = ? WHERE id = ?').bind(cleanMaxDevices(body.max_devices), id).run();
  }
  if (body?.guest_note !== undefined) {
    await c.env.DB.prepare('UPDATE share_links SET guest_note = ? WHERE id = ?').bind(cleanNote(body.guest_note), id).run();
  }
  if (body?.expires_at !== undefined) {
    let v: number | null = null;
    if (body.expires_at != null && Number.isFinite(Number(body.expires_at)) && Number(body.expires_at) > now()) {
      v = Math.min(Number(body.expires_at), now() + 3650 * 86400_000);
    }
    await c.env.DB.prepare('UPDATE share_links SET expires_at = ?, revoked_at = NULL WHERE id = ?').bind(v, id).run();
  }
  if (body?.unrevoke) {
    await c.env.DB.prepare('UPDATE share_links SET revoked_at = NULL WHERE id = ?').bind(id).run();
  }
  return c.json({ ok: true });
});

// ---------- revoke (soft) — every guest browser dies on its next request ----------
app.post('/:id/revoke', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const r = await c.env.DB.prepare('UPDATE share_links SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL')
    .bind(now(), id, u.id).run();
  if (!r.meta?.changes) return c.json({ ok: false, error: 'not_found' }, 404);
  // the sessions go too — “revoke” means NOW, not “next heartbeat”
  await c.env.DB.prepare('DELETE FROM sessions WHERE share_id = ?').bind(id).run();
  return c.json({ ok: true });
});

// ---------- hard delete — the credential leaves the database ----------
app.delete('/:id', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM share_addresses WHERE share_id = ?').bind(id).run();
  const r = await c.env.DB.prepare('DELETE FROM share_links WHERE id = ? AND owner_id = ?').bind(id, u.id).run();
  if (!r.meta?.changes) return c.json({ ok: false, error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// ---------- kick every live guest browser of one share ----------
app.post('/:id/kick', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const own = await c.env.DB.prepare('SELECT id FROM share_links WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  const r = await c.env.DB.prepare('DELETE FROM sessions WHERE share_id = ?').bind(id).run();
  return c.json({ ok: true, removed: r.meta?.changes ?? 0 });
});

// ---------- devices & sessions of one share — see them, kill them ----------
app.get('/:id/sessions', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const own = await c.env.DB.prepare('SELECT id, username FROM share_links WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  const t = now();
  const { results } = await c.env.DB.prepare(
    `SELECT token, ua, ip, created_at, expires_at FROM sessions
      WHERE share_id = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 50`
  ).bind(id, t).all<{ token: string; ua: string | null; ip: string | null; created_at: number; expires_at: number }>();
  const sessions = (results ?? []).map((s) => ({
    token: s.token,
    ua: s.ua ?? '',
    ip: s.ip ?? '',
    created_at: s.created_at,
    expires_at: s.expires_at,
    left_ms: Math.max(0, Number(s.expires_at) - t),
  }));
  return c.json({ ok: true, username: own.username, sessions, total: sessions.length });
});

// disable ONE device/session — the row dies, that browser is out on its very next request
app.delete('/:id/sessions/:token', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const token = c.req.param('token');
  const own = await c.env.DB.prepare('SELECT id FROM share_links WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  const r = await c.env.DB.prepare('DELETE FROM sessions WHERE share_id = ? AND token = ?').bind(id, token).run();
  return c.json({ ok: true, removed: r.meta?.changes ?? 0 });
});

// ---------- manual suspension — the admin's hand, with a time choice ----------
// freeze_time = true  → the remaining subscription time stands still while
//                       suspended (frozen_at becomes the effective "now" for
//                       every expiry check; the cron can never kill it)
// freeze_time = false → the countdown keeps burning exactly as before
app.post('/:id/suspend', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const own = await c.env.DB.prepare('SELECT id FROM share_links WHERE id = ? AND owner_id = ?').bind(id, u.id).first();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  const body = await c.req.json<{ freeze_time?: boolean }>().catch(() => null);
  const freeze = !!body?.freeze_time;
  await c.env.DB.prepare(
    'UPDATE share_links SET suspended_at = ?, time_frozen = ?, frozen_at = ? WHERE id = ?'
  ).bind(now(), freeze ? 1 : 0, freeze ? now() : null, id).run();
  return c.json({ ok: true, suspended: true, time_frozen: freeze });
});

// unsuspend — a frozen span is given back: expires_at moves forward by the
// time the share spent frozen, then the flags clear and the share is normal
app.post('/:id/unsuspend', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, expires_at, time_frozen, frozen_at FROM share_links WHERE id = ? AND owner_id = ?'
  ).bind(id, u.id).first<{ id: string; expires_at: number | null; time_frozen: number | null; frozen_at: number | null }>();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  let expires = row.expires_at;
  if (row.time_frozen && row.frozen_at && expires) {
    // hand back the frozen span — the time never belonged to the suspension
    expires = expires + Math.max(0, now() - Number(row.frozen_at));
    await c.env.DB.prepare('UPDATE share_links SET expires_at = ? WHERE id = ?').bind(expires, id).run();
  }
  await c.env.DB.prepare(
    'UPDATE share_links SET suspended_at = NULL, time_frozen = 0, frozen_at = NULL WHERE id = ?'
  ).bind(id).run();
  return c.json({ ok: true, suspended: false, expires_at: expires });
});

// ---------- credentials: view + regenerate ----------
// the password was sealed (AES-GCM, same vault as TOTP secrets) at create /
// regenerate time, so the admin can always look it up again — credentials
// created before 0011 answer no_stored_password until regenerated once
app.get('/:id/credential', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT username, password_enc FROM share_links WHERE id = ? AND owner_id = ?'
  ).bind(id, u.id).first<{ username: string; password_enc: string | null }>();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  if (!row.password_enc) return c.json({ ok: false, error: 'no_stored_password' }, 409);
  const password = await openText(c.env, row.password_enc);
  return c.json({ ok: true, username: row.username, password });
});

// regenerate the credential — new username and/or password (random when the
// caller omits them), optionally signing out every live guest browser
app.post('/:id/regenerate', requireAdmin, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const row = await c.env.DB.prepare(
    'SELECT id, username FROM share_links WHERE id = ? AND owner_id = ?'
  ).bind(id, u.id).first<{ id: string; username: string }>();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  const body = await c.req.json<{ username?: string; password?: string; kick?: boolean }>().catch(() => null);

  // username: keep, or take the admin's — or roll a fresh guest-xxxx
  let username = row.username;
  if (body?.username !== undefined && body.username !== '') {
    const wanted = clean(body.username, 32);
    if (!usernameValid(wanted)) return c.json({ ok: false, error: 'invalid_username' }, 400);
    if (wanted.toLowerCase() !== row.username.toLowerCase()) {
      const dup = await c.env.DB.prepare('SELECT id FROM share_links WHERE username = ? AND id != ?').bind(wanted, id).first();
      if (dup) return c.json({ ok: false, error: 'address_taken' }, 409);
    }
    username = wanted;
  }

  // password: keep, take the admin's, or roll a friendly Cm-xxx-xxx-xxx
  let password = String(body?.password ?? '');
  if (!password) {
    const rnd = (n: number) => {
      const pool = 'abcdefghjkmnpqrstuvwxyz23456789';
      const a = new Uint8Array(n);
      crypto.getRandomValues(a);
      return [...a].map((b) => pool[b % pool.length]).join('');
    };
    password = `Cm-${rnd(4)}-${rnd(4)}-${rnd(4)}`;
  }
  if (!passwordStrong(password)) return c.json({ ok: false, error: 'weak_password' }, 400);

  await c.env.DB.prepare(
    'UPDATE share_links SET username = ?, password_hash = ?, password_enc = ? WHERE id = ?'
  ).bind(username, await hashPassword(password), await sealText(c.env, password), id).run();

  let kicked = 0;
  if (body?.kick) {
    const r = await c.env.DB.prepare('DELETE FROM sessions WHERE share_id = ?').bind(id).run();
    kicked = r.meta?.changes ?? 0;
  }
  return c.json({ ok: true, username, password, kicked });
});

export default app;
