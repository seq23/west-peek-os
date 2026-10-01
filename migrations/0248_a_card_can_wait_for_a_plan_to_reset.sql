-- A card whose phase could not run because BOTH subscription seats (Claude Code and Codex) are out of usage is not
-- stopped and not failing: it waits for the earlier plan to reset and starts again by itself. `waiting_until` is
-- when; `waiting_for` is the sentence the card shows. Both are NULL on every other card. Additive; nothing is
-- rewritten. The sweep's own `lease_until` is what actually keeps the card out of its hands until then.
ALTER TABLE work_card ADD COLUMN waiting_until TEXT;
ALTER TABLE work_card ADD COLUMN waiting_for TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0248_a_card_can_wait_for_a_plan_to_reset');
