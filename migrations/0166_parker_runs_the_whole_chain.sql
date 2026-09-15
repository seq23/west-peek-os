-- 0166 · Parker runs the whole chain (15 Sep 2026)
--
-- THE VERDICT. The first October packet under 0161/0164 — "The Rise of the Black Lawyer Room" —
-- was "sub par": Harvey AI at $10K with no evidence it sponsors anything, two more legal vendors
-- from memory (three legal logos in one room), five steakhouses, agenda lines. The operator showed
-- the standard she meant, and it is a CHAIN: research the sponsor's real programme and the people
-- who run it (name, title, the page they were read from); ideate three concepts, compare, commit;
-- a venue chosen with cultural intent and a comp; the run of show to the minute with named roles;
-- a line budget with its basis; a sponsorship structure priced so sponsorship = cost + the firm's
-- keep; the cold email to the named contact; and a PDF she can download. Her rules: "parker should
-- be able to find sponsors without my prompt and find others when i give him one"; "he needs to
-- send the room of the month to both me and scooter and he needs to intro himself"; and "'up to 4
-- sponsors' shouldn't be a hard rule — always push back and tell me if I'm wrong".
--
-- WHERE IT RUNS. Several model calls and a dozen page fetches do not fit one cron tick on the Free
-- plan, so the build is a work card on Parker's desk (kind ROOM_PACKET) that the employee sweep
-- works a stage or two at a time; `build_stage` says where it is and `build_state_json` carries
-- what earlier stages found, so a tick that dies loses one stage, not the packet.

-- The packet: the chain's outputs, and the PDF.
ALTER TABLE evt_room_packet ADD COLUMN build_stage TEXT NOT NULL DEFAULT 'QUEUED';
ALTER TABLE evt_room_packet ADD COLUMN build_state_json TEXT;
ALTER TABLE evt_room_packet ADD COLUMN work_card_id TEXT;
-- The three concepts, compared; the chosen one is flagged and the other two are the appendix.
ALTER TABLE evt_room_packet ADD COLUMN concepts_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evt_room_packet ADD COLUMN concept_choice_md TEXT;
-- To the minute, with the named role on every line.
ALTER TABLE evt_room_packet ADD COLUMN run_of_show_json TEXT NOT NULL DEFAULT '[]';
-- The cold email to the rank-1 sponsor's named contact, in Sequoia's voice. A draft; never sent.
ALTER TABLE evt_room_packet ADD COLUMN pitch_email_json TEXT;
-- What the firm's own records can put in the room. Counts and archetypes, never fabricated people.
ALTER TABLE evt_room_packet ADD COLUMN invite_check_json TEXT;
-- Where Parker disagreed with the brief, and why.
ALTER TABLE evt_room_packet ADD COLUMN pushback_md TEXT;
-- The downloadable packet (document.doc_type = 'ROOM_PACKET').
ALTER TABLE evt_room_packet ADD COLUMN document_id TEXT;

-- A venue is chosen for a reason, has a minimum, and one is the fallback.
ALTER TABLE evt_packet_venue ADD COLUMN why_here TEXT;
ALTER TABLE evt_packet_venue ADD COLUMN room_minimum_usd REAL;
ALTER TABLE evt_packet_venue ADD COLUMN is_fallback INTEGER NOT NULL DEFAULT 0;

-- A sponsor prospect qualifies only with evidence, and a contact is a name read off a page.
-- (contact_name, contact_email and contact_url exist since 0044; the rest are new.)
ALTER TABLE evt_sponsor_prospect ADD COLUMN evidence_url TEXT;
ALTER TABLE evt_sponsor_prospect ADD COLUMN evidence_note TEXT;
ALTER TABLE evt_sponsor_prospect ADD COLUMN contact_title TEXT;
ALTER TABLE evt_sponsor_prospect ADD COLUMN contact_source_url TEXT;
ALTER TABLE evt_sponsor_prospect ADD COLUMN fit_argument TEXT;
ALTER TABLE evt_sponsor_prospect ADD COLUMN rank INTEGER;
ALTER TABLE evt_sponsor_prospect ADD COLUMN sponsorship_summary TEXT;

CREATE INDEX IF NOT EXISTS idx_evt_room_packet_stage ON evt_room_packet (status, build_stage);

-- The job's description on the Work page says what it does now: it opens the card; the sweep builds.
UPDATE scheduled_job
   SET name = 'Rooms: queue what was asked for, propose next month''s',
       interval_minutes = 15
 WHERE job_key = 'monthly_room_proposal';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0166_parker_runs_the_whole_chain');
