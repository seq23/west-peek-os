-- 0143 — The named-employee half of `company.update` could never match anybody.
--
-- Migration 0125 recorded `{"roles":["MANAGING_PARTNER","INVESTMENT_TEAM"],"employees":["Wyatt"]}`
-- and every Actor carries a seat id, `aie_wyatt`. So `employees.includes(actor.aiEmployeeId)` was
-- comparing "Wyatt" to "aie_wyatt" and was false for everybody, for ever.
--
-- It failed in the SAFE direction, which is exactly why nothing noticed for a month: Wyatt was
-- denied by a rule written specifically to permit him, and a denial from an authorization check
-- looks identical whether the rule meant it or not. The operator's own words on 21 Aug were "the
-- MPs should be able to edit and the host employee" — the host employee half never worked.
--
-- `authorize.ts` now canonicalises names to seat ids as it reads the row, so both spellings work
-- and the comparison stays exact. This migration fixes the row itself, because a row that says
-- something different from what it means will mislead the next person to read it even after the
-- code stops being fooled by it.
--
-- Sixth instance of the same name-versus-id divergence in this codebase. `seatId()` in
-- src/shared/intake/emailTriggers.ts carries the list.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0143_the_employee_named_in_a_restriction_is_a_seat_not_a_word');

UPDATE restricted_action
   SET allowed_json = '{"roles":["MANAGING_PARTNER","INVESTMENT_TEAM"],"employees":["aie_wyatt"]}'
 WHERE key = 'company.update';
