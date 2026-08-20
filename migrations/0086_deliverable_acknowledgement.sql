-- 0086 — a deliverable you can answer.
--
-- WHAT WAS MISSING. Things were prepared for the partners and then simply accumulated. There was no
-- way to say "read it", no way to put one away, and no way to tell the employee who wrote it that
-- it was not what was wanted. A list that only ever grows is a list nobody reads, and an employee
-- who never hears anything writes the same unwanted thing next week.
--
-- THREE DISTINCT ACTS, deliberately not collapsed into one:
--   · ACKNOWLEDGED — I have read this. It stays on the page; it stops asking for attention.
--   · DISMISSED    — I do not want this. It leaves the page and can be brought back, because a
--                    dismiss that destroys is how people lose work they meant to keep.
--   · FEEDBACK     — what was wrong or right with it, addressed to whoever prepared it.
--
-- Feedback is a separate table rather than a column because it is a conversation, not a flag: more
-- than one note can be left, each is dated, and each is addressed to the employee who signed the
-- piece so it can be read back into their next run.

ALTER TABLE deliverable ADD COLUMN acknowledged_at TEXT;
ALTER TABLE deliverable ADD COLUMN acknowledged_by TEXT REFERENCES firm_user (id);
ALTER TABLE deliverable ADD COLUMN dismissed_at TEXT;
ALTER TABLE deliverable ADD COLUMN dismissed_by TEXT REFERENCES firm_user (id);

-- The page's default view is "not dismissed", so that is the index that matters.
CREATE INDEX IF NOT EXISTS idx_deliverable_open
  ON deliverable (firm_scope, dismissed_at, created_at DESC);

CREATE TABLE IF NOT EXISTS deliverable_feedback (
  id             TEXT PRIMARY KEY,
  deliverable_id TEXT NOT NULL REFERENCES deliverable (id),
  -- Roster name of the employee it is addressed to, copied from the deliverable's byline. Not a
  -- foreign key for the same reason prepared_by is not: an employee can retire and the note stands.
  to_employee    TEXT NOT NULL,
  from_user_id   TEXT NOT NULL REFERENCES firm_user (id),
  -- What the partner actually said. The useful part.
  note           TEXT NOT NULL,
  -- A one-word read so the employee's next run can weight it without parsing prose.
  verdict        TEXT NOT NULL DEFAULT 'NOTE'
                 CHECK (verdict IN ('GOOD','NOT_WHAT_I_WANTED','TOO_LONG','WRONG_FOCUS','NOTE')),
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_deliverable_feedback_employee
  ON deliverable_feedback (to_employee, created_at DESC);

-- ── "Needs your attention", which you can now answer ─────────────────────────
--
-- Those items are DERIVED — recomputed from system state every time Home loads — so there is no
-- row to mark. Dismissing one therefore has to be recorded separately, and the hard part is making
-- it forgettable in the right way.
--
-- A permanent dismissal is dangerous: the operator would silence "no AI provider configured" once
-- and never be told again, including the next time it is true for a different reason. A dismissal
-- that expires on a timer alone is merely annoying.
--
-- So a dismissal is recorded against a SIGNATURE — the item's key plus the exact words it was
-- showing. Say "I know" and it goes quiet. If the condition changes, the words change, the
-- signature no longer matches and it speaks up again. And every dismissal ages out after a week
-- regardless, because "I know" a week ago is not "I know" today.
CREATE TABLE IF NOT EXISTS attention_dismissal (
  id           TEXT PRIMARY KEY,
  item_key     TEXT NOT NULL,
  -- The headline the operator was actually looking at when they dismissed it.
  signature    TEXT NOT NULL,
  -- ACKNOWLEDGED: seen and understood, still true. DISMISSED: stop showing me this.
  kind         TEXT NOT NULL DEFAULT 'DISMISSED' CHECK (kind IN ('ACKNOWLEDGED','DISMISSED')),
  dismissed_by TEXT NOT NULL REFERENCES firm_user (id),
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_attention_dismissal_lookup
  ON attention_dismissal (firm_scope, item_key, created_at DESC);

-- ── The three duplicate weekly reviews ───────────────────────────────────────
--
-- The generator wrote one copy per ACTIVE firm user, which by 20 August meant three: both partners
-- and fu_browser_agent, the read-only identity the browser employees run as. A service account does
-- not read a weekly operating review. The generator is fixed to write one joint copy; these rows
-- are the ones it already wrote, and they are dismissed rather than deleted — a partner may want to
-- see what was there, and destroying rows to tidy a page is how work gets lost.
UPDATE deliverable
   SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE kind = 'weekly_review'
   AND prepared_for NOT IN (
     SELECT u.id FROM firm_user u
       JOIN firm_user_role r ON r.firm_user_id = u.id AND r.role_id = 'role_managing_partner'
   );

-- The remaining per-partner copies are identifiable exactly, with no cleverness required: the old
-- generator wrote source_id as "<review id>:<partner id>", and the fixed one writes the review id
-- alone. Every row carrying a colon is therefore a copy from the old scheme. They are put away
-- rather than deleted, and the next weekly run writes one clean joint row.
--
-- (An earlier draft of this migration matched them with substr/LIKE against the newest row per
--  review. It would have worked and nobody reading it in a year could have said why. The colon is
--  a fact about how the rows were written; the substring arithmetic was a guess about their order.)
UPDATE deliverable
   SET dismissed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE kind = 'weekly_review'
   AND dismissed_at IS NULL
   AND source_id LIKE '%:%';

-- The schema this migration leaves behind, so /api/health and the health board report the version
-- the code actually expects rather than the one before it.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0086_deliverable_acknowledgement');
