/**
 * A CALL THE BRAND ASKED FOR IS SCHEDULED FROM HER CALENDAR (owner, 26 Oct 2026). Wynn never suggests a call; when
 * a brand does, he offers two or three open times on her calendar, or says yes to the time they proposed when she is
 * free, and once they confirm, the event goes on her calendar with them invited (so the meeting-prep email covers
 * it the evening before). PURE: the busy times come from the caller; nothing here reads a calendar.
 *
 * Times are New York wall-clock (she and the club are in New York), 30 minutes, on weekdays between 10:00 and
 * 16:30, never within 15 minutes of anything on her calendar, one per day, starting the next working day.
 */
export const CALL_TZ = "America/New_York";
export const CALL_MINUTES = 30;
export const CALL_BUFFER_MINUTES = 15;
export interface Busy { start: number; end: number }

const parts = (at: Date): Record<string, string> =>
  Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: CALL_TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" }).formatToParts(at).map((p) => [p.type, p.value]));

/** The UTC instant of a New York wall-clock time. */
export function nyToUtc(y: number, m: number, d: number, h: number, min = 0): Date {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const p = parts(new Date(guess));
  const shown = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute));
  return new Date(guess - (shown - guess));
}

const overlaps = (start: number, busy: readonly Busy[]): boolean => {
  const end = start + CALL_MINUTES * 60_000;
  const pad = CALL_BUFFER_MINUTES * 60_000;
  return busy.some((b) => start < b.end + pad && end > b.start - pad);
};

/** Preferred start times in a day, in the order offered. */
const PREFERRED: ReadonlyArray<[number, number]> = [[11, 0], [14, 0], [10, 0], [15, 0], [12, 0], [16, 0], [10, 30], [13, 30], [15, 30], [16, 30]];

/** Up to `count` open times, one per working day, none touching anything on her calendar. */
export function freeSlots(busy: readonly Busy[], now: Date, count = 3, days = 14): string[] {
  const out: string[] = [];
  const today = parts(now);
  for (let k = 1; k <= days && out.length < count; k++) {
    const day = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day) + k, 12));
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    for (const [h, m] of PREFERRED) {
      const at = nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m);
      if (at.getTime() <= now.getTime() + 12 * 3_600_000 || overlaps(at.getTime(), busy)) continue;
      out.push(at.toISOString());
      break;
    }
  }
  return out;
}

/** Is she free for a 30-minute call starting then (in working hours, nothing within the buffer)? */
export function isFree(iso: string, busy: readonly Busy[], now: Date): boolean {
  const t = Date.parse(iso);
  if (!Number.isFinite(t) || t <= now.getTime()) return false;
  const p = parts(new Date(t));
  const minutes = Number(p.hour) * 60 + Number(p.minute);
  if (p.weekday === "Sat" || p.weekday === "Sun" || minutes < 9 * 60 || minutes + CALL_MINUTES > 18 * 60) return false;
  return !overlaps(t, busy);
}

/** "Tuesday 3 Nov, 11:00am" (Eastern time, as her template says once above the list). */
export function slotWords(iso: string): string {
  const d = new Date(iso);
  const date = new Intl.DateTimeFormat("en-US", { timeZone: CALL_TZ, weekday: "long", day: "numeric", month: "short" }).formatToParts(d);
  const get = (t: string) => date.find((x) => x.type === t)?.value ?? "";
  const time = new Intl.DateTimeFormat("en-US", { timeZone: CALL_TZ, hour: "numeric", minute: "2-digit", hour12: true }).format(d).replace(/\s/g, "").toLowerCase();
  return `${get("weekday")} ${get("day")} ${get("month")}, ${time}`;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function clock(text: string): { h: number; m: number } | null {
  const t = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)/i.exec(text) ?? /\bat\s+(\d{1,2})(?::(\d{2}))\b/i.exec(text);
  if (!t) return null;
  let h = Number(t[1]);
  const m = Number(t[2] ?? 0);
  const ap = (t[3] ?? "").toLowerCase();
  if (ap.startsWith("p") && h < 12) h += 12;
  if (ap.startsWith("a") && h === 12) h = 0;
  if (!ap && h >= 1 && h <= 6) h += 12; // "at 2:30" in a business email is the afternoon
  return h <= 23 && m <= 59 ? { h, m } : null;
}

/** A specific time the brand proposed ("Tuesday at 2pm", "Nov 12 at 3:30pm", "tomorrow at 11am"), as UTC, or null. */
export function proposedTime(text: string, now: Date): string | null {
  const t = text.toLowerCase();
  const c = clock(t);
  if (!c) return null;
  const today = parts(now);
  const base = new Date(Date.UTC(Number(today.year), Number(today.month) - 1, Number(today.day), 12));
  let day: Date | null = null;
  const md = new RegExp(`\\b(${MONTHS.join("|")})[a-z]*\\.?\\s+(\\d{1,2})\\b`).exec(t);
  if (md) {
    const month = MONTHS.indexOf(md[1]!);
    day = new Date(Date.UTC(base.getUTCFullYear(), month, Number(md[2]), 12));
    if (day.getTime() < base.getTime()) day = new Date(Date.UTC(base.getUTCFullYear() + 1, month, Number(md[2]), 12));
  } else if (/\btomorrow\b/.test(t)) {
    day = new Date(base.getTime() + 86_400_000);
  } else {
    const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\b${w}\\b`).test(t));
    if (wd >= 0) {
      const ahead = ((wd - base.getUTCDay() + 7) % 7) || 7;
      day = new Date(base.getTime() + (ahead + (/\bnext\s+\w+day\b/.test(t) && ahead < 7 ? 7 : 0)) * 86_400_000);
    }
  }
  if (!day) return null;
  return nyToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), c.h, c.m).toISOString();
}

/** Which of the times Wynn offered the brand picked ("Tuesday works", "the second one", "11am on the 3rd"), or null. */
export function pickedSlot(text: string, offered: readonly string[], now: Date): string | null {
  const t = text.toLowerCase();
  const ordinal = [/\b(?:first|1st|option 1|#1)\b/, /\b(?:second|2nd|option 2|#2)\b/, /\b(?:third|3rd|option 3|#3)\b/].findIndex((r) => r.test(t));
  if (ordinal >= 0 && offered[ordinal] && !/\b(?:none|neither|don'?t work|doesn'?t work)\b/.test(t)) return offered[ordinal]!;
  const exact = proposedTime(text, now);
  if (exact && offered.includes(exact)) return exact;
  const hits = offered.filter((iso) => {
    const p = parts(new Date(iso));
    const wd = WEEKDAYS[new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay()]!;
    return new RegExp(`\\b${wd}\\b`).test(t) && !new RegExp(`\\b${wd}\\b[^.]{0,20}\\b(?:doesn'?t|does not|won'?t|can'?t)\\b`).test(t);
  });
  return hits.length === 1 ? hits[0]! : null;
}
