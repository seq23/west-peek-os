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

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- TWO LABELS ON EVERY WORK CARD, AND NEITHER IS DERIVED FROM THE OTHER
--
-- The owner, 17 Sep 2026, on seeing that a hire search was running on the dearest model on the
-- account:
--
--   "WHY IS INTERNAL STUFF COSTING A LOT? THAT IS BACKWARDS."
--   "ITS NOT DEAL TERMS OR LP INFORMATION SO IT DOESNT MATTER IF ITS USING THIS DATA TO TRAIN.
--    WHO CARES ABOUT HIRING SEARCH AND EVENT KITS AND ROOM KITS. THEY ARE NOT PRIVATE INFO."
--   "WE NEED TO CLASSIFY ON EACH WORK CARD GOING FORWARD — CONFIDENTIAL VS NOT, AND INTERNAL VS
--    EXTERNAL, SO THERE IS NO CONFUSION. MOST WORK IS INTERNAL AND NOT-CONFIDENTIAL SO CAN USE
--    FREE TRAINING MODELS WITH REASONING AND CLOSE TO $0."
--
-- ONE COLUMN WAS ANSWERING TWO QUESTIONS. `privacy_label` says INTERNAL, which under her own
-- settled rule — "ITS INTERNAL IF IT GOES TO ME SEQUOIA OR SCOOTER" — is a statement about the
-- RECIPIENT. It was being read as a statement about the CONTENT, and every training-permitting lane
-- is capped at PUBLIC, so a room packet addressed to a partner became ineligible for both free
-- reasoning models. That left exactly one legal lane in the catalogue, `anthropic/claude-sonnet-5`,
-- the dearest model on the account. The router was not misrouting; it had one legal choice.
--
--   model_access  → WHICH MODELS MAY SEE IT.  PRIVATE_MODEL_ONLY = LP names, deal terms, fund
--                   figures, diligence. PUBLIC_MODEL_APPROVED is the default and the normal case.
--   audience      → PREVIEW AND APPROVAL.     External is anyone but sequoia@ or scooter@.
--
-- They are independent and both combinations that look odd are real: an LP memo for Sequoia is
-- confidential AND internal; an event kit for a guest is external AND not confidential. Neither may
-- be inferred from the other, which is why they are two columns and not one enum of four.
--
-- `privacy_label` IS LEFT EXACTLY WHERE IT IS. It is the egress label the AI boundary already reads
-- and is referenced by live history; redefining it in place would silently change the meaning of
-- every existing row. `audience` is the recipient axis stated plainly, alongside it.

-- ── THE NAME IS PART OF THE FIX ──────────────────────────────────────────────────────────────
-- "I'D ALSO LIKE TO CHANGE THE TERMINOLOGY FROM CONFIDENTIAL / NOT — MAYBE JUST LABEL IT PUBLIC
--  MODEL APPROVED / PRIVATE MODEL ONLY" — the owner, 17 Sep 2026.
--
-- She is right, and it is not a string swap. "Confidential" asks the reader to judge how secret
-- something FEELS. That is subjective, it invites hedging towards the answer that looks safest, and
-- hedging is precisely how every room packet and hire search ended up on the dearest model on the
-- account. "Public model approved" names the CONSEQUENCE instead, so ticking the box is a decision
-- about where the work may go rather than a guess about how sensitive it is.
--
-- THE STORED VALUES READ THE SAME WAY THE LABELS DO. A column called `confidential` displayed as
-- "Private model only" would hand the next reader the same confusion back, so the column, the API
-- field, the form control and the badge on the card all say the same two words.
ALTER TABLE work_card ADD COLUMN model_access TEXT NOT NULL DEFAULT 'PUBLIC_MODEL_APPROVED'
  CHECK (model_access IN ('PUBLIC_MODEL_APPROVED', 'PRIVATE_MODEL_ONLY'));
ALTER TABLE work_card ADD COLUMN audience TEXT NOT NULL DEFAULT 'INTERNAL' CHECK (audience IN ('INTERNAL', 'EXTERNAL'));

-- THE DEFAULT IS THE POINT, NOT AN OVERSIGHT. "MOST WORK IS INTERNAL AND NOT-CONFIDENTIAL" — the
-- common case must need no thought, or the label becomes a box nobody ticks and the cheap lane goes
-- unused exactly as it did before. Confidential is the exception and is chosen deliberately.

-- ── EXISTING CARDS ARE CLASSIFIED, NOT ASSUMED ───────────────────────────────────────────────
-- A blanket PUBLIC_MODEL_APPROVED over history would be the silent relabelling this whole change
-- exists to stop, so the backfill asks two questions of every existing row and marks it
-- PRIVATE_MODEL_ONLY if EITHER says so. Erring towards private is free — the card runs on the lane
-- it runs on today — while erring the other way would put a deal term on a training lane.
--
-- 1. WHERE THE CARD SITS. Every machine on the private side of the fund: investment, LP
--    fundraising, portfolio, finance, legal, and the relationship machines, which hold LP
--    relationships. A card on one of those is confidential whatever its text says, because the
--    material it will pull in during its run is not visible here.
UPDATE work_card
   SET model_access = 'PRIVATE_MODEL_ONLY'
 WHERE model_access = 'PUBLIC_MODEL_APPROVED'
   AND machine_id IN (
     SELECT m.id FROM machine m
      WHERE m.key IN (
        'early_stage_deal', 'secondaries_investment', 'investment_mandate_exclusion', 'ic_decision',
        'venturedeals_deal_math', 'ic_learning_loop', 'fund_construction_allocation',
        'lp_fundraising', 'lp_diligence_request', 'lp_proof_engine', 'data_room_control',
        'portfolio_support', 'portfolio_performance_followon',
        'finance_fund_admin', 'legal_compliance_rules',
        'relationship_intelligence', 'network_os_sync_verification', 'relationship_capital_budget'
      )
   );

