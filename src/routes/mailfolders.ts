// Cmail — mail folders: user-managed folders bound to ONE address each.
// Every mailbox organizes its own mail; a folder never bridges two accounts
// (same rule the 2FA vault folders follow). `sort_from` carries comma-
// separated sender fragments — the incoming pipeline files matching mail
// automatically, so a folder can also act as a quiet sorting rule.
import { Hono } from 'hono';
import type { AppEnv, SessionUser } from '../util';
import { uid, now, clean } from '../util';
import { requireUser, shareCan } from '../auth';

const app = new Hono<AppEnv>();

// the guest's mailbox set — shared addresses only, since v3.0.0 a set
function guestScope(u: SessionUser): string[] | null {
  if (!u.share) return null;
  const ids = (u.share.address_ids?.length ? u.share.address_ids : [u.share.address_id]).filter(Boolean);
  return ids.length ? ids : null;
}

const FOLDER_FIELDS = `f.id, f.address_id, f.name, f.icon, f.color, f.sort_from, f.created_at,
  (SELECT COUNT(*) FROM emails e WHERE e.folder_id = f.id) AS count,
  (SELECT COUNT(*) FROM emails e WHERE e.folder_id = f.id AND e.is_read = 0) AS unread`;

// list folders (+ live counts) for one address
app.get('/', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  // the guest's folder list is the shared mailboxes' folders
  const gScope = guestScope(u);
  const qAddr = c.req.query('address_id') ?? '';
  const addressId = gScope
    ? (qAddr && gScope.includes(qAddr) ? qAddr : gScope[0])
    : qAddr;
  if (!addressId) return c.json({ ok: false, error: 'address_required' }, 400);
  const own = await c.env.DB.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?')
    .bind(addressId, u.id).first<{ id: string }>();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT ${FOLDER_FIELDS} FROM mail_folders f WHERE f.address_id = ? ORDER BY f.created_at`
  ).bind(addressId).all();
  return c.json({ ok: true, folders: results ?? [] });
});

// create a folder on one address
app.post('/', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (!shareCan(u, 'archive')) return c.json({ ok: false, error: 'forbidden' }, 403);
  const body = await c.req.json<{ address_id?: string; name?: string; icon?: string; color?: string; sort_from?: string }>().catch(() => null);
  const gScope = guestScope(u);
  const wanted = clean(body?.address_id, 64);
  const addressId = gScope
    ? (wanted && gScope.includes(wanted) ? wanted : gScope[0])
    : wanted;
  const name = clean(body?.name, 40) || 'unnamed';
  if (!addressId) return c.json({ ok: false, error: 'address_required' }, 400);
  const own = await c.env.DB.prepare('SELECT id FROM addresses WHERE id = ? AND user_id = ?')
    .bind(addressId, u.id).first<{ id: string }>();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);

  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM mail_folders WHERE user_id = ?').bind(u.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 40) return c.json({ ok: false, error: 'folder_limit' }, 409);

  const id = uid('mfd_');
  const sortFrom = clean(body?.sort_from, 300) || null;
  await c.env.DB.prepare(
    'INSERT INTO mail_folders (id, user_id, address_id, name, icon, color, sort_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).bind(id, u.id, addressId, name, clean(body?.icon, 40) || null, clean(body?.color, 20) || null, sortFrom, now()).run();
  return c.json({ ok: true, folder: { id, address_id: addressId, name, icon: clean(body?.icon, 40) || null, color: clean(body?.color, 20) || null, sort_from: sortFrom, count: 0, unread: 0 } });
});

// rename / restyle / re-rule a folder
app.patch('/:id', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (!shareCan(u, 'archive')) return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const body = await c.req.json<{ name?: string; icon?: string; color?: string; sort_from?: string }>().catch(() => null);
  const own = await c.env.DB.prepare('SELECT id, address_id FROM mail_folders WHERE id = ? AND user_id = ?').bind(id, u.id).first<{ id: string; address_id: string }>();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  // a guest may restyle only folders of its shared mailboxes
  const gScope2 = guestScope(u);
  if (gScope2 && !gScope2.includes(own.address_id)) return c.json({ ok: false, error: 'not_found' }, 404);
  if (body?.name !== undefined) await c.env.DB.prepare('UPDATE mail_folders SET name = ? WHERE id = ?').bind(clean(body.name, 40) || 'unnamed', id).run();
  if (body?.icon !== undefined) await c.env.DB.prepare('UPDATE mail_folders SET icon = ? WHERE id = ?').bind(clean(body.icon, 40) || null, id).run();
  if (body?.color !== undefined) await c.env.DB.prepare('UPDATE mail_folders SET color = ? WHERE id = ?').bind(clean(body.color, 20) || null, id).run();
  if (body?.sort_from !== undefined) await c.env.DB.prepare('UPDATE mail_folders SET sort_from = ? WHERE id = ?').bind(clean(body.sort_from, 300) || null, id).run();
  return c.json({ ok: true });
});

// delete a folder — its mail falls back to the plain inbox, nothing is lost
app.delete('/:id', requireUser, async (c) => {
  const u = c.get('user') as SessionUser;
  if (!shareCan(u, 'archive')) return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const own = await c.env.DB.prepare('SELECT id, address_id FROM mail_folders WHERE id = ? AND user_id = ?').bind(id, u.id).first<{ id: string; address_id: string }>();
  if (!own) return c.json({ ok: false, error: 'not_found' }, 404);
  // same guard as the rename: the guest stays inside its mailbox set
  const gScope3 = guestScope(u);
  if (gScope3 && !gScope3.includes(own.address_id)) return c.json({ ok: false, error: 'not_found' }, 404);
  await c.env.DB.prepare('UPDATE emails SET folder_id = NULL WHERE folder_id = ?').bind(id).run();
  await c.env.DB.prepare('DELETE FROM mail_folders WHERE id = ?').bind(id).run();
  return c.json({ ok: true });
});

export default app;
