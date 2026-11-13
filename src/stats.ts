// Cmail — denormalized mailbox counters (issue #1, §5).
// Every unread badge / total / starred count the UI shows used to be a live
// COUNT(*) over the emails table — O(total mail), run on every poll cycle.
// A small stats table now travels beside the mail: one row per mailbox,
// updated on the exact mutation points that can move a counter, with the
// hourly cron as a full self-healing reconciliation pass.
//
// Polling becomes O(1): GET /api/ping reads one row per mailbox instead of
// scanning the user's whole mail history.
import type { Env } from './util';

export type MailboxCounters = {
  address_id: string;
  total: number;
  unread: number;
  starred: number;
  noted: number;
  last_mail_at: number | null;
};

// Move a mailbox's counters by a delta. Never throws — a stats glitch must
// never break a real mail action (the cron reconciles every hour anyway).
export async function bumpStats(
  env: Env,
  addressId: string,
  d: { total?: number; unread?: number; starred?: number; noted?: number; lastMailAt?: number | null },
): Promise<void> {
  if (!addressId || (!d.total && !d.unread && !d.starred && !d.noted && d.lastMailAt === undefined)) return;
  try {
    await env.DB.prepare(
      `INSERT INTO mailbox_stats (address_id, total, unread, starred, noted, last_mail_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(address_id) DO UPDATE SET
         total        = MAX(0, mailbox_stats.total + ?),
         unread       = MAX(0, mailbox_stats.unread + ?),
         starred      = MAX(0, mailbox_stats.starred + ?),
         noted        = MAX(0, mailbox_stats.noted + ?),
         last_mail_at = COALESCE(?, mailbox_stats.last_mail_at)`
    ).bind(
      addressId,
      d.total ?? 0, d.unread ?? 0, d.starred ?? 0, d.noted ?? 0,
      d.lastMailAt === undefined ? null : d.lastMailAt,
      d.total ?? 0, d.unread ?? 0, d.starred ?? 0, d.noted ?? 0,
      d.lastMailAt === undefined ? null : d.lastMailAt,
    ).run();
  } catch { /* pre-0009 schema or a hiccup — the cron pass heals it */ }
}

// Recompute counters from the truth. With no addressId: every mailbox of
// every user (the cron's reconciliation pass — one aggregate scan per hour).
// With one: just that mailbox (used right after destructive actions like
// purge, where a delta would need its own scan anyway).
// Addresses without any mail also get a (zero) row, so /api/ping always
// answers with the full account list.
export async function recomputeStats(env: Env, addressId?: string): Promise<void> {
  try {
    const sql = addressId
      ? `INSERT INTO mailbox_stats (address_id, total, unread, starred, noted, last_mail_at)
         SELECT a.id,
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id),
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.is_read = 0 AND e.direction != 'out'),
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.starred = 1),
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.has_note = 1),
           (SELECT MAX(e.received_at) FROM emails e WHERE e.address_id = a.id)
         FROM addresses a WHERE a.id = ?
         ON CONFLICT(address_id) DO UPDATE SET
           total = excluded.total, unread = excluded.unread, starred = excluded.starred,
           noted = excluded.noted, last_mail_at = excluded.last_mail_at`
      : `INSERT INTO mailbox_stats (address_id, total, unread, starred, noted, last_mail_at)
         SELECT a.id,
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id),
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.is_read = 0 AND e.direction != 'out'),
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.starred = 1),
           (SELECT COUNT(*) FROM emails e WHERE e.address_id = a.id AND e.has_note = 1),
           (SELECT MAX(e.received_at) FROM emails e WHERE e.address_id = a.id)
         FROM addresses a
         ON CONFLICT(address_id) DO UPDATE SET
           total = excluded.total, unread = excluded.unread, starred = excluded.starred,
           noted = excluded.noted, last_mail_at = excluded.last_mail_at`;
    await env.DB.prepare(sql).bind(...(addressId ? [addressId] : [])).run();
  } catch { /* pre-0009 schema — old COUNT paths still answer */ }
}

// The O(1) poll payload: one stats row per mailbox + the newest arrival.
export async function pingPayload(env: Env, userId: string) {
  let accounts: MailboxCounters[] = [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT s.address_id, s.total, s.unread, s.starred, s.noted, s.last_mail_at
       FROM mailbox_stats s JOIN addresses a ON a.id = s.address_id
       WHERE a.user_id = ? ORDER BY a.created_at DESC`
    ).bind(userId).all<MailboxCounters>();
    accounts = results ?? [];
  } catch { /* pre-0009 schema */ }

  // newest inbound mail — a covering index (user_id, received_at) makes this
  // a single index seek, not a scan
  let last: { id: string; from_name: string | null; from_addr: string; subject: string | null; received_at: number } | null = null;
  try {
    last = await env.DB.prepare(
      `SELECT id, from_name, from_addr, subject, received_at FROM emails
       WHERE user_id = ? AND direction != 'out' ORDER BY received_at DESC LIMIT 1`
    ).bind(userId).first();
  } catch { /* never block the ping */ }

  const unread = accounts.reduce((n, a) => n + (a.unread || 0), 0);
  return { accounts, unread, last_email: last ?? null };
}
