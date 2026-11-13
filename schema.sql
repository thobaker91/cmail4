-- ============================================================================
--  Cmail — complete database schema (D1 / SQLite)
-- ----------------------------------------------------------------------------
--  One file. One paste. Fully idempotent:
--    every statement is IF NOT EXISTS, so running it twice never errors.
--
--  Run it from the app itself (Setup screen → "Create tables automatically",
--  which executes this exact file) or by hand:
--    · Cloudflare dashboard → Storage & Databases → D1 → cmail-db → Console
--    · npx wrangler d1 execute cmail-db --remote --file=schema.sql
--
--  Shape: 13 tables · 20 indexes — the final form of every migration
--  (0001 → 0005) merged, so fresh installs skip the chain entirely.
--  Console-safe by design: comments carry no semicolons, every statement
--  is IF NOT EXISTS, and nothing here can ever error on a re-run.
-- ============================================================================

-- ----------------------------------------------------------------------------
--  Identity & access
-- ----------------------------------------------------------------------------

-- The single admin account. Passwords live as PBKDF2-SHA256 strings and
-- the TOTP secret is stored AES-GCM-sealed, never in the clear.
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',        -- admin | user
  display_name  TEXT,
  totp_enabled  INTEGER NOT NULL DEFAULT 0,
  totp_secret   TEXT,                                -- AES-GCM sealed
  created_at    INTEGER NOT NULL,
  last_login_at INTEGER
);

-- Server-side sessions. Small by design: one row per signed-in browser,
-- expired rows are swept by the hourly cron.
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  share_id   TEXT REFERENCES share_links(id) ON DELETE CASCADE,  -- NULL = the owner's own session
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua         TEXT,
  ip         TEXT
);