-- 2. WHAT THE CARD SAYS. The same LP and deal-term markers the AI boundary uses at run time
--    (src/shared/ai/contentClass.ts), applied once to the text already on the card. Multi-word
--    terms of art only: the sister system tripped every run firmwide on the single word
--    "commitment", and the words that did that — commitment, capital, fund, round, investor — are
--    deliberately not here, because they are ordinary English in an event brief.
UPDATE work_card
   SET model_access = 'PRIVATE_MODEL_ONLY'
 WHERE model_access = 'PUBLIC_MODEL_APPROVED'
   AND (
     LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%limited partner%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%term sheet%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%cap table%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%capital call%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%side letter%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%data room%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%carried interest%'
     OR LOWER(COALESCE(title, '') || ' ' || COALESCE(description, '') || ' ' || COALESCE(next_action, '') || ' ' || COALESCE(prompt, ''))
       LIKE '%liquidation preference%'
   );

-- Audience follows the label the card already carries, which is the only recipient statement in the
-- data. A PUBLIC card was written to leave the building; anything else was addressed to a partner.
UPDATE work_card SET audience = 'EXTERNAL' WHERE privacy_label = 'PUBLIC';

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- AND EVERY EMPLOYEE IS TOLD, BECAUSE A LABEL NOBODY KNOWS ABOUT IS A BOX NOBODY TICKS
--
-- "WE NEED TO NOTIFY EVERYONE IN GOVERNANCE TAB ABOUT THESE CHANGES TOO." — the owner, 17 Sep 2026.
--
-- No new surface. 0181 made `internal_memo` with audience='FIRM' the firmwide noticeboard and wired
-- it into every employee prompt through `firmNoticesBlock`, so a thirteenth row IS the notification.
--
-- ── ONE COHERENT RULE, NOT TWO THAT OVERLAP — AND THE TABLE IS APPEND-ONLY ───────────────────
-- Notice 4 already said "LP names and deal terms never reach a model that may train on the prompt".
-- That is still true and now has a LABEL and a MECHANISM behind it, so leaving both standing would
-- hand an employee two notices about one rule and let them choose which to follow.
--
-- `internal_memo` is append-only by trigger (0014, D15) and rightly so: a noticeboard somebody can
-- quietly rewrite is not a record. So a notice is not edited, it is SUPERSEDED — the new row names
-- the one it replaces, which is an INSERT, and `firmNoticesBlock` stops reading the old one. The
-- history survives, the employee reads one rule, and nothing was overwritten. This is the same
-- `supersedes_id` shape `knowledge_record` already uses for the same reason.
ALTER TABLE internal_memo ADD COLUMN supersedes_id TEXT REFERENCES internal_memo (id);

-- ── THE NEW NOTICE ───────────────────────────────────────────────────────────────────────────
-- WORDING HAS WEIGHT HERE IN A WAY IT DOES NOT ELSEWHERE, and this is not a stylistic note. Every
-- notice is read into every prompt, and the run-time classifier in src/shared/ai/contentClass.ts
-- scans those same prompt inputs for LP and deal-term markers. A notice containing one of those
-- phrases would revoke the public-model verdict on EVERY RUN IN THE FIRM — which is exactly what
-- happened in the sister system, where the single word "commitment" in a notice made every run scan
-- as LP material and refused every free route firmwide.
--
-- So this body says what it means without using a marker phrase, and
-- `scripts/validate/two-labels-on-every-card.mjs` runs every seeded notice through the real
-- classifier and hard-fails if any of them trips it. The check is a build step, not a comment.
INSERT OR IGNORE INTO internal_memo (id, author_type, author_id, audience, department, title, body, supersedes_id) VALUES
  ('memo_notice_13_two_labels_on_every_card', 'SYSTEM', 'west-peek-os', 'FIRM', NULL,
   'Every work card carries two labels, and neither one implies the other',
   'The first label is Public model approved or Private model only, and it decides WHICH MODELS may see the work. Public model approved is the default and covers most of what we do — hiring searches, event kits, room and workshop packets, social posts, blog writing, Productions work. None of that is private, and it runs on a free reasoning model at almost no cost. Private model only is for LP names, deal terms, fund figures and diligence material: that work never goes to a model or a route whose terms permit training on what it is sent, in any cost posture, however much better that model would be — a free route is usually free because the provider keeps the prompt. If you are unsure which one you are holding, mark it Private model only; being wrong that way costs a fraction of a cent. The second label is Internal or External, and it decides PREVIEW AND APPROVAL, not which model runs. Internal means it goes to Sequoia or Scooter. External means anyone else, and it previews to Sequoia first. Read both labels and never infer one from the other. An LP memo for Sequoia is Internal and Private model only. An event kit for a guest is External and Public model approved. If a card carries no labels, treat it as Internal and Public model approved, and say in your work that you did.',
   'memo_notice_04_confidential_never_trains');

-- The version marker every migration in this repo ends with. `/api/health` and the deploy gate both
-- read it, so a migration that omits it reports the database as older than it is.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0184_a_lane_that_cannot_serve_must_chain');
