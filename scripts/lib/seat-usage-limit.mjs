/**
 * IS THIS CLI OUTPUT A USAGE-LIMIT NOTICE RATHER THAN AN ANSWER?
 *
 * A subscription seat runs on a flat-fee plan with a usage window. When the window is spent, the
 * CLIs do not necessarily fail: they print a sentence and may exit 0. The claimer used to take any
 * non-empty stdout as the answer, so that sentence could be saved as a card's answer and the chain
 * would never reach the next lane. This decides, from the output alone, that the seat is out.
 *
 * THE WORDING IS NOT VERIFIED AGAINST EVERY CLI VERSION. The patterns below cover the phrasings the
 * two tools are known to use ("usage limit reached", "you've hit your limit", "5-hour limit
 * reached", "limit will reset at …", "rate limit exceeded, try again in …") and the vendors' quota
 * errors. A wording that is not covered fails OPEN in the old direction — the text is treated as an
 * answer — so this list narrows a known hole; it does not close every possible one. It is UNPROVEN
 * against the live CLIs until the owner's Mac has hit a real limit, and the ledger says so.
 *
 * LONG OUTPUT IS NEVER A LIMIT NOTICE. A real answer that happens to discuss "usage limits" runs to
 * paragraphs; a limit notice is a line or two. Above SHORT_OUTPUT_CHARS the stdout is an answer
 * whatever it contains, which is what keeps a false positive from throwing away good work. stderr is
 * only consulted when stdout is short or empty, for the same reason.
 *
 * Pure: no clock is read unless `now` is passed, so the tests are deterministic.
 */

/** Above this many characters of stdout, the output is an answer and is never inspected. */
export const SHORT_OUTPUT_CHARS = 600;

/** How long a seat is treated as out when the notice gives no reset time. Then it is tried once more. */
export const DEFAULT_COOLDOWN_SECONDS = 30 * 60;
/**
 * The shortest and longest cooldown a notice may set. A parsed time in the past or a year away is not believed.
 * The longest is seven days because a WEEKLY limit is real ("You've hit your weekly limit · resets Oct 2 at 8am",
 * seen 29 Sep 2026); a one-day cap turned it into a daily retry of a seat that could not answer.
 */
export const MIN_COOLDOWN_SECONDS = 60;
export const MAX_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;

const LIMIT_PATTERNS = [
  /usage limit (?:reached|exceeded|has been reached)/i,
  /(?:hit|reached|exceeded) (?:your|the) (?:\w+[ -]){0,2}(?:usage |rate )?limit/i,
  /(?:5-hour|five-hour|weekly|session|daily|monthly)\s+(?:usage\s+)?limit\s+(?:reached|hit|exceeded)/i,
  /limit will reset/i,
  /rate[- ]limit(?:ed)?\b[^\n]{0,80}\b(?:reached|exceeded|try again)/i,
  /insufficient[_ ]quota|exceeded your current quota/i,
];

/**
 * @param {{ stdout?: string, stderr?: string }} output
 * @param {number} [nowMs]
 * @returns {{ limited: boolean, snippet: string, retryAfterSeconds: number | null }}
 */
export function detectUsageLimit(output, nowMs = Date.now()) {
  const stdout = (output?.stdout ?? "").replace(/\r/g, "").trim();
  const stderr = (output?.stderr ?? "").replace(/\r/g, "").trim();
  if (stdout.length > SHORT_OUTPUT_CHARS) return { limited: false, snippet: "", retryAfterSeconds: null };

  const text = `${stdout}\n${stderr.slice(0, 4000)}`.trim();
  if (!text) return { limited: false, snippet: "", retryAfterSeconds: null };
  if (!LIMIT_PATTERNS.some((p) => p.test(text))) return { limited: false, snippet: "", retryAfterSeconds: null };

  return {
    limited: true,
    snippet: text.replace(/\s+/g, " ").slice(0, 240),
    retryAfterSeconds: retryAfterFrom(text, nowMs),
  };
}

