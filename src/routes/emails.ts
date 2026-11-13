// Cmail — emails: list, read, notes, bulk ops, compose/send
import { Hono } from 'hono';
import type { Env, AppEnv, SessionUser } from '../util';
import { uid, now, clean, getSetting } from '../util';
import { requireUser, shareCan } from '../auth';
import { sendViaProvider } from '../emailout';

const app = new Hono<AppEnv>();

// a share guest sees exactly its shared mailbox set and only what its
// permission list allows — these helpers keep that rule in one place.
// since v3.0.0 the set can hold many mailboxes (junction 0010). An EMPTY set
// (the admin unassigned every mailbox) matches nothing — never the owner's
// whole world, which the raw user_id query alone would answer.
function shareScope(u: SessionUser): string[] | null {
  if (!u.share) return null;
  const ids = (u.share.address_ids?.length ? u.share.address_ids : [u.share.address_id]).filter(Boolean);
  return ids; // may be [] — an unassigned guest
}
function shareAddr(u: SessionUser): string | null { return shareScope(u)?.[0] ?? null; }
const inPh = (ids: string[]) => `(${ids.map(() => '?').join(',')})`;
// scope as a WHERE fragment: null = owner (no filter), [] = guest with no
// mailbox left (matches nothing), otherwise the IN list
function scopeSql(scope: string[] | null, col = 'address_id'): string {
  if (scope === null) return '';
  return scope.length ? ` AND ${col} IN ${inPh(scope)}` : ' AND 1=0';
}

const LIST_FIELDS = 'e.id, e.address_id, e.from_name, e.from_addr, e.to_addr, e.subject, e.preview, e.size, e.is_read, e.starred, e.has_note, e.received_at, e.folder_id, e.direction, e.provider, a.address, a.label AS address_label, a.kind AS address_kind';

// list (per user, filters)
app.get('/', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  const q = c.req.query();
  const box = q.box ?? 'inbox'; // inbox | starred | noted | unread
  const search = (q.q ?? '').trim();
  const limit = Math.min(100, Math.max(10, parseInt(q.limit ?? '50', 10)));
  const offset = Math.max(0, parseInt(q.offset ?? '0', 10));

  const where: string[] = ['e.user_id = ?'];
  const binds: unknown[] = [u.id];
  // the guest's world is the shared mailbox set — any other address_id is ignored
  const scope0 = shareScope(u);
  if (scope0 && scope0.length) {
    where.push(`e.address_id IN ${inPh(scope0)}`);
    binds.push(...scope0);
  } else if (scope0) {
    where.push('1=0'); // every mailbox unassigned — an empty honest world
  } else {
    const addressId = q.address_id ?? '';
    if (addressId) { where.push('e.address_id = ?'); binds.push(addressId); }
  }
  if (box === 'starred') where.push('e.starred = 1');
  if (box === 'unread') where.push('e.is_read = 0');
  if (box === 'noted') where.push('e.has_note = 1');
  // box is opt-in — the frontend cuts folders client-side, so the default
  // pull (no box) is All Mail: received and sent together
  if (box === 'sent') where.push("e.direction = 'out'");
  if (search) {
    where.push('(e.subject LIKE ? OR e.from_addr LIKE ? OR e.from_name LIKE ? OR e.preview LIKE ?)');
    const like = `%${search}%`;
    binds.push(like, like, like, like);
  }

  const sql = `SELECT ${LIST_FIELDS} FROM emails e JOIN addresses a ON a.id = e.address_id
     WHERE ${where.join(' AND ')} ORDER BY e.received_at DESC LIMIT ${limit} OFFSET ${offset}`;
  let results: Record<string, unknown>[] | undefined;
  try {
    ({ results } = await c.env.DB.prepare(sql).bind(...binds).all());
  } catch {
    // a database the 0008 migration hasn't reached yet: same list, no direction cut
    const slimFields = LIST_FIELDS.replace(', e.direction, e.provider', '');
    const slimWhere = where.map((w) => w.replace("e.direction = 'out'", '1=1').replace("e.direction != 'out'", '1=1'));
    const slim = `SELECT ${slimFields} FROM emails e JOIN addresses a ON a.id = e.address_id
     WHERE ${slimWhere.join(' AND ')} ORDER BY e.received_at DESC LIMIT ${limit} OFFSET ${offset}`;
    ({ results } = await c.env.DB.prepare(slim).bind(...binds).all());
  }

  const cntSql = `SELECT COUNT(*) AS n FROM emails e WHERE ${where.join(' AND ')}`;
  const total = await c.env.DB.prepare(cntSql).bind(...binds).first<{ n: number }>();

  // a suspended guest (manual suspension, or no mailbox assigned anymore)
  // gets the suspended flag — the shell freezes into the suspended page
  // until the admin unsuspends or re-assigns mailboxes
  const suspended = scope0 ? !!u.share?.suspended : undefined;
  return c.json({ ok: true, emails: results ?? [], total: total?.n ?? 0, limit, offset, ...(suspended !== undefined ? { suspended } : {}) });
});

