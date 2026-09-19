/**
 * A MEETING WHOSE TIME HAS PASSED IS NOT "COMING UP" (19 Sep 2026).
 *
 * WHAT PRODUCTION SHOWED. The Meetings masthead read "Nothing today. The next one is Wed, Sep 16
 * at 08:00 AM" on Saturday 19 September, and "Coming up" listed calendar events from the 16th and
 * the 18th. The calendar sync imports a window that reaches seven days BACK (so a meeting held
 * before the sync was switched on still gets a record), writes every event as SCHEDULED, and the
 * list treated SCHEDULED as upcoming regardless of the date. Nothing ever moved a synced meeting
 * out of SCHEDULED unless a person opened the room or a transcript arrived.
 *
 * THE RULE, decided here so the server and the page cannot disagree about it:
 *
 *   · A meeting is PAST once `scheduled_at + MEETING_SETTLES_AFTER_MINUTES` is behind the clock.
 *     The schema carries no end time, so ninety minutes stands in for one — long enough for any
 *     meeting this firm takes, short enough that a morning meeting is off "Coming up" by lunch.
 *   · A past SCHEDULED meeting is HELD, with nothing on the record: the calendar says it happened
 *     and no capture says what came of it. The server settles synced rows to HELD on that basis
 *     (`settlePastMeetings`); the page files ANY past SCHEDULED row under "On the record" with that
 *     reading, so a row the sync has not reached yet is still never listed as upcoming.
 *   · The masthead's "next one" is the first SCHEDULED meeting whose time is not past.
 *
 * Pure, so `tests/pastMeetings.test.ts` pins it: a past-dated SCHEDULED meeting never appears
 * under "Coming up", whatever its source, and one still ahead always does.
 */

export const MEETING_SETTLES_AFTER_MINUTES = 90;

export interface SplittableMeeting {
  status: string;
  scheduled_at: string | null;
  occurred_at: string | null;
}

/** True when the meeting's time, plus the settle window, is behind `now`. Unknown times are never past. */
export function isPastMeeting(m: SplittableMeeting, now: Date): boolean {
  if (!m.scheduled_at) return false;
  const t = Date.parse(m.scheduled_at);
  if (Number.isNaN(t)) return false;
  return t + MEETING_SETTLES_AFTER_MINUTES * 60_000 < now.getTime();
}

/** "Coming up" is SCHEDULED and not past. Everything else is on the record. */
export function isUpcoming(m: SplittableMeeting, now: Date): boolean {
  return m.status === "SCHEDULED" && !isPastMeeting(m, now);
}

/** The reading a past SCHEDULED row carries on the record, since nothing was captured from it. */
export const HELD_NOTHING_ON_THE_RECORD = "held, nothing on the record";

function timeOf(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const t = Date.parse(value);
  return Number.isNaN(t) ? fallback : t;
}

/**
 * Split and sort the list the way a partner reads a calendar: soonest first for what is coming,
 * newest first for what happened. A row with no time goes last in either list, never first.
 */
export function splitMeetings<T extends SplittableMeeting>(rows: readonly T[], now: Date): { upcoming: T[]; past: T[] } {
  const upcoming = rows.filter((m) => isUpcoming(m, now)).sort((a, b) => timeOf(a.scheduled_at, Infinity) - timeOf(b.scheduled_at, Infinity));
  const past = rows
    .filter((m) => !isUpcoming(m, now))
    .sort((a, b) => timeOf(b.occurred_at ?? b.scheduled_at, -Infinity) - timeOf(a.occurred_at ?? a.scheduled_at, -Infinity));
  return { upcoming, past };
}
