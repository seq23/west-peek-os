-- TWO SEATS SHE ALREADY PAYS FOR — $0, FRONTIER, AND ABSENT MOST OF THE TIME BY DESIGN.
--
-- The owner pays for a Claude Max subscription. The sister system already draws on it: `boss-os`
-- registers `bk_claude_code` as an `agent_executed` backend, parks a run awaiting a claim, and a
-- launchd agent on her Mac takes it. West Peek OS had no such lane, so the equivalent work ran on
-- paid API models. The stack she asked both systems to share:
--
--     rung 0a. Claude Code on her Claude Max seat      $0, frontier, PRIVATE-CAPABLE
--     rung 0b. Codex CLI on her ChatGPT Plus seat      $0, frontier, PRIVATE-CAPABLE
--     rungs 1-6. OpenRouter :free reasoning lanes      $0, PUBLIC-ONLY (all training-permitting)
--     rungs 7-13. Paid, cheapest first                 all private-capable
--
-- This migration builds rung 0 — both seats — and the machinery underneath them. The paid and free
-- rungs are migration 0188.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- WHY TWO SEATS AND NOT ONE, which is a real design question rather than "because we have two".
--
-- They fail independently and they fail often. A subscription seat is a laptop process: it dies
-- with a lid, with a reboot, with an `npm -g` upgrade, with a token that needs re-authenticating.
-- One seat awake is worth having; two seats awake is not twice as good, but two seats where either
-- can be down is very much better than one seat that must be up.
--
-- They are also independently PRIVATE-CAPABLE, which is the scarce property in this firm. Before
-- this migration, `anthropic/claude-sonnet-5` was the ONLY lane in the catalogue allowed to see LP
-- names and deal terms, so an OpenRouter outage meant confidential work could not run at all. Each
-- seat added here is one more lane that can.
--
-- WHAT WAS CONFIRMED ABOUT THE CODEX SEAT, rather than assumed, on 17 Sep 2026:
--   · `/opt/homebrew/bin/codex` → `@openai/codex`, installed.
--   · `~/.codex/auth.json` carries `auth_mode = "chatgpt"` and a NULL `OPENAI_API_KEY`, so the CLI
--     runs on the ChatGPT subscription rather than on metered API billing. This is the whole basis
--     for pricing the lane at $0, and it is a fact about the machine's configuration — which is why
--     the claimer re-checks it at startup rather than trusting this comment for ever.
--   · A real generation completed headlessly:
--       codex exec --sandbox read-only --skip-git-repo-check "Reply with exactly: lane is alive"
--     returned `lane is alive`. Two traps were found and are encoded in the claimer rather than
--     written down: without `--skip-git-repo-check` it refuses and resets the working directory,
--     and without stdin redirected to /dev/null it blocks for ever waiting to be typed at.
--
-- COPIED IN SHAPE, NOT IN CODE. `boss-os` and this repo are separate properties and the standing
-- rule is copy and diverge. Nothing here imports from there; the two claimers are separate scripts
-- with separate launchd labels, so a stall in one cannot take the other down.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- WHICH WORK THIS LANE CARRIES, AND WHY IT IS NOT ALL OF IT
--
-- The brief's question, answered explicitly rather than by default: THIS LANE CARRIES
-- PRIVATE_MODEL_ONLY WORK AND NOTHING ELSE.
--
--   · PUBLIC_MODEL_APPROVED work — which migration 0184's own notice says is MOST of what the firm
--     does: hiring searches, event kits, room and workshop packets, social posts, blog writing —
--     already leads on a free reasoning lane at $0. Routing it here would spend her interactive
--     subscription capacity to replace something that is ALREADY FREE. That is a pure loss: the
--     bill does not fall, and the capacity she uses to work is smaller.
--
--   · PRIVATE_MODEL_ONLY work is the slice with no cheap door at all, and 0184 says so in as many
--     words: "every cheap lane registered in this firm is a FREE lane and free lanes are capped at
--     PUBLIC for the correct reason." That work sits on `claude-sonnet-5` at $2/$10. The cheap
--     alternative 0184 registered — `claude-haiku-4.5` — is BENCH behind an unfunded account.
--
-- So this is the only slice where the lane both SAVES MONEY and is LEGALLY ALLOWED to serve. It is
-- allowed because Claude Code is Anthropic first-party under the same Commercial Terms §B that
-- 0184 quotes verbatim — "Anthropic may not train models on Customer Content from Services" — a
-- contractual prohibition rather than an account setting, which is exactly the test this firm
-- applies before a lane may see an LP name or a deal term.
--
-- And it is where frontier quality earns its keep: the work that may not use a free reasoning model
-- is the work that most wants a strong one.
--
-- WHOSE SUBSCRIPTION. Hers, and she has approved Scooter's work running on it, so there is NO
-- per-person restriction anywhere in this design. The claimer authenticates as the FIRM, not as a
-- partner.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- AVAILABILITY IS A HEARTBEAT, NOT A TIMEOUT — the design decision, and the reason for two tables
-- instead of one.
--
-- Her Mac sleeps. `caffeinate` runs today, but lids close and she travels, so ABSENCE IS THE
-- NORMAL STATE and must cost nothing. A timeout would make every private card wait for a machine
-- that is not there before falling through. A heartbeat is a single indexed read: the router asks
-- "was this lane seen in the last two minutes", and a stale answer skips it with ZERO DELAY.
--
-- THE STALE LANE IS NOT A NEW KIND OF THING. It is a lane that cannot serve, which is precisely
-- what migration 0184 built the chain for. It throws an outage-class reason, the existing
-- `executeAttempt` chain engages, and the free or paid lane answers inside the same `ai_run`. No
-- parallel mechanism, no second notion of "unavailable".
--
-- ONE THING IS DELIBERATELY WITHHELD FROM THE 0184 MACHINERY: the back-off. `shouldBackOff` arms a
-- 5→60 minute cooldown on an outage, which is right for an unfunded vendor and WRONG for a shut
-- lid — the cooldown would outlive her opening the laptop, and the heartbeat already answers the
-- same question better and faster. The heartbeat IS the availability signal; a cooldown on top of
-- it would be the duplicate mechanism 0184 warned against. See `shouldBackOff` in
-- src/shared/ai/providerFailure.ts, where the exclusion is written and reasoned.
--
-- ═════════════════════════════════════════════════════════════════════════════════════════════

