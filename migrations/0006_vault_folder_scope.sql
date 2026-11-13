-- ============================================================================
--  Cmail migration 0006 — vault folders scoped per mailbox account
-- ----------------------------------------------------------------------------
--  Folders stop being global: every totp_folders row now carries the
--  address_id of the account it belongs to, so the keys of one account can
--  never mix with the folders of another.
--  Legacy folders (address_id NULL) keep working — the UI treats them as
--  belonging to the account whose keys they already hold, and the vault
--  offers to adopt them on first save.
--  !! CLI ONLY — never paste this file into the Cloudflare D1 Console. !!
--  SQLite has no ADD COLUMN IF NOT EXISTS, so on any database where the
--  column already exists the ALTER fails — and one failed statement aborts
--  the whole console batch. The wrangler migration tracker runs each file
--  exactly once, which is why this route never hits that wall.
--  Manual install? Paste schema.sql (the merged, idempotent file) instead —
--  or just press the setup button inside the app and skip SQL altogether.
-- ============================================================================

ALTER TABLE totp_folders ADD COLUMN address_id TEXT;
CREATE INDEX IF NOT EXISTS idx_folders_addr ON totp_folders(address_id);
