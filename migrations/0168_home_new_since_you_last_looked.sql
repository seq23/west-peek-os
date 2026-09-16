-- 0168 · Home: new since you last looked, and a week puts things away (15 Sep 2026)
--
-- "Who has something for you" counted modules that merely HAD items — five companies in the
-- pipeline was "something" forever, and pressing Open never quieted it. A module has something
-- only if it holds items newer than the last time this partner opened it. That mark lives here,
-- per partner per module: the moment they pressed Open or visited the module's page, and a hash of
-- the item ids they saw, for modules whose items carry no timestamp.
CREATE TABLE IF NOT EXISTS mp_home_module_seen (
  firm_user_id TEXT NOT NULL REFERENCES firm_user (id),
  module_key   TEXT NOT NULL,
  seen_at      TEXT NOT NULL,
  items_hash   TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  PRIMARY KEY (firm_user_id, module_key)
);

-- A deliverable older than a week that nobody marked as read is put away BY AGE — derived in the
-- query, nothing written. "Put it back" from the put-away list has to mean something against that
-- rule, so it records when it was put back and the week counts from there.
ALTER TABLE deliverable ADD COLUMN restored_at TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0168_home_new_since_you_last_looked');