// stats for dashboard badges
app.get('/stats', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  const scope = shareScope(u);
  const escope = scopeSql(scope);
  const eb = scope && scope.length ? [u.id, ...scope] : [u.id];
  const [total, unread, starred, noted, addresses] = await Promise.all([
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM emails WHERE user_id = ?${escope}`).bind(...eb).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM emails WHERE user_id = ? AND is_read = 0${escope}`).bind(...eb).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM emails WHERE user_id = ? AND starred = 1${escope}`).bind(...eb).first<{ n: number }>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS n FROM emails WHERE user_id = ? AND has_note = 1${escope}`).bind(...eb).first<{ n: number }>(),
    scope
      ? c.env.DB.prepare(`SELECT COUNT(*) AS n FROM addresses WHERE id IN ${inPh(scope)}`).bind(...scope).first<{ n: number }>()
      : c.env.DB.prepare('SELECT COUNT(*) AS n FROM addresses WHERE user_id = ?').bind(u.id).first<{ n: number }>(),
  ]);
  return c.json({
    ok: true,
    stats: {
      total: total?.n ?? 0, unread: unread?.n ?? 0, starred: starred?.n ?? 0,
      noted: noted?.n ?? 0, addresses: addresses?.n ?? 0,
    },
  });
});

// full message (marks as read)
app.get('/:id', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const email = await c.env.DB.prepare(
    `SELECT e.*, a.address, a.label AS address_label FROM emails e JOIN addresses a ON a.id = e.address_id
     WHERE e.id = ? AND e.user_id = ?`
  ).bind(id, u.id).first<Record<string, unknown>>();
  if (!email) return c.json({ ok: false, error: 'not_found' }, 404);
  // a guest opening a letter from outside the shared set gets an honest 404
  const emScope = shareScope(u);
  if (emScope && !emScope.includes(String(email.address_id))) return c.json({ ok: false, error: 'not_found' }, 404);

  const atts = await c.env.DB.prepare(
    'SELECT id, filename, content_type, size, (content_b64 IS NOT NULL) AS available FROM attachments WHERE email_id = ?'
  ).bind(id).all();
  const note = await c.env.DB.prepare('SELECT body, color, pinned, updated_at FROM email_notes WHERE email_id = ?').bind(id).first();

  // the advanced-details panel reads this: a compact header snapshot
  // (path, auth results, ids) captured on delivery / on send
  let headers: { k: string; v: string }[] = [];
  try { headers = JSON.parse(String(email.headers ?? '[]')); } catch { headers = []; }
  delete email.headers;

  if (!email.is_read) await c.env.DB.prepare('UPDATE emails SET is_read = 1 WHERE id = ?').bind(id).run();
  return c.json({ ok: true, email: { ...email, is_read: 1 }, headers, attachments: atts.results ?? [], note: note ?? null });
});

