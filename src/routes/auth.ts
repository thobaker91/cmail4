// Cmail — auth routes: login / 2FA login / me / password / account TOTP
// Single-user ecosystem: one account exists, created on first visit.
import { Hono } from 'hono';
import type { Env, AppEnv, SessionUser } from '../util';
import {
  usernameValid, passwordStrong, hashPassword, verifyPassword, uid, now,
  getSetting, setSetting, sealText, openText, randomToken, shareSuspended, shareExpired,
} from '../util';
import {
  createSession, setSessionCookie, clearSessionCookie, destroySession, tokenFrom,
  requireUser, requireOwner, clientIp, rateLimit, rateLimitClear
} from '../auth';
import { randomSecret, verifyTotp, buildOtpauthUri } from '../totp';
import { renderSVG } from 'uqr';

const app = new Hono<AppEnv>();

// current user
app.get('/me', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  // the lock screen reads the chosen unlock method; guests never see the lock
  let lockMode = 'totp';
  if (u.role !== 'share') {
    lockMode = (await getSetting(c.env, 'lock_mode')) === 'password' ? 'password' : 'totp';
    const unread = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM emails WHERE user_id = ? AND is_read = 0'
    ).bind(u.id).first<{ n: number }>();
    // the newest arrival rides along — the dynamic island announces it without
    // a second round trip
    let last: { id: string; from_name: string | null; from_addr: string; subject: string | null; received_at: number } | null = null;
    try {
      last = await c.env.DB.prepare(
        `SELECT id, from_name, from_addr, subject, received_at FROM emails
         WHERE user_id = ? AND direction != 'out' ORDER BY received_at DESC LIMIT 1`
      ).bind(u.id).first();
    } catch {
      // a database the 0008 migration hasn't reached yet still answers
      try {
        last = await c.env.DB.prepare(
          'SELECT id, from_name, from_addr, subject, received_at FROM emails WHERE user_id = ? ORDER BY received_at DESC LIMIT 1'
        ).bind(u.id).first();
      } catch { /* never block /me */ }
    }
    return c.json({ ok: true, user: u, unread: unread?.n ?? 0, last_email: last ?? null, lock_mode: lockMode });
  }
  // share guest: unread lives inside the shared mailboxes
  const guestAddrIds = (u.share?.address_ids?.length ? u.share.address_ids : [u.share?.address_id ?? '']).filter(Boolean);
  let guestUnread = 0;
  if (guestAddrIds.length) {
    const ph = guestAddrIds.map(() => '?').join(',');
    const unread = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM emails WHERE address_id IN (${ph}) AND is_read = 0`
    ).bind(...guestAddrIds).first<{ n: number }>().catch(() => null);
    guestUnread = unread?.n ?? 0;
  }
  // suspension rides on /me too — a guest mid-session learns about it on its
  // very next boot without waiting for the list endpoint. The flag is already
  // computed per-request inside getUserFromToken: manual suspension by the
  // admin, or no mailbox assigned to the credential anymore.
  return c.json({ ok: true, user: u, unread: guestUnread, lock_mode: null, suspended: !!u.share?.suspended });
});

// step 1: password login → may ask for 2FA
// username may be omitted when the owner disabled username login in settings
app.post('/login', async (c) => {
  const ip = clientIp(c);
  if (!(await rateLimit(c.env, ip, 'login', 10))) return c.json({ ok: false, error: 'rate_limited' }, 429);

  const body = await c.req.json<{ username?: string; password?: string }>().catch(() => null);
  const username = (body?.username ?? '').trim();
  const password = body?.password ?? '';

  const withUsername = (await getSetting(c.env, 'login_username')) !== '0';
  const user = withUsername && username
    ? await c.env.DB.prepare('SELECT id, username, role, password_hash, totp_enabled FROM users WHERE username = ?')
        .bind(username).first<{ id: string; username: string; role: string; password_hash: string; totp_enabled: number }>()
    : await c.env.DB.prepare('SELECT id, username, role, password_hash, totp_enabled FROM users ORDER BY created_at LIMIT 1')
        .first<{ id: string; username: string; role: string; password_hash: string; totp_enabled: number }>();

  if (!user || !(await verifyPassword(password, user.password_hash))) {
    // not the owner — maybe a share guest. The same login form answers both:
    // the credential is looked up in share_links too, and a match opens the
    // shared mailboxes with exactly the permissions the admin handed out
    if (username) {
      const sh = await c.env.DB.prepare(
        'SELECT id, owner_id, username, password_hash, expires_at, revoked_at, max_devices, suspended_at, time_frozen, frozen_at FROM share_links WHERE username = ?'
      ).bind(username).first<{ id: string; owner_id: string; username: string; password_hash: string; expires_at: number | null; revoked_at: number | null; max_devices: number | null; suspended_at: number | null; time_frozen: number | null; frozen_at: number | null }>();
      if (sh && !sh.revoked_at && !shareExpired(sh) && (await verifyPassword(password, sh.password_hash))) {
        // the device cap is enforced at the door: too many live browsers for
        // this credential → the newest is refused, not the oldest kicked
        const maxDevices = Number(sh.max_devices ?? 0) || 0;
        if (maxDevices > 0) {
          const live = await c.env.DB.prepare(
            'SELECT COUNT(*) AS n FROM sessions WHERE share_id = ? AND expires_at > ?'
          ).bind(sh.id, now()).first<{ n: number }>();
          if ((live?.n ?? 0) >= maxDevices) {
            return c.json({ ok: false, error: 'device_limit', max_devices: maxDevices }, 403);
          }
        }
        await rateLimitClear(c.env, ip, 'login');
        const token = await createSession(c.env, sh.owner_id, c.req.header('User-Agent'), ip, sh.id);
        setSessionCookie(c, token);
        // the share context rides along on the login response itself — the
        // shell can paint the banner and the countdown without a /me round trip
        const full = await c.env.DB.prepare(
          'SELECT id, username, label, address_id, perms, expires_at, owner_id, max_devices, guest_note FROM share_links WHERE id = ?'
        ).bind(sh.id).first<{ id: string; username: string; label: string | null; address_id: string; perms: string; expires_at: number | null; owner_id: string; max_devices: number | null; guest_note: string | null }>();
        // the mailbox set: junction first, primary column as the fallback
        let addrIds: string[] = [];
        let addrs: string[] = [];
        try {
          const jn = await c.env.DB.prepare(
            `SELECT sa.address_id, a.address FROM share_addresses sa
               JOIN addresses a ON a.id = sa.address_id
              WHERE sa.share_id = ? ORDER BY a.created_at`
          ).bind(sh.id).all<{ address_id: string; address: string }>();
          if (jn.results?.length) {
            addrIds = jn.results.map((x) => x.address_id);
            addrs = jn.results.map((x) => x.address);
          }
        } catch { /* pre-0010 database */ }
        if (!addrIds.length && full?.address_id) {
          const one = await c.env.DB.prepare('SELECT address FROM addresses WHERE id = ?').bind(full.address_id)
            .first<{ address: string }>().catch(() => null);
          if (one) { addrIds = [full.address_id]; addrs = [one.address]; }
        }
        const share = full ? {
          id: full.id, username: full.username, label: full.label,
          address_id: addrIds[0] ?? full.address_id, address: addrs[0] ?? '',
          address_ids: addrIds, addresses: addrs,
          owner_id: full.owner_id,
          perms: (full.perms ?? 'read').split(',').map((x) => x.trim()).filter(Boolean),
          max_devices: Number(full.max_devices ?? 0) || 0,
          note: full.guest_note ?? null,
          expires_at: full.expires_at,
          suspended: shareSuspended(sh, addrIds),
          time_frozen: !!(sh.time_frozen && sh.frozen_at),
          frozen_at: sh.time_frozen && sh.frozen_at ? Number(sh.frozen_at) : null,
        } : undefined;
        // a suspended share (manual, or no mailbox assigned anymore) freezes
        // at the door: the guest signs in and the frozen page answers — never
        // a broken empty inbox. Assigning mailboxes again (تنظیم مجدد) melts
        // the ice on the guest's next request.
        const suspended = !!share?.suspended;
        return c.json({ ok: true, user: { id: sh.id, username: sh.username, role: 'share', display_name: full?.label ?? sh.username, totp_enabled: 0, share }, suspended });
      }
    }
    return c.json({ ok: false, error: 'invalid_credentials' }, 401);
  }

  await rateLimitClear(c.env, ip, 'login');

  const userOut = () => ({ id: user.id, username: user.username, role: user.role, totp_enabled: user.totp_enabled ? 1 : 0 });

  if (user.totp_enabled) {
    // configurable grace: right after a verified sign-in, re-entering the
    // password within N minutes does not ask for the code again. 0 (default)
    // always asks. The moment of the last verified code lives in settings.
    const graceMin = parseInt((await getSetting(c.env, 'totp_grace_min')) ?? '0', 10) || 0;
    if (graceMin > 0) {
      const last = parseInt((await getSetting(c.env, `totp_last:${user.id}`)) ?? '0', 10);
      if (last && now() - last < graceMin * 60_000) {
        await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run();
        const token = await createSession(c.env, user.id, c.req.header('User-Agent'), ip);
        setSessionCookie(c, token);
        return c.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, totp_enabled: 1 }, totp_skipped: true });
      }
    }
    // short-lived pending token so the client can complete the 2FA step
    const pending = randomToken(24);
    await setSetting(c.env, `pending2fa:${pending}`, `${user.id}.${now() + 5 * 60_000}`);
    return c.json({ ok: true, totp_required: true, pending });
  }

  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run();
  const token = await createSession(c.env, user.id, c.req.header('User-Agent'), ip);
  setSessionCookie(c, token);
  return c.json({ ok: true, user: userOut() });
});

// step 2: complete login with TOTP
app.post('/login/totp', async (c) => {
  const ip = clientIp(c);
  if (!(await rateLimit(c.env, ip, 'totp', 10))) return c.json({ ok: false, error: 'rate_limited' }, 429);

  const body = await c.req.json<{ pending?: string; code?: string }>().catch(() => null);
  const pending = body?.pending ?? '';
  const code = (body?.code ?? '').trim();
  if (!pending || !/^\d{6,8}$/.test(code)) return c.json({ ok: false, error: 'invalid_request' }, 400);

  const val = await getSetting(c.env, `pending2fa:${pending}`);
  if (!val) return c.json({ ok: false, error: 'pending_expired' }, 401);
  const [userId, expStr] = val.split('.');
  if (Number(expStr) < now()) {
    await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`pending2fa:${pending}`).run();
    return c.json({ ok: false, error: 'pending_expired' }, 401);
  }

  const user = await c.env.DB.prepare('SELECT id, username, role, totp_enabled, totp_secret FROM users WHERE id = ?')
    .bind(userId).first<{ id: string; username: string; role: string; totp_enabled: number; totp_secret: string }>();
  if (!user || !user.totp_secret) return c.json({ ok: false, error: 'invalid_request' }, 400);

  const secret = await openText(c.env, user.totp_secret);
  if (!(await verifyTotp(secret, code))) return c.json({ ok: false, error: 'invalid_code' }, 401);

  await c.env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(`pending2fa:${pending}`).run();
  await c.env.DB.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(now(), user.id).run();
  // the verified-code moment feeds the re-ask timer (totp_grace_min)
  await setSetting(c.env, `totp_last:${user.id}`, String(now()));
  const token = await createSession(c.env, user.id, c.req.header('User-Agent'), ip);
  setSessionCookie(c, token);
  return c.json({ ok: true, user: { id: user.id, username: user.username, role: user.role, totp_enabled: 1 } });
});

app.post('/logout', async (c) => {
  await destroySession(c.env, tokenFrom(c));
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// change password (the owner only — a guest never touches the panel password)
app.post('/password', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const body = await c.req.json<{ current?: string; next?: string }>().catch(() => null);
  const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(body?.current ?? '', row.password_hash))) {
    return c.json({ ok: false, error: 'invalid_credentials' }, 401);
  }
  if (!passwordStrong(body?.next ?? '')) return c.json({ ok: false, error: 'weak_password' }, 400);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(await hashPassword(body!.next!), u.id).run();
  return c.json({ ok: true });
});

// --------------------------------------------------------------------------
//  Lock screen — verify the unlock credential WITHOUT creating a session or
//  changing anything. The owner pressed the padlock at the top; the answer
//  is either the second factor (default) or the panel password (the mode
//  chosen in Settings → Security). A verified TOTP code also feeds the
//  re-ask timer, exactly like a sign-in code would.
// --------------------------------------------------------------------------
app.post('/verify-unlock', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (u.role === 'share') return c.json({ ok: false, error: 'forbidden' }, 403);
  const ip = clientIp(c);
  if (!(await rateLimit(c.env, ip, 'unlock', 10))) return c.json({ ok: false, error: 'rate_limited' }, 429);

  const body = await c.req.json<{ mode?: string; code?: string; password?: string }>().catch(() => null);
  const mode = body?.mode === 'password' ? 'password' : 'totp';

  if (mode === 'password') {
    const row = await c.env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first<{ password_hash: string }>();
    if (!row || !(await verifyPassword(body?.password ?? '', row.password_hash))) {
      return c.json({ ok: false, error: 'invalid_credentials' }, 401);
    }
    await rateLimitClear(c.env, ip, 'unlock');
    return c.json({ ok: true });
  }

  const code = (body?.code ?? '').trim();
  if (!/^\d{6,8}$/.test(code)) return c.json({ ok: false, error: 'invalid_code' }, 401);
  const row = await c.env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(u.id).first<{ totp_secret: string | null }>();
  if (!row?.totp_secret) return c.json({ ok: false, error: 'totp_not_enabled' }, 409);
  const secret = await openText(c.env, row.totp_secret);
  if (!(await verifyTotp(secret, code))) return c.json({ ok: false, error: 'invalid_code' }, 401);
  await rateLimitClear(c.env, ip, 'unlock');
  // a verified unlock counts as a verified moment for the grace timer
  await setSetting(c.env, `totp_last:${u.id}`, String(now()));
  return c.json({ ok: true });
});

// ---------- account login-2FA management ----------

// start enabling: returns secret + otpauth uri (not saved until verified)
app.post('/totp/start', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  if (u.totp_enabled) return c.json({ ok: false, error: 'totp_enabled' }, 409);
  const secret = randomSecret();
  const uri = buildOtpauthUri({ secret, issuer: 'Cmail', name: u.username, algo: 'SHA1', digits: 6, period: 30 });
  return c.json({ ok: true, secret, uri });
});

// confirm enabling with a code
app.post('/totp/enable', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const body = await c.req.json<{ secret?: string; code?: string }>().catch(() => null);
  const secret = (body?.secret ?? '').trim();
  const code = (body?.code ?? '').trim();
  if (!secret || !/^\d{6,8}$/.test(code)) return c.json({ ok: false, error: 'invalid_request' }, 400);
  if (!(await verifyTotp(secret, code))) return c.json({ ok: false, error: 'invalid_code' }, 401);
  const sealed = await sealText(c.env, secret);
  await c.env.DB.prepare('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?').bind(sealed, u.id).run();
  // enabling counts as a verified moment — the grace window starts now
  await setSetting(c.env, `totp_last:${u.id}`, String(now()));
  return c.json({ ok: true });
});

// QR svg for a not-yet-saved secret (account 2FA enrollment)
app.post('/totp/qr', requireOwner, async (c) => {
  const body = await c.req.json<{ secret?: string; name?: string }>().catch(() => null);
  const secret = (body?.secret ?? '').trim();
  if (!secret) return c.json({ ok: false, error: 'invalid_request' }, 400);
  const u = c.get('user') as SessionUser;
  const uri = buildOtpauthUri({ secret, issuer: 'Cmail', name: body?.name ?? u.username, algo: 'SHA1', digits: 6, period: 30 });
  const svg = renderSVG(uri, { border: 1 });
  return c.body(svg, 200, { 'content-type': 'image/svg+xml', 'cache-control': 'no-store' });
});

app.post('/totp/disable', requireOwner, async (c) => {
  const u = c.get('user') as SessionUser;
  const body = await c.req.json<{ code?: string }>().catch(() => null);
  const row = await c.env.DB.prepare('SELECT totp_secret FROM users WHERE id = ?').bind(u.id).first<{ totp_secret: string }>();
  if (row?.totp_secret) {
    const secret = await openText(c.env, row.totp_secret);
    if (!(await verifyTotp(secret, (body?.code ?? '').trim()))) return c.json({ ok: false, error: 'invalid_code' }, 401);
  }
  await c.env.DB.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').bind(u.id).run();
  return c.json({ ok: true });
});

// pending2fa cleanup helper is handled by cron via settings scan
export default app;
