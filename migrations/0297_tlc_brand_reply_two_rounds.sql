-- 0297 · BRAND REPLIES GO IN TWO ROUNDS (owner, 6 Nov 2026: "any emails where they are ready to send pricing info
--   they stop and send me something for approval first and then the next round of it goes to me + scooter for both
--   approval"; "he should wait for both our inputs").
--   · tlc_brand_reply.round: NULL or 'HER' = round 1, to Sequoia alone. 'PARTNERS' = round 2 (a pricing draft she
--     approved), to Sequoia and Scooter; nothing reaches the brand until both reply approved.
--   · tlc_brand_reply.inputs_json: round 2's answers so far on the current email, {firm_user_id: {approved, note, at}}.
--     Wynn redrafts only once every partner on it has answered; cleared when a new round-2 email goes.
--   · tlc_brand_reply.page_token: the private link to round 2's live draft page (their email, the answer, the sheet,
--     every note so far); the partners read and comment there instead of a PDF going back and forth.
--   · tlc_brand_reply.previous_draft: the draft before the last redraft, so the email shows what Wynn changed.
--   · tlc_deal.offer_json: an offer the partners set for one brand (a quarterly series: year, events, per-event price,
--     total), shown on that brand's sheet and draft page in place of the series-of-six line.
-- Additive only; no row changes.
ALTER TABLE tlc_brand_reply ADD COLUMN round TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN inputs_json TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN page_token TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN previous_draft TEXT;
ALTER TABLE tlc_deal ADD COLUMN offer_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0297_tlc_brand_reply_two_rounds');
