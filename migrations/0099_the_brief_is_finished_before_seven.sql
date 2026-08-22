-- The brief is WAITING at seven, not starting at seven.
--
-- Operator intent, stated 21 Aug 2026: "the intent for the daily brief is for us to open our app and
-- have a brief waiting for us in the morning fully complete if its after 7am, and if its before we
-- can go ahead and press the button to do it for us on demand."
--
-- TWO THINGS WERE WRONG, and the column name hid the first.
--
-- 1 · `deliver_at_local` is not a delivery time. It is the moment a partner becomes ELIGIBLE — the
--     earliest tick that may BEGIN their brief. At the default 06:45, on a fifteen-minute cron, the
--     first tick that could start was 06:45 and the report reached READY around 07:00: exactly when
--     the partner opens the app, so some mornings it is there and some mornings it is thirty seconds
--     away, and nothing could tell you which.
--
--     06:15 gives three ticks — 06:15, 06:30, 06:45 — before seven. Not an arbitrary cushion:
--     MAX_BRIEF_ATTEMPTS is 3, so the entire retry budget now fits inside the window and a brief
--     that loses two attempts to a provider blip is still finished before anyone looks. At 06:45 the
--     second attempt landed after seven and the third never ran in time at all.
--
--     Renamed to `earliest_start_local`, because a name that says the opposite of what a column does
--     is how this survived a rewrite of the surrounding job.
--
-- 2 · The default timezone was `America/Chicago` while the operator's stated intent is 7am ET. On a
--     Chicago clock 06:15 local is 07:15 in New York — the brief would have been late against the
--     intent by construction, every day, and correctly according to its own configuration. The
--     default becomes America/New_York, which is the firm's stated morning.
--
--     Per-partner and not firm-wide on purpose: a partner in another timezone should get their own
--     morning, not New York's. This changes the DEFAULT, not anybody's explicit choice.
--
-- Sources are not a constraint on moving earlier: the sweep takes two per tick and runs all night,
-- so material is in place hours before either time.

ALTER TABLE partner_intelligence_profile RENAME COLUMN deliver_at_local TO earliest_start_local;

-- Only rows still sitting on the old defaults are moved. A partner who deliberately chose 07:30
-- chose it, and this migration has no business overriding that.
UPDATE partner_intelligence_profile
   SET earliest_start_local = '06:15'
 WHERE earliest_start_local = '06:45';

UPDATE partner_intelligence_profile
   SET timezone = 'America/New_York'
 WHERE timezone = 'America/Chicago';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0099_the_brief_is_finished_before_seven');
