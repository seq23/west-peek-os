-- 0204 — The meeting is a live room (Phase C, owner-approved 18 Sep 2026).
--
-- Phase B gave a meeting three faces and built the BEFORE and AFTER. This is the DURING: the room
-- records itself (Nova-3 with speaker turns, Whisper when Nova-3 is not there), writes the After
-- draft while people talk, answers a question asked out loud or typed, builds a table or a chart on
-- the spot from the firm's own record, and pulls an employee in for a task whose result comes back
-- to the room. NOTHING IN THIS ROOM WRITES A RECORD FROM VOICE. A question — spoken or typed —
-- produces a saved block (`meeting_artifact`), a work card (preview-first, through the ordinary
-- door), or a DRAFT (`meeting_after_draft`); a person clicks Phase B's approve route to make any of
-- it a decision, a commitment, an open question or a stage move. `validate:voice-is-read-only`
-- reads the Phase C services and fails if that ever stops being true.
--
-- WHAT IS ADDED, AND WHY IT IS SMALL. Phase B already built `meeting_artifact` (the block) and
-- `meeting_after_draft` (the rolling summary reuses it — idempotent over the input fingerprint).
-- Three columns on the block say where it came from, so the During face can tell an answer to a
-- typed question from one to a spoken one, and a finished work card from a chart:
--
--   asked_text     the question this block answers, as the room heard or read it
--   asked_via      TEXT | VOICE | SYSTEM — SYSTEM is a card's result returning to the room
--   work_card_id   the card whose result this is, so one card returns exactly one block
--
-- The Google Meet columns on `meeting` (0202/0203: google_event_id, meet_conference_id, source,
-- recording_ref) belong to the sibling phase and are not added here.

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0204_the_meeting_is_a_live_room');

ALTER TABLE meeting_artifact ADD COLUMN asked_text TEXT;
ALTER TABLE meeting_artifact ADD COLUMN asked_via TEXT CHECK (asked_via IS NULL OR asked_via IN ('TEXT','VOICE','SYSTEM'));
ALTER TABLE meeting_artifact ADD COLUMN work_card_id TEXT REFERENCES work_card (id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_artifact_card ON meeting_artifact (work_card_id) WHERE work_card_id IS NOT NULL;

-- ── The action key (P4 convention) ────────────────────────────────────────────────────────────
-- One key for the room's read-only acts: asking, querying the record, transcribing a spoken
-- question. Registered so the audit trail names what happened in the room rather than borrowing
-- `ai.run`. Saving the block stays under `meeting.note.add` (Phase B: a block is a note in a
-- different shape); opening a card stays under `work_card.create`; the rolling draft stays under
-- `meeting.commitment.create` (Phase B: drafting is preparing a proposal).
INSERT INTO action_type (key, name, description, is_external_effect, is_reserved) VALUES
  ('meeting.room.ask', 'Ask the live room', 'Ask a question in a live meeting, typed or spoken (push-to-talk). Read-only: the answer, table or chart is saved as a block on the meeting, an employee may be handed a preview-first work card, and the After draft may be refreshed. Nothing asked here becomes a decision, commitment, question or stage move without a partner approving it.', 0, 0)
ON CONFLICT (key) DO NOTHING;
