-- Whether a routing pin survives the cheap setting.
--
-- `cost_mode` could not express the difference between "as cheap as sensible" and "free, and I
-- accept the brief gets worse". Both are CHEAPO; they differ only in whether the morning brief's
-- pinned frontier model is honoured. Without somewhere to record that, the cheapest setting either
-- silently degraded the one thing the partners read first, or did nothing at all — and it did
-- nothing at all, because a pin beat cost mode outright.
--
-- Defaults to 1 so every existing policy version keeps behaving exactly as it did.

ALTER TABLE budget_policy ADD COLUMN honours_pins INTEGER NOT NULL DEFAULT 1;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0082_spend_posture');
