-- ============================================================================
--  Cmail migration 0004 — performance indexes for the real query paths
-- ----------------------------------------------------------------------------
--  Covers the queries that run on every page load and every cron tick:
--    · sessions(expires_at)        — the cron's stale-session sweep
--    · auth_attempts(window_start) — sliding-window rate-limit cleanup
--    · addresses(domain_id)        — cascade paths + domain health lookups
--    · addresses(kind, expires_at) — the hourly temporary-inbox expiry sweep
--    · emails(address_id, is_read) — unread badges, computed per inbox
--
--  Idempotent: every statement is IF NOT EXISTS.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_sessions_exp     ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_attempts_window  ON auth_attempts(window_start);
CREATE INDEX IF NOT EXISTS idx_addresses_domain ON addresses(domain_id);
CREATE INDEX IF NOT EXISTS idx_addresses_exp    ON addresses(kind, expires_at);
CREATE INDEX IF NOT EXISTS idx_emails_unread    ON emails(address_id, is_read);
