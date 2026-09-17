-- 0180 · A draft proposed event kit with every monthly proposal (17 Sep 2026)
--
-- Scooter got one by hand for the September livestream: the header, the published description, the
-- run of show with an On Screen column, the discussion guide, and two social posts. It is what
-- makes a proposal something to react to rather than a menu — so Parker now writes ONE with every
-- monthly proposal, Rooms AND Workshops, for the single angle he would run.
--
-- `event_kit_json` holds the kit itself (see shared/events/eventKit.ts `EventKit`). One nullable
-- column rather than nine tables, for the same reason `workshop_json` is one: nothing else reads
-- its parts, and a kit is rewritten whole whenever the chain rebuilds.
--
-- `event_kit_deliverable_id` is the LINK, and the link is the point. The owner's own product says
-- it in West Peek Live's instruction pages: "The email never carries the text, so correcting a page
-- corrects it for everyone who already has the link." A draft changes; an attachment cannot. So the
-- kit is filed as a deliverable on the partners' Home, the email carries the TL;DR and the link,
-- and a rebuild rewrites the same deliverable rather than sending a second copy of a stale one.
ALTER TABLE evt_room_packet ADD COLUMN event_kit_json TEXT;
ALTER TABLE evt_room_packet ADD COLUMN event_kit_deliverable_id TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0180_a_draft_event_kit_with_every_proposal');