-- ── THE HEARTBEAT ────────────────────────────────────────────────────────────────────────────
-- One row per (seat, device). The claimer pings every 30 seconds; the router treats a ping inside
-- 120 seconds as fresh. Four missed pings before a seat is declared away: one miss is a nap or a
-- network blip, four consecutive misses over two minutes is a machine that is genuinely gone.
--
-- The window is SHORT because the cost of being wrong is asymmetric. Declaring a seat away while it
-- is present costs a fraction of a cent on the lane that would have run anyway. Declaring it
-- present while it is gone costs the card a parked run and up to ninety seconds of waiting before
-- the chain rescues it. So the check errs towards away, which is also the direction that keeps the
-- firm's work moving on the ordinary day when the laptop is shut.
--
-- SEAT IS PART OF THE KEY, AND THAT IS THE WHOLE OF THE INDEPENDENCE GUARANTEE. Claude Code being
-- asleep says nothing about Codex: they are different subscriptions, different processes, and
-- either can die on its own. One shared "is the Mac awake" row would couple them, and the first
-- time Claude Code hung we would lose a seat that was working perfectly.
CREATE TABLE IF NOT EXISTS subscription_seat_device (
  -- 'claude_code' | 'codex'. Matches provider_registry.provider_key exactly, so there is one name
  -- for a seat across the registry, the queue, the heartbeat and the run explanation.
  seat          TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  hostname      TEXT,
  agent_version TEXT,
  -- ISO. The whole of the availability decision reads this column and nothing else.
  last_seen_at  TEXT NOT NULL,
  -- What the claimer says it is willing to take. Recorded for the Cockpit, never trusted as
  -- authority: eligibility is decided by the router, not claimed by the device.
  capabilities_json TEXT NOT NULL DEFAULT '[]',
  first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (seat, device_id)
);

-- "Which device on THIS seat was seen most recently" is the only query the router makes.
CREATE INDEX IF NOT EXISTS idx_seat_device_seen ON subscription_seat_device (seat, last_seen_at DESC);

