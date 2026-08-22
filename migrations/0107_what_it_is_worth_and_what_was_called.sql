-- What a holding is worth, what was called, and what was paid back.
--
-- THE GAP, and it is the one every LP metric sits on. `position` records `cost_basis` — what the
-- fund PAID, derived from an executed transaction — and nothing anywhere records what a holding is
-- WORTH. There is no valuation table in this system, and no TVPI, DPI, RVPI, MOIC or IRR is
-- computed anywhere; the only two mentions in the codebase are display fields on an IC packet, one
-- of them labelled "manual only". So the fund could answer "what did we put in" and could not answer
-- "what is it worth", which is the numerator of every number an LP asks for.
--
-- Nor was there anywhere to record capital CALLED from an LP or DISTRIBUTED back to them.
-- `distribution_receipt` sounds like the second and is not: it records sending a REPORT.
--
-- Operator, 21 Aug 2026: "we are going to need to report to the LPs how the fund is doing... the LP
-- page needs to allow us to create a report for LPs at the drop of a hat that explains where we are
-- at any given time with metrics LPs care about."
--
-- WHERE EACH FACT BELONGS, decided so two surfaces never both claim the fund's position:
--   * A MARK is a fact about a holding and lives with the holding — Portfolio.
--   * A CALL and a DISTRIBUTION are facts about the investor relationship — LP.
--   * Fund strategy stays the PLAN and never holds actuals. It already says so.
--
-- EVERY ROW CARRIES ITS SOURCE, from the first day and before any administrator is connected.
-- Operator: "one day we are going to want to connect and integrate our fund admin stuff." When that
-- happens an administrator becomes another value of `source` feeding the same table rather than a
-- migration and a second set of numbers — and the reconciliation surface already on the LP page is
-- the right shape for "they say X, we say Y".
--
-- MARKS ARE APPEND-ONLY. A valuation is superseded, never edited: what the fund believed a holding
-- was worth last quarter is exactly what an LP letter from last quarter asserted, and rewriting it
-- would make the firm's own history disagree with what it sent. The current mark is the newest row.
--
-- Money is INTEGER MINOR UNITS throughout. `position.cost_basis` is a REAL and predates this; these
-- are the tables that end up in an LP letter, and a float has no business in one.

CREATE TABLE IF NOT EXISTS position_mark (
  id            TEXT PRIMARY KEY,
  position_id   TEXT NOT NULL REFERENCES position (id),
  value_minor   INTEGER NOT NULL CHECK (value_minor >= 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  -- LAST_ROUND: priced by a round we can point at. THIRD_PARTY: a 409A or an administrator's mark.
  -- WRITE_DOWN / WRITE_OFF: a judgement the firm made. COST: held at what we paid, which is the
  -- honest default for something that has not repriced.
  source        TEXT NOT NULL CHECK (source IN ('COST','LAST_ROUND','THIRD_PARTY','WRITE_DOWN','WRITE_OFF')),
  -- What the mark rests on, in a sentence. A number with no basis is a number nobody can defend to
  -- an LP, and "why is Sensori held at that" is a question that gets asked.
  basis         TEXT,
  as_of_date    TEXT NOT NULL,
  privacy_label TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  marked_by     TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_position_mark_current ON position_mark (position_id, as_of_date DESC, created_at DESC);

-- Capital actually called from an LP against their commitment.
CREATE TABLE IF NOT EXISTS capital_call (
  id            TEXT PRIMARY KEY,
  fund_id       TEXT NOT NULL REFERENCES fund (id),
  lp_record_id  TEXT NOT NULL REFERENCES lp_record (id),
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL DEFAULT 'USD',
  called_on     TEXT NOT NULL,
  -- Called and received are different facts and an LP letter distinguishes them.
  received_on   TEXT,
  note          TEXT,
  source        TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','ADMINISTRATOR')),
  privacy_label TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope    TEXT NOT NULL DEFAULT 'west-peek',
  recorded_by   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_capital_call_fund ON capital_call (fund_id, lp_record_id);

-- Cash paid back to an LP. This is the D of DPI, and the thing `distribution_receipt` is not.
CREATE TABLE IF NOT EXISTS capital_distribution (
  id             TEXT PRIMARY KEY,
  fund_id        TEXT NOT NULL REFERENCES fund (id),
  lp_record_id   TEXT NOT NULL REFERENCES lp_record (id),
  amount_minor   INTEGER NOT NULL CHECK (amount_minor > 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  distributed_on TEXT NOT NULL,
  -- RETURN_OF_CAPITAL and GAIN are taxed differently and reported separately; an LP asks.
  kind           TEXT NOT NULL DEFAULT 'GAIN' CHECK (kind IN ('RETURN_OF_CAPITAL','GAIN','OTHER')),
  note           TEXT,
  source         TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','ADMINISTRATOR')),
  privacy_label  TEXT NOT NULL DEFAULT 'LP_PRIVATE',
  firm_scope     TEXT NOT NULL DEFAULT 'west-peek',
  recorded_by    TEXT NOT NULL,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_capital_distribution_fund ON capital_distribution (fund_id, lp_record_id);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0107_what_it_is_worth_and_what_was_called');
