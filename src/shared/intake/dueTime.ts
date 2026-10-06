/**
 * A DEADLINE IN A PARTNER'S OWN WORDS (0253, addendum item 3). "Live by Monday morning", "today",
 * "before doors", "as soon as you can", "by Friday 5pm", "end of day" — read at the door, once,
 * deterministically against the time the email arrived. It sets the card's priority, rides on the
 * request as `due_at` / `due_words`, and every wait email that could eat it (the Mac asleep, a seat
 * reset) states it, so a closed lid never silently swallows a deadline.
 *
 * Pure. Times are read in America/Chicago (the partners' clock) and returned as ISO UTC.
 */

export interface DueTime {
  /** ISO UTC. */
  due_at: string;
  /** The words that said so, verbatim. */
  due_words: string;
  priority: "URGENT" | "HIGH";
}

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const CHICAGO = "America/Chicago";

/** The Chicago wall-clock parts of an instant. */
function chicagoParts(at: Date): { y: number; m: number; d: number; h: number; min: number; dow: number; offsetMin: number } {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short" });
  const p = Object.fromEntries(fmt.formatToParts(at).map((x) => [x.type, x.value]));
  const y = Number(p.year), m = Number(p.month), d = Number(p.day), h = Number(p.hour) % 24, min = Number(p.minute);
  const dow = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  const asUtc = Date.UTC(y, m - 1, d, h, min);
  const offsetMin = Math.round((asUtc - at.getTime()) / 60_000);
  return { y, m, d, h, min, dow, offsetMin };
}

/** A Chicago wall-clock → ISO UTC, using the offset in force at the reference instant (DST edges are a few-hour error at worst, never a day). */
function chicagoToIso(ref: Date, y: number, m: number, d: number, h: number, min: number): string {
  const { offsetMin } = chicagoParts(ref);
  return new Date(Date.UTC(y, m - 1, d, h, min) - offsetMin * 60_000).toISOString();
}

const HOUR_WORDS: Array<[RegExp, number]> = [
  [/\b(first thing|morning|am\b|breakfast)/i, 9],
  [/\b(noon|midday|lunch)/i, 12],
  [/\b(afternoon)/i, 15],
  [/\b(end of (the )?day|eod|close of business|cob|tonight|evening|by 5|5 ?pm)/i, 17],
  [/\b(before doors|doors open|doors)/i, 17],
  [/\b(midnight)/i, 23],
];

function hourIn(words: string): number {
  const explicit = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(words);
  if (explicit) {
    let h = Number(explicit[1]) % 12;
    if (explicit[3]!.toLowerCase() === "pm") h += 12;
    return h;
  }
  for (const [re, h] of HOUR_WORDS) if (re.test(words)) return h;
  return 17;
}

/**
 * The deadline named in the text, or null. The first match wins; a quoted thread is the caller's
 * business (pass the written part). `now` is when the email arrived.
 */
export function dueTimeIn(text: string, now: Date = new Date()): DueTime | null {
  const t = String(text ?? "").replace(/\s+/g, " ");
  const { y, m, d, dow } = chicagoParts(now);
  const at = (days: number, h: number, words: string, priority: DueTime["priority"]): DueTime => ({ due_at: chicagoToIso(now, y, m, d + days, h, 0), due_words: words.trim(), priority });

  const asap = /\b(as soon as (you|u) can|asap|right away|immediately|urgent(ly)?|today|this morning|this afternoon|tonight|by end of (the )?day|by eod|before doors|by (\d{1,2}(:\d{2})?\s*(am|pm)) today)\b/i.exec(t);
  if (asap) {
    const words = asap[0];
    const h = /today|this morning|this afternoon|tonight|by end|by eod|before doors|by \d/i.test(words) ? hourIn(words) : chicagoParts(now).h + 2;
    return at(0, Math.min(23, Math.max(h, chicagoParts(now).h)), words, "URGENT");
  }
  const tomorrow = /\b(by |before |for )?tomorrow( morning| afternoon| evening| night| at \d{1,2}(:\d{2})?\s*(am|pm)|\s*\d{1,2}(:\d{2})?\s*(am|pm))?\b/i.exec(t);
  if (tomorrow) return at(1, hourIn(tomorrow[0]), tomorrow[0], "HIGH");
  const weekday = /\b(?:live |ready |done |up |launch(?:ed)? )?(?:by|before|for|on) (?:this |next )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)( morning| afternoon| evening| night| at \d{1,2}(:\d{2})?\s*(am|pm)|\s*\d{1,2}(:\d{2})?\s*(am|pm))?\b/i.exec(t);
  if (weekday) {
    const target = DAYS.indexOf(weekday[1]!.toLowerCase());
    let days = (target - dow + 7) % 7;
    if (days === 0) days = 7;
    if (/\bnext\b/i.test(weekday[0]) && days < 7) days += 7;
    return at(days, hourIn(weekday[0]), weekday[0], days <= 2 ? "URGENT" : "HIGH");
  }
  const week = /\b(by |before |for )?(the )?end of (the |this )?week\b/i.exec(t);
  if (week) return at(((5 - dow + 7) % 7) || 7, 17, week[0], "HIGH");
  const explicitDate = /\b(?:by|before|for|on) ((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.? (\d{1,2})(?:st|nd|rd|th)?)\b/i.exec(t);
  if (explicitDate) {
    const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(explicitDate[1]!.slice(0, 3).toLowerCase()) + 1;
    const day = Number(explicitDate[2]);
    let year = y;
    if (month < m || (month === m && day < d)) year += 1;
    const due = chicagoToIso(now, year, month, day, 17, 0);
    const days = (Date.parse(due) - now.getTime()) / 86_400_000;
    return { due_at: due, due_words: explicitDate[0], priority: days <= 2 ? "URGENT" : "HIGH" };
  }
  return null;
}

/** "due Mon 6 Oct, 9:00 CT (your words: 'by Monday morning')" — for an email line. */
export function dueLine(due: Pick<DueTime, "due_at" | "due_words"> | null | undefined): string | null {
  if (!due?.due_at) return null;
  const when = new Intl.DateTimeFormat("en-US", { timeZone: CHICAGO, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(due.due_at));
  return `due ${when} CT (your words: "${due.due_words}")`;
}
