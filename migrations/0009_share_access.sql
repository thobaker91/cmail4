-- ============================================================================
--  Cmail migration 0009 — share access (sub-account sharing)
-- ----------------------------------------------------------------------------
--  share_links: one row per guest credential the admin hands out for ONE
--  address. The guest signs in with its own username/password at the normal
--  login, lands directly in that mailbox, and every action is gated by the
--  perms list (csv of: read star archive delete compose notes).
--  Revocation = deleting the row (DB level) → the very next API call of the
--  guest answers 401 → the shell logs them out automatically.
--
--  sessions.share_id: marks a session as a share session (NULL = the owner).
--  user_id stays the OWNER's id, so every existing owner-scoped query keeps
--  working and the FK on sessions.user_id stays valid.
--
--  CLI users:  npx wrangler d1 migrations apply cmail-db --remote
-- ============================================================================

CREATE TABLE IF NOT EXISTS share_links (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id    TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  label         TEXT,
  perms         TEXT NOT NULL DEFAULT ('read,star,archive'),
  expires_at    INTEGER,
  revoked_at    INTEGER,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

ALTER TABLE sessions ADD COLUMN share_id TEXT;

CREATE INDEX IF NOT EXISTS idx_shares_owner ON share_links(owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_addr  ON share_links(address_id);
CREATE INDEX IF NOT EXISTS idx_sessions_share ON sessions(share_id);
