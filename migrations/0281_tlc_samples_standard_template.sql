-- 0281 · HER FINAL PINECONE DOCUMENT IS THE STANDARD SAMPLES TEMPLATE FOR EVERY BRAND (owner, 30 Oct 2026: "yes. make
-- it a real template"). shared/tlc/samples.ts, services/tlcSamples.ts. Data only.
--   · Every brand is told 25 to 100+ guests per event, flexible to its goals (was 25–40): Wynn's standing rule says so.
--   · The community wheel's stored mix takes her final words: "Creators" (not "Creatives"), and the operators'
--     intrapreneur note. Changed only where it is still the seeded default, so an edited mix is never overwritten.
--   · Rows already SENT are untouched: their input and their stored PDF stay exactly as they went.
UPDATE tlc_wynn_rule SET rule = 'Every brand email and pitch says 25 to 100+ guests per event, flexible to the brand''s needs.'
 WHERE code = 'GUESTS_25_40';

UPDATE tlc_setting SET value =
  '[{"label":"Operators","pct":35,"roles":["marketing","finance","product","sales and people teams"],"note":"many are intrapreneurs building side businesses with AI tools like Claude and Codex outside work"},{"label":"Creators","pct":35,"roles":["film","music","design","writing and content"]},{"label":"Founders","pct":25,"roles":["AI and tech startups","consumer brands","agencies"]},{"label":"Investors & legal","pct":5,"roles":["angels","VCs","family offices","lawyers"]}]'
 WHERE key = 'community_mix_json'
   AND value = '[{"label":"Operators","pct":35,"roles":["marketing","finance","product","sales","people teams"]},{"label":"Creatives","pct":35,"roles":["film","music","design","writing"]},{"label":"Founders","pct":25,"roles":["AI and tech startups","consumer brands","agencies"]},{"label":"Investors & legal","pct":5,"roles":["angels","VCs","family offices","lawyers"]}]';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0281_tlc_samples_standard_template');
