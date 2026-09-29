import { describe, expect, it } from "vitest";
import { detectUsageLimit, retryAfterFrom, MAX_COOLDOWN_SECONDS } from "../scripts/lib/seat-usage-limit.mjs";

/**
 * THE REAL NOTICE (29 Sep 2026, her terminal): "You've hit your weekly limit · resets Oct 2 at 8am
 * (America/Chicago)". Detection already recognised it; without the reset time the seat was retried every
 * 30 minutes for three days. `now` is 14:20 CDT on 29 Sep 2026 in every case.
 */
const NOW = Date.UTC(2026, 8, 29, 19, 20);
const hours = (s: number | null) => (s === null ? null : s / 3600);

describe("the reset time a notice states", () => {
  it("reads 'resets Oct 2 at 8am (America/Chicago)' as that instant, to the second", () => {
    const r = detectUsageLimit({ stdout: "You've hit your weekly limit · resets Oct 2 at 8am (America/Chicago)" }, NOW);
    expect(r.limited).toBe(true);
    expect(r.retryAfterSeconds).toBe((Date.UTC(2026, 9, 2, 13, 0) - NOW) / 1000);
  });
  it("reads a time with no date as today, or tomorrow when that hour has passed", () => {
    expect(hours(retryAfterFrom("limit reached, resets 3pm (America/Chicago)", NOW))).toBeCloseTo(40 / 60, 2);
    expect(hours(retryAfterFrom("resets 1pm (America/Chicago)", NOW))).toBeCloseTo(22 + 40 / 60, 2);
  });
  it("reads minutes and a comma-separated date", () => {
    expect(hours(retryAfterFrom("resets on Oct 2, 8:30 pm (America/Chicago)", NOW))).toBeCloseTo((Date.UTC(2026, 9, 3, 1, 30) - NOW) / 3.6e6, 2);
  });
  it("rolls a date that already passed to next year and clamps it, never believing a far date", () => {
    expect(retryAfterFrom("resets Jan 2 at 8am (America/Chicago)", NOW)).toBe(MAX_COOLDOWN_SECONDS);
  });
  it("ignores a time zone it does not know, and still reads the older forms", () => {
    expect(retryAfterFrom("resets 3pm (Not/AZone)", NOW)).not.toBeNull();
    expect(retryAfterFrom("try again in 2 hours", NOW)).toBe(7200);
    expect(retryAfterFrom(`limit|${Math.floor(NOW / 1000) + 7200}`, NOW)).toBe(7200);
    expect(retryAfterFrom("You've hit your limit", NOW)).toBeNull();
  });
  it("reads a weekday-only reset as the next such weekday, never as 'today or tomorrow'", () => {
    // 29 Sep 2026 is a Tuesday. Monday 8am CDT is 5 days and 17h40m ahead; Tuesday 8am has passed, so next Tuesday.
    expect(retryAfterFrom("resets Monday at 8am (America/Chicago)", NOW)).toBe((Date.UTC(2026, 9, 5, 13, 0) - NOW) / 1000);
    expect(retryAfterFrom("resets Tuesday at 8am (America/Chicago)", NOW)).toBe((Date.UTC(2026, 9, 6, 13, 0) - NOW) / 1000);
    expect(hours(retryAfterFrom("resets Tuesday 3pm (America/Chicago)", NOW))).toBeCloseTo(40 / 60, 2);
  });
  it("captures any valid zone name, not only two-part ones", () => {
    expect(retryAfterFrom("resets 3pm (UTC)", NOW)).toBe((Date.UTC(2026, 8, 29, 15, 0) + 86_400_000 - NOW) / 1000);
    expect(retryAfterFrom("resets 3pm (Etc/GMT+5)", NOW)).toBe((Date.UTC(2026, 8, 29, 20, 0) - NOW) / 1000);
    expect(retryAfterFrom("resets 9pm (America/Argentina/Buenos_Aires)", NOW)).toBe((Date.UTC(2026, 8, 30, 0, 0) - NOW) / 1000);
  });
  it("allows a weekly wait: the longest cooldown is seven days, which the server also accepts", () => {
    expect(MAX_COOLDOWN_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
