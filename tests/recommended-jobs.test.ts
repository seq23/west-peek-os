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

const MIGRATION = readFileSync(
  fileURLToPath(new URL("../migrations/0018_orchestration.sql", import.meta.url)),
  "utf8",
);

/** Pull the allowed values out of a `CHECK (<col> IN ('A','B'))` in the real migration. */
function allowedFromSchema(column: string): string[] {
  const m = new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`).exec(MIGRATION);
  if (!m) throw new Error(`no CHECK constraint found for ${column}`);
  return [...m[1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]!);
}

const ALL = recommendJobs(new Set(["Wren", "Wyatt", "Wesley", "Paige", "Winter"]));

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
      // CHECK (target_kind = 'SYSTEM' OR target_id IS NOT NULL)
      if (j.target_kind !== "SYSTEM") expect(j.target_name).toBeTruthy();
    }
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
