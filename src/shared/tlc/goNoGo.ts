/**
 * THE GO / NO-GO DATE (owner's ask, decided 31 Oct 2026). Each club has one, stored on the club (tlc_event.go_no_go_date,
 * migration 0282): seven weeks before the event, moved back to the Friday when that falls on a weekend, so it is a
 * working day (Sat 23 Jan 2027 → Fri 4 Dec 2026). The topic-switch deadline (15 Nov for January) stays as it is.
 *
 * On that date, a club with no sponsor committed in writing is DROPPED: its status becomes CANCELLED with dropped_at and
 * dropped_reason (never deleted), its topic goes back on the ideas list, and Wynn says so in the Monday roundup.
 */
export const GO_NO_GO_WEEKS = 7;
export const DROPPED_NO_SPONSOR = "No sponsor had committed in writing by the go/no-go date";

/** "Committed in writing": a deal that reached AGREED or beyond (cash or in kind). */
export const COMMITTED_STAGES = ["AGREED", "PAID", "DELIVERED"] as const;

/** YYYY-MM-DD, seven weeks before the event, back to Friday from a weekend. */
export function goNoGoDate(eventDate: string): string {
  const d = new Date(`${eventDate.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - GO_NO_GO_WEEKS * 7);
  const dow = d.getUTCDay();
  if (dow === 6) d.setUTCDate(d.getUTCDate() - 1);
  if (dow === 0) d.setUTCDate(d.getUTCDate() - 2);
  return d.toISOString().slice(0, 10);
}

/** The stored date, or the rule's when a row predates it. */
export function goNoGoOf(ev: { event_date: string; go_no_go_date?: string | null }): string {
  return (ev.go_no_go_date ?? "").slice(0, 10) || goNoGoDate(ev.event_date);
}

/** Is the go/no-go date reached (on or after the day, UTC)? */
export function goNoGoReached(ev: { event_date: string; go_no_go_date?: string | null }, now: Date): boolean {
  return now.toISOString().slice(0, 10) >= goNoGoOf(ev);
}

/** "Fri 4 Dec 2026" */
export function dayWords(yyyyMmDd: string): string {
  const d = new Date(`${yyyyMmDd.slice(0, 10)}T12:00:00.000Z`);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).replace(/,/g, "");
}
