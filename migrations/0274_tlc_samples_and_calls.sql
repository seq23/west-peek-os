-- 0274 · THE THREE SAMPLES, AND A CALL THE BRAND ASKED FOR (owner, 26 Oct 2026). services/tlcSamples.ts,
-- services/tlcBrandReply.ts, shared/tlc/samples.ts, shared/tlc/callSlots.ts.
--   · tlc_samples: one 3-page PDF per deal (run of show · a series of six · who's in the room), built from the
--     approved template when the brand says yes to the offer, or ahead of time (state PLANNED: the per-brand words
--     are stored, the PDF is rendered on the next pass, and nothing is sent until the brand says yes).
--   · community_mix_json: her approximate mix of the community, the wheel on page 3. Editable data.
--   · tlc_brand_reply gains the samples it carries, the call times it offered, and the time agreed + the calendar
--     event made for it once she approved the confirmation.
--   · Wynn's rules: 25–40 guests per event, flexible; a call the brand asks for is scheduled from her calendar.
CREATE TABLE IF NOT EXISTS tlc_samples (
  id           TEXT PRIMARY KEY,
  deal_id      TEXT NOT NULL UNIQUE REFERENCES tlc_deal(id),
  input_json   TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'PLANNED' CHECK (state IN ('PLANNED','READY','SENT','FAILED')),
  pdf_r2_key   TEXT,
  pdf_name     TEXT,
  problem      TEXT,
  built_at     TEXT,
  sent_at      TEXT,
  firm_scope   TEXT NOT NULL DEFAULT 'west-peek',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT OR IGNORE INTO tlc_setting (key, value) VALUES ('community_mix_json',
  '[{"label":"Operators","pct":35,"roles":["marketing","finance","product","sales","people teams"]},{"label":"Creatives","pct":35,"roles":["film","music","design","writing"]},{"label":"Founders","pct":25,"roles":["AI and tech startups","consumer brands","agencies"]},{"label":"Investors & legal","pct":5,"roles":["angels","VCs","family offices","lawyers"]}]');

ALTER TABLE tlc_brand_reply ADD COLUMN samples_id TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN offered_slots_json TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN agreed_slot TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN calendar_event_id TEXT;
-- Which step of her flow the draft is (shared/tlc/brandFlow.ts): ANSWER, SAMPLES, CALL, PROPOSAL (step 4, the first
-- time money appears), CONFIRM (step 5, agreement + invoice); the level a CONFIRM is for; the PDFs it carries.
ALTER TABLE tlc_brand_reply ADD COLUMN kind TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN tier TEXT;
ALTER TABLE tlc_brand_reply ADD COLUMN attachments_json TEXT;

INSERT OR IGNORE INTO tlc_wynn_rule (id, code, rule, source) VALUES
  ('wr_guests_25_40', 'GUESTS_25_40',
   'Every brand email and pitch says 25–40 guests per event, flexible to the brand''s needs.',
   'her rule to the coordinator, 26 Oct 2026'),
  ('wr_schedule_their_call', 'SCHEDULE_THEIR_CALL',
   'If a brand suggests a call, schedule it: offer two or three open times from her calendar, or accept the time they proposed when she is free. Never suggest a call unprompted.',
   'her rule to the coordinator, 26 Oct 2026');

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0274_tlc_samples_and_calls');
