/**
 * The one SQL fragment the note readers share with the live path (tier 4, migration 0215).
 *
 * In its own file so `meetingAfter.ts` and `meetingRoom.ts` can read it without importing
 * `meetLive.ts`, which imports the room (for the rolling draft) — the same clause in one place,
 * with no cycle.
 *
 * A live import the official Meet transcript has superseded is corroboration: its notes stay on
 * the record, and the After draft and the room's context read the official transcript instead of
 * the same conversation twice.
 */
export const LIVE_PROVIDER = "GOOGLE_MEET_LIVE" as const;

export const NOT_SUPERSEDED_NOTE_CLAUSE =
  "(transcript_import_id IS NULL OR transcript_import_id NOT IN (SELECT id FROM transcript_import WHERE superseded_by IS NOT NULL))";
