-- ============================================================================
--  Cmail migration 0011 — share control: manual suspension + time freeze +
--  viewable credentials
-- ----------------------------------------------------------------------------
--  v3.0.0 r6 turns the share lifecycle fully admin-owned:
--
--    suspended_at  — manual suspension stamp (NULL = not suspended by hand).
--                    The auto rule stays derived: a share with NO mailbox
--                    assigned is suspended too; assigning mailboxes again
--                    (تنظیم مجدد) brings it back with no flag to flip.
--    time_frozen   — 1 = the remaining subscription time stops counting down
--                    while the share is suspended (the admin chooses per
--                    suspension: keep burning or freeze).
--    frozen_at     — the moment the countdown stopped. While frozen, the
--                    effective "now" for every expiry check is frozen_at, so
--                    a frozen share can never expire under the cron. On
--                    unsuspend the frozen span is added back to expires_at.
--    password_enc  — the guest password sealed with AES-GCM (same vault as
--                    TOTP secrets) so the admin can VIEW and REGENERATE the
--                    credential instead of the one-glance-at-create flow.
--
--  CLI users:  npx wrangler d1 migrations apply cmail-db --remote
-- ============================================================================

ALTER TABLE share_links ADD COLUMN suspended_at INTEGER;
ALTER TABLE share_links ADD COLUMN time_frozen INTEGER NOT NULL DEFAULT 0;
ALTER TABLE share_links ADD COLUMN frozen_at INTEGER;
ALTER TABLE share_links ADD COLUMN password_enc TEXT;
