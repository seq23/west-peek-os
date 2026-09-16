-- 0171 · Monthly Workshops beside the Rooms (16 Sep 2026)
--
-- Operator: "we are introducing monthly workshops in addition to Rooms … the same workflow as
-- Rooms: a packet with three concepts compared, one chosen." A Workshop is the SAME packet on the
-- SAME table — the same queue, the same card on Parker's desk, the same stage-per-tick sweep, the
-- same keep/dismiss door — with a `kind`. Every row that exists today is a Room.
--
-- `workshop_json` holds what only a Workshop has: the promise, the exercises, what attendees
-- leave with, the facilitator, the delivery plan on West Peek Live (Workshops are virtual only —
-- no venue rows are ever written for one), the invitation sequence, the optional sponsorship and
-- the budget. One nullable column rather than twelve, because a Room never reads it.
ALTER TABLE evt_room_packet ADD COLUMN kind TEXT NOT NULL DEFAULT 'ROOM' CHECK (kind IN ('ROOM','WORKSHOP'));
ALTER TABLE evt_room_packet ADD COLUMN workshop_json TEXT;

-- A scheduled Workshop is an event of kind WORKSHOP. `event_class` keeps its vocabulary (a Workshop
-- is not a ROOM; it lands on OTHER with event_type WORKSHOP); `kind` says which series it is in.
ALTER TABLE evt_event ADD COLUMN kind TEXT NOT NULL DEFAULT 'ROOM' CHECK (kind IN ('ROOM','WORKSHOP'));

CREATE INDEX IF NOT EXISTS idx_room_packet_kind_month ON evt_room_packet (firm_scope, kind, proposed_for_month);

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0171_monthly_workshops');
