-- 0290 · WYNN ANSWERS ONLY WHEN ASKED, AND ANSWERS EVERYONE ON THE THREAD (owner, 2 Nov 2026). services/tlcBrandReply.ts.
--   · tlc_deal.waiting_since: a brand reply that needs no answer (passed on, reviewing, asked nothing) gets no draft;
--     the deal is marked waiting on them from that time, cleared when they write again with something to answer.
--   · tlc_brand_reply.send_to / send_cc_json: who the answer goes to, taken from the brand's latest message (reply-all:
--     its sender To, everyone else on its To and Cc copied, our own addresses left out). NULL on older rows, which
--     go to the deal's contact as before. The approval email shows both.
-- Additive only; no row changes.
ALTER TABLE tlc_deal ADD COLUMN waiting_since TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN send_to TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN send_cc_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0290_tlc_reply_only_when_asked_and_reply_all');
