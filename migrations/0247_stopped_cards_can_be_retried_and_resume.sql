-- 0247 — A card the spend setting stopped is described truthfully, offers a retry, and resumes by itself.
--
-- WHY (1 Oct 2026). Parker's November 2026 Room packet (card wc_26f988c2-…) stopped on
-- `free_only_cannot_serve_protected_work` — the spend lever was on Free only and the work needs a paid model.
-- The card said "Parker tried three times and could not get this done" and offered four doors: type an answer,
-- rewrite the job, drop it, send it to an engineer. None said *try it again*, and nothing resumed it when the
-- setting was fixed. #215 made NEW stops of that kind read correctly; the card the owner is looking at was
-- stopped before it, and a block stores its wording and doors as text at the moment it stops, so it kept the
-- old ones.
--
-- WHAT THIS DOES.
--   1 · `work_card.block_context` — what was true of the world when the card stopped, as JSON, for a stop the
--       world can undo by itself. Today only the spend setting writes it: {"lever":"FREE_ONLY","seat_search":false}.
--       The sweep compares it with the present (`releaseSpendSettingBlocks`) and puts the card back in the queue
--       when the setting now permits the work and did not before. Once per change; never a loop.
--   2 · BACKFILL. Every card still BLOCKED whose engineer note records a spend-setting refusal is rewritten to the
--       block #215 now writes for a new one: the spend-setting wording, the doors "try it again / give it to
--       somebody else / drop it", and the marker (`block_lane = 'spend_lever'`) the release reads. The recorded
--       state is the one it stopped in — Free only, no search-capable seat — so the first tick after the setting
--       changes releases it. The wording is the catalogue's own (src/shared/work/blocks.ts); a test asserts the
--       two are identical so they cannot drift.
--
-- NOT DONE HERE: the lever itself. Moving production off Free only is the owner's act (governance.policy_change).
-- A card stopped for any OTHER reason is untouched by the backfill; every stopped card gets its retry door when it
-- is read (`withRetryDoor`), which needs no data change at all.
ALTER TABLE work_card ADD COLUMN block_context TEXT;

-- THE TRIGGER (0173) REFUSES ANY UPDATE THAT LEAVES A BLOCKED CARD WITHOUT "what was being done" AND "who can
-- clear it", and a refused statement here would abort the whole migration and the deploy with it. Every card this
-- touches was blocked through `blockCard` and has both; the two COALESCEs make that true rather than assumed, so a
-- card from before the standard cannot be the thing that stops a release.
UPDATE work_card
   SET block_reason       = 'a_lane_refused_the_work',
       block_trying       = COALESCE(NULLIF(trim(block_trying), ''), title),
       block_who          = COALESCE(block_who, 'SEQUOIA'),
       block_stopped      = 'The spend setting is on Free only, and this work needs a paid model, so it was held back.',
       block_needed       = 'Set the spend setting to Moderate on the AI page, then try it again — or drop it for this month.',
       block_actions_json = '[{"key":"RETRY","label":"Try it again now","hint":"Puts the work straight back in the queue. Worth a press when whatever stopped it has since been fixed — a setting changed, an account topped up, the Mac switched back on."},{"key":"HAND_ON","label":"Give it to somebody else","hint":"Pick a different employee. They start it again from the beginning, with a note saying why it moved."},{"key":"DROP","label":"Drop it","hint":"Decide it is not worth doing. Kept on the record with your reason, and they stop asking."}]',
       block_lane         = 'spend_lever',
       block_lane_name    = 'the spend setting',
       block_context      = '{"lever":"FREE_ONLY","seat_search":false}',
       next_action        = 'Held back by the spend setting (Free only). It resumes by itself when the setting changes, or you can try it again.',
       description        = substr(COALESCE(description, '') || char(10) || '• Re-read 1 Oct 2026: this stopped because the spend setting was on Free only, not because the employee could not do it.', 1, 16000),
       updated_at         = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE state = 'BLOCKED'
   AND COALESCE(block_lane, '') <> 'spend_lever'
   AND (description LIKE '%free_only_cannot_serve_protected_work%' OR description LIKE '%free_only_no_free_model_available%');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0247_stopped_cards_can_be_retried_and_resume');