// single field toggles (+ filing a message into one of the account's own folders)
app.patch('/:id', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  const id = c.req.param('id');
  const body = await c.req.json<{ is_read?: boolean; starred?: boolean; folder_id?: string | null }>().catch(() => null);
  const em = await c.env.DB.prepare('SELECT id, address_id FROM emails WHERE id = ? AND user_id = ?').bind(id, u.id)
    .first<{ id: string; address_id: string }>();
  if (!em) return c.json({ ok: false, error: 'not_found' }, 404);
  const emScope = shareScope(u);
  if (emScope && !emScope.includes(em.address_id)) return c.json({ ok: false, error: 'not_found' }, 404);
  if (body?.starred !== undefined && !shareCan(u, 'star')) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (body?.folder_id !== undefined && !shareCan(u, 'archive')) return c.json({ ok: false, error: 'forbidden' }, 403);
  if (body?.is_read !== undefined) await c.env.DB.prepare('UPDATE emails SET is_read = ? WHERE id = ?').bind(body.is_read ? 1 : 0, id).run();
  if (body?.starred !== undefined) await c.env.DB.prepare('UPDATE emails SET starred = ? WHERE id = ?').bind(body.starred ? 1 : 0, id).run();
  if (body?.folder_id !== undefined) {
    if (body.folder_id === null || body.folder_id === '') {
      // back to the plain inbox
      await c.env.DB.prepare('UPDATE emails SET folder_id = NULL WHERE id = ?').bind(id).run();
    } else {
      // the folder must exist, belong to this user AND to the same account —
      // a message never crosses accounts through a folder
      const folder = await c.env.DB.prepare('SELECT id FROM mail_folders WHERE id = ? AND user_id = ? AND address_id = ?')
        .bind(body.folder_id, u.id, em.address_id).first<{ id: string }>();
      if (!folder) return c.json({ ok: false, error: 'invalid_folder' }, 400);
      await c.env.DB.prepare('UPDATE emails SET folder_id = ? WHERE id = ?').bind(folder.id, id).run();
    }
  }
  return c.json({ ok: true });
});

app.delete('/:id', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (!shareCan(u, 'delete')) return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const emScope = shareScope(u);
  if (emScope && !emScope.length) return c.json({ ok: true }); // nothing is theirs to delete
  if (emScope) {
    await c.env.DB.prepare(`DELETE FROM emails WHERE id = ? AND user_id = ? AND address_id IN ${inPh(emScope)}`).bind(id, u.id, ...emScope).run();
  } else {
    await c.env.DB.prepare('DELETE FROM emails WHERE id = ? AND user_id = ?').bind(id, u.id).run();
  }
  return c.json({ ok: true });
});

