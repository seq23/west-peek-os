-- 0291 · THE PARTNER-LEVELS SHEET IS MADE FOR EACH BRAND, AND A PAUSED SEND IS TOLD (owner, 4 Nov 2026).
--   · tlc_deal.large_brand: the deal's research marks the brand as large enough to fund a whole room (1), or not (0).
--     NULL is unknown, and unknown never shows the Title level (fail closed; shared/tlc/pitch.ts sponsorOf).
--   · The send-pause notice (services/tlcSendPause.ts) keeps its state in tlc_setting rows; no table is needed.
-- Additive only; no row changes.
ALTER TABLE tlc_deal ADD COLUMN large_brand INTEGER;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0291_tlc_sheet_per_brand_and_send_pause');
