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
 * A QUIET LANE AND A BROKEN ONE ARE DIFFERENT FACTS, AND ONLY ONE OF THEM IS A FAULT.
 *
 * Operator, 18 Sep 2026, reading her live Home: "decks arriving is not broken. we just dont get
 * decks every day. he should not check every 15 min."
 *
 * WHAT THIS FILE USED TO PIN, AND WHY IT IS INVERTED RATHER THAN RELAXED. The previous tests
 * required DEGRADED after a silence of sixteen days and OK the moment anything arrived — that is,
 * they pinned "counting quiet days" as the contract. On 18 Sep that contract rendered as "Decks
 * arriving · Needs a look · nothing has arrived for 25 days" over a firm that is sent a deck a few
 * times a month, next to a check that was genuinely failing. The check was firing on the ordinary
 * condition of the business it watched.
 *
 * THE NEW CONTRACT IS STRICTER, NOT LOOSER. The old file asserted one thing (an age crossed a line).
 * These assert that every REAL way the lane can stop is caught — no bucket, no job, a job switched
 * off, a job that failed, a job not running to its own schedule, a deck that arrived and was not
 * read — AND that a long silence over healthy machinery is reported as working. A threshold moved
 * from 7 days to 60 would have passed the old tests and is exactly the bug with a later fuse; it
 * fails these, because quiet is not permitted to move the state at all.
 */
