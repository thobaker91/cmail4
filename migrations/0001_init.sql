-- ============================================================================
--  Cmail migration 0001 — foundation
-- ----------------------------------------------------------------------------
--  Creates the core of the system: account + sessions + rate limiting,
--  domains and inboxes, the mail store with attachments and sticky notes,
--  the 2FA vault, the settings key/value store — plus the first round of
--  indexes for the hot paths (inbox lists, retention sweeps).
--
--  Every statement is IF NOT EXISTS: safe to run more than once.
--  CLI users:  npx wrangler d1 migrations apply cmail-db --remote
--  Fresh installs can skip the chain entirely — schema.sql (or the
--  one-click button on the Setup screen) builds this final shape in one go.
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',        -- admin | user
  display_name  TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_secret   TEXT,                                -- AES-GCM encrypted
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS domains (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  catch_all  INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id    TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label        TEXT,
  kind         TEXT NOT NULL DEFAULT 'permanent',    -- permanent | temp
  expires_at   INTEGER,                              -- temp only
  forward_to   TEXT,
  created_at   INTEGER NOT NULL,
  last_mail_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_addresses_user ON addresses(user_id);

CREATE TABLE IF NOT EXISTS emails (
  id         TEXT PRIMARY KEY,
  address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  from_name  TEXT,
  from_addr  TEXT NOT NULL,
  to_addr    TEXT NOT NULL,
  subject    TEXT,
  preview    TEXT,
  text_body  TEXT,
  html_body  TEXT,
  size       INTEGER NOT NULL DEFAULT 0,
  is_read    INTEGER NOT NULL DEFAULT 0,
  starred    INTEGER NOT NULL DEFAULT 0,
  has_note   INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_emails_addr  ON emails(address_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_user  ON emails(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_expir ON emails(received_at);

CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  email_id     TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  content_b64  TEXT
);
CREATE INDEX IF NOT EXISTS idx_att_email ON attachments(email_id);

CREATE TABLE IF NOT EXISTS email_notes (
  email_id   TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT 'amber',          -- amber | mint | sky | rose | violet
  pinned     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS totp_entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  issuer      TEXT,
  secret_enc  TEXT NOT NULL,                         -- AES-GCM encrypted
  algo        TEXT NOT NULL DEFAULT 'SHA1',          -- SHA1 | SHA256 | SHA512
  digits      INTEGER NOT NULL DEFAULT 6,
  period      INTEGER NOT NULL DEFAULT 30,
  color       TEXT,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_totp_user ON totp_entries(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS auth_attempts (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);
