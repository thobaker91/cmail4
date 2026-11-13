// Cmail — authentication: sessions, cookies, rate limiting
import { Context, Next } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, SessionUser, ShareInfo } from './util';
export type { SessionUser };
import { randomToken, now, shareExpired, shareSuspended } from './util';



const SESSION_COOKIE = 'cmail_session';

export async function createSession(env: Env, userId: string, ua?: string, ip?: string, shareId?: string): Promise<string> {
  const token = randomToken(36);
  const days = parseInt((await env.DB.prepare("SELECT value FROM settings WHERE key='session_days'").first<{ value: string }>())?.value ?? '30', 10) || 30;
  await env.DB.prepare(
    'INSERT INTO sessions (token, user_id, share_id, created_at, expires_at, ua, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(token, userId, shareId ?? null, now(), now() + days * 86400_000, (ua ?? '').slice(0, 200), (ip ?? '').slice(0, 64)).run();
  return token;
}

export function setSessionCookie(c: Context, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: true,
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
}

export async function getUserFromToken(env: Env, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.role, u.display_name, u.totp_enabled, s.expires_at, s.share_id,
            sl.username AS share_username, sl.label AS share_label, sl.address_id AS share_address_id,
            sl.perms AS share_perms, sl.expires_at AS share_expires, sl.revoked_at AS share_revoked,
            sl.suspended_at AS share_susp, sl.time_frozen AS share_frozen, sl.frozen_at AS share_frozen_at,
            sl.owner_id AS share_owner, a.address AS share_address, sl.last_seen_at AS share_seen,
            sl.max_devices AS share_maxdev, sl.guest_note AS share_note
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN share_links sl ON sl.id = s.share_id
       LEFT JOIN addresses a ON a.id = sl.address_id
      WHERE s.token = ?`
  ).bind(token).first<SessionUser & {
    expires_at: number; share_id: string | null;
    share_username: string | null; share_label: string | null; share_address_id: string | null;
    share_perms: string | null; share_expires: number | null; share_revoked: number | null;
    share_susp: number | null; share_frozen: number | null; share_frozen_at: number | null;
    share_owner: string | null; share_address: string | null; share_seen: number | null;
    share_maxdev: number | null; share_note: string | null;
    share_addr_ids?: string[]; share_addrs?: string[];
  }>().then(async (r) => {
    if (!r || !r.share_id) return r;
    // the mailbox set lives in the junction (0010) — a database the migration
    // has not reached yet falls back to the primary column alone
    try {
      const jn = await env.DB.prepare(
        `SELECT sa.address_id, a.address FROM share_addresses sa
           JOIN addresses a ON a.id = sa.address_id
          WHERE sa.share_id = ? ORDER BY a.created_at`
      ).bind(r.share_id).all<{ address_id: string; address: string }>();
      if (jn.results?.length) {
        r.share_addr_ids = jn.results.map((x) => x.address_id);
        r.share_addrs = jn.results.map((x) => x.address);
      } else if (r.share_address_id) {
        // junction empty but a primary exists (or the junction is missing):
        // repair the junction silently so the guest keeps seeing their mailbox
        try { await env.DB.prepare('INSERT OR IGNORE INTO share_addresses (share_id, address_id) VALUES (?, ?)').bind(r.share_id, r.share_address_id).run(); } catch { /* pre-0010 database */ }
      }
    } catch { /* pre-0010 database keeps answering with the primary column */ }
    return r;
  });
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
    return null;
  }

  // a share session lives only while its credential does: revoked or expired
  // → the row (and by cascade this session) is gone → 401 → the shell logs
  // the guest out with an honest message instead of a silent dead session.
  // While the admin froze the remaining time, expiry checks run against
  // frozen_at — a frozen share can never time out under the cron.
  if (row.share_id) {
    const flags = { suspended_at: row.share_susp, time_frozen: row.share_frozen, frozen_at: row.share_frozen_at, expires_at: row.share_expires };
    if (!row.share_username || row.share_revoked || shareExpired(flags)) {
      await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
      return null;
    }
    // live audit: “last seen” moves at most once a minute — a heartbeat, not
    // a write per request
    if (!row.share_seen || now() - row.share_seen > 60_000) {
      try { await env.DB.prepare('UPDATE share_links SET last_seen_at = ? WHERE id = ?').bind(now(), row.share_id).run(); } catch { /* never block auth */ }
    }
    const shareAddrIds = row.share_addr_ids ?? [row.share_address_id ?? ''].filter(Boolean);
    const share: ShareInfo = {
      id: row.share_id,
      username: row.share_username,
      label: row.share_label,
      address_id: row.share_addr_ids?.[0] ?? row.share_address_id ?? '',
      address: row.share_addrs?.[0] ?? row.share_address ?? '',
      address_ids: shareAddrIds,
      addresses: row.share_addrs ?? [row.share_address ?? ''].filter(Boolean),
      owner_id: row.share_owner ?? row.id,
      perms: (row.share_perms ?? 'read').split(',').map((p) => p.trim()).filter(Boolean),
      max_devices: Number(row.share_maxdev ?? 0) || 0,
      note: row.share_note ?? null,
      expires_at: row.share_expires,
      suspended: shareSuspended(flags, shareAddrIds),
      time_frozen: !!(row.share_frozen && row.share_frozen_at),
      frozen_at: row.share_frozen && row.share_frozen_at ? Number(row.share_frozen_at) : null,
    };
    return { id: row.id, username: row.share_username, role: 'share', display_name: row.share_label ?? row.share_username, totp_enabled: 0, share };
  }

  return { id: row.id, username: row.username, role: row.role, display_name: row.display_name, totp_enabled: row.totp_enabled };
}

export function tokenFrom(c: Context): string | undefined {
  const cookie = getCookie(c, SESSION_COOKIE);
  if (cookie) return cookie;
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return undefined;
}

// middleware: attach user if any
// (fail-open: a half-configured deployment must not explode here —
//  the diagnostics page / setup wizard handles that path)
export async function attachUser(c: Context, next: Next) {
  let user: SessionUser | null = null;
  try {
    user = await getUserFromToken(c.env as Env, tokenFrom(c));
  } catch { user = null; }
  c.set('user', user);
  await next();
}

// middleware: require authenticated user
export async function requireUser(c: Context, next: Next) {
  const user = c.get('user') as SessionUser | null;
  if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
  await next();
}

// middleware: require admin role
export async function requireAdmin(c: Context, next: Next) {
  const user = c.get('user') as SessionUser | null;
  if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ ok: false, error: 'forbidden' }, 403);
  await next();
}

// middleware: the owner only — a share guest must never reach account-level
// surfaces (password change, 2FA, addresses, vault, folders of other rooms)
export async function requireOwner(c: Context, next: Next) {
  const user = c.get('user') as SessionUser | null;
  if (!user) return c.json({ ok: false, error: 'unauthorized' }, 401);
  if (user.role === 'share') return c.json({ ok: false, error: 'forbidden' }, 403);
  await next();
}

// permission check for share sessions — the owner always passes
export function shareCan(u: SessionUser | null | undefined, perm: string): boolean {
  if (!u) return false;
  if (u.role !== 'share' || !u.share) return true;
  return u.share.perms.includes(perm);
}

export async function destroySession(env: Env, token: string | undefined) {
  if (!token) return;
  await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
}

// ---------- rate limiting (auth endpoints) ----------
// persistent counter in D1, 10 attempts / 10 minutes per ip+route

export async function rateLimit(env: Env, ip: string, route: string, max = 10, windowMs = 10 * 60_000): Promise<boolean> {
  try {
    const key = `${route}:${ip}`;
    const t = now();
    const row = await env.DB!.prepare('SELECT count, window_start FROM auth_attempts WHERE key = ?').bind(key)
      .first<{ count: number; window_start: number }>();
    if (!row || t - row.window_start > windowMs) {
      await env.DB!.prepare(
        'INSERT INTO auth_attempts (key, count, window_start) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = 1, window_start = excluded.window_start'
      ).bind(key, t).run();
      return true;
    }
    if (row.count >= max) return false;
    await env.DB!.prepare('UPDATE auth_attempts SET count = count + 1 WHERE key = ?').bind(key).run();
    return true;
  } catch {
    // auth_attempts not created yet (pre-init) → do not block setup flows
    return true;
  }
}

export async function rateLimitClear(env: Env, ip: string, route: string) {
  try {
    await env.DB!.prepare('DELETE FROM auth_attempts WHERE key = ?').bind(`${route}:${ip}`).run();
  } catch { /* table may not exist yet */ }
}

export function clientIp(c: Context): string {
  return c.req.header('CF-Connecting-IP') || c.req.header('X-Forwarded-For')?.split(',')[0].trim() || '0.0.0.0';
}
