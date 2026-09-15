-- 0164 · a venue always has an estimated cost, and a Room has a full budget (15 Sep 2026)
--
-- Operator, after the first packet under 0161 showed "$0–$0" beside every venue: "the venues need
-- an educated guess at cost. no venue is truly $0 and best guesses using comps should be used";
-- and "the final math on what it costs and what's left over needs to be thought through from the
-- POV of a senior event designer and coordinator — food / entertainment / speakers / etc. all
-- possible costs need to go into this".
--
-- A venue keeps the PUBLISHED price where the cited page states one (price_low_usd / price_high_usd,
-- unchanged) and now also carries an ESTIMATE with the comparable it rests on — never null, never
-- zero. The budget itself lives in economics_json on the packet (lines, basis, and the sponsor
-- scenarios); no new column is needed for it.
ALTER TABLE evt_packet_venue ADD COLUMN estimate_low_usd REAL;
ALTER TABLE evt_packet_venue ADD COLUMN estimate_high_usd REAL;
ALTER TABLE evt_packet_venue ADD COLUMN estimate_basis TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0164_a_venue_has_a_cost_and_a_room_has_a_budget');