-- ── THE CLAIMABLE QUEUE ──────────────────────────────────────────────────────────────────────
-- A run the router offers to this lane is PARKED here rather than executed by the Worker, because
-- a Cloudflare Worker cannot run Claude Code. The claimer takes it, runs it locally, and reports.
--
-- STATUSES, and every one of them is reachable:
--   QUEUED     parked, nobody has taken it
--   CLAIMED    a device holds it and is working
--   REPORTED   the device returned output; the router read it and the run COMPLETED
--   FAILED     the device returned an error; the chain took over
--   ABANDONED  terminal, nothing will run it — the router stopped waiting, or the reaper gave up
--
-- A run never sits here for ever. That is the failure `boss-os` actually had in production — a run
-- claimed at 22:10 and never reported, a task reading "running" for two days and eleven hours,
-- with nothing anywhere able to end it. The reaper below is the third party that did not exist
-- there, and `bk_local_runtime`'s "NO LOCAL HOST" disablement is the other failure this must not
-- recreate: absence is ordinary here, so absence must be cheap rather than fatal.
CREATE TABLE IF NOT EXISTS subscription_seat_run (
  id              TEXT PRIMARY KEY,
  -- Which seat this was parked for. A claimer asks for the seats it can actually serve, so a
  -- machine with Claude Code installed and Codex not is never handed a Codex run.
  seat            TEXT NOT NULL,
  -- The governed run this belongs to. The lane never creates work of its own: every row here is a
  -- leg of an `ai_run` that already passed every budget, egress and content-class gate.
  ai_run_id       TEXT,
  purpose         TEXT NOT NULL,
  -- The instruction, in words. Already through `classifyContent` and the egress gate upstream.
  prompt          TEXT NOT NULL,
  -- Stored rather than assumed, so the validator can assert the volume decision against real rows
  -- instead of against a comment. Today the router parks only PRIVATE_MODEL_ONLY work here.
  model_access    TEXT NOT NULL DEFAULT 'PRIVATE_MODEL_ONLY'
    CHECK (model_access IN ('PUBLIC_MODEL_APPROVED', 'PRIVATE_MODEL_ONLY')),
  work_card_id    TEXT,
  ai_employee_id  TEXT,
  task_class      TEXT,
  firm_scope      TEXT NOT NULL DEFAULT 'west-peek',
  status          TEXT NOT NULL DEFAULT 'QUEUED'
    CHECK (status IN ('QUEUED', 'CLAIMED', 'REPORTED', 'FAILED', 'ABANDONED')),
  claimed_by      TEXT,
  claimed_at      TEXT,
  -- How many times this row has been handed out. A run returned to the pool once may be taken
  -- again; twice and it is abandoned, because a job that kills two claimers will kill a third.
  attempt_count   INTEGER NOT NULL DEFAULT 0,
  -- How long the claimer may take before the reaper calls it silent. Written by the router.
  max_seconds     INTEGER NOT NULL DEFAULT 300,
  output_text     TEXT,
  error           TEXT,
  -- Why this row reached a terminal state. Always a sentence a person can act on, never a code.
  resolution      TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reported_at     TEXT,
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- The claim query: oldest QUEUED row first. The reaper query: anything not terminal, by age.
CREATE INDEX IF NOT EXISTS idx_seat_run_status ON subscription_seat_run (seat, status, created_at);
CREATE INDEX IF NOT EXISTS idx_seat_run_claimed ON subscription_seat_run (status, claimed_at);
CREATE INDEX IF NOT EXISTS idx_seat_run_ai_run ON subscription_seat_run (ai_run_id);

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- A LANE NO WORKER CAN CALL
--
-- Every other row in `provider_registry` is something the Worker dials. This one is not: it is
-- served by an agent that CLAIMS the run. That difference has to be a column rather than a special
-- case on an id, because the consequence is structural — a claimable lane must never be picked by
-- an ordinary cost comparison.
--
-- WHY THAT MATTERS, CONCRETELY. This lane costs $0. The free lanes cost $0 too, and migration 0178
-- had to exclude them from ranking for exactly this reason: "the moment the lanes existed they
-- became the cheapest thing in the catalogue and started taking every PUBLIC-labelled call in the
-- firm". They are excluded by `training_permitted = 1`. This lane does NOT permit training — that
-- is the whole point of it — so that filter does not catch it, and without `claimable` a zero-cost
-- Anthropic-terms lane would silently win every unpinned selection in the firm. That is precisely
-- the "do not silently route everything" failure, arriving through the price column.
--
-- So: a claimable lane is excluded from ordinary ranking and assembled only by its own eligibility
-- gate, which reads the heartbeat and the two labels. Naming the property rather than the row means
-- a second claimable lane — another machine, another agent — works without a code change.
ALTER TABLE provider_registry ADD COLUMN claimable INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json,
   base_url, training_permitted, claimable, firm_scope)
