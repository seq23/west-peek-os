-- 0224 — The partner adds her own words to the finished email (owner, 22 Sep 2026).
--
-- The other half of 0223. Reading Porter's DONE reply before it goes is worth little if the only
-- two answers are "send it" and "send it back": what she actually wanted on Scooter's forms card
-- was to send Porter's report WITH a line of her own in it. Today that was done by editing the
-- rendered body of a `preview_approval` row by hand.
--
-- So the card carries her words. `requester_notes` is free text a MANAGING PARTNER sets through the
-- card API (`PATCH /api/work-cards/:id`, `authorize()` then an explicit Managing-Partner check —
-- an analyst with `work_card.update` may move a card, not speak for the firm); `requester_notes_by`
-- and `requester_notes_at` record who and when, so the section can be labelled in their own name.
--
-- WHERE IT SHOWS: the DONE reply and nowhere else, as a section "From <first name>" whose bullets
-- are her lines, placed immediately before "Your call". Not on RECEIVED (the work has not happened
-- yet), not on PLAN or QUESTION (those carry Porter's question, and her answer to it is the reply),
-- not on STUCK. Additive: a card with no notes renders exactly the email it rendered before.

ALTER TABLE work_card ADD COLUMN requester_notes TEXT;
ALTER TABLE work_card ADD COLUMN requester_notes_by TEXT;
ALTER TABLE work_card ADD COLUMN requester_notes_at TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0224_the_partner_adds_her_own_words_to_the_finished_email');
