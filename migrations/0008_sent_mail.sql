-- 0008 — real sent mail.
-- Outgoing messages become rows of their own (direction='out') so they can be
-- opened, searched and inspected exactly like received mail, and every
-- message keeps a header snapshot for the advanced-details panel.

ALTER TABLE emails ADD COLUMN direction TEXT NOT NULL DEFAULT 'in';
ALTER TABLE emails ADD COLUMN headers TEXT;
ALTER TABLE emails ADD COLUMN provider TEXT;

CREATE INDEX IF NOT EXISTS idx_emails_direction ON emails(user_id, direction, received_at);
