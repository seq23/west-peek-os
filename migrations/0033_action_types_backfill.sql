-- 0033_action_types_backfill.sql — P37 fix: action types added after 0003 never reached production.
--
-- THE TRAP, recorded so the next person does not fall into it. `scripts/seed/generate-machine-seed.mjs`
-- writes the action-type registry into migration 0003. That works perfectly for a fresh database
-- and is invisible in tests, because the test harness applies every migration from scratch and
-- therefore always gets the current 0003.
--
-- Production applied 0003 months ago. Rewriting that file changes nothing there. So three action
-- keys added on 17 Aug 2026 — event.manage, community.manage, weekly_review.manage — existed in
-- code, passed `validate:authority`, passed every test, and were simply ABSENT from the production
-- table. Unknown action keys are DENIED by authorize() (fail closed), so Event OS creation,
-- Community OS saves and weekly-review generation would each have returned 403 in production while
-- working locally. Found by querying prod for the keys rather than trusting the deploy.
--
-- WHY THIS IS NOT A ONE-OFF FIX. Anyone adding an action type after this will hit the same wall.
-- The durable fix is for the seed generator to emit new keys into a NEW migration rather than
-- rewriting 0003; that is a change to the generator and is deliberately not bundled into this
-- hotfix, which exists to make production correct today. Until it lands, adding an action type
-- means adding a backfill migration like this one.
--
-- INSERT OR IGNORE: on a fresh database 0003 has already inserted these, and this migration must
-- be a no-op rather than a duplicate-key failure.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0033_action_types_backfill');

INSERT OR IGNORE INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('event.manage',
   'Manage event',
   'Create or update an Event OS event and its attendee list. Internal record only; sending invitations is an external effect.',
   0, 0),
  ('community.manage',
   'Manage community member',
   'Create or update a Community OS member record. Internal record only.',
   0, 0),
  ('weekly_review.manage',
   'Manage weekly review',
   'Generate the weekly MP operating review from live firm state, and record how each agenda item exited.',
   0, 0);
