-- "I know" and "Stop telling me" did exactly the same thing.
--
-- Both wrote the same row, differing only in a `kind` column nobody reads, and both lapsed after
-- seven days. The operator noticed and asked for one of them to mean it.
--
-- They now mean different things, which they always claimed to:
--   * "I know"           — ACKNOWLEDGED. Seen, still true, living with it. Quiet for seven days.
--   * "Stop telling me"  — DISMISSED. Permanent. It does not come back.
--
-- WHAT PERMANENT DOES NOT MEAN. It is still keyed to the item AND its exact wording. Silencing
-- "3 scheduled job(s) recently failed" for ever must not also silence "9 scheduled job(s) recently
-- failed" — a different fact deserves to be said. That signature rule is the reason it is safe to
-- offer a permanent option at all, and it is why this is a column rather than a delete.
--
-- Nothing is destroyed either way. "Bring them back" already clears the table, and an operator who
-- silences something by mistake has a way out.

ALTER TABLE attention_dismissal ADD COLUMN permanent INTEGER NOT NULL DEFAULT 0 CHECK (permanent IN (0,1));

-- Everything dismissed before this migration keeps the seven-day behaviour it was written under.
-- Retro-applying "permanent" would silence things the operator never chose to silence for ever.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0093_stop_telling_me_means_stop');
