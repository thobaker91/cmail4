-- ============================================================================
--  0005 · domain lifecycle & the connect wizard
-- ----------------------------------------------------------------------------
--  What it does:
--    gives `domains` a registration state machine (draft → verifying →
--    verified, with `unverified` as the owner-responsibility skip), the
--    wizard stage kept for resume, and the loop-verification code fields.
--
--  Who should run it:
--    installs created before v2.2.0. Fresh installs skip this file —
--    schema.sql already ships the final shape (and the one-click setup
--    inside the app applies it automatically). Already applied? The
--    tracker skips it; nothing here runs twice by accident.
--  !! CLI ONLY — never paste this file into the Cloudflare D1 Console. !!
--  SQLite has no ADD COLUMN IF NOT EXISTS, so on any database where these
--  columns already exist the ALTER fails — and one failed statement aborts
--  the whole console batch. The wrangler migration tracker runs each file
--  exactly once, which is why this route never hits that wall.
--  Manual install? Paste schema.sql (the merged, idempotent file) instead —
--  or just press the setup button inside the app and skip SQL altogether.
-- ============================================================================
ALTER TABLE domains ADD COLUMN status         TEXT NOT NULL DEFAULT 'verified'; -- legacy rows keep working
ALTER TABLE domains ADD COLUMN stage          INTEGER NOT NULL DEFAULT 3;       -- 1 connect · 2 verify · 3 done
ALTER TABLE domains ADD COLUMN verify_code    TEXT;
ALTER TABLE domains ADD COLUMN verify_expires INTEGER;
