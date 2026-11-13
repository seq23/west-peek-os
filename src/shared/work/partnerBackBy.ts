/**
 * A PARTNER IS TAKEN AT HIS WORD ON TIMING (owner, 13 Nov 2026; migration 0302).
 *
 * A partner answered a preview: "looks great … i will come back with edits this weekend." The OS
 * would have reminded him the next morning that it was still waiting. When the partner who asked
 * says when he will be back, that is when the card expects him: it records the time and his own
 * words, and sends no reminder about the block before the time has passed.
 *
 * PURE. Reads one thing: a first-person promise to return ("I will come back / get back / send /
 * follow up …") that names when. The time returned is the START OF THE WORKING DAY AFTER the
 * window he named, in Central time: "this weekend" → Monday 8:00 AM CT; "tomorrow" → the day
 * after, 8:00 AM CT. A sentence about anything else ("the launch is this weekend") is not a promise.
 */
export interface PartnerBack {
  /** ISO time before which nothing reminds him. */
  back_at: string;
  /** His sentence, as he wrote it. */
  words: string;
  /** The window he named: "this weekend", "tomorrow", "Monday"… */
  when: string;
}

const PROMISE = /\b(?:i|we)(?:\s+will|'ll|\s+am\s+going\s+to|\s+can|\s+plan\s+to|\s+should)\s+(?:come\s+back|get\s+back|circle\s+back|be\s+back|follow\s+up|send|share|have|reply|respond|review|look|go\s+through|take\s+a\s+look)\b/i;
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WHEN = new RegExp(`\\b(this weekend|over the weekend|the weekend|tonight|tomorrow|next week|early next week|end of (?:the )?week|${DAYS.join("|")})\\b`, "i");
const TZ = "America/Chicago";

/** The Central calendar day `daysAhead` after `now`'s Central day, at 8:00 AM Central, as an instant. */
function centralMorning(now: Date, daysAhead: number): Date {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now).map((p) => [p.type, p.value]));
  const day = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + daysAhead, 12));
  // 8:00 AM Central is 13:00 or 14:00 UTC; pick the one that reads 08 in Central on that day.
  for (const utcHour of [13, 14]) {
    const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), utcHour));
    if (new Intl.DateTimeFormat("en-US", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(t) === "08") return t;
  }
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), 14));
}

function centralWeekday(now: Date): number {
  return DAYS.indexOf(new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" }).format(now).toLowerCase());
}

/** When the partner said he will be back, or null. Only the newest part of a reply is read, never the quoted thread. */
export function partnerBackIn(text: string | null | undefined, now: Date = new Date()): PartnerBack | null {
  const own = String(text ?? "").split(/\n\s*On .{0,120}wrote:|\n>|\n-{2,}\s*Original Message/i)[0] ?? "";
  for (const sentence of own.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)) {
    if (!PROMISE.test(sentence)) continue;
    const when = WHEN.exec(sentence)?.[1]?.toLowerCase();
    if (!when) continue;
    const today = centralWeekday(now);
    // Days until the first working morning AFTER the window he named.
    let ahead: number;
    if (when.includes("weekend")) ahead = ((8 - today) % 7) || 7; // → Monday
    else if (when === "tonight") ahead = 1;
    else if (when === "tomorrow") ahead = 2;
    else if (when.includes("next week")) ahead = (((8 - today) % 7) || 7) + 7; // → the Monday after next week
    else if (when.includes("end of")) ahead = ((8 - today) % 7) || 7; // → Monday
    else ahead = ((DAYS.indexOf(when) - today + 7) % 7 || 7) + 1; // the named day, then the morning after
    return { back_at: centralMorning(now, ahead).toISOString(), words: sentence.trim().slice(0, 300), when };
  }
  return null;
}
