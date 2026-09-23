-- 0239 — Cc a partner on the finished email (owner, 23 Sep 2026: "yes add cc support").
--
-- The requesting partner writes "cc Scooter" (or "cc scooter@…", or "cc Sequoia") in the request, in
-- a reply on the card's thread, or in a note on the card; that partner is copied on the finished
-- (DONE) email and on a site change's PREVIEW email.
--
--   1 · `work_card.cc_emails` — a JSON list of PARTNER addresses. Written only by
--       `services/ccPartners.ts#recordCcFrom`, only from the requesting partner's own words, only
--       with addresses the partner registry resolves; read back through `ccList`, which drops
--       anything that is not a partner, so even a hand-edited row can widen nothing.
--   2 · `preview_approval.cc_emails` — the same list, frozen onto a finished email that was FILED
--       for her instead of sent (done_reply_preview_first), so "Send it" carries the cc it was
--       composed with.
--
-- Additive; no trigger is touched.
ALTER TABLE work_card ADD COLUMN cc_emails TEXT NOT NULL DEFAULT '[]';
ALTER TABLE preview_approval ADD COLUMN cc_emails TEXT NOT NULL DEFAULT '[]';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0239_cc_a_partner_on_the_finished_email');
