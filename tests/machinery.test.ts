import { describe, expect, it } from "vitest";
import { isOneOffMachineryCard, oneOffTag, sortOnAClock, sortOneOff, timeOfDayMinutes } from "../src/shared/work/machinery";
import { PARTNERS } from "../src/shared/registry/partners";

/**
 * Machinery (Addendum 4 item 2 / Addendum 5.1, 22 Sep 2026): two buckets, not three — "On a clock"
 * sorted by literal time of day, "One-off" sorted by arrival, origin as a tag rather than a
 * grouping axis. The thing worth pinning is the boundary: what counts as machinery moving without
 * her pressing anything, and what does not.
 */

const SEQUOIA = PARTNERS[0]!;
const SCOOTER = PARTNERS[1]!;

describe("timeOfDayMinutes", () => {
  it("reads a literal clock time", () => {
    expect(timeOfDayMinutes({ daily_at_utc: "00:00" })).toBe(0);
    expect(timeOfDayMinutes({ daily_at_utc: "14:00" })).toBe(840);
    expect(timeOfDayMinutes({ daily_at_utc: "23:59" })).toBe(1439);
  });

  it("is null for a job with no literal time", () => {
    expect(timeOfDayMinutes({ daily_at_utc: null })).toBeNull();
  });

  it("is null for anything that is not actually HH:MM, rather than guessing", () => {
    expect(timeOfDayMinutes({ daily_at_utc: "not-a-time" })).toBeNull();
    expect(timeOfDayMinutes({ daily_at_utc: "24:00" })).toBeNull();
    expect(timeOfDayMinutes({ daily_at_utc: "10:60" })).toBeNull();
  });
});

describe("sortOnAClock", () => {
  it("orders timed jobs by literal time of day, earliest to latest — 'order of the day'", () => {
    const jobs = [
      { name: "Weekly review", schedule_kind: "WEEKLY", daily_at_utc: "14:00", interval_minutes: null },
      { name: "Morning brief", schedule_kind: "DAILY_AT", daily_at_utc: "06:00", interval_minutes: null },
      { name: "Wednesday prep", schedule_kind: "WEEKLY", daily_at_utc: "09:00", interval_minutes: null },
    ];
    expect(sortOnAClock(jobs).map((j) => j.name)).toEqual(["Morning brief", "Wednesday prep", "Weekly review"]);
  });

  it("puts an interval job after every timed job, since it has no time-of-day position", () => {
    const jobs = [
      { name: "Employee sweep", schedule_kind: "INTERVAL", daily_at_utc: null, interval_minutes: 5 },
      { name: "Morning brief", schedule_kind: "DAILY_AT", daily_at_utc: "23:00", interval_minutes: null },
    ];
    expect(sortOnAClock(jobs).map((j) => j.name)).toEqual(["Morning brief", "Employee sweep"]);
  });

  it("puts an on-request job last of all — it never lands on a clock", () => {
    const jobs = [
      { name: "Deck rebuild", schedule_kind: "ON_REQUEST", daily_at_utc: null, interval_minutes: null },
      { name: "Employee sweep", schedule_kind: "INTERVAL", daily_at_utc: null, interval_minutes: 5 },
      { name: "Morning brief", schedule_kind: "DAILY_AT", daily_at_utc: "06:00", interval_minutes: null },
    ];
    expect(sortOnAClock(jobs).map((j) => j.name)).toEqual(["Morning brief", "Employee sweep", "Deck rebuild"]);
  });

  it("does not mutate the array it was given", () => {
    const jobs = [{ name: "B", schedule_kind: "DAILY_AT", daily_at_utc: "10:00", interval_minutes: null }, { name: "A", schedule_kind: "DAILY_AT", daily_at_utc: "09:00", interval_minutes: null }];
    const copy = [...jobs];
    sortOnAClock(jobs);
    expect(jobs).toEqual(copy);
  });
});

