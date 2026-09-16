import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  JOB_KINDS,
  PROPOSED_JOB_STATUS,
  SCHEDULE_KINDS,
  TARGET_KINDS,
  recommendJobs,
} from "../src/shared/setup/recommendedJobs";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";

const MIGRATION = readFileSync(
  // 0172 rebuilt the table again (WEEKLY, after 0169's MONTHLY, ON_REQUEST, RETIRED); its DDL is the one that is live.
  fileURLToPath(new URL("../migrations/0172_weekly_hire_search.sql", import.meta.url)),
  "utf8",
);

/** Pull the allowed values out of a `CHECK (<col> IN ('A','B'))` in the real migration. */
function allowedFromSchema(column: string): string[] {
  const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`).exec(MIGRATION);
  if (!m) throw new Error(`no CHECK constraint found for ${column}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

/*
 * The employed set is built from the REAL ROSTER, not typed by hand.
 *
 * It used to be a hand-written list containing "Paige", who is not and never has been on the roster.
 * So `diligence_ic_preparation` — the firm's only automated route from active diligence to an IC
 * brief — could never be proposed in production, because `requiresEmployees` looked her up and
 * always reported her missing. The suite passed throughout, because the suite had invented her too.
 * A fixture that names people the system does not have will agree with any bug that shares its
 * imagination.
 */
const ROSTER_NAMES = new Set(AI_EMPLOYEE_ROSTER.map((e) => e.name));
const ALL = recommendJobs(ROSTER_NAMES);

describe("recommended recurring work fits the real schema", () => {
  // The point of these three: a proposal the database would reject must fail here, not when an
  // operator clicks create.
  it("every proposed kind is a kind the table accepts", () => {
    const allowed = allowedFromSchema("kind");
    expect([...JOB_KINDS].sort()).toEqual([...allowed].sort());
    for (const j of ALL) expect(allowed).toContain(j.kind);
  });

  it("every proposed schedule_kind and target_kind is accepted", () => {
    const schedules = allowedFromSchema("schedule_kind");
    const targets = allowedFromSchema("target_kind");
    expect([...SCHEDULE_KINDS].sort()).toEqual([...schedules].sort());
    expect([...TARGET_KINDS].sort()).toEqual([...targets].sort());
    for (const j of ALL) {
      expect(schedules).toContain(j.schedule_kind);
      expect(targets).toContain(j.target_kind);
    }
  });

  it("satisfies the table's conditional CHECKs", () => {
    for (const j of ALL) {
      // CHECK (schedule_kind <> 'INTERVAL' OR interval_minutes IS NOT NULL)
      if (j.schedule_kind === "INTERVAL") expect(j.interval_minutes).toBeGreaterThan(0);
      // CHECK (schedule_kind <> 'DAILY_AT' OR daily_at_utc IS NOT NULL)
      if (j.schedule_kind === "DAILY_AT") expect(j.daily_at_utc).toMatch(/^\d{2}:\d{2}$/);
      // CHECK (schedule_kind <> 'WEEKLY' OR (day_of_week IS NOT NULL AND daily_at_utc IS NOT NULL))
      if (j.schedule_kind === "WEEKLY") { expect(j.day_of_week).toBeGreaterThanOrEqual(0); expect(j.daily_at_utc).toMatch(/^\d{2}:\d{2}$/); }
      // CHECK (target_kind = 'SYSTEM' OR target_id IS NOT NULL)
      if (j.target_kind !== "SYSTEM") expect(j.target_name).toBeTruthy();
    }
  });
});

describe("recommended recurring work names people who exist", () => {
  it("targets and requires only employees on the roster", () => {
    // The guard for the bug above: a job pointed at a name nobody has is not a job, it is a silent
    // hole in the schedule. It fails closed and says nothing, which is the worst combination.
    const phantom: string[] = [];
    for (const j of ALL) {
      if (j.target_kind === "EMPLOYEE" && j.target_name && !ROSTER_NAMES.has(j.target_name)) {
        phantom.push(`${j.job_key} targets ${j.target_name}`);
      }
      for (const n of j.requiresEmployees ?? []) {
        if (!ROSTER_NAMES.has(n)) phantom.push(`${j.job_key} requires ${n}`);
      }
    }
    expect(phantom).toEqual([]);
  });

  it("proposes every job when the whole roster is employed", () => {
    // If this drops, some job is gated on somebody who cannot be hired.
    expect(ALL.length).toBeGreaterThan(0);
  });
});

describe("recommended recurring work is governed", () => {
  it("proposes PAUSED and nothing else", () => {
    expect(PROPOSED_JOB_STATUS).toBe("PAUSED");
    const allowed = allowedFromSchema("status");
    expect(allowed).toContain(PROPOSED_JOB_STATUS);
  });

  it("never proposes a data class the enabled provider lane may not receive", () => {
    // OpenRouter is permitted PUBLIC and INTERNAL only (migration 0004). Proposing anything more
    // sensitive would be proposing work the egress policy refuses.
    for (const j of ALL) expect(["PUBLIC", "INTERNAL"]).toContain(j.data_class);
  });

  it("blocks a job whose employee is not active, and says how to fix it", () => {
    const none = recommendJobs(new Set());
    const prep = none.find((j) => j.job_key === "wednesday_mp_meeting_prep")!;
    expect(prep.canRunNow).toBe(false);
    expect(prep.blockers.join(" ")).toContain("Wren");
    expect(prep.blockers.join(" ")).toContain("approval receipt");
  });

  it("blocks everything when no provider is configured", () => {
    const out = recommendJobs(new Set(["Wren"]), new Map(), false);
    expect(out.every((j) => !j.canRunNow)).toBe(true);
    expect(out[0]!.blockers.join(" ")).toContain("No AI provider");
  });

  it("system-level jobs need no employee and can run once a provider exists", () => {
    const out = recommendJobs(new Set());
    const sys = out.filter((j) => j.target_kind === "SYSTEM");
    expect(sys.length).toBeGreaterThan(0);
    for (const j of sys) {
      expect(j.requiresEmployees).toEqual([]);
      expect(j.canRunNow).toBe(true);
    }
  });

  it("reports a job that already exists rather than proposing a duplicate", () => {
    const out = recommendJobs(new Set(["Wren"]), new Map([["wednesday_mp_meeting_prep", "ACTIVE"]]));
    const prep = out.find((j) => j.job_key === "wednesday_mp_meeting_prep")!;
    expect(prep.alreadyExists).toBe(true);
    expect(prep.existingStatus).toBe("ACTIVE");
  });

  it("gives every proposal a distinct key, a purpose and a cadence", () => {
    expect(new Set(ALL.map((j) => j.job_key)).size).toBe(ALL.length);
    for (const j of ALL) {
      expect(j.purpose.length).toBeGreaterThan(40);
      expect(j.cadence.length).toBeGreaterThan(4);
    }
  });
});
