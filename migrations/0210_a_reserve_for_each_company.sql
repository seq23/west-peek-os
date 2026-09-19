-- 0210 — A reserve for each company (Phase D: portfolio, owner-approved 18 Sep 2026).
--
-- design/DEALS_SECTION_DESIGN.md §6: "a per-company reserve — new table position_reserve". The
-- fund-level reserve (reserve_policy_version) says how much of the sleeve is HELD BACK for
-- follow-ons in total, and it stays the source of the deployment ring's Reserves slice. This is the
-- other question a partner asks per company: "how much of that is earmarked for THIS one?"
--
-- Append-only, like position_mark: a reserve is superseded by a newer row, never edited, so the
-- record of what the firm intended to keep behind a company at each date survives. The current
-- reserve is the newest row by (as_of_date, created_at). Money is integer minor units, as every
-- table that can reach an LP letter is.
--
-- Written only by a person (MANAGING_PARTNER) through `position.reserve`; not an approval card —
-- earmarking is a decision about intent, not a movement of money, and the design's approvals law
-- keeps marks and reserves as MP writes.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0210_a_reserve_for_each_company');

CREATE TABLE IF NOT EXISTS position_reserve (
  id            TEXT PRIMARY KEY,
  position_id   TEXT NOT NULL REFERENCES position (id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  as_of_date    TEXT NOT NULL,
  note          TEXT,
  set_by        TEXT NOT NULL,
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_position_reserve_current ON position_reserve (position_id, as_of_date DESC, created_at DESC);

-- ── The action key (P4 convention): in the TS registry, the 0003 generated seed, and here. ──
INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('position.reserve', 'Reserve for a holding', 'Earmark follow-on capital for one company, as of a date, with a note. Append-only; a reserve is superseded, never edited. The fund-level reserve stays the plan.', 0, 0);
