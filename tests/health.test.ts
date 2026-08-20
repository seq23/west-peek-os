import { describe, expect, it } from "vitest";
import { ago, summarise, worstOf, type HealthCheck } from "../src/shared/health/checks";

const check = (state: HealthCheck["state"], label: string): HealthCheck => ({
  key: label.toLowerCase(),
  label,
  state,
  reading: "a reading",
});

describe("health roll-up", () => {
  it("takes the worst state, not the average", () => {
    expect(worstOf([check("OK", "A"), check("DEGRADED", "B"), check("DOWN", "C")])).toBe("DOWN");
    expect(worstOf([check("OK", "A"), check("DEGRADED", "B")])).toBe("DEGRADED");
    expect(worstOf([check("OK", "A")])).toBe("OK");
    expect(worstOf([])).toBe("OK");
  });

  it("names what is broken rather than counting it", () => {
    expect(summarise([check("OK", "Database"), check("DOWN", "Morning brief")])).toContain("Morning brief");
  });

  // A red thing and an amber thing at once must not read as "everything essential is working" —
  // that sentence belongs only to a board with nothing red on it.
  it("does not report degraded-only wording while something is down", () => {
    const s = summarise([check("DOWN", "Morning brief"), check("DEGRADED", "Email")]);
    expect(s).not.toContain("Everything essential is working");
  });

  it("says nothing is wrong only when nothing is wrong", () => {
    expect(summarise([check("OK", "A"), check("OK", "B")])).toBe("Everything is working.");
  });
});

describe("ago", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");

  it("reads UTC timestamps as UTC", () => {
    // The database writes strftime('%Y-%m-%dT%H:%M:%fZ'). Losing the Z would shift every reading
    // by the operator's offset and make a run four minutes old look hours old.
    expect(ago("2026-08-20T11:56:00.000Z", now)).toBe("4 minutes ago");
  });

  it("scales the unit to the age", () => {
    expect(ago("2026-08-20T11:59:50.000Z", now)).toBe("just now");
    expect(ago("2026-08-20T09:00:00.000Z", now)).toBe("3 hours ago");
    expect(ago("2026-08-18T12:00:00.000Z", now)).toBe("2 days ago");
  });

  it("says never rather than inventing a date", () => {
    expect(ago(null, now)).toBe("never");
    expect(ago("not a date", now)).toBe("never");
  });
});

// ── The endpoint, against a real database ───────────────────────────────────
import { afterAll, beforeAll } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";

let t: TestDb;
let env: Env;
const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the health board", () => {
  it("answers with a reading on every check, not a bare state", async () => {
    const res = await handleRequest(new Request("https://test.local/api/diagnostics/health", { headers: MP }), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { overall: string; summary: string; checks: HealthCheck[] };

    expect(body.checks.length).toBeGreaterThan(5);
    // The rule the whole page rests on: no light without something behind it.
    for (const c of body.checks) {
      expect(c.reading, `${c.key} has no reading`).toBeTruthy();
      expect(c.reading).not.toBe("OK");
      expect(["OK", "DEGRADED", "DOWN"]).toContain(c.state);
    }
    expect(body.overall).toBe(worstOf(body.checks));
    expect(body.summary).toBeTruthy();
  });

  it("reads the database it is actually connected to", async () => {
    const res = await handleRequest(new Request("https://test.local/api/diagnostics/health", { headers: MP }), env);
    const body = (await res.json()) as { checks: HealthCheck[] };
    const db = body.checks.find((c) => c.key === "database");
    // Not "reachable" as a constant — the schema number comes back from schema_version.
    expect(db?.state).toBe("OK");
    expect(db?.reading).toMatch(/schema \d+/);
  });

  // The regression this file exists to prevent: a check that could not run must never read as clean.
  it("does not report a check it could not take", async () => {
    const res = await handleRequest(new Request("https://test.local/api/diagnostics/health", { headers: MP }), env);
    const body = (await res.json()) as { checks: HealthCheck[] };
    expect(body.checks.find((c) => c.key === "readings")).toBeUndefined();
  });
});