/** The reset time a notice states, in seconds from now, clamped; null when it states none we can read. */
export function retryAfterFrom(text, nowMs = Date.now()) {
  // "Claude AI usage limit reached|1759071600" — an epoch in seconds after a pipe.
  const epoch = /\|\s*(\d{10})\b/.exec(text);
  if (epoch) return clamp(Number(epoch[1]) - Math.floor(nowMs / 1000));
  // "try again in 2 hours" / "resets in 45 minutes".
  const rel = /(?:try again|resets?)\s+in\s+(\d+)\s*(second|minute|hour)s?/i.exec(text);
  if (rel) {
    const unit = rel[2].toLowerCase() === "hour" ? 3600 : rel[2].toLowerCase() === "minute" ? 60 : 1;
    return clamp(Number(rel[1]) * unit);
  }
  // "resets Oct 2 at 8am (America/Chicago)" / "resets on Oct 2, 8:30 pm" / "resets 3pm (America/Chicago)".
  const abs = /resets?\s+(?:on\s+)?(?:(mon|tue|wed|thu|fri|sat|sun)[a-z]*,?\s+)?(?:([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b(?:\s*\(([A-Za-z0-9_+\-]+(?:\/[A-Za-z0-9_+\-]+)*)\))?/i.exec(text);
  if (abs) {
    const at = resetAt(abs, nowMs);
    if (at !== null) return clamp(Math.round((at - nowMs) / 1000));
  }
  return null;
}

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset (ms) of `zone` from UTC at instant `utcMs`; zone undefined means this machine's own zone. */
function zoneOffsetMs(utcMs, zone) {
  if (!zone) return -new Date(utcMs).getTimezoneOffset() * 60_000;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
      .formatToParts(new Date(utcMs)).map((p) => [p.type, p.value]),
  );
  return Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second) - Math.floor(utcMs / 1000) * 1000;
}

/** The instant (ms) a matched reset phrase names, or null when it cannot be read as a real time. */
function resetAt(m, nowMs) {
  const [, weekday, mon, day, hh, mm, ap, zone] = m;
  let hour = Number(hh);
  if (!(hour >= 1 && hour <= 12)) return null;
  hour = (hour % 12) + (ap.toLowerCase() === "pm" ? 12 : 0);
  const minute = mm ? Number(mm) : 0;
  if (minute > 59) return null;
  let tz = zone || undefined;
  if (tz) { try { new Intl.DateTimeFormat("en-US", { timeZone: tz }); } catch { tz = undefined; } }
  const local = (utcMs) => {
    const d = new Date(utcMs + zoneOffsetMs(utcMs, tz));
    return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate() };
  };
  const wall = (y, mo, d) => {
    const guess = Date.UTC(y, mo, d, hour, minute);
    let t = guess - zoneOffsetMs(guess, tz);
    t = guess - zoneOffsetMs(t, tz); // once more, so a date across a daylight-saving change is exact
    return t;
  };
  const today = local(nowMs);
  if (mon && day) {
    const mo = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
    if (mo < 0 || Number(day) < 1 || Number(day) > 31) return null;
    let t = wall(today.y, mo, Number(day));
    if (t < nowMs - 60_000) t = wall(today.y + 1, mo, Number(day));
    return t;
  }
  if (weekday) {
    // "resets Monday at 8am": the next such weekday (today counts only if that hour is still ahead), in the notice's zone.
    const want = WEEKDAYS.indexOf(weekday.slice(0, 3).toLowerCase());
    const dow = new Date(Date.UTC(today.y, today.mo, today.d)).getUTCDay();
    let ahead = (want - dow + 7) % 7;
    let t = wall(today.y, today.mo, today.d + ahead);
    if (t < nowMs) t = wall(today.y, today.mo, today.d + ahead + 7);
    return t;
  }
  let t = wall(today.y, today.mo, today.d);
  if (t < nowMs) t = wall(today.y, today.mo, today.d + 1);
  return t;
}

function clamp(seconds) {
  if (!Number.isFinite(seconds)) return null;
  return Math.min(MAX_COOLDOWN_SECONDS, Math.max(MIN_COOLDOWN_SECONDS, Math.round(seconds)));
}
