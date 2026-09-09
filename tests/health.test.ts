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
import { runHealthChecks } from "../src/worker/services/health";

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

/**
 * A LANE NOBODY IS FEEDING IS NOT THE SAME AS A LANE THAT IS KEEPING UP.
 *
 * Operator, 9 Sep 2026: "i noticed i had to tell Wyatt to 'start' inputting the decks that came in
 * — this should be automatic not something he asks me if he can do."
 *
 * The premise turned out to be wrong in a way that matters more than the complaint. Wyatt does not
 * ask. `deck_reading` is ACTIVE, fires every fifteen minutes, and has no approval gate of any kind —
 * and in the seven days to 9 Sep it succeeded 310 times, every run reporting "no decks waiting".
 * Production holds two decks ever, both read on 23 August. The lane had had NO ARRIVALS FOR SIXTEEN
 * DAYS, and 310 green ticks said so in a way nobody could hear. A human became the trigger because
 * an empty lane and a healthy one were indistinguishable.
 *
 * DEGRADED, never DOWN: nothing is broken and decks may genuinely not have been sent. The point is
 * that the silence is now visible and escalates to both partners like any other fault, instead of
 * being discovered by a partner going and asking an employee to start.
 */
describe("the deck lane reports its own silence", () => {
  /** Its own database: the suite above must stay a clean board. */
  let lane: TestDb;
  let laneEnv: Env;

  beforeAll(async () => {
    lane = await createTestDb();
    laneEnv = makeTestEnv(lane.db);
  });
  afterAll(async () => {
    await disposeTestDb(lane);
  });

  const deckCheck = async () => {
    const checks = await runHealthChecks(laneEnv);
    const found = checks.find((c) => c.key === "deck_intake");
    // Hard-fails when the check is absent, rather than skipping and passing.
    expect(found, "there is no deck_intake check, so nothing watches this lane").toBeTruthy();
    return found!;
  };

  async function arrive(id: string, createdAt: string, state: "PENDING" | "READ"): Promise<void> {
    await laneEnv.WP_OS_DB.prepare(
      `INSERT INTO pending_deck (id, filename, object_key, bytes, state, created_at, firm_scope)
       VALUES (?1, ?2, ?3, 1024, ?4, ?5, 'west-peek')`,
    )
      .bind(id, `${id}.pdf`, `decks/${id}.pdf`, state, createdAt)
      .run();
  }

  it("says so when no deck has ever arrived, instead of reporting a clean queue", async () => {
    const c = await deckCheck();
    expect(c.state).toBe("DEGRADED");
    expect(c.reading).toContain("has ever arrived");
    // The remedy corrects the premise rather than repeating it: he is not waiting for permission.
    expect(c.remedy).toContain("needs no permission");
  });

  it("is DEGRADED once the lane has been silent past the threshold, and names the days", async () => {
    // The production shape: read long ago, nothing since.
    const sixteenDaysAgo = new Date(Date.now() - 16 * 86_400_000).toISOString();
    await arrive("pd_old", sixteenDaysAgo, "READ");

    const c = await deckCheck();
    expect(c.state).toBe("DEGRADED");
    expect(c.reading, "the silence is not quantified, so it reads the same on day 1 and day 16")
      .toMatch(/nothing has arrived for 1[0-9] days/);
    expect(c.reading).toContain(sixteenDaysAgo.slice(0, 10));
  });

  it("is OK again the moment something arrives", async () => {
    await arrive("pd_new", new Date().toISOString(), "READ");
    const c = await deckCheck();
    expect(c.state).toBe("OK");
    expect(c.remedy).toBeUndefined();
  });

  it("is OK with decks waiting, because a full queue is the lane working", async () => {
    await arrive("pd_waiting", new Date().toISOString(), "PENDING");
    const c = await deckCheck();
    expect(c.state).toBe("OK");
    expect(c.reading).toContain("1 waiting");
  });
});