VALUES
  ('prov_claude_code', 'claude_code', 'Claude Code (her Mac)', 1, 0, '["text-completion"]',
   '{"note":"Claude Code running under the owner''s Claude Max subscription on her own machine. NOT an API vendor: the Worker cannot dial it. A run assigned here is parked in claude_code_run and a launchd claimer takes it. Cost is $0 because the subscription is a flat fee already paid — the figure is plan-equivalent usage, not a bill. Absence is the normal state: when the Mac is asleep or away the heartbeat goes stale and the router skips this lane with zero delay."}',
   NULL, 0, 1, 'west-peek');

-- ── THE EGRESS DECISION, MADE EXPLICITLY AND NARROWLY ────────────────────────────────────────
-- `provider_data_policy` is default-deny, so a row is required before ANYTHING may be sent here.
-- PUBLIC and INTERNAL, and DELIBERATELY NOT CONFIDENTIAL — nor RESTRICTED, LP_PRIVATE,
-- MNPI_SENSITIVE or BANKING_RESTRICTED, which have no lane in this firm and must keep having none.
--
-- THE TEMPTATION HERE IS REAL AND IS BEING REFUSED. This lane is genuinely the safest destination
-- in the catalogue: the material never leaves her own machine's session and there is no third party
-- in the path at all. It would be easy to argue it should carry the strict labels too.
--
-- IT MUST NOT, BECAUSE THAT IS A DIFFERENT DECISION THAN THE ONE ASKED FOR. `tests/ai.test.ts`
-- asserts that a CONFIDENTIAL-labelled run is EGRESS_BLOCKED with ZERO provider calls, in every
-- privacy mode. That guarantee predates this work, nobody asked for it to be revisited, and a new
-- lane quietly becoming the first thing ever allowed to see MNPI is exactly the kind of widening
-- that should require its own argument rather than arriving as a side effect of a cost change.
--
-- AND NOTHING IS LOST BY THE NARROWNESS, which is the part worth checking rather than assuming.
-- The private slice this lane exists for does NOT arrive labelled CONFIDENTIAL. Migration 0184
-- established that the label is the RECIPIENT axis and `model_access` is the CONTENT axis: a work
-- card marked PRIVATE_MODEL_ONLY reaches the boundary as `sensitivity: "INTERNAL"` with
-- `confidential: true` in its budget context, and it is the latter that this lane is selected on.
-- So the whole of the intended traffic is covered by the INTERNAL row, and the strict labels stay
-- exactly as blocked as they were yesterday.
INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
  ('pdp_claude_code_public', 'prov_claude_code', 'PUBLIC', 1),
  ('pdp_claude_code_internal', 'prov_claude_code', 'INTERNAL', 1);

-- ── THE MODEL ROW ────────────────────────────────────────────────────────────────────────────
-- ACTIVE rather than BENCH, and the distinction from 0184's benched Haiku row is real: that lane
-- was held back because an UNFUNDED ACCOUNT would fail every call and nothing would notice until a
-- partner's card deferred. This lane's unavailability is DETECTED BEFORE THE CALL, by the
-- heartbeat, and its failure mode is a chain handover rather than a deferral. There is nothing for
-- a bench to protect against.
--
-- `provider_lane_health` still starts it at zero completions, so it cannot undercut a proven lane
-- on price however cheap it is — the 0184 rule applies to this lane exactly as to every other.
INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, latency_source, max_data_class,
   pricing_state, pricing_source_note, pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_claude_code_local', 'prov_claude_code', 'claude-code-local', 'Claude Code on her Mac',
   '["text-completion"]', 200000, 8192, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED',
   'Zero, and the zero is real rather than a placeholder: the work runs inside a Claude Max subscription that is a flat monthly fee already paid, so a run here moves no money. Recorded as plan-equivalent usage, not as a bill. Anthropic Commercial Terms of Service §B — "Anthropic may not train models on Customer Content from Services" — is a contractual prohibition rather than an account setting, which is why this lane may carry PRIVATE_MODEL_ONLY work where every free reasoning lane may not. The capacity it draws on is the same capacity the owner uses interactively, which is why it is confined to the private slice rather than given the whole firm.',
   '2026-09-17', 'ACTIVE', 'migration:0187', 'west-peek');

INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0187_claude_code', 'prov_claude_code', 'claude-code-local', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0187_claude_code');

