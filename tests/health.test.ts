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
import { BRIEF_FAULT_WINDOW_HOURS, runHealthChecks } from "../src/worker/services/health";
import { STALE_AFTER_MINUTES } from "../src/worker/services/dailyIntelligence";

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

/**
 * A BRIEF NOBODY ASKED FOR CANNOT BE DOWN.
 *
 * Willow, 20 Sep 2026: "Scooter's brief is down." Production: his latest row was 18 Sep, FAILED,
 * written by the schedule retired on the 19th, `requested_at` NULL. Nothing had been asked for
 * and nothing had run since; the board read the latest row of any date and carried a
 * pre-retirement failure forward as today's fault — and would have until someone pressed for him.
 *
 * THE CONTRACT, PINNED FROM THE PRODUCTION SHAPE. Only a REQUESTED brief can be a fault, and only
 * while the request is current; every real way a press can fail is still red. `BRIEF_FAULT_WINDOW_HOURS`
 * is read from the module so a change there changes the pin rather than dodging it.
 */
describe("a partner's brief is judged by what was asked for, not by the last row on file", () => {
  let lane: TestDb;
  let laneEnv: Env;
  const SCOOTER = "fu_scooter_taylor";
  const H = 3_600_000;

  beforeAll(async () => {
    lane = await createTestDb();
    laneEnv = makeTestEnv(lane.db);
  });
  afterAll(async () => {
    await disposeTestDb(lane);
  });

  const scootersBrief = async () => {
    const checks = await runHealthChecks(laneEnv);
    const found = checks.find((c) => c.key === `daily_brief_${SCOOTER}`);
    // Hard-fails when the check is absent, rather than skipping and passing.
    expect(found, "there is no per-partner brief check, so nothing watches the brief").toBeTruthy();
    return found!;
  };

  async function reset(): Promise<void> {
    await laneEnv.WP_OS_DB.prepare("DELETE FROM intelligence_report_section").run();
    await laneEnv.WP_OS_DB.prepare("DELETE FROM intelligence_report").run();
  }

  async function row(opts: {
    id: string; date: string; status: string; startedAt: string; requestedAt: string | null; error?: string | null; completedAt?: string | null;
  }): Promise<void> {
    await laneEnv.WP_OS_DB.prepare(
      `INSERT INTO intelligence_report (id, firm_user_id, report_date, status, prompt_version, firm_scope, started_at, stage_at, requested_at, requested_by, error_code, error_message, completed_at, attempts)
       VALUES (?1, ?2, ?3, ?4, 'daily-intelligence-v6', 'west-peek', ?5, ?5, ?6, CASE WHEN ?6 IS NULL THEN NULL ELSE ?2 END, CASE WHEN ?7 IS NULL THEN NULL ELSE 'incomplete' END, ?7, ?8, 3)`,
    ).bind(opts.id, SCOOTER, opts.date, opts.status, opts.startedAt, opts.requestedAt, opts.error ?? null, opts.completedAt ?? null).run();
  }

  it("reads a never-requested failure from the retired schedule as history, not a fault", async () => {
    await reset();
    // Scooter's production shape on 20 Sep: last READY 17 Sep, 18 Sep FAILED by the schedule, no request ever.
    const ready = new Date(Date.now() - 3 * 24 * H).toISOString();
    await row({ id: "dir_ready", date: "2026-09-17", status: "READY", startedAt: ready, requestedAt: null, completedAt: ready });
    await row({ id: "dir_sched_fail", date: "2026-09-18", status: "FAILED", startedAt: new Date(Date.now() - 2 * 24 * H).toISOString(), requestedAt: null, error: "the brief was rejected twice: executive_summary carries no [n] citation" });
    const c = await scootersBrief();
    expect(c.state).toBe("OK");
    expect(c.reading).toMatch(/last brief 3 days ago/);
    expect(c.reading).toMatch(/on demand/);
    expect(c.remedy).toBeUndefined();
  });

  it("a requested brief that failed today is DOWN, with the row's own reason as the remedy", async () => {
    await reset();
    const at = new Date(Date.now() - 2 * H).toISOString();
    await row({ id: "dir_fail_now", date: new Date().toISOString().slice(0, 10), status: "FAILED", startedAt: at, requestedAt: at, error: "the brief was rejected twice: markets_macro is missing" });
    const c = await scootersBrief();
    expect(c.state).toBe("DOWN");
    expect(c.remedy).toContain("markets_macro is missing");
    expect(c.reading).toMatch(/requested by Scooter/);
  });

  it("a requested brief that failed and recorded no reason is DOWN and says so", async () => {
    await reset();
    const at = new Date(Date.now() - H).toISOString();
    await row({ id: "dir_fail_mute", date: new Date().toISOString().slice(0, 10), status: "FAILED", startedAt: at, requestedAt: at, error: null });
    const c = await scootersBrief();
    expect(c.state).toBe("DOWN");
    expect(c.remedy).toMatch(/did not record why/);
  });

  it("a requested brief that stopped moving past the sweeper's threshold is DOWN", async () => {
    await reset();
    const at = new Date(Date.now() - (STALE_AFTER_MINUTES + 5) * 60_000).toISOString();
    await row({ id: "dir_stuck", date: new Date().toISOString().slice(0, 10), status: "GENERATING", startedAt: at, requestedAt: at });
    const c = await scootersBrief();
    expect(c.state).toBe("DOWN");
    expect(c.reading).toMatch(/stopped part-way/);
  });

  it("a requested brief still moving inside the threshold is DEGRADED, never DOWN", async () => {
    await reset();
    const at = new Date(Date.now() - 2 * 60_000).toISOString();
    await row({ id: "dir_moving", date: new Date().toISOString().slice(0, 10), status: "GENERATING", startedAt: at, requestedAt: at });
    const c = await scootersBrief();
    expect(c.state).toBe("DEGRADED");
  });

  it("a requested failure older than the window is history in the reading and OK in the state", async () => {
    await reset();
    const at = new Date(Date.now() - (BRIEF_FAULT_WINDOW_HOURS + 1) * H).toISOString();
    await row({ id: "dir_fail_old", date: at.slice(0, 10), status: "FAILED", startedAt: at, requestedAt: at, error: "the model timed out" });
    const c = await scootersBrief();
    expect(c.state).toBe("OK");
    expect(c.reading).toMatch(/last request \(\d{4}-\d{2}-\d{2}\) failed/);
    expect(c.remedy).toBeUndefined();
  });

  it("a requested failure just inside the window is still DOWN — the window is a line, not a slope", async () => {
    await reset();
    const at = new Date(Date.now() - (BRIEF_FAULT_WINDOW_HOURS - 1) * H).toISOString();
    await row({ id: "dir_fail_edge", date: at.slice(0, 10), status: "FAILED", startedAt: at, requestedAt: at, error: "the model timed out" });
    const c = await scootersBrief();
    expect(c.state).toBe("DOWN");
  });

  it("a requested brief that arrived is OK and says delivered", async () => {
    await reset();
    const at = new Date(Date.now() - H).toISOString();
    await row({ id: "dir_ok", date: new Date().toISOString().slice(0, 10), status: "READY", startedAt: at, requestedAt: at, completedAt: at });
    const c = await scootersBrief();
    expect(c.state).toBe("OK");
    expect(c.reading).toMatch(/delivered/);
    expect(c.reading).toMatch(/last brief today/);
  });
});
