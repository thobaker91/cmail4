-- 0007 — mail folders: user-managed folders bound to ONE address each,
-- so every mailbox organizes its own mail (like per-account labels).
-- emails.folder_id files a message into a folder; NULL = plain inbox.
-- sort_from holds comma-separated sender fragments — incoming mail whose
-- sender matches one of them files itself (rules never bridge accounts).

CREATE TABLE IF NOT EXISTS mail_folders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  address_id TEXT NOT NULL,
  name TEXT NOT NULL,
  icon TEXT,
  color TEXT,
  sort_from TEXT,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mail_folders_addr ON mail_folders(address_id);
CREATE INDEX IF NOT EXISTS idx_mail_folders_user ON mail_folders(user_id);

ALTER TABLE emails ADD COLUMN folder_id TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_folder ON emails(folder_id);
