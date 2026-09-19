-- 0200 — The brief is written the night before, and the vocabulary for the three faces.
--
-- ── The action keys (P4 convention) ──────────────────────────────────────────────────────────
-- The registry (src/shared/registry/actionTypes.ts) is the source and the 0003 generated block
-- carries them for a fresh database. This compensating block reaches every database that applied
-- 0003 before Phase B existed — without it authorize() denies the key and the feature 403s in
-- production while passing every local test (17 Aug 2026, three times).
--
-- ON CONFLICT DO NOTHING rather than INSERT OR IGNORE (0131): the generator legitimately re-emits
-- the same key, so a duplicate is a genuine no-op, but OR IGNORE would ALSO swallow a CHECK
-- failure silently, which has shipped a bug in this repo twice.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0200_the_brief_is_written_the_night_before');

INSERT INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('meeting.decision.record', 'Record a meeting decision', 'Record that something was settled in a meeting: what, by whom, and the note or transcript line it came from.', 0, 0),
  ('meeting.open_question.record', 'Record a meeting open question', 'Record a question a meeting left open and who owes the answer. Rolls forward into the next brief for the same company or LP until resolved.', 0, 0),
  ('meeting.stage_change.propose', 'Propose a stage change from a meeting', 'Propose that a deal move stage because of what a meeting produced. A proposal only — a partner accepts it, and acceptance runs the ordinary opportunity transition.', 0, 0),
  ('meeting.brief.assemble', 'Assemble a meeting brief', 'Assemble the BEFORE face of a meeting: why it exists, what we need to find out, what both sides said last time, the record, and (for founder and diligence meetings) the diligence framework marked answered or not. AI may draft; an empty brief says what it examined.', 0, 0),
  ('meeting.after.approve', 'Approve a meeting''s After draft', 'A partner approves the AI-drafted decisions, commitments, open questions and stage proposal from a meeting, which is the moment they become records. Human only in code; nothing is a record until this.', 0, 0)
ON CONFLICT (key) DO NOTHING;

-- ── The job ──────────────────────────────────────────────────────────────────────────────────
--
-- Once a day, for every meeting in the next 36 hours that has no brief yet, the type's lead
-- employee assembles one. 22:00 UTC is early evening in New York — the night before a morning
-- meeting, and late enough that a meeting put on the calendar during the working day is caught.
-- 36 hours rather than 24 so a meeting at 09:00 the day after tomorrow, seen at 22:00 tonight, is
-- not missed by an hour and then briefed with nothing to spare.
--
-- STARTS ENABLED, and that is the owner's instruction (18 Sep 2026), not a default that slipped
-- through: a brief that has to be switched on before the first meeting is a brief that misses the
-- first meeting. It is on the same DAILY_AT shape as `wednesday_prep`, dispatched by job_key in
-- jobs.ts because `kind` is a CHECK that D1 cannot widen (see 0043).
--
-- SEEDED THE LOUD WAY (0152): WHERE NOT EXISTS is idempotent without being deaf. INSERT OR IGNORE
-- once swallowed a NOT NULL violation and registered a job that existed in no database at all.
INSERT INTO scheduled_job
  (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, task_class, budget_usd,
   data_class, status, created_by, firm_scope)
SELECT
  'sjb_meeting_brief', 'meeting_brief', 'Meeting briefs for the next 36 hours',
  'INTELLIGENCE', 'DAILY_AT', '22:00', 'SYSTEM', 'DERIVATION', 0,
  'INTERNAL', 'ACTIVE', 'system', 'west-peek'
WHERE NOT EXISTS (SELECT 1 FROM scheduled_job WHERE job_key = 'meeting_brief');
