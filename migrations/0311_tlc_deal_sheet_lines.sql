-- 0311 · A BRAND'S OWN LINES ON ITS ONE-PAGER (16 Nov 2026, Notion).
--
-- Notion asked what we would want from them as a founding partner, the fee, who is in the room and what guests would
-- build with Notion. Her words: "this needs to be a re-worked 1 pager attached to an email". The partner one-pager
-- (shared/tlc/pitch.ts renderBrandPitch) now answers "what guests build with <Brand>" and "what we'd ask beyond the
-- fee"; the concrete, brand-specific examples are set per deal, like series_json: {"build": [...], "asks": [...]}.
-- Unset, the sheet uses its general lines for the brand's kind.
--
-- Additive: one new nullable column. Nothing is rewritten.
ALTER TABLE tlc_deal ADD COLUMN sheet_json TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0311_tlc_deal_sheet_lines');