describe("the deck lane reports whether it can receive a deck, not whether one came", () => {
  /** Its own database: the suite above must stay a clean board. */
  let lane: TestDb;
  let laneEnv: Env;

  beforeAll(async () => {
    lane = await createTestDb();
    // The bucket is BOUND here, because an unbound one is itself one of the faults under test and
    // would otherwise mask every other case behind a single permanent red.
    laneEnv = makeTestEnv(lane.db, { WP_OS_DOCUMENTS: lane.docs });
    await healthyJob();
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

  /** The job as a healthy daily lane: on, ran within its cadence, last run fine. */
  async function healthyJob(lastRunAt = new Date(Date.now() - 3 * 3_600_000).toISOString()): Promise<void> {
    await laneEnv.WP_OS_DB.prepare(
      `UPDATE scheduled_job
          SET status = 'ACTIVE', schedule_kind = 'DAILY_AT', interval_minutes = NULL,
              daily_at_utc = '11:15', daily_at_tz = 'America/Chicago',
              last_run_at = ?1, next_run_at = ?2
        WHERE job_key = 'deck_reading'`,
    )
      .bind(lastRunAt, new Date(Date.now() + 20 * 3_600_000).toISOString())
      .run();
    await laneEnv.WP_OS_DB.prepare("DELETE FROM job_run WHERE job_id = 'sjob_deck_reading'").run();
  }

  async function arrive(id: string, createdAt: string, state: "PENDING" | "READ", companyId: string | null = null): Promise<void> {
    await laneEnv.WP_OS_DB.prepare(
      `INSERT INTO pending_deck (id, company_id, filename, object_key, bytes, state, created_at, firm_scope)
       VALUES (?1, ?6, ?2, ?3, 1024, ?4, ?5, 'west-peek')`,
    )
      .bind(id, `${id}.pdf`, `decks/${id}.pdf`, state, createdAt, companyId)
      .run();
  }

  async function clearDecks(): Promise<void> {
    await laneEnv.WP_OS_DB.prepare("DELETE FROM pending_deck").run();
  }

  it("is WORKING when nothing has ever arrived and the machinery is fine", async () => {
    await clearDecks();
    await healthyJob();
    const c = await deckCheck();
    expect(c.state, "an empty lane with a healthy reader is the lane working").toBe("OK");
    expect(c.remedy, "there is nothing for her to do, so there is no remedy").toBeUndefined();
    // The quiet is still SAID — it is worth knowing and it is not worth a light.
    expect(c.reading).toContain("no deck has arrived yet");
    // And the cadence she asked for is on the board, in her own clock.
    expect(c.reading).toContain("once a day at 11:15 America/Chicago");
  });

  it("is WORKING through the exact silence she complained about: 25 days, healthy pipeline", async () => {
    await clearDecks();
    await healthyJob();
    const twentyFive = new Date(Date.now() - 25 * 86_400_000).toISOString();
    await arrive("pd_old", twentyFive, "READ");

    const c = await deckCheck();
    expect(c.state, "nothing has arrived for 25 days and nothing is broken — this must not read as a fault").toBe("OK");
    expect(c.remedy).toBeUndefined();
    // The age is reported as the normal fact it is, with its date, and says so in words.
    expect(c.reading).toMatch(/nothing to read for 25 days/);
    expect(c.reading).toContain(twentyFive.slice(0, 10));
    expect(c.reading).toContain("normal for this firm");
  });

  it("stays WORKING at any silence, because no threshold exists to cross", async () => {
    await clearDecks();
    await healthyJob();
    // Six months. A check with a 60-day fuse instead of a 7-day one would fail here, which is the
    // point: raising the threshold is the same bug later, and this test refuses it.
    await arrive("pd_ancient", new Date(Date.now() - 180 * 86_400_000).toISOString(), "READ");
    const c = await deckCheck();
    expect(c.state).toBe("OK");
  });

  it("is DOWN when nothing can store a deck, because one arriving today could not be read", async () => {
    await clearDecks();
    await healthyJob();
    const storeless = makeTestEnv(lane.db);
    const c = (await runHealthChecks(storeless)).find((x) => x.key === "deck_intake");
    expect(c?.state).toBe("DOWN");
    expect(c?.reading).toContain("no document store is bound");
  });

  it("is DOWN when the reader is switched off, however recently a deck arrived", async () => {
    await clearDecks();
    await healthyJob();
    await arrive("pd_today", new Date().toISOString(), "READ");
    await laneEnv.WP_OS_DB.prepare("UPDATE scheduled_job SET status = 'PAUSED' WHERE job_key = 'deck_reading'").run();
    const c = await deckCheck();
    expect(c.state, "a recent arrival does not make a switched-off reader healthy").toBe("DOWN");
    expect(c.reading).toContain("paused");
    expect(c.remedy).toContain("Switch the deck reader back on");
    await healthyJob();
  });

  it("is DOWN when the last run failed", async () => {
    await clearDecks();
    await healthyJob();
    await laneEnv.WP_OS_DB.prepare(
      `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, started_at, requested_by, firm_scope)
       VALUES ('jr_deck_fail', 'sjob_deck_reading', 'deck_reading:test-fail', 'SCHEDULED', 'FAILED', ?1, 'test', 'west-peek')`,
    ).bind(new Date(Date.now() - 3_600_000).toISOString()).run();
    const c = await deckCheck();
    expect(c.state).toBe("DOWN");
    expect(c.reading).toContain("the last run failed");
    await healthyJob();
  });

  it("is DOWN when the reader has stopped running to its own schedule", async () => {
    await clearDecks();
    // Three days since the last run of a job that runs daily.
    await healthyJob(new Date(Date.now() - 3 * 86_400_000).toISOString());
    const c = await deckCheck();
    expect(c.state).toBe("DOWN");
    expect(c.reading).toContain("it last ran");
    // The lateness is measured against the row's OWN cadence, so the words name it.
    expect(c.reading).toContain("once a day at 11:15 America/Chicago");
    await healthyJob();
  });

  it("is DOWN when a deck arrived and was not read past the lane's own cadence", async () => {
    await clearDecks();
    await healthyJob();
    // It has a company, so nothing is waiting on a person: the reader simply did not read it.
    await laneEnv.WP_OS_DB.prepare(
      "INSERT INTO canonical_company (id, canonical_name, privacy_label, created_by) VALUES ('cc_deck_health','Sensori','INTERNAL','test')",
    ).run();
    await arrive("pd_stuck", new Date(Date.now() - 3 * 86_400_000).toISOString(), "PENDING", "cc_deck_health");
    const c = await deckCheck();
    expect(c.state, "a deck that arrived and was never read is the real version of this alarm").toBe("DOWN");
    expect(c.reading).toContain("has not been read");
  });

  it("is a look-at-me, not a fault, when a deck waits for somebody to open its company", async () => {
    await clearDecks();
    await healthyJob();
    await arrive("pd_no_company", new Date().toISOString(), "PENDING", null);
    const c = await deckCheck();
    expect(c.state, "a person has to act, and nothing is broken").toBe("DEGRADED");
    expect(c.reading).toContain("1 waiting");
    expect(c.remedy).toContain("that step is a person's");
  });

  it("is WORKING with decks waiting that it can read, because a full queue is the lane working", async () => {
    await clearDecks();
    await healthyJob();
    await arrive("pd_waiting", new Date().toISOString(), "PENDING", "cc_deck_health");
    const c = await deckCheck();
    expect(c.state).toBe("OK");
    expect(c.reading).toContain("1 waiting");
  });
});
