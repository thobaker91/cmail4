// Cmail — incoming email handler (Cloudflare Email Routing → Worker)
// Rule zero: a platform hiccup must never bounce real mail. Every database
// touch below degrades gracefully — an older schema falls back to the
// columns it actually has, a heartbeat failure stays silent.
import PostalMime from 'postal-mime';
import type { Env, } from './util';
import { uid, now, previewOf, randomLocalPart } from './util';

const MAX_HTML = 900_000;      // ~0.9 MB html stored
const MAX_TEXT = 400_000;
const MAX_ATTACHMENT_B64 = 900_000; // stored base64 cap

export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const to = message.to.toLowerCase();
  const [local, domainName] = to.split('@');
  if (!local || !domainName) return;

  const db = env.DB;

  // find domain (with its registration lifecycle). On a database that hasn't
  // run the 2.2 lifecycle migration yet, the wide SELECT would throw and the
  // message would bounce — so fall back to the pre-2.2 column shape and keep
  // delivering exactly like 2.1 did.
  type DomRow = { id: string; catch_all: number; active: number; status?: string | null; verify_code?: string | null; verify_expires?: number | null };
  let domain: DomRow | null = null;
  let legacySchema = false;
  try {
    domain = await db.prepare('SELECT id, catch_all, active, status, verify_code, verify_expires FROM domains WHERE name = ?')
      .bind(domainName).first<DomRow>();
  } catch {
    try {
      domain = await db.prepare('SELECT id, catch_all, active FROM domains WHERE name = ?')
        .bind(domainName).first<DomRow>();
      legacySchema = true; // no lifecycle columns → behave like v2.1
    } catch { domain = null; }
  }

  // ---- connect-wizard loop verification ----
  // while a domain is 'verifying', the only mail it expects is the code mail:
  // any message to <verify_code>@<domain> proves the MX path works, flips the
  // domain to 'verified' and never touches the mail store.
  if (domain && !legacySchema && domain.status === 'verifying' && domain.verify_code
    && local === domain.verify_code
    && (!domain.verify_expires || domain.verify_expires > now())) {
    await db.prepare("UPDATE domains SET status = 'verified', stage = 3, verify_code = NULL, verify_expires = NULL WHERE id = ?")
      .bind(domain.id).run();
    return; // the confirmation itself — nothing to store
  }

  // a domain still inside its wizard holds no mailboxes yet: drop quietly
  // (legacy schemas never enter the wizard, so they pass through)
  if (domain && !legacySchema && (domain.status === 'draft' || domain.status === 'verifying')) return;

  // find address
  let addr = await db.prepare('SELECT id, user_id, expires_at, forward_to, kind FROM addresses WHERE address = ?').bind(to)
    .first<{ id: string; user_id: string; expires_at: number | null; forward_to: string | null; kind: string }>();

  // catch-all: create a temporary inbox on the fly for unknown recipients
  if (!addr && domain && domain.active && domain.catch_all) {
    const owner = await firstAdminId(env);
    if (owner) {
      const ttlHours = parseInt((await db.prepare("SELECT value FROM settings WHERE key='temp_ttl_default'").first<{ value: string }>())?.value ?? '24', 10) || 24;
      // local part may contain tags (user+tag@) — keep full local part as generated address
      let localSafe = local.toLowerCase().replace(/[^a-z0-9._-]/g, '').slice(0, 32);
      if (!localSafe || !/^[a-z0-9]/.test(localSafe)) localSafe = randomLocalPart();
      let full = `${localSafe}@${domainName}`;
      const exists = await db.prepare('SELECT id FROM addresses WHERE address = ?').bind(full).first<{ id: string }>();
      if (exists) {
        addr = await db.prepare('SELECT id, user_id, expires_at, forward_to, kind FROM addresses WHERE address = ?').bind(full)
          .first<{ id: string; user_id: string; expires_at: number | null; forward_to: string | null; kind: string }>();
      } else {
        const id = uid('adr_');
        await db.prepare(
          'INSERT INTO addresses (id, user_id, domain_id, address, kind, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).bind(id, owner, domain.id, full, 'temp', now() + ttlHours * 3600_000, now()).run();
        addr = { id, user_id: owner, expires_at: now() + ttlHours * 3600_000, forward_to: null, kind: 'temp' };
      }
    }
  }

  if (!addr) return; // unknown recipient, drop silently

  // parse
  const raw = new Uint8Array(await new Response(message.raw).arrayBuffer());
  let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
  try {
    parsed = await PostalMime.parse(raw);
  } catch {
    parsed = { subject: '(unparsable message)', text: '', html: '', from: { address: message.from }, attachments: [] } as never;
  }

  const fromName = parsed.from?.name ?? null;
  const fromAddr = parsed.from?.address ?? message.from;
  const subject = parsed.subject ?? '(no subject)';
  const text = (parsed.text ?? '').slice(0, MAX_TEXT);
  const html = (parsed.html ?? '').slice(0, MAX_HTML);
  const preview = previewOf(text || stripHtml(html), 180);

  const emailId = uid('eml_');
  await db.prepare(
    `INSERT INTO emails (id, address_id, user_id, from_name, from_addr, to_addr, subject, preview, text_body, html_body, size, received_at, direction, headers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in', ?)`
  ).bind(
    emailId, addr.id, addr.user_id, fromName, fromAddr, to, subject, preview, text, html,
    raw.length, now(), headerSnapshot(parsed, message)
  ).run();

  // attachments (store small ones inline in D1)
  for (const att of (parsed.attachments ?? []).slice(0, 8)) {
    let bytes: Uint8Array | null = null;
    const c0: unknown = att.content;
    if (c0 instanceof Uint8Array) bytes = c0;
    else if (typeof c0 === 'string') bytes = new TextEncoder().encode(c0);
    else if (c0 instanceof ArrayBuffer) bytes = new Uint8Array(c0);
    const b64 = bytes ? arrToB64(bytes) : null;
    await db.prepare(
      'INSERT INTO attachments (id, email_id, filename, content_type, size, content_b64) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(uid('att_'), emailId, att.filename ?? 'attachment', att.mimeType ?? 'application/octet-stream',
      bytes?.length ?? 0,
      b64 && b64.length <= MAX_ATTACHMENT_B64 ? b64 : null).run();
  }

  await db.prepare('UPDATE addresses SET last_mail_at = ? WHERE id = ?').bind(now(), addr.id).run();

  // auto-file: the account's folders may carry sender rules (comma-separated
  // fragments) — the first match quietly files the message. A database
  // without the folders yet must never bounce real mail over it.
  try {
    const { results: ruled } = await db.prepare(
      'SELECT id, sort_from FROM mail_folders WHERE address_id = ? AND sort_from IS NOT NULL'
    ).bind(addr.id).all<{ id: string; sort_from: string }>();
    if (ruled?.length) {
      const hay = `${fromName ?? ''} ${fromAddr ?? ''}`.toLowerCase();
      for (const f of ruled) {
        const needles = String(f.sort_from ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
        if (needles.some((n) => hay.includes(n))) {
          await db.prepare('UPDATE emails SET folder_id = ? WHERE id = ?').bind(f.id, emailId).run();
          break;
        }
      }
    }
  } catch { /* older schema — plain inbox is fine */ }

  // heartbeat for the health panel ("mail is flowing") — never fail the message over it
  try {
    await db.prepare("INSERT INTO settings (key, value) VALUES ('last_mail_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(now())).run();
  } catch { /* cosmetic only */ }

  // optional forwarding via Email Routing (destination must be verified in CF dashboard)
  const fwd = addr.forward_to;
  if (fwd) {
    try { await message.forward(fwd); } catch { /* destination not verified yet — ignore */ }
  }

  // auto-reply could be added here later
}

// a compact header snapshot for the advanced-details panel: the headers a
// person actually asks about (path, auth results, ids), capped so a mailing
// list monster can never bloat the row
function headerSnapshot(
  parsed: { headers?: { key: string; value: string }[]; messageId?: string; date?: string },
  message: ForwardableEmailMessage,
): string {
  const KEEP = new Set([
    'from', 'to', 'cc', 'subject', 'date', 'message-id', 'reply-to', 'return-path',
    'received', 'authentication-results', 'arc-authentication-results',
    'dkim-signature', 'dkim-filter', 'spf', 'received-spf', 'dmarc',
    'mime-version', 'content-type', 'user-agent', 'x-mailer', 'x-sender',
    'list-unsubscribe', 'list-id', 'delivered-to', 'x-original-to',
  ]);
  const out: { k: string; v: string }[] = [];
  for (const h of parsed.headers ?? []) {
    const k = String(h.key ?? '').toLowerCase().trim();
    if (!k || !KEEP.has(k)) continue;
    const v = String(h.value ?? '').replace(/\s+/g, ' ').trim().slice(0, 900);
    if (v) out.push({ k, v });
    if (out.length >= 60) break;
  }
  if (!out.some((h) => h.k === 'date') && parsed.date) out.push({ k: 'date', v: String(parsed.date) });
  if (!out.some((h) => h.k === 'received')) out.push({ k: 'received', v: `by Cloudflare Email Routing for ${message.to}; ${new Date().toUTCString()}` });
  try { return JSON.stringify(out).slice(0, 24_000); } catch { return '[]'; }
}

function arrToB64(u8: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    s += String.fromCharCode(...u8.subarray(i, i + chunk));
  }
  return btoa(s);
}

function stripHtml(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function firstAdminId(env: Env): Promise<string | null> {
  const row = await env.DB.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY created_at LIMIT 1").first<{ id: string }>();
  return row?.id ?? null;
}

// hourly cleanup: expired temp addresses + retention
export async function scheduledCleanup(env: Env): Promise<void> {
  const t = now();
  // delete emails of expired temp addresses, then addresses themselves
  await env.DB.prepare(
    `DELETE FROM emails WHERE address_id IN (SELECT id FROM addresses WHERE kind='temp' AND expires_at IS NOT NULL AND expires_at < ?)`
  ).bind(t).run();
  await env.DB.prepare(`DELETE FROM addresses WHERE kind='temp' AND expires_at IS NOT NULL AND expires_at < ?`).bind(t).run();

  const days = parseInt((await env.DB.prepare("SELECT value FROM settings WHERE key='retention_days'").first<{ value: string }>())?.value ?? '0', 10);
  if (days > 0) {
    await env.DB.prepare('DELETE FROM emails WHERE received_at < ?').bind(t - days * 86400_000).run();
  }
  // stale sessions
  await env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t).run();
  // expired share credentials leave completely: every live guest session dies,
  // the mailbox junction rows and the link itself leave the database — the
  // credential is unreachable from anywhere after this line (v3.0.0).
  // A share whose countdown the admin FROZE does not burn while suspended:
  // its effective clock stands at frozen_at, so only a frozen_at already past
  // its own expiry can end it (0011).
  try {
    const expired = await env.DB.prepare(
      `SELECT id FROM share_links
        WHERE expires_at IS NOT NULL AND (
          (time_frozen = 1 AND frozen_at IS NOT NULL AND expires_at < frozen_at)
          OR ((time_frozen IS NULL OR time_frozen = 0) AND expires_at < ?)
        )`
    ).bind(t).all<{ id: string }>();
    for (const s of expired.results ?? []) {
      await env.DB.prepare('DELETE FROM sessions WHERE share_id = ?').bind(s.id).run();
      await env.DB.prepare('DELETE FROM share_addresses WHERE share_id = ?').bind(s.id).run().catch(() => { /* pre-0010 */ });
      await env.DB.prepare('DELETE FROM share_links WHERE id = ?').bind(s.id).run();
    }
  } catch { /* a database without share tables yet */ }
  // old rate-limit rows
  await env.DB.prepare('DELETE FROM auth_attempts WHERE window_start < ?').bind(t - 3600_000).run();
  // heartbeat: the health panel shows "background cleanup ran X ago"
  try {
    await env.DB.prepare("INSERT INTO settings (key, value) VALUES ('last_cron_run', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(String(t)).run();
  } catch { /* cosmetic only */ }
}