// bulk actions
app.post('/bulk', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  const body = await c.req.json<{ ids?: string[]; action?: string; folder_id?: string | null }>().catch(() => null);
  const ids = (body?.ids ?? []).slice(0, 500);
  const action = body?.action ?? '';
  if (!ids.length) return c.json({ ok: false, error: 'no_ids' }, 400);
  // the guest's bulk actions stay inside the shared mailbox set — every
  // update carries the address guard, so foreign letters can never be touched
  const gScope = shareScope(u);
  const scope = gScope && !gScope.length ? ' AND 1=0' : (gScope ? ` AND address_id IN ${inPh(gScope)}` : '');
  const sb = gScope && gScope.length ? [...gScope] : [];
  const permNeeded: Record<string, string> = { read: 'read', unread: 'read', star: 'star', unstar: 'star', delete: 'delete', move: 'archive' };
  const perm = permNeeded[action];
  if (perm && !shareCan(u, perm)) return c.json({ ok: false, error: 'forbidden' }, 403);
  const ph = ids.map(() => '?').join(',');
  switch (action) {
    case 'read': await c.env.DB.prepare(`UPDATE emails SET is_read = 1 WHERE user_id = ? AND id IN (${ph})${scope}`).bind(u.id, ...ids, ...sb).run(); break;
    case 'unread': await c.env.DB.prepare(`UPDATE emails SET is_read = 0 WHERE user_id = ? AND id IN (${ph})${scope}`).bind(u.id, ...ids, ...sb).run(); break;
    case 'star': await c.env.DB.prepare(`UPDATE emails SET starred = 1 WHERE user_id = ? AND id IN (${ph})${scope}`).bind(u.id, ...ids, ...sb).run(); break;
    case 'unstar': await c.env.DB.prepare(`UPDATE emails SET starred = 0 WHERE user_id = ? AND id IN (${ph})${scope}`).bind(u.id, ...ids, ...sb).run(); break;
    case 'delete': await c.env.DB.prepare(`DELETE FROM emails WHERE user_id = ? AND id IN (${ph})${scope}`).bind(u.id, ...ids, ...sb).run(); break;
    case 'move': {
      // filing a whole selection into one folder of THIS account —
      // the folder must belong to the caller and to every message's account
      const fid = body?.folder_id ?? null;
      if (!fid) return c.json({ ok: false, error: 'folder_required' }, 400);
      const rows = await c.env.DB.prepare(`SELECT id, address_id FROM emails WHERE user_id = ? AND id IN (${ph})`).bind(u.id, ...ids).all<{ id: string; address_id: string }>();
      const folder = await c.env.DB.prepare('SELECT id, address_id FROM mail_folders WHERE id = ? AND user_id = ?')
        .bind(fid, u.id).first<{ id: string; address_id: string }>();
      if (!folder) return c.json({ ok: false, error: 'invalid_folder' }, 400);
      const match = (rows.results ?? []).filter((r) => r.address_id === folder.address_id && (!gScope || gScope.includes(r.address_id))).map((r) => r.id);
      if (match.length) {
        const mph = match.map(() => '?').join(',');
        await c.env.DB.prepare(`UPDATE emails SET folder_id = ? WHERE user_id = ? AND id IN (${mph})`).bind(folder.id, u.id, ...match).run();
      }
      break;
    }
    default: return c.json({ ok: false, error: 'unknown_action' }, 400);
  }
  return c.json({ ok: true });
});

// ---------- notes (annotations on emails) ----------

app.put('/:id/note', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (!shareCan(u, 'notes')) return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const body = await c.req.json<{ body?: string; color?: string; pinned?: boolean }>().catch(() => null);
  const own = await c.env.DB.prepare('SELECT id, address_id FROM emails WHERE id = ? AND user_id = ?').bind(id, u.id).first<{ id: string; address_id: string }>();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  const ownScope = shareScope(u);
  if (ownScope && !ownScope.includes(own.address_id)) return c.json({ ok: false, error: 'not_found' }, 404);
  const text = typeof body?.body === 'string' ? body.body.slice(0, 10_000) : '';
  const color = ['amber', 'mint', 'sky', 'rose', 'violet'].includes(body?.color ?? '') ? body!.color : 'amber';
  if (!text.trim()) {
    await c.env.DB.prepare('DELETE FROM email_notes WHERE email_id = ?').bind(id).run();
    await c.env.DB.prepare('UPDATE emails SET has_note = 0 WHERE id = ?').bind(id).run();
    return c.json({ ok: true, note: null });
  }
  await c.env.DB.prepare(
    `INSERT INTO email_notes (email_id, user_id, body, color, pinned, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(email_id) DO UPDATE SET body = excluded.body, color = excluded.color, pinned = excluded.pinned, updated_at = excluded.updated_at`
  ).bind(id, u.id, text, color, body?.pinned ? 1 : 0, now()).run();
  await c.env.DB.prepare('UPDATE emails SET has_note = 1 WHERE id = ?').bind(id).run();
  return c.json({ ok: true, note: { email_id: id, body: text, color, pinned: !!body?.pinned, updated_at: now() } });
});

// ---------- attachments ----------

