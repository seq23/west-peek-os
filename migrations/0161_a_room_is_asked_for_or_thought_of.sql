-- 0161 · a Room is asked for, or thought of — and the packet says which (15 Sep 2026)
--
-- WHAT THE OPERATOR SAID. "basically the 'ask parker for a room' flow needs to change where i can
-- input what im thinking and he use my initial suggestions… i like that he can think of a room on
-- demand but i need to be able to do that OR ask for a specific type of room." And on the money:
-- "$10,000 to us per sponsor; aim for up to $40K in sponsorships per room — ideally 4 sponsors or
-- whichever number makes sense based on the logistics." And on the shelf: "rooms we turned down
-- need more info so i can see how much was proposed and what the event was about and types of
-- people to be invited."
--
-- WHAT WAS WRONG. Both packets Parker proposed (2026-08, 2026-09) were declined. The monthly job
-- proposed for the month it ran in, which left no time to sell a sponsor; the button took no input,
-- so she could not ask for a specific Room; the economics were a tier table from the pilot rather
-- than her rule; and a declined packet showed only its title and month.
--
-- THE COLUMNS. `origin` says which door the packet came through and `brief_json` carries her brief
-- so the page shows what was asked beside what Parker made of it. A requested packet is INSERTED
-- FIRST as DRAFT — the brief is on the record before a model is called — and built in place, so a
-- failed build leaves a visible row with `build_error` on it rather than nothing. The job retries
-- unbuilt drafts (one per tick) and proposes for the FOLLOWING month when that month has none.
-- `parent_packet_id` is the "propose again with changes" trail from a declined packet to its
-- successor. `sponsor_count` and `sponsor_total_usd` are what the shelf shows without opening the
-- packet.
ALTER TABLE evt_room_packet ADD COLUMN origin TEXT NOT NULL DEFAULT 'PARKER';
ALTER TABLE evt_room_packet ADD COLUMN brief_json TEXT;
ALTER TABLE evt_room_packet ADD COLUMN requested_by TEXT;
ALTER TABLE evt_room_packet ADD COLUMN sponsor_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evt_room_packet ADD COLUMN sponsor_total_usd REAL NOT NULL DEFAULT 0;
ALTER TABLE evt_room_packet ADD COLUMN risks_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE evt_room_packet ADD COLUMN commitment_md TEXT;
ALTER TABLE evt_room_packet ADD COLUMN build_error TEXT;
ALTER TABLE evt_room_packet ADD COLUMN build_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE evt_room_packet ADD COLUMN parent_packet_id TEXT;
ALTER TABLE evt_room_packet ADD COLUMN emailed_at TEXT;

-- A requested Room should not wait a day. The job ran once a day at 13:00 UTC; it now runs every
-- half hour and does ONE thing per run — build one waiting draft, or propose next month's Room if
-- that month has none, or nothing — so no tick does more than one search and one synthesis.
UPDATE scheduled_job
   SET schedule_kind = 'INTERVAL',
       interval_minutes = 30,
       daily_at_utc = NULL,
       name = 'Rooms: build what was asked for, propose next month''s',
       next_run_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
 WHERE job_key = 'monthly_room_proposal';

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0161_a_room_is_asked_for_or_thought_of');
