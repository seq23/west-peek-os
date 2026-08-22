-- Work cards that named an employee instead of identifying one, and two real arrivals cancelled by
-- a test.
--
-- TWO REPAIRS, BOTH OF THINGS THIS SESSION BROKE.
--
-- 1 · OWNER FORMAT. `DEAL_INTAKE_EMPLOYEE` is the display string "Wyatt" and the intake path wrote
--     it straight into `work_card.owner_id`, while every other path wrote `aie_wyatt`.
--     `runEmployeeWork` resolves an owner with `ai_employee WHERE id = ?`, so a card owned by a NAME
--     answered "That employee does not exist" and could never be worked. `createWorkCardInternal`
--     now resolves names to ids, which fixes every future card; these are the ones already written.
--
--     Matched on `name` rather than by hardcoding the pairs, so a seat renamed later still resolves
--     and nothing here has to be kept in step with the roster by hand.
--
-- 2 · TWO CANCELLED ARRIVALS. Helios Grid and Vantage Robotics arrived by email at 01:36 and 01:42
--     on 22 Aug and were CANCELLED at 01:43 by `fu_browser_agent` — the Cloudflare Access service
--     token, which is to say by this project's own review agent while it was walking the interface.
--     Nobody at the firm decided those were not worth working.
--
--     Put back to OPEN rather than left cancelled: the companies are still in the funnel, so the
--     cards are the only thing telling anybody to look at them. Scoped to those two ids and that one
--     actor, so a card a PARTNER cancelled is never silently reopened underneath her — the whole
--     point of a pass pile is that a decision to stop stays stopped.
UPDATE work_card
   SET owner_id = (SELECT e.id FROM ai_employee e WHERE e.name = work_card.owner_id)
 WHERE owner_type = 'AI'
   AND owner_id NOT LIKE 'aie_%'
   AND EXISTS (SELECT 1 FROM ai_employee e WHERE e.name = work_card.owner_id);

UPDATE work_card
   SET state = 'OPEN'
 WHERE state = 'CANCELLED'
   AND title IN ('Deal flow: Helios Grid', 'Deal flow: Vantage Robotics')
   AND EXISTS (
     SELECT 1 FROM event_record ev
      WHERE ev.object_type = 'work_card'
        AND ev.object_id = work_card.id
        AND ev.event_type = 'work_card.state_changed'
        AND ev.actor_id = 'fu_browser_agent'
   );

-- OR IGNORE here and NOWHERE else in this file: the version marker is the one row where a re-apply
-- is genuinely a no-op rather than a swallowed failure.
INSERT OR IGNORE INTO schema_version (migration) VALUES ('0139_repair_the_work_cards_that_could_never_be_worked');
