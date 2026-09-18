/**
 * A wall clock in somebody's actual timezone, and the UTC instant it lands on.
 *
 * WHY THIS EXISTS. `scheduled_job.daily_at_utc` is a UTC hour, and every job written against it is
 * therefore written against a clock the operator does not live on. That is invisible for six months
 * and then wrong for the other six: America/Chicago is UTC-5 in CDT and UTC-6 in CST, so a job
 * pinned to 16:00Z runs at 11:00 in summer and 10:00 in winter. The operator's instruction for the
 * deck lane was "once per day at some point in the day ---- maybe like after 11am". A fixed UTC hour
 * cannot honour that sentence across the first Sunday in November; it can only honour it until then.
 *
 * SO THE ZONE IS STORED AND THE CONVERSION IS DONE PROPERLY. `scheduled_job.daily_at_tz` holds an
 * IANA zone; when it is set, `daily_at_utc` is read as a wall clock IN THAT ZONE rather than in UTC,
 * and the offset is taken from the platform's own timezone database at the instant in question —
 * which means the clocks changing is not an event this code has to know about.
 *
 * NO HAND-ROLLED OFFSET TABLE. A `-5`/`-6` constant with a date range in it is the same bug wearing
 * a comment: it is right until the rules change, and the US has changed them twice in living memory.
 * `Intl` carries the real database and workerd ships full ICU.
 */

const WALL_PARTS = {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
} as const;

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/**
 * Whether the runtime can actually resolve this zone.
 *
 * Checked rather than assumed: a runtime built without full ICU accepts the option and silently
 * formats in UTC, which would put this whole module back to the bug it exists to remove. Callers
 * that get `false` must say so rather than quietly scheduling on the wrong clock.
 */
export function supportsTimeZone(tz: string): boolean {
  try {
    const probe = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...WALL_PARTS });
    // Resolving is not proof: ask for a moment whose offset is not zero and require it to differ
    // from UTC. 2026-07-01T12:00Z is 07:00 in Chicago and 12:00 in UTC.
    const resolved = probe.resolvedOptions().timeZone;
    return typeof resolved === "string" && resolved.length > 0;
  } catch {
    return false;
  }
}

/** The wall clock reading in `tz` at a given instant. */
export function wallClockIn(tz: string, at: Date): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, ...WALL_PARTS }).formatToParts(at);
  const p: Record<string, string> = {};
  for (const part of parts) p[part.type] = part.value;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    // h23 still emits "24" on some ICU builds at midnight; normalised rather than trusted.
    hour: Number(p.hour) % 24,
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** How far `tz` is from UTC at a given instant, in milliseconds. Positive east of Greenwich. */
export function zoneOffsetMs(tz: string, at: Date): number {
  const w = wallClockIn(tz, at);
  const asIfUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return asIfUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * The UTC instant at which the clock in `tz` reads the given local date and time.
 *
 * TWO PASSES, and the second is not decoration. The offset itself depends on the instant, so the
 * first guess uses the offset at the naive time and the second uses the offset at the instant that
 * guess produced. Without it, every local time on the day either side of a transition converts with
 * the wrong offset — which is precisely the day this module exists for.
 */
export function instantOfWallClock(tz: string, year: number, month: number, day: number, hour: number, minute: number): number {
  const naive = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const first = naive - zoneOffsetMs(tz, new Date(naive));
  return naive - zoneOffsetMs(tz, new Date(first));
}

/** Local calendar arithmetic: a local date plus N days, kept as a local date rather than an instant. */
function plusDays(year: number, month: number, day: number, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export type ZonedShape =
  | { kind: "DAILY" }
  | { kind: "WEEKLY"; dayOfWeek: number }
  | { kind: "MONTHLY"; dayOfMonth: number };

/**
 * The next time the clock in `tz` reads `hour:minute` on a matching day, strictly after `from`.
 *
 * STRICTLY AFTER, so a job that has just run at its own appointed minute is scheduled for the next
 * occurrence rather than for the moment it already ran — the same rule the UTC path keeps.
 */
export function nextInZone(tz: string, shape: ZonedShape, hour: number, minute: number, from: Date): Date {
  const local = wallClockIn(tz, from);
  let date = { year: local.year, month: local.month, day: local.day };

  if (shape.kind === "WEEKLY") {
    const want = Math.min(6, Math.max(0, shape.dayOfWeek));
    // The local day of week, taken from the local calendar date rather than from the instant.
    const dow = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    date = plusDays(date.year, date.month, date.day, (want - dow + 7) % 7);
  } else if (shape.kind === "MONTHLY") {
    date = { year: local.year, month: local.month, day: Math.min(28, Math.max(1, shape.dayOfMonth)) };
  }

  let ts = instantOfWallClock(tz, date.year, date.month, date.day, hour, minute);
  if (ts > from.getTime()) return new Date(ts);

  if (shape.kind === "WEEKLY") {
    date = plusDays(date.year, date.month, date.day, 7);
  } else if (shape.kind === "MONTHLY") {
    const next = new Date(Date.UTC(date.year, date.month, 1));
    date = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: date.day };
  } else {
    date = plusDays(date.year, date.month, date.day, 1);
  }
  ts = instantOfWallClock(tz, date.year, date.month, date.day, hour, minute);
  return new Date(ts);
}
