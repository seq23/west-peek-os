-- 0229 — Banter and plain questions do not reach the Mac (Addendum 10, 22 Sep 2026).
--
-- THE INCIDENT. Scooter replied to a thread with pure banter — "'on our side' -- we're all one
-- team :)" — a joke, not a request. `dealIntake.ts`'s capture principle is "ONLY THE ADDRESS IS
-- AUTHORITY, NEVER THE CONTENT": every authenticated partner email becomes a work card
-- unconditionally, so a real ask is never silently missed. That stays untouched. What was missing
-- is a step AFTER capture and BEFORE the card ever dispatches a PLAN run to her Mac: a wasted
-- Claude Code invocation reported back "I can't find 'on our side' anywhere on joinwestpeek.com."
--
-- Her follow-up widened it to three-way: a plain QUESTION ("what are you asking of me?") is neither
-- actionable work nor banter — it has real content but nothing to build, and dispatching it to the
-- Mac wastes a cycle exactly like a joke would. That path reuses the existing `a_question_for_you`
-- block reason (services/blocks.ts) rather than a new state; only BANTER needs a new outcome, since
-- a card that never gets an answer and never needed one is neither DONE nor a normal drop.
--
-- WHY A NEW COLUMN, NOT A NEW `state`. `work_card.state`'s CHECK is `IN ('OPEN','IN_PROGRESS',
-- 'BLOCKED','DONE','CANCELLED')` (migration 0003) and SQLite cannot ALTER a CHECK in place — only
-- rebuild the table (see migration 0151). `work_card` carries dozens of real `REFERENCES work_card
-- (id)` foreign keys from other tables (request_attachment, web_property_change, inbound_message,
-- preview_approval, work_packet, standing_authority, ai_run_attribution, …); `jobs.ts`'s own comment
-- on `scheduled_job.kind` already documents, "tried and confirmed, not assumed", that
-- `PRAGMA foreign_keys=OFF` is a no-op inside the transaction D1 wraps a migration in. Rebuilding a
-- table this heavily referenced is exactly the risk that comment declined to take for a
-- display-only column; taking it here, live, for the same reason would repeat the mistake rather
-- than learn from it documented three lines away.
--
-- So a caught card stays `state = 'CANCELLED'` — already the terminal "decided against, not done"
-- state, already reopenable to OPEN by the existing put-back door — and `auto_resolution` is the
-- new, additive, CHECK-constrained column that tells a real DROP apart from an auto-caught one.
-- Record's query and the purge job both read it; nothing else needs to change to add the value.

ALTER TABLE work_card ADD COLUMN auto_resolution TEXT
  CHECK (auto_resolution IS NULL OR auto_resolution IN ('NO_ACTION_NEEDED'));

CREATE INDEX IF NOT EXISTS idx_work_card_auto_resolution ON work_card (auto_resolution) WHERE auto_resolution IS NOT NULL;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0229_banter_and_questions_do_not_reach_the_mac');
