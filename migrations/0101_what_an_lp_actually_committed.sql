-- What an LP actually committed, and how big the fund is.
--
-- THE GAP, found by mapping the LP domain end to end on 21 Aug 2026. The operator's report was that
-- the LP page is incomprehensible — "i have no idea what a claim is" — and the vocabulary is the
-- smaller half of it. There is nowhere in this system to record **how much money an LP committed**,
-- or **how big the fund is**. A page about limited partners could not answer the only two questions
-- anybody asks about limited partners.
--
-- What existed and why none of it was enough:
--   * `lp_opportunity.target_commitment` is a TARGET on a fundraising conversation. Nullable, never
--     summed anywhere, and reachable from no UI at all — the whole fundraising pipeline had schema,
--     service code and tests, and not one button.
--   * "COMMITTED" existed three times as a STATUS STRING — on `lp_record.status`,
--     `lp_opportunity.stage` and `lp_engagement.state` — so the system could say an LP had committed
--     while holding no idea what they committed TO or how much.
--   * `fund` has four columns and no size. Fund size lived only inside
--     `fund_construction_scenario.fund_size`, a per-scenario stated input, so two scenarios on the
--     same fund could name different fund sizes and nothing reconciled them.
--
-- A COMMITMENT IS ITS OWN RECORD, not a column on the LP and not a status. One LP can commit to more
-- than one fund, can increase a commitment later, and the fund's total is the sum of what people
-- actually signed — never a number somebody typed. Amounts are INTEGER MINOR UNITS (cents): a REAL
-- would introduce rounding into the one table in the system where the number IS the fact.
--
-- 0002 says "NO hardcoded fund sizes, sleeve targets, or strategies anywhere: policy content lives
-- only in versioned JSON rows created by humans." `target_size_minor` does not break that. A target
-- is not policy — it is a stated goal a partner types, and the number that matters (what has
-- actually been committed) is derived from signed commitments rather than declared.

ALTER TABLE fund ADD COLUMN target_size_minor INTEGER;
ALTER TABLE fund ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD';
ALTER TABLE fund ADD COLUMN vintage_year INTEGER;

CREATE TABLE IF NOT EXISTS lp_commitment (
  id             TEXT PRIMARY KEY,
  lp_record_id   TEXT NOT NULL REFERENCES lp_record (id),
  fund_id        TEXT NOT NULL REFERENCES fund (id),
  -- Minor units. See the note above: this number is the fact, so it is never a float.
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  -- SOFT is a verbal yes and belongs in the pipeline view but never in the fund's total.
  -- SIGNED is a subscription document. WITHDRAWN keeps the history of one that fell through.
  state          TEXT NOT NULL DEFAULT 'SOFT' CHECK (state IN ('SOFT','SIGNED','WITHDRAWN')),
  committed_on   TEXT,
  note           TEXT,
  privacy_label  TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  recorded_by    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- One live commitment per LP per fund. An increase edits the row and leaves an event; a second row
-- would double-count the same money in the fund's total, which is the one number that must be right.
CREATE UNIQUE INDEX IF NOT EXISTS idx_lp_commitment_unique
  ON lp_commitment (lp_record_id, fund_id, firm_scope);

CREATE INDEX IF NOT EXISTS idx_lp_commitment_fund ON lp_commitment (fund_id, state);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0101_what_an_lp_actually_committed');
