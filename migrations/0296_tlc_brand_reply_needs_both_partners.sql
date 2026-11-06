-- 0296 · A BRAND REPLY SENDS ONLY ONCE BOTH PARTNERS HAVE APPROVED IT (owner, 6 Nov 2026).
--   On Wynn's brand-reply approval email Scooter is copied, and nothing is approved until Sequoia AND Scooter each
--   reply "approved" from their own authenticated address (services/tlcBrandReply.ts applyBrandReplyApproval).
--   · tlc_brand_reply_notice.approvers_json: the firm_user ids whose "approved" that email needs, fixed when it is
--     sent. NULL (every notice before this) means Sequoia alone, as it was.
--   · tlc_brand_reply.approved_by_json: the firm_user ids who have approved this draft on its current email. Cleared
--     when the draft goes back for changes, so a redraft is approved afresh.
-- Additive only; no row changes.
ALTER TABLE tlc_brand_reply_notice ADD COLUMN approvers_json TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN approved_by_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0296_tlc_brand_reply_needs_both_partners');