-- Sliding-window rate-limit counters (per IP + route). Fail-open by design:
-- if the table is missing, sign-in still works.
CREATE TABLE IF NOT EXISTS auth_attempts (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
--  Domains & inboxes
-- ----------------------------------------------------------------------------

-- Every domain routed through Cloudflare Email Routing to this Worker.
-- Lifecycle: draft (wizard in progress) → verifying (awaiting the loop mail)
-- → verified — or unverified (owner skipped the loop knowingly). Legacy rows
-- default to verified, so pre-2.2 installs keep working untouched.
CREATE TABLE IF NOT EXISTS domains (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label          TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  catch_all      INTEGER NOT NULL DEFAULT 1,
  status         TEXT NOT NULL DEFAULT 'verified',  -- draft | verifying | verified | unverified
  stage          INTEGER NOT NULL DEFAULT 3,        -- wizard stage kept for resume: 1 connect · 2 verify · 3 done
  verify_code    TEXT,                              -- local part awaiting the loop mail (verifying only)
  verify_expires INTEGER,                           -- code expiry, ms epoch
  created_at     INTEGER NOT NULL
);

-- The inboxes. permanent addresses live forever, temp ones carry an
-- expires_at stamp the cron enforces. notes is the per-mailbox memo
-- (credentials hints, owner, purpose) shown in the account bar.
CREATE TABLE IF NOT EXISTS addresses (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain_id    TEXT REFERENCES domains(id) ON DELETE CASCADE,
  address      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  label        TEXT,
  kind         TEXT NOT NULL DEFAULT 'permanent',    -- permanent | temp
  expires_at   INTEGER,                              -- temp only
  forward_to   TEXT,
  notes        TEXT NOT NULL DEFAULT '',             -- per-mailbox account notes
  created_at   INTEGER NOT NULL,
  last_mail_at INTEGER
);

-- ----------------------------------------------------------------------------
--  Mail
-- ----------------------------------------------------------------------------

-- Full messages. html_body keeps the sanitized original, preview is the
-- list-line snippet so the list never touches the big columns.
CREATE TABLE IF NOT EXISTS emails (
  id          TEXT PRIMARY KEY,
  address_id  TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL,
  from_name   TEXT,
  from_addr   TEXT NOT NULL,
  to_addr     TEXT NOT NULL,
  subject     TEXT,
  preview     TEXT,
  text_body   TEXT,
  html_body   TEXT,
  size        INTEGER NOT NULL DEFAULT 0,
  is_read     INTEGER NOT NULL DEFAULT 0,
  starred     INTEGER NOT NULL DEFAULT 0,
  has_note    INTEGER NOT NULL DEFAULT 0,
  received_at INTEGER NOT NULL,
  folder_id   TEXT,                                   -- the mail folder this message lives in (NULL = plain inbox)
  direction   TEXT NOT NULL DEFAULT 'in',             -- 'in' received · 'out' sent from this account
  headers     TEXT,                                   -- JSON snapshot of the message headers (advanced details)
  provider    TEXT                                    -- how a sent mail left (brevo / resend)
);

-- Attachments are stored base64 inside the row — one database, no buckets.
CREATE TABLE IF NOT EXISTS attachments (
  id           TEXT PRIMARY KEY,
  email_id     TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
  filename     TEXT,
  content_type TEXT,
  size         INTEGER NOT NULL DEFAULT 0,
  content_b64  TEXT
);

-- Colored sticky notes, one per email at most. has_note on emails mirrors
-- the existence of a row here so list queries never need a join.
CREATE TABLE IF NOT EXISTS email_notes (
  email_id   TEXT PRIMARY KEY REFERENCES emails(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  color      TEXT NOT NULL DEFAULT 'amber',          -- amber | mint | sky | rose | violet
  pinned     INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER
);

-- ----------------------------------------------------------------------------
--  2FA vault
-- ----------------------------------------------------------------------------

-- Authenticator keys, AES-GCM-sealed at rest. folder_id groups them,
-- address_id binds a key to one inbox (its codes show only inside that
-- account), icon/color pick a mark from the built-in glyph library.
CREATE TABLE IF NOT EXISTS totp_entries (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  issuer      TEXT,
  secret_enc  TEXT NOT NULL,                         -- AES-GCM sealed
  algo        TEXT NOT NULL DEFAULT 'SHA1',          -- SHA1 | SHA256 | SHA512
  digits      INTEGER NOT NULL DEFAULT 6,
  period      INTEGER NOT NULL DEFAULT 30,
  color       TEXT,
  icon        TEXT,                                  -- glyph from the built-in mark library
  address_id  TEXT REFERENCES addresses(id) ON DELETE SET NULL,  -- bound mailbox (optional)
  folder_id   TEXT REFERENCES totp_folders(id) ON DELETE SET NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- User-managed vault folders. Every folder belongs to ONE mailbox account —
-- grouping never mixes two accounts' keys. (SQLite resolves foreign keys
-- lazily, so declaration order between the two tables is not a constraint.)
CREATE TABLE IF NOT EXISTS totp_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  address_id TEXT,                                  -- the account this folder belongs to
  name       TEXT NOT NULL,
  icon       TEXT,
  color      TEXT,
  created_at INTEGER NOT NULL
);

-- User-managed mail folders. Every folder belongs to ONE mailbox account —
-- sorting never mixes two accounts' mail. sort_from holds comma-separated
-- sender fragments; incoming mail matching one of them files itself.
CREATE TABLE IF NOT EXISTS mail_folders (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL,
  address_id TEXT NOT NULL,                           -- the account this folder belongs to
  name       TEXT NOT NULL,
  icon       TEXT,
  color      TEXT,
  sort_from  TEXT,
  created_at INTEGER NOT NULL
);

-- ----------------------------------------------------------------------------
--  Share access (sub-account sharing)
-- ----------------------------------------------------------------------------

-- One row per guest credential the admin hands out. Since v3.0.0 a
-- credential can hold SEVERAL mailboxes at once: share_addresses carries the
-- full set, share_links.address_id stays the primary (the one older code
-- paths read). The guest signs in with this username/password at the normal
-- login, lands directly in the shared mailboxes, and every action is gated
-- by the perms list (csv of: read star archive delete compose notes).
-- max_devices caps concurrent signed-in browsers (0 = unlimited) and
-- guest_note is the welcome line the guest sees right after signing in.
-- suspended_at is a MANUAL suspension (admin's hand, optional time freeze);
-- a share with no mailbox assigned stays derived-suspended with no flag.
-- time_frozen/frozen_at stop the subscription countdown while suspended —
-- frozen_at becomes the effective "now" for every expiry check, and the
-- frozen span is added back to expires_at on unsuspend. password_enc keeps
-- the guest password AES-GCM-sealed so the admin can view/regenerate it.
-- Revocation = deleting the row → the guest's very next request answers
-- 401 → auto logout.
CREATE TABLE IF NOT EXISTS share_links (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  address_id    TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  label         TEXT,
  perms         TEXT NOT NULL DEFAULT ('read,star,archive'),
  max_devices   INTEGER NOT NULL DEFAULT 0,
  guest_note    TEXT,
  expires_at    INTEGER,
  revoked_at    INTEGER,
  suspended_at  INTEGER,
  time_frozen   INTEGER NOT NULL DEFAULT 0,
  frozen_at     INTEGER,
  password_enc  TEXT,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER
);

-- The junction: one row per (share, address) pair — the full mailbox set of
-- a credential. share_addresses rows die with their share (CASCADE).
CREATE TABLE IF NOT EXISTS share_addresses (
  share_id   TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  address_id TEXT NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
  PRIMARY KEY (share_id, address_id)
);

-- ----------------------------------------------------------------------------
--  Settings
-- ----------------------------------------------------------------------------

-- Key/value store: sending provider + key, login mode, app secret, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ============================================================================
--  Indexes — one per real query path, nothing speculative:
--    · inbox lists        → emails(address_id, received_at DESC)
--    · cross-account view → emails(user_id, received_at DESC)
--    · unread badges      → emails(address_id, is_read)
--    · session auth       → sessions(user_id) / sessions(expires_at)
--    · cron sweeps        → emails(received_at) · addresses(kind, expires_at)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_user    ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_exp     ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_attempts_window  ON auth_attempts(window_start);
CREATE INDEX IF NOT EXISTS idx_addresses_user   ON addresses(user_id);
CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id);
CREATE INDEX IF NOT EXISTS idx_addresses_exp    ON addresses(kind, expires_at);
CREATE INDEX IF NOT EXISTS idx_emails_addr      ON emails(address_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_user      ON emails(user_id, received_at DESC);
CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(user_id, direction, received_at);
CREATE INDEX IF NOT EXISTS idx_emails_unread    ON emails(address_id, is_read);
CREATE INDEX IF NOT EXISTS idx_emails_expir     ON emails(received_at);
CREATE INDEX IF NOT EXISTS idx_att_email        ON attachments(email_id);
CREATE INDEX IF NOT EXISTS idx_totp_user        ON totp_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_totp_addr        ON totp_entries(address_id);
CREATE INDEX IF NOT EXISTS idx_totp_folder      ON totp_entries(folder_id);
CREATE INDEX IF NOT EXISTS idx_folders_user     ON totp_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_folders_addr     ON totp_folders(address_id);
CREATE INDEX IF NOT EXISTS idx_mailf_addr       ON mail_folders(address_id);
CREATE INDEX IF NOT EXISTS idx_mailf_user       ON mail_folders(user_id);
CREATE INDEX IF NOT EXISTS idx_shares_owner     ON share_links(owner_id);
CREATE INDEX IF NOT EXISTS idx_shares_addr      ON share_links(address_id);
CREATE INDEX IF NOT EXISTS idx_share_addr_addr  ON share_addresses(address_id);
CREATE INDEX IF NOT EXISTS idx_sessions_share   ON sessions(share_id);
CREATE INDEX IF NOT EXISTS idx_emails_folder    ON emails(folder_id);
