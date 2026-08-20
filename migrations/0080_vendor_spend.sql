-- Money spent with a vendor that is not a reasoning model.
--
-- THE GAP THIS CLOSES. Firm spend is summed from `ai_run`, which is correct for everything that
-- goes through the model boundary and blind to everything that does not. Image generation is the
-- first thing that does not: Runware is a vendor this system pays, deliberately outside `runAi`
-- because forcing an image generator through a text-completion pipeline would mean inventing token
-- counts and an output that do not exist.
--
-- The consequence was that "total spent across the firm" — the number the operator asked to have
-- made prominent — would silently under-report by whatever pictures cost. A cost figure that is
-- quietly incomplete is worse than one that is obviously missing, because it gets believed.
--
-- SEPARATE FROM ai_run, NOT MERGED INTO IT. Writing a fake ai_run for every image would corrupt the
-- model ledger: per-model spend, per-provider spend and the routing evaluation all read that table
-- and would start reporting a model that was never called. Two tables, one total.
--
-- COST COMES FROM THE VENDOR when it reports one. There is no local price list here, because a
-- guessed rate that drifts from the real bill is how a spend page becomes fiction. A call whose
-- cost the vendor did not report stores NULL and is counted in the unit count but not the money,
-- and the cost centre says so rather than treating unknown as zero.

CREATE TABLE IF NOT EXISTS vendor_spend (
  id           TEXT PRIMARY KEY,
  vendor       TEXT NOT NULL,
  -- What was bought, in the operator's words.
  purpose      TEXT NOT NULL,
  -- NULL when the vendor did not report a cost. Never defaulted to zero.
  cost_usd     REAL,
  -- How many of the thing: images, seconds, requests.
  units        INTEGER NOT NULL DEFAULT 1,
  unit_kind    TEXT NOT NULL DEFAULT 'request',
  -- What it produced, so a charge can be traced to the artifact it paid for.
  object_type  TEXT,
  object_id    TEXT,
  requested_by TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE INDEX IF NOT EXISTS idx_vendor_spend_when ON vendor_spend (firm_scope, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_spend_vendor ON vendor_spend (vendor, created_at DESC);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0080_vendor_spend');
