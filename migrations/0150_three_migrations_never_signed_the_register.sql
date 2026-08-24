-- 0150 — Three migrations ran and never recorded that they had.
--
-- `schema_version` exists so this repo can answer "what is applied" from its own table rather than
-- from Wrangler's. Production held 135 rows against 138 migrations, and the three missing ones —
-- `0050_opportunity_backfill`, `0052_opportunity_placeholders`, `0054_capture_resolution` — simply
-- omit the `INSERT OR IGNORE INTO schema_version` line every other migration carries.
--
-- Nothing is out of step: Wrangler's own `d1_migrations` records all 138, and `migrations list`
-- reports nothing pending. The schema is exactly what the repo describes. What was wrong is the
-- REGISTER, and a register that under-reports is worse than no register — it invites somebody to
-- re-run a migration that has already run, which for a backfill means doing it twice.
--
-- Found while answering "are production and the repo the same thing?", which is the only reason
-- anybody ever looks at this table.

INSERT OR IGNORE INTO schema_version (migration) VALUES
  ('0050_opportunity_backfill'),
  ('0052_opportunity_placeholders'),
  ('0054_capture_resolution'),
  ('0150_three_migrations_never_signed_the_register');