app.get('/attachment/:attId', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  const attId = c.req.param('attId');
  const row = await c.env.DB.prepare(
    `SELECT at.filename, at.content_type, at.content_b64, at.email_id, e.address_id AS address_id FROM attachments at
     JOIN emails e ON e.id = at.email_id WHERE at.id = ? AND e.user_id = ?`
  ).bind(attId, u.id).first<{ filename: string; content_type: string; content_b64: string | null; email_id: string; address_id: string }>();
  if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
  const atScope = shareScope(u);
  if (atScope && !atScope.includes(row.address_id)) return c.json({ ok: false, error: 'not_found' }, 404);
  if (!row.content_b64) return c.json({ ok: false, error: 'attachment_too_large' }, 413);
  const buf = Uint8Array.from(atob(row.content_b64), (ch) => ch.charCodeAt(0));
  return new Response(buf.buffer as ArrayBuffer, {
    headers: {
      'content-type': row.content_type || 'application/octet-stream',
      'content-disposition': `attachment; filename="${(row.filename || 'attachment').replace(/[^\w.\- ]/g, '_')}"`,
    },
  });
});

// ---------- compose / send ----------

app.post('/send', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (!shareCan(u, 'compose')) return c.json({ ok: false, error: 'forbidden' }, 403);
  const body = await c.req.json<{ from_address_id?: string; to?: string; subject?: string; text?: string; html?: string }>().catch(() => null);
  const to = clean(body?.to, 120);
  const subject = clean(body?.subject, 200) || '(no subject)';
  const text = typeof body?.text === 'string' ? body.text.slice(0, 100_000) : '';
  const html = typeof body?.html === 'string' ? body.html.slice(0, 300_000) : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return c.json({ ok: false, error: 'invalid_recipient' }, 400);
  if (!text && !html) return c.json({ ok: false, error: 'empty_body' }, 400);

  // the guest sends AS one of the shared addresses — the from field is not theirs to pick
  const sendScope = shareScope(u);
  if (sendScope && !sendScope.length) return c.json({ ok: false, error: 'forbidden' }, 403);
  const fromId = sendScope ? (body?.from_address_id && sendScope.includes(body.from_address_id) ? body.from_address_id : sendScope[0]) : (body?.from_address_id ?? '');
  const from = await c.env.DB.prepare('SELECT address FROM addresses WHERE id = ? AND user_id = ?')
    .bind(fromId, u.id).first<{ address: string }>();
  if (!from) return c.json({ ok: false, error: 'invalid_sender' }, 400);

  const provider = (await getSetting(c.env, 'sending_provider')) ?? 'none';
  if (provider === 'none') return c.json({ ok: false, error: 'sending_not_configured' }, 409);

  const res = await sendViaProvider(c.env, { to, subject, text, html, replyTo: from.address });
  if (!res.ok) return c.json({ ok: false, error: 'send_failed', detail: res.error }, 502);

  // the message becomes a real row of this account (direction='out') — it
  // opens, searches, files and inspects exactly like received mail, and the
  // dynamic island can point straight at it
  const emailId = uid('eml_');
  const sentHeaders = [
    { k: 'from', v: from.address },
    { k: 'to', v: to },
    { k: 'subject', v: subject },
    { k: 'date', v: new Date().toUTCString() },
    ...(res.id ? [{ k: 'message-id', v: res.id }] : []),
    { k: 'received', v: `by ${provider} for ${from.address}; composed in Cmail` },
  ];
  try {
    await c.env.DB.prepare(
      `INSERT INTO emails (id, address_id, user_id, from_name, from_addr, to_addr, subject, preview, text_body, html_body, size, is_read, received_at, direction, headers, provider)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'out', ?, ?)`
    ).bind(
      emailId, fromId, u.id, from.address, to, subject,
      (typeof body?.text === 'string' ? body.text : '').slice(0, 180) || '(no preview)',
      text.slice(0, 400_000), html.slice(0, 900_000),
      text.length + html.length, now(),
      JSON.stringify(sentHeaders).slice(0, 24_000),
      provider,
    ).run();
  } catch { /* an older schema without direction must never fail a sent mail */ }

  return c.json({ ok: true, id: emailId });
});

export default app;