describe("isOneOffMachineryCard", () => {
  const AT = "2026-09-22T09:00:00.000Z";

  it("counts an authenticated partner-email assignment — it started itself", () => {
    expect(isOneOffMachineryCard({ id: "wc_1", requested_by_email: SCOOTER.email, created_by: "fu_x", created_at: AT })).toBe(true);
  });

  it("counts a held card, by state, even with no email origin", () => {
    expect(isOneOffMachineryCard({ id: "wc_2", state: "HELD", created_by: SEQUOIA.firmUserId, created_at: AT })).toBe(true);
  });

  it("counts a held card by held_at even before the client-side HELD state is synthesised", () => {
    expect(isOneOffMachineryCard({ id: "wc_3", held_at: AT, created_by: SEQUOIA.firmUserId, created_at: AT })).toBe(true);
  });

  it("excludes a card she created and started by hand — she pressed something, it is not machinery", () => {
    expect(isOneOffMachineryCard({ id: "wc_4", state: "OPEN", created_by: SEQUOIA.firmUserId, created_at: AT }, SEQUOIA.firmUserId)).toBe(false);
  });

  it("excludes a hand-off between employees and a meeting-born card — neither is a partner email or a hold", () => {
    expect(isOneOffMachineryCard({ id: "wc_5", assigned_from_card_id: "wc_parent", created_at: AT })).toBe(false);
    expect(isOneOffMachineryCard({ id: "wc_6", meeting_id: "mtg_1", created_at: AT })).toBe(false);
  });

  it("counts a card a scheduled job opened on its own cadence, by kind — the job moved it, not her", () => {
    // ROOM_PACKET is door: "JOB" in cardKinds.ts; created_by is the sweep's own identity, not an
    // email or a hold, so only the kind check catches it.
    expect(isOneOffMachineryCard({ id: "wc_7", kind: "ROOM_PACKET", created_by: "system:work_sweep", created_at: AT })).toBe(true);
  });

  it("excludes a plain hand-made card even when it shares no origin with anything above", () => {
    // kind: null (or a HAND/EMAIL-door kind) is the ordinary, always-hand-startable case.
    expect(isOneOffMachineryCard({ id: "wc_8", kind: "ARTIFACT", created_by: "fu_sequoia_taylor", created_at: AT }, SEQUOIA.firmUserId)).toBe(false);
  });
});

describe("sortOneOff", () => {
  it("orders by arrival, earliest first", () => {
    const cards = [
      { id: "wc_late", created_at: "2026-09-22T12:00:00.000Z" },
      { id: "wc_early", created_at: "2026-09-20T08:00:00.000Z" },
      { id: "wc_mid", created_at: "2026-09-21T08:00:00.000Z" },
    ];
    expect(sortOneOff(cards).map((c) => c.id)).toEqual(["wc_early", "wc_mid", "wc_late"]);
  });
});

describe("oneOffTag", () => {
  const AT = "2026-09-22T09:00:00.000Z";

  it("names the sender on a live email assignment — no flip-on needed, it is already running", () => {
    expect(oneOffTag({ id: "wc_1", requested_by_email: SCOOTER.email, created_by: "fu_x", created_at: AT })).toBe(`from ${SCOOTER.email}`);
  });

  it("says 'held by you' rather than re-deriving 'from you' from created_by", () => {
    expect(
      oneOffTag(
        { id: "wc_2", state: "HELD", created_by: SEQUOIA.firmUserId, held_by: SEQUOIA.firmUserId, held_by_name: SEQUOIA.fullName, created_at: AT },
        SEQUOIA.firmUserId,
      ),
    ).toBe("held by you");
  });

  it("names the holder when somebody else is holding it", () => {
    expect(
      oneOffTag(
        { id: "wc_3", state: "HELD", created_by: SCOOTER.firmUserId, held_by: SCOOTER.firmUserId, held_by_name: SCOOTER.fullName, created_at: AT },
        SEQUOIA.firmUserId,
      ),
    ).toBe(`held by ${SCOOTER.fullName}`);
  });

  it("falls back to the ordinary origin badge when a card is not held", () => {
    expect(oneOffTag({ id: "wc_4", created_by: SEQUOIA.firmUserId, created_at: AT }, SEQUOIA.firmUserId)).toBe("from you");
  });
});