-- The promotion gate refuses ACTIVE without a recorded evaluation. FIXTURE and score 0: this is a
-- REGISTRATION decision on record, not a benchmark. Recording it as LIVE with no `ai_run` to cite
-- would be the fabricated evaluation that gate exists to prevent.
INSERT OR IGNORE INTO model_evaluation (id, provider_model_id, task_class, method, score, sample_size, notes, evaluated_by)
VALUES
  ('mev_0187_claude_code', 'pm_claude_code_local', 'private-model-only-drafting', 'FIXTURE', 0, 0,
   'Registration decision, 17 Sep 2026, migration 0187. The firm''s PRIVATE_MODEL_ONLY work had one lane, claude-sonnet-5 at $2/$10, and one benched alternative behind an unfunded account. This registers the owner''s own Claude Max subscription as a $0 frontier lane for that slice only. NOT a quality benchmark: no run has been served here yet, and provider_lane_health starts it at zero completions so it cannot undercut a proven lane on price until it has actually finished work.',
   'system');

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- RUNG 0b — THE CODEX SEAT, on the same machinery and with the same reservations.
--
-- Registered identically to rung 0a and for the same reasons, so the only things worth saying here
-- are the ways it DIFFERS.
--
-- THE NO-TRAINING BASIS IS DIFFERENT AND IS WEAKER, AND THAT IS SAID PLAINLY BECAUSE IT DECIDES
-- WHETHER LP NAMES MAY GO HERE. Anthropic's Commercial Terms §B is an unconditional contractual
-- prohibition — "Anthropic may not train models on Customer Content from Services" — which is why
-- 0184 accepted it for `claude-haiku-4.5` and why rung 0a carries private work without argument.
-- OpenAI's consumer ChatGPT terms are NOT that: on a Plus plan, training on conversations is a
-- SETTING, defaulted on for chat and off for Codex/API-shaped traffic, and a setting an account
-- holder can flip is not a contractual bar.
--
-- SO THIS SEAT IS REGISTERED PRIVATE-CAPABLE ONLY TO THE SAME LABEL AS RUNG 0a — PUBLIC and
-- INTERNAL, never CONFIDENTIAL — and `scripts/validate/two-seats-she-already-pays-for.mjs` fails if
-- anybody widens either seat past INTERNAL without a migration that argues for it. That is the
-- honest position given what can be established from this repository: the traffic is Codex-shaped
-- rather than chat-shaped, which is the category OpenAI excludes by default, but "excluded by
-- default" is a weaker sentence than "may not", and the difference belongs on the record rather
-- than in somebody's memory.

INSERT OR IGNORE INTO provider_registry
  (id, provider_key, display_name, enabled, kill_switched, capabilities_json, cost_metadata_json,
   base_url, training_permitted, claimable, firm_scope)
VALUES
  ('prov_codex', 'codex', 'Codex CLI (her ChatGPT seat)', 1, 0, '["text-completion"]',
   '{"note":"OpenAI Codex CLI running under the owner''s ChatGPT Plus subscription on her own machine. NOT an API vendor: the Worker cannot dial it, and the local auth.json carries auth_mode=chatgpt with a null OPENAI_API_KEY, so no metered billing is involved. A run assigned here is parked in subscription_seat_run and the claimer takes it. Absence is the normal state: when the machine is asleep the heartbeat goes stale and the router skips this seat with zero delay."}',
   NULL, 0, 1, 'west-peek');

INSERT OR IGNORE INTO provider_data_policy (id, provider_id, privacy_label, allowed) VALUES
  ('pdp_codex_public', 'prov_codex', 'PUBLIC', 1),
  ('pdp_codex_internal', 'prov_codex', 'INTERNAL', 1);

INSERT OR IGNORE INTO provider_model
  (id, provider_id, model, display_name, capabilities_json, context_window, max_output_tokens,
   supports_tools, supports_reasoning, latency_source, max_data_class,
   pricing_state, pricing_source_note, pricing_sourced_at, status, registered_by, firm_scope)
VALUES
  ('pm_codex_local', 'prov_codex', 'codex-local', 'Codex CLI on her Mac',
   '["text-completion"]', 272000, 8192, 1, 1, 'UNKNOWN', 'INTERNAL',
   'SOURCED',
   'Zero, and the zero is real: ~/.codex/auth.json on the claiming machine records auth_mode=chatgpt with a null OPENAI_API_KEY, so the CLI draws on a flat-fee ChatGPT Plus subscription and no metered billing occurs. Recorded as plan-equivalent usage, not as a bill. Registered as the second private-capable subscription seat so that one laptop process dying does not take the firm''s only free frontier capacity with it. Confirmed by a real headless generation on 17 Sep 2026; the claimer re-verifies auth_mode at startup rather than trusting this note, because a seat that has silently fallen back to API billing would spend real money while reporting $0.',
   '2026-09-17', 'ACTIVE', 'migration:0187', 'west-peek');

