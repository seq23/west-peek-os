-- 0245 — A subscription seat that has run out of usage is skipped until it resets, not retried per call.
--
-- WHY. The two seats (0187) draw on flat-fee plans: Claude Code on the owner's Claude Max, Codex on
-- her ChatGPT Plus. A plan has a usage window. When the window is spent the CLI does not fail the way
-- a dead process does — it prints a sentence ("usage limit reached, resets at …") and, depending on the
-- version, may exit 0. The claimer took any non-empty output as the answer, so the sentence could be
-- saved as a card's answer and the chain would never reach the next lane (the Codex seat, then the
-- free lanes). And where it did fail, every following call still parked a run and waited up to the
-- router's ninety seconds on a seat that would refuse until its window reset.
--
-- WHAT THIS ADDS. Two nullable columns on the row that IS the availability signal:
--
--   exhausted_until   ISO. While it is in the future the seat reads UNAVAILABLE — `allSeatAvailability`
--                     and `laneAvailability` both consult it — so nothing is parked and nothing waits.
--                     The reason names the seat and the time it will be tried again.
--   exhausted_reason  The CLI's own sentence (truncated), so "why did the Mac skip Claude Code" is
--                     answerable from the row.
--
-- WHY NOT `provider_registry.paused_until`. That column is the OWNER'S stand-down (0185): a card button
-- with a person's name behind it, read by every lane picker and guarded by validate:stopped-cards.
-- A seat running out of usage is a fact the machine reports, not a decision a person made, and mixing
-- the two would make "who switched this lane off" unanswerable.
--
-- AND IT HEALS ITSELF. The cooldown is a timestamp, not a flag: when it passes the seat is offered
-- work again with no one having to remember. A seat that is still limited when tried again costs one
-- fast failed run (the chain moves straight on) and re-arms the cooldown. A seat that answers clears
-- it immediately (`reportRun`).
--
-- Additive; nothing existing reads these columns, and a row with both NULL behaves exactly as before.
ALTER TABLE subscription_seat_device ADD COLUMN exhausted_until TEXT;
ALTER TABLE subscription_seat_device ADD COLUMN exhausted_reason TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0245_a_seat_out_of_usage_is_skipped_until_it_resets');
