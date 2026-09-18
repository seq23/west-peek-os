import { describe, expect, it } from "vitest";
import { computeNextRun } from "../src/worker/services/jobs";
import { instantOfWallClock, nextInZone, supportsTimeZone, wallClockIn, zoneOffsetMs } from "../src/shared/time/zonedClock";

/**
 * A JOB PINNED TO HER CLOCK STAYS ON HER CLOCK WHEN THE CLOCKS CHANGE.
 *
 * Operator, 18 Sep 2026: the deck reader "should check once per day at some point in the day ----
 * maybe like after 11am". Her 11am is 16:00Z from March to November and 17:00Z from November to
 * March. A job written as a UTC hour is a guess about which half of the year somebody is looking:
 * '16:00' runs at 10am for her all winter, which is the one thing her sentence ruled out, and
 * '17:00' runs at noon all summer. Neither is wrong on the day it is written and both are wrong for
 * four months of every year.
 *
 * So these tests do not check one hour. They walk a whole year of occurrences and require the LOCAL
 * reading to be 11:15 on every single one — which is the only assertion a transition cannot slip
 * past, and which fails for any fixed-UTC-hour implementation no matter which hour is chosen.
 */

const CHICAGO = "America/Chicago";
const DECK_JOB = {
  schedule_kind: "DAILY_AT" as const,
  interval_minutes: null,
  daily_at_utc: "11:15",
  daily_at_tz: CHICAGO,
};

describe("the runtime's own timezone database", () => {
  /*
   * NOT A FORMALITY. A runtime built without full ICU accepts `timeZone: "America/Chicago"` and
   * formats in UTC anyway. Everything below would then pass in a way that means nothing, and the
   * deck job would silently be scheduled an hour or six wrong in production. This is the check that
   * turns that into a red build instead of an unread deck.
   */
  it("knows Chicago, and knows that Chicago moves", () => {
    expect(supportsTimeZone(CHICAGO)).toBe(true);
    // CDT: UTC-5.
    expect(zoneOffsetMs(CHICAGO, new Date("2026-07-01T12:00:00Z"))).toBe(-5 * 3_600_000);
    // CST: UTC-6.
    expect(zoneOffsetMs(CHICAGO, new Date("2026-01-01T12:00:00Z"))).toBe(-6 * 3_600_000);
  });

  it("refuses a zone it cannot resolve rather than pretending", () => {
    expect(supportsTimeZone("Mars/Olympus_Mons")).toBe(false);
  });

  it("converts a wall clock to the instant it actually lands on, both sides of a transition", () => {
    // 11:15 on a CDT day is 16:15Z.
    expect(new Date(instantOfWallClock(CHICAGO, 2026, 7, 1, 11, 15)).toISOString()).toBe("2026-07-01T16:15:00.000Z");
    // 11:15 on a CST day is 17:15Z.
    expect(new Date(instantOfWallClock(CHICAGO, 2026, 1, 1, 11, 15)).toISOString()).toBe("2026-01-01T17:15:00.000Z");
  });
});

