-- A LANE THAT CANNOT SERVE MUST CHAIN, NOT STOP THE WORK — AND MUST NOT HAVE BEEN CHOSEN.
--
-- CONFIRMED from `ai_run` in production, 17 Sep 2026. A work card for Parker failed three times in
-- fourteen minutes. Each attempt ended the same way:
--
--     prov_anthropic  claude-sonnet-5  BLOCKED_DEFERRED  provider_failure:provider_http_400
--
-- Probed directly with the same key, the 400 body reads: "Your credit balance is too low to access
-- the Anthropic API." The key authenticates. The account is unfunded. The lane cannot serve anyone.
--
-- The owner's words are the specification, and there are two halves to them:
--
--     "the fix is to make it fallback to one that is working and assess cost correctly the first
--      time"
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- ASSESS COST CORRECTLY THE FIRST TIME — which is the half that matters, and the half this table
-- exists for.
--
-- `prov_openrouter` and `prov_anthropic` both offer `claude-sonnet-5`. The direct lane prices lower
-- because it carries no OpenRouter margin, so on an unpinned call it won on price. It had never
-- completed a single run. OpenRouter had completed hundreds. NOTHING IN THE COMPARISON SAW THAT.
--
-- A PRICE ON PAPER IS NOT A COST. A lane that cannot complete the work has an INFINITE effective
-- cost, not a cheap one. A lane that has never completed the work has an UNKNOWN cost, not a low
-- one. Cheaper-on-paper must never beat working-in-practice.
--
-- This is the THIRD instance of one shape in this repo:
--
--   1. `perplexity/sonar` won a judging job on price (0158's $1/$1 row) and refused its own answer.
--   2. That same mispriced row made an unsuitable model "cheapest adequate" firmwide.
--   3. An unfunded lane outranked a proven one, tonight.
--
-- So this closes the CLASS rather than the third case: every cheapest/dearest comparison in the
-- router now ranks on effective cost, and effective cost reads this table.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- WHY A TABLE RATHER THAN THE MECHANISMS THAT ALREADY EXIST — each considered and rejected for a
-- stated reason, because a fourth overlapping mechanism would itself be a defect.
--
--   · `model_job_outcome` (0179) answers "does this MODEL do this JOB well" — a quality question,
--     decided by a human accepting or discarding output, and deliberately silent below twenty
--     decided outcomes. It is used, unchanged, and it still outranks price. What it cannot answer
--     is "can this LANE serve at all", which is not a quality question, needs no human, and must
--     be answerable on run number one rather than run number twenty.
--   · `provider_health_check` records LOCAL_FIXTURE configuration coherence and says so loudly. It
--     has never contacted a vendor and must not start pretending to.
--   · `provider_registry.enabled = 0` is the operator's switch. A transient outage must not consume
--     it, because nothing ever turns it back on. `enabled = 0` is currently set on `anthropic` by
--     hand; the point of this work is to make re-enabling that lane SAFE, not to depend on it
--     staying off.
--   · An in-memory circuit breaker forgets on every cold start and is per-isolate and per-colo. It
--     would re-hammer an unfunded vendor within seconds of being armed.
--
-- One table, written by the AI boundary itself on every attempt — not a counter somebody has to
-- remember to increment — answering both questions from the same rows.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- THE BACK-OFF, AND HOW IT RECOVERS ON ITS OWN.
--
-- Consecutive outage-class failures on a lane arm an EXPIRING cooldown: 5 minutes, doubling per
-- consecutive failure, capped at 60. While `cooldown_until` is in the future the lane is skipped —
-- both in selection and in the fallback chain — so an unfunded vendor is not re-attempted on every
-- run for the rest of the night.
--
-- It recovers with NO human act and NO scheduled job, which is the property that matters: the
-- cooldown is a TIMESTAMP, not a flag. The moment it passes, the lane is an ordinary candidate
-- again; one completion clears the row entirely and resets the doubling. A lane disabled forever by
-- a transient outage would be its own defect, so there is no state here that can outlive the clock.
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- BACKFILLED FROM `ai_run`, WHICH IS WHAT MAKES THE FIX WORK ON THE FIRST CALL RATHER THAN THE
-- TWENTY-FIRST. The history is already in the table the boundary has always written; it simply had
-- no summary anyone could rank on. After this runs, `prov_openrouter / anthropic/claude-sonnet-5`
-- carries its real completion count and `prov_anthropic / claude-sonnet-5` carries zero — which is
-- precisely the fact the comparison was missing tonight.

CREATE TABLE IF NOT EXISTS provider_lane_health (
  -- A LANE IS (provider, model), not a provider. The same vendor can serve one model and not
  -- another — a retired snapshot 404s while its sibling is fine — and cooling a whole vendor for
  -- one dead model id would throw away capacity that works.
  provider_id        TEXT NOT NULL,
  model              TEXT NOT NULL,
  -- How many runs this lane has actually finished. Zero means UNKNOWN cost, never low cost.
  completed_runs     INTEGER NOT NULL DEFAULT 0,
  -- How many outage-class failures in a row, since the last completion. Drives the doubling.
  consecutive_outages INTEGER NOT NULL DEFAULT 0,
  -- Lifetime outage count, kept for the Cockpit. Never reset, so "this lane is flaky" stays visible
  -- after a recovery clears the consecutive counter.
  outage_runs        INTEGER NOT NULL DEFAULT 0,
  last_completed_at  TEXT,
  last_outage_at     TEXT,
  -- The vendor's own words for the most recent outage, already credential-scrubbed and truncated by
  -- src/worker/ai/providers/httpError.ts. "Your credit balance is too low" on a page beats
  -- "provider_http_400" by the whole distance between a billing page and a bug hunt.
  last_outage_reason TEXT,
  -- ISO timestamp. In the future ⇒ skip this lane. Absent or past ⇒ ordinary candidate.
  cooldown_until     TEXT,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (provider_id, model)
);

-- Read on every routed call, ordered by nothing and looked up by key, so the primary key is the
-- index. This one exists for the Cockpit's "which lanes are cooling right now" query.
CREATE INDEX IF NOT EXISTS idx_provider_lane_health_cooldown
  ON provider_lane_health (cooldown_until);

-- ── The backfill ─────────────────────────────────────────────────────────────────────────────
-- Completions only. A historical failure is NOT replayed into `consecutive_outages`: the doubling
-- describes what is happening now, and arming a cooldown from a week-old 500 would take working
-- capacity away on the strength of an outage that ended long ago.
INSERT INTO provider_lane_health (provider_id, model, completed_runs, last_completed_at, updated_at)
SELECT r.provider_id,
       r.model,
       COUNT(*),
       MAX(r.completed_at),
       strftime('%Y-%m-%dT%H:%M:%fZ','now')
  FROM ai_run r
 WHERE r.status = 'COMPLETED'
   AND r.provider_id IS NOT NULL
   AND r.model IS NOT NULL
 GROUP BY r.provider_id, r.model
    ON CONFLICT (provider_id, model) DO UPDATE SET
       completed_runs    = excluded.completed_runs,
       last_completed_at = excluded.last_completed_at,
       updated_at        = excluded.updated_at;
