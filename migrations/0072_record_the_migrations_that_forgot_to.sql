-- 0069 and 0070 did not record themselves.
--
-- Every migration ends with `INSERT OR IGNORE INTO schema_version (migration) VALUES ('…')`. Both
-- of the Whitney migrations were hand-written and both omitted it, so the database's idea of where
-- it had got to stopped at 0068 while two later migrations had in fact run. `/api/health` reports
-- that value as the schema version, which means the answer to "what is deployed" was wrong.
--
-- Backfilled here rather than by editing 0069 and 0070, which have already been applied: a
-- migration whose recorded text differs from what ran is the drift the whole mechanism exists to
-- prevent. IGNORE makes this a no-op on any database that somehow has them.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0069_whitney_returns_as_professor');
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0070_whitney_activation_is_not_a_migrations_job');
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0072_record_the_migrations_that_forgot_to');
