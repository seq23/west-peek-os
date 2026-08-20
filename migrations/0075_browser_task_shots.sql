-- Screenshots taken during a browser task.
--
-- WHY THE PAGE HAS TO BE SEEN AND NOT ONLY READ. Everything a browser task returned until now was
-- `innerText`. That answers "does this page mention a VP of Sales" and cannot answer "is the
-- hierarchy wrong", "is the call to action invisible", "does this look trustworthy" — which are the
-- questions a founder asks when they want their homepage reviewed. Those need the pixels.
--
-- BYTES IN R2, METADATA HERE, matching how documents already work. A screenshot is a few hundred
-- kilobytes and D1 is the wrong place for that; the r2_key is the join.
--
-- TWO PER TASK, desktop and mobile, because half of design review is what happens on a phone and a
-- desktop-only review of a page most of whose visitors are on mobile reviews something nobody sees.
--
-- KEPT AFTER THE TASK so a claim about a page can be checked against what the page actually looked
-- like. An employee saying a pricing page buries its enterprise tier is a claim; the shot is the
-- evidence, and without it the operator can only take the employee's word.

CREATE TABLE IF NOT EXISTS browser_task_shot (
  id           TEXT PRIMARY KEY,
  task_id      TEXT NOT NULL REFERENCES browser_task (id),
  -- 'desktop' or 'mobile'. Not a CHECK: adding a viewport should not need a migration.
  viewport     TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  r2_key       TEXT NOT NULL,
  sha256       TEXT NOT NULL,
  size_bytes   INTEGER NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'image/jpeg',
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_browser_task_shot_task ON browser_task_shot (task_id, viewport);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0075_browser_task_shots');
