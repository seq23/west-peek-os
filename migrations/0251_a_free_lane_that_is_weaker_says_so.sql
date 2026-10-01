-- 0251 — A free lane that may be weaker than the work wants says so, on the deliverable.
--
-- WHY (1 Oct 2026). At Free only the owner's rule is "get the work done at the price I set". The subscription seats
-- (Claude Code, Codex) are free and full quality and lead. When both are away, a free OpenRouter / Google lane carries
-- the work instead of the call being stopped — and the deliverable says so, because whether a given free model is as good
-- as the seats is a question about THAT MODEL.
--
-- WHAT THE CATALOGUE KNOWS AND DOES NOT. Every ACTIVE free model here completed a real generation (0178, 0188): that proves
-- the lane is alive, not that its writing is as good as Claude's. `supports_reasoning` says a model can reason, not how well
-- it writes a sponsor packet. No quality measurement exists anywhere in this repo, so no free model is marked FULL by this
-- migration. `quality_tier` is where the owner's decision about each model lives:
--   FULL        written to the seats' standard — no warning when this model serves a protected call
--   DEGRADED    known to be weaker — the warning says so
--   UNMEASURED  nobody has compared it — the warning says that, which is the default for every model
-- The seats and every paid lane are never flagged (the flag applies to a $0 non-seat lane serving a protected call).
--
-- ai_run gets the record: which run was served by a lane whose tier is not FULL, and the sentence for the deliverable.
ALTER TABLE provider_model ADD COLUMN quality_tier TEXT NOT NULL DEFAULT 'UNMEASURED'
  CHECK (quality_tier IN ('FULL', 'DEGRADED', 'UNMEASURED'));
ALTER TABLE ai_run ADD COLUMN quality_degraded INTEGER NOT NULL DEFAULT 0 CHECK (quality_degraded IN (0, 1));
ALTER TABLE ai_run ADD COLUMN quality_note TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0251_a_free_lane_that_is_weaker_says_so');