describe("the deck job's next run, on her clock", () => {
  it("is 16:15Z while she is on CDT", () => {
    expect(computeNextRun(DECK_JOB, new Date("2026-09-18T09:00:00Z"))).toBe("2026-09-18T16:15:00.000Z");
  });

  it("is 17:15Z once she is on CST — the same 11:15 for her, a different hour in UTC", () => {
    expect(computeNextRun(DECK_JOB, new Date("2026-12-10T09:00:00Z"))).toBe("2026-12-10T17:15:00.000Z");
  });

  it("carries the change across the transition weekend without a person touching the row", () => {
    // US DST ends 1 Nov 2026. The last CDT occurrence and the first CST one, computed from the same
    // unchanged row: 16:15Z on the Saturday, 17:15Z on the Sunday.
    expect(computeNextRun(DECK_JOB, new Date("2026-10-31T06:00:00Z"))).toBe("2026-10-31T16:15:00.000Z");
    expect(computeNextRun(DECK_JOB, new Date("2026-11-01T06:00:00Z"))).toBe("2026-11-01T17:15:00.000Z");
  });

  it("never lands before 11am her time on any day of a whole year", () => {
    // The assertion the operator actually made. A fixed UTC hour fails this twice a year; nothing
    // else about the implementation matters if this holds.
    let at = new Date("2026-09-18T00:00:00Z");
    let occurrences = 0;
    for (let i = 0; i < 400; i += 1) {
      const next = computeNextRun(DECK_JOB, at);
      expect(next).toBeTruthy();
      const local = wallClockIn(CHICAGO, new Date(next!));
      expect(local.hour, `occurrence ${i} landed at ${local.hour}:${local.minute} local (${next})`).toBe(11);
      expect(local.minute).toBe(15);
      occurrences += 1;
      at = new Date(next!);
    }
    // Hard-fails rather than passing over an empty loop.
    expect(occurrences).toBe(400);
  });

  it("advances strictly, so a run at its own minute is not scheduled for the moment it just ran", () => {
    expect(computeNextRun(DECK_JOB, new Date("2026-09-18T16:15:00Z"))).toBe("2026-09-19T16:15:00.000Z");
  });

  it("leaves every job written before the zone column existed exactly where it was", () => {
    // daily_at_tz null means the hour is UTC, which is what 0018 through 0192 all meant.
    const utcJob = { schedule_kind: "DAILY_AT" as const, interval_minutes: null, daily_at_utc: "11:15", daily_at_tz: null };
    expect(computeNextRun(utcJob, new Date("2026-12-10T09:00:00Z"))).toBe("2026-12-10T11:15:00.000Z");
    // And a row that never heard of the column at all.
    const legacy = { schedule_kind: "DAILY_AT" as const, interval_minutes: null, daily_at_utc: "12:00" };
    expect(computeNextRun(legacy, new Date("2026-12-10T09:00:00Z"))).toBe("2026-12-10T12:00:00.000Z");
  });

  it("falls back to UTC rather than throwing on a zone the runtime cannot read", () => {
    // One bad row must not take the whole tick — and every other job with it — down.
    const bad = { schedule_kind: "DAILY_AT" as const, interval_minutes: null, daily_at_utc: "11:15", daily_at_tz: "Mars/Olympus_Mons" };
    expect(computeNextRun(bad, new Date("2026-12-10T09:00:00Z"))).toBe("2026-12-10T11:15:00.000Z");
  });
});

describe("the zone applies to the weekly and monthly shapes too", () => {
  it("picks the local Sunday, not the UTC one", () => {
    // 2026-11-01 is a Sunday. From the Friday before, the next Sunday 11:15 local is 17:15Z (CST).
    const weekly = { schedule_kind: "WEEKLY" as const, interval_minutes: null, daily_at_utc: "11:15", daily_at_tz: CHICAGO, day_of_week: 0 };
    expect(computeNextRun(weekly, new Date("2026-10-30T12:00:00Z"))).toBe("2026-11-01T17:15:00.000Z");
  });

  it("picks the local day of the month", () => {
    const monthly = { schedule_kind: "MONTHLY" as const, interval_minutes: null, daily_at_utc: "11:15", daily_at_tz: CHICAGO, day_of_month: 5 };
    expect(computeNextRun(monthly, new Date("2026-11-06T12:00:00Z"))).toBe("2026-12-05T17:15:00.000Z");
  });

  it("rolls a monthly occurrence into the next month rather than repeating this one", () => {
    expect(nextInZone(CHICAGO, { kind: "MONTHLY", dayOfMonth: 5 }, 11, 15, new Date("2026-07-05T16:15:00Z")).toISOString())
      .toBe("2026-08-05T16:15:00.000Z");
  });
});
