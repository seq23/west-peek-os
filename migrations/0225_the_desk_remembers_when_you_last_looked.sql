-- 0225 — THE DESK REMEMBERS WHEN YOU LAST LOOKED.
--
-- One row per partner: the moment they last read the Work desk. It is what lets the desk say
-- "three of these arrived since you last looked" instead of showing twenty cards at one weight.
--
-- NOT `mp_home_module_seen`. That table is Home's freshness contract and is stamped on every route
-- change, so reusing it would make "since you last looked at Work" mean "since you last navigated
-- anywhere" — a value that is always a few seconds old and therefore always says nothing.
CREATE TABLE IF NOT EXISTS work_desk_seen (
  firm_user_id TEXT PRIMARY KEY REFERENCES firm_user (id),
  seen_at      TEXT NOT NULL,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek'
);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0225_the_desk_remembers_when_you_last_looked');
