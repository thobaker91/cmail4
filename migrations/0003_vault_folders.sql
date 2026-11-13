-- ============================================================================
--  Cmail migration 0003 — vault folders
-- ----------------------------------------------------------------------------
--  Group 2FA keys into user-managed folders: create, rename, delete.
--  Deleting a folder releases its keys (folder_id becomes NULL) —
--  no key is ever lost with the folder.
--  !! CLI ONLY — never paste this file into the Cloudflare D1 Console. !!
--  SQLite has no ADD COLUMN IF NOT EXISTS, so on any database where these
--  columns already exist the ALTER fails — and one failed statement aborts
--  the whole console batch. The wrangler migration tracker runs each file
--  exactly once, which is why this route never hits that wall.
--  Manual install? Paste schema.sql (the merged, idempotent file) instead —
--  or just press the setup button inside the app and skip SQL altogether.
-- ============================================================================

CREATE TABLE IF NOT EXISTS totp_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  created_at INTEGER NOT NULL
);
ALTER TABLE totp_entries ADD COLUMN folder_id TEXT REFERENCES totp_folders(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_totp_folder ON totp_entries(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_user ON totp_folders(user_id);