INSERT OR IGNORE INTO provider_pricing_snapshot (id, provider_id, model, input_per_mtok_usd, output_per_mtok_usd, request_usd, captured_at)
SELECT 'pps_0187_codex', 'prov_codex', 'codex-local', 0.0, 0.0, 0.0, '2026-09-17T00:00:00.000Z'
WHERE NOT EXISTS (SELECT 1 FROM provider_pricing_snapshot WHERE id = 'pps_0187_codex');

INSERT OR IGNORE INTO model_evaluation (id, provider_model_id, task_class, method, score, sample_size, notes, evaluated_by)
VALUES
  ('mev_0187_codex', 'pm_codex_local', 'private-model-only-drafting', 'FIXTURE', 0, 0,
   'Registration decision, 17 Sep 2026, migration 0187. The second subscription seat, registered alongside Claude Code so that neither is a single point of failure for the firm''s free frontier capacity. A real headless generation completed before registration. NOT a quality benchmark and NOT a claim that the two seats are interchangeable: provider_lane_health starts it at zero completions, and model_job_outcome will reorder the two on their actual results once twenty decided outcomes exist.',
   'system');

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- WHO THE CLAIMER IS
--
-- Not a person. The owner has approved Scooter's work running on her subscription, so a per-person
-- restriction would be wrong as well as unnecessary — the claimer takes whatever the firm parked.
--
-- It authenticates the way the read-only browser agent already does: a Cloudflare Access service
-- token, presented as CF-Access-Client-Id / CF-Access-Client-Secret, which Access verifies before
-- the request reaches this Worker. No new auth mechanism, no shared secret in the repo, and the
-- existing rule that A HUMAN IDENTITY ALWAYS WINS is preserved — see src/worker/auth.ts.
INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES
  ('fu_subscription_claimer', 'subscription-claimer@joinwestpeek.com', 'Subscription seat claimer (her Mac)', 'ACTIVE');

-- ═════════════════════════════════════════════════════════════════════════════════════════════
-- AND THE FIRM IS TOLD, because a lane nobody knows about is a lane nobody trusts when it appears
-- on a run's explanation.
--
-- The same append-only noticeboard 0181 built and 0184 used. WORDING HAS WEIGHT: every notice is
-- read into every prompt and the run-time classifier scans those same inputs for LP and deal-term
-- markers, so a notice containing one would revoke the public-model verdict on EVERY RUN IN THE
-- FIRM. This body says what it means without using a marker phrase, and
-- `scripts/validate/a-lane-on-her-own-mac.mjs` runs it through the real classifier and hard-fails
-- if it trips. The check is a build step, not a comment.
INSERT OR IGNORE INTO internal_memo (id, author_type, author_id, audience, department, title, body, supersedes_id) VALUES
  ('memo_notice_14_a_lane_on_her_own_mac', 'SYSTEM', 'west-peek-os', 'FIRM', NULL,
   'Work marked Private model only may now run on Sequoia''s own machine, free, when it is awake',
   'There is a new lane in the stack and it sits at the top of it. Claude Code runs on Sequoia''s Mac under a subscription the firm already pays for, so a run there costs nothing and is answered by a frontier model. It is offered ONLY to work marked Private model only. Work marked Public model approved already runs free on a reasoning lane and is not sent here, because moving it would spend the partners'' own working capacity to replace something that is already free. The lane is absent most of the time and that is normal, not a fault: the machine sleeps, the lid closes, she travels. The router checks whether it has reported in within the last two minutes and, if it has not, goes straight on to the next lane with no waiting at all. Nothing ever depends on the machine being awake. If a run is taken by the machine and the machine then stops, the run goes back into the pool and, failing that, to another lane, so no piece of work can be stranded by a closed laptop. You will see which lane answered on the run''s own explanation, as you do today. Scooter''s work uses this lane on the same terms as Sequoia''s; it is the firm''s lane, not one partner''s.',
   NULL);

-- The version marker every migration in this repo ends with. `/api/health` and the deploy gate both
-- read it, so a migration that omits it reports the database as older than it is.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0187_a_lane_on_her_own_mac');
