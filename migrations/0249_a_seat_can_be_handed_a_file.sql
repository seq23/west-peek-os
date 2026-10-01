-- 0249 — A subscription seat may be handed a PICTURE or a DOCUMENT, but only by a claimer that PROVED it can read one.
--
-- WHY (1 Oct 2026). The owner's rule: when Claude Code is out of usage, Codex must be able to take the work — any work.
-- Work that carries a deck, a term sheet or a screenshot was the exception: a seat was never offered an attachment
-- because the queue carries text and an adapter that dropped a file would answer confidently about something it
-- never saw. This adds the transport; it does NOT turn routing on by itself. A seat is offered a file only when the
-- claimer on that Mac declared `read_image:<seat>` / `read_document:<seat>`, and it declares those only after
-- `scripts/probes/seat-attachments-probe.mjs` has PROVEN them there (the probe writes the proof file the claimer reads).
--
-- WHAT THIS ADDS (additive; nothing existing reads these):
--   attachments_json        the descriptors for the files parked with the run: [{n, kind, media_type, label, key, bytes}].
--                           The BYTES are in R2 under `seat-attachments/<run id>/…`, never in D1.
--   attachments_cleared_at  when those objects were deleted. They live only as long as the run does.
ALTER TABLE subscription_seat_run ADD COLUMN attachments_json TEXT;
ALTER TABLE subscription_seat_run ADD COLUMN attachments_cleared_at TEXT;

INSERT OR IGNORE INTO schema_version (migration) VALUES ('0249_a_seat_can_be_handed_a_file');
