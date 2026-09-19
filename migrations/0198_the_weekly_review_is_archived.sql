-- 0198 · the weekly review is archived (18 Sep 2026)
--
-- Owner: "we don't need it anymore."
--
-- The Wednesday operating review — one agenda across sixteen headings, generated daily by the job
-- `weekly_mp_review` (seeded PAUSED in 0043) — is replaced by the per-person Wednesday prep packet
-- (services/meetingPrep.ts, kind `meeting_prep`): what YOU finished since the last sync and what is
-- waiting on YOU, rather than one shared list of the firm's open items.
--
-- RETIRED, NOT DELETED, AND NOT MERELY PAUSED. The table's own lifecycle has three states —
-- ACTIVE, PAUSED, RETIRED — and the difference matters here:
--   · PAUSED means "not on a timer". A human asking by hand still runs it (services/jobs.ts,
--     checkPreconditions: a MANUAL run by a HUMAN passes the pause check), and
--     POST /api/jobs/:key/status can flip it back to ACTIVE.
--   · RETIRED means "will never run again". The dispatcher refuses it on every trigger, the status
--     route answers 409 `retired` rather than re-enabling it, and the Work page's machinery list
--     leaves it out. Its job_run rows still resolve, which is why the row stays.
-- So the job is RETIRED, the way 0169 retired the three folded productions duties.
--
-- EVERYTHING ELSE IS KEPT. `weekly_review`, `weekly_review_item`, `mp_meeting_note` and every
-- `deliverable` of kind `weekly_review` stay exactly as they are and stay readable by URL. Only
-- the machinery that would make more of them stops, and the nav item goes.
--
-- `validate:weekly-review-archived` fails the build if any later migration or seed sets this job
-- back to ACTIVE or PAUSED.

UPDATE scheduled_job
   SET status = 'RETIRED',
       next_run_at = NULL,
       pause_reason = COALESCE(pause_reason, '') ||
         ' Retired 18 Sep 2026 on the owner''s decision ("we don''t need it anymore"): the per-person Wednesday prep packet replaced it. A retired job never runs again; its runs are kept.'
 WHERE job_key = 'weekly_mp_review'
   AND status <> 'RETIRED';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0198_the_weekly_review_is_archived');
