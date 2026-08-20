import { describe, expect, it } from "vitest";
import { cadenceInWords, delivererLine, delivererNames } from "@shared/work/scheduledWork";

/**
 * Cadence, asserted against the values production actually stores.
 *
 * This printed "No cadence set" on all three of the firm's jobs, directly above a line giving each
 * one's next run time — because it compared `schedule_kind` against "DAILY" and the stored value is
 * "DAILY_AT". A wrong string literal in TypeScript does not fail; it silently never matches, which
 * is the same failure shape as the SQL bugs `validate:sql` now catches, in the one place that
 * validator cannot see.
 */
describe("how often a job runs, in words", () => {
  it("reads the enum production actually stores", () => {
    expect(cadenceInWords({ schedule_kind: "DAILY_AT", interval_minutes: null, daily_at_utc: "06:00" }))
      .toBe("Every day at 06:00 UTC");
  });

  it("still understands the plain spelling, so neither is a trap", () => {
    expect(cadenceInWords({ schedule_kind: "DAILY", interval_minutes: null, daily_at_utc: "06:00" }))
      .toBe("Every day at 06:00 UTC");
  });

  it("turns an interval into something a person would say", () => {
    const at = (m: number) => cadenceInWords({ schedule_kind: "INTERVAL", interval_minutes: m, daily_at_utc: null });
    expect(at(60)).toBe("Every hour");
    expect(at(1440)).toBe("Once a day");
    expect(at(10080)).toBe("Once a week");
    expect(at(30)).toBe("Every 30 minutes");
  });

  it("says so plainly when there genuinely is no cadence", () => {
    // Distinct from the bug above: nothing scheduled at all is a real state and reads as one.
    expect(cadenceInWords({ schedule_kind: "MANUAL", interval_minutes: null, daily_at_utc: null }))
      .toBe("No cadence set");
  });
});

describe("who hands a job over", () => {
  it("signs the brief and the review jointly, because both partners read them", () => {
    expect(delivererNames({ job_key: "daily_intelligence", target_kind: "SYSTEM", target_id: null }))
      .toEqual(["Walker", "Wren"]);
    expect(delivererLine(["Walker", "Wren"])).toBe("Delivered by Walker and Wren");
  });

  it("falls back to a job's own target employee, so a job added later still names somebody", () => {
    expect(delivererNames({ job_key: "something_new", target_kind: "EMPLOYEE", target_id: "Parker" }))
      .toEqual(["Parker"]);
  });

  it("says nobody rather than inventing a deliverer", () => {
    expect(delivererLine([])).toBe("Nobody is named as delivering this");
  });
});
