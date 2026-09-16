import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { computeNextRun, occurrenceKey, runDueJobs, runJob, type ScheduledJobRow } from "../src/worker/services/jobs";

/**
 * MONTHLY and ON_REQUEST are real schedule kinds (0169, 15 Sep 2026).
 *
 * WHAT THIS HOLDS.
 *   · A MONTHLY job's occurrence window is the MONTH: a second cron tick in the same month replays
 *     and does not re-run; "Run it now" mints its own key and runs regardless (item 6 of the brief).
 *   · ON_REQUEST is never due on a tick, and its next_run_at is NULL by CHECK.
 *   · RETIRED rows are off the Work page, cannot be resumed, and refuse to run.
 *   · The rebuild in 0169 works with job_run rows present — the reason 0043 gave for never
 *     rebuilding scheduled_job was the foreign key from job_run; `defer_foreign_keys` is what lets
 *     the DROP happen inside D1's transaction. Proven here by replaying the rebuild over a database
 *     that has runs, not assumed.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

function req(path: string, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? MP : { ...MP, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // Walker on duty, so the monthly job's refusals below are about the schedule and nothing else.
  await t.db.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_walker'").run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the arithmetic", () => {
  it("moves a MONTHLY job to its day this month, or next month once it has passed", () => {
    const job = { schedule_kind: "MONTHLY", interval_minutes: null, daily_at_utc: "14:00", day_of_month: 1 } as const;
    expect(computeNextRun(job, new Date("2026-09-15T20:00:00.000Z"))).toBe("2026-10-01T14:00:00.000Z");
    expect(computeNextRun(job, new Date("2026-10-01T13:59:00.000Z"))).toBe("2026-10-01T14:00:00.000Z");
    expect(computeNextRun(job, new Date("2026-10-01T14:00:00.000Z"))).toBe("2026-11-01T14:00:00.000Z");
    expect(computeNextRun(job, new Date("2026-12-20T09:00:00.000Z"))).toBe("2027-01-01T14:00:00.000Z");
  });

  it("has no next time for ON_REQUEST", () => {
    expect(computeNextRun({ schedule_kind: "ON_REQUEST", interval_minutes: null, daily_at_utc: null }, new Date())).toBeNull();
  });

  it("keys a MONTHLY occurrence by the month, so two ticks in one month share a key", () => {
    const job = { job_key: "k", schedule_kind: "MONTHLY", interval_minutes: null, daily_at_utc: "14:00", day_of_month: 1 } as unknown as ScheduledJobRow;
    expect(occurrenceKey(job, new Date("2026-10-01T14:00:00.000Z"))).toBe("k:2026-10");
    expect(occurrenceKey(job, new Date("2026-10-28T09:00:00.000Z"))).toBe("k:2026-10");
    expect(occurrenceKey(job, new Date("2026-11-01T14:00:00.000Z"))).toBe("k:2026-11");
  });
});

describe("what 0169 did to the rows", () => {
  it("made productions_monthly MONTHLY on the 1st at 14:00 and due on a 1st", async () => {
    const row = await t.db.prepare("SELECT schedule_kind, day_of_month, daily_at_utc, next_run_at, status FROM scheduled_job WHERE job_key = 'productions_monthly'")
      .first<{ schedule_kind: string; day_of_month: number; daily_at_utc: string; next_run_at: string; status: string }>();
    expect(row).toMatchObject({ schedule_kind: "MONTHLY", day_of_month: 1, daily_at_utc: "14:00", status: "ACTIVE" });
    expect(row!.next_run_at).toMatch(/-01T14:00:00\.000Z$/);
    expect(row!.next_run_at > new Date().toISOString(), "due on the NEXT 1st, not in the past").toBe(true);
  });

  it("made deck_rebuild ON_REQUEST with no clock", async () => {
    const row = await t.db.prepare("SELECT schedule_kind, next_run_at, status FROM scheduled_job WHERE job_key = 'deck_rebuild'")
      .first<{ schedule_kind: string; next_run_at: string | null; status: string }>();
    expect(row).toMatchObject({ schedule_kind: "ON_REQUEST", next_run_at: null, status: "ACTIVE" });
  });

  it("retired the introduction and the two folded duties, keeping their rows", async () => {
    const rows = (await t.db.prepare("SELECT job_key, status FROM scheduled_job WHERE job_key IN ('productions_intro_note','productions_customer_ideas','productions_press_pitches') ORDER BY job_key")
      .all<{ job_key: string; status: string }>()).results!;
    expect(rows.map((r) => r.status)).toEqual(["RETIRED", "RETIRED", "RETIRED"]);
  });
});

describe("a MONTHLY job runs once a month, and by hand whenever asked", () => {
  it("a second cron tick in the same month replays; Run it now still runs", async () => {
    const first = new Date("2026-10-01T14:00:30.000Z");
    const ran = await runJob(env, MP_ACTOR, "productions_monthly", { trigger: "SCHEDULED", now: first });
    expect(ran.replayed).toBe(false);
    expect(ran.run.status, String(ran.run.outcome_summary)).toBe("SUCCEEDED");
    const after = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'productions_monthly'").first<{ next_run_at: string }>();
    expect(after!.next_run_at).toBe("2026-11-01T14:00:00.000Z");

    // The same month, weeks later, with the clock wrongly put back: still one occurrence.
    await t.db.prepare("UPDATE scheduled_job SET next_run_at = ?1 WHERE job_key = 'productions_monthly'").bind("2026-10-20T00:00:00.000Z").run();
    const again = await runJob(env, MP_ACTOR, "productions_monthly", { trigger: "SCHEDULED", now: new Date("2026-10-20T14:05:00.000Z") });
    expect(again.replayed, "a second tick in October must not open a second card").toBe(true);
    const runs = await t.db.prepare("SELECT COUNT(*) AS n FROM job_run WHERE job_id = (SELECT id FROM scheduled_job WHERE job_key = 'productions_monthly') AND trigger_kind = 'SCHEDULED'").first<{ n: number }>();
    expect(runs!.n).toBe(1);
    // …and the replay repaired the clock instead of wedging the tick on it.
    const repaired = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'productions_monthly'").first<{ next_run_at: string }>();
    expect(repaired!.next_run_at).toBe("2026-11-01T14:00:00.000Z");

    // A person asking gets a fresh occurrence, same month.
    const byHand = await runJob(env, MP_ACTOR, "productions_monthly", { trigger: "MANUAL", now: new Date("2026-10-20T14:06:00.000Z") });
    expect(byHand.replayed).toBe(false);
    expect(String(byHand.run.idempotency_key)).toMatch(/^productions_monthly:manual:/);
    // The card is month-unique, so the manual run opens nothing new and says so.
    expect(String(byHand.run.outcome_summary)).toMatch(/already open or done/);

    // November is a new occurrence.
    const nov = await runJob(env, MP_ACTOR, "productions_monthly", { trigger: "SCHEDULED", now: new Date("2026-11-01T14:00:10.000Z") });
    expect(nov.replayed).toBe(false);
  });
});

describe("ON_REQUEST never wakes on the clock", () => {
  it("is not picked up by the tick, and runs when asked", async () => {
    // Every other job paused, so the only candidate is the on-request one.
    await t.db.prepare("UPDATE scheduled_job SET status = 'PAUSED', pause_reason = 'test' WHERE status = 'ACTIVE' AND job_key <> 'deck_rebuild'").run();
    const results = await runDueJobs(env, new Date("2026-10-02T09:00:00.000Z"));
    expect(results.filter((r) => r.job_key === "deck_rebuild")).toEqual([]);
    const still = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'deck_rebuild'").first<{ next_run_at: string | null }>();
    expect(still!.next_run_at).toBeNull();

    const asked = await runJob(env, MP_ACTOR, "deck_rebuild", { trigger: "MANUAL", now: new Date("2026-10-02T09:01:00.000Z") });
    expect(asked.replayed).toBe(false);
    expect(["SUCCEEDED", "REFUSED", "FAILED"]).toContain(String(asked.run.status));
    // Running it by hand leaves it with no clock.
    const after = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'deck_rebuild'").first<{ next_run_at: string | null }>();
    expect(after!.next_run_at).toBeNull();
  });

  it("refuses a MONTHLY job without its day, and an ON_REQUEST job with a clock, at the schema", async () => {
    await expect(
      t.db.prepare("INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, created_by) VALUES ('sj_bad1','bad_monthly','x','EMPLOYEE_TASK','MONTHLY','14:00','SYSTEM','test')").run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      t.db.prepare("INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, target_kind, created_by, next_run_at) VALUES ('sj_bad2','bad_req','x','EMPLOYEE_TASK','ON_REQUEST','SYSTEM','test','2026-10-01T00:00:00.000Z')").run(),
    ).rejects.toThrow(/CHECK/);
  });
});

describe("RETIRED is off the page and never runs", () => {
  it("is hidden from /api/jobs, cannot be put back on, and refuses to run", async () => {
    const list = await handleRequest(req("/api/jobs"), env);
    const keys = ((await list.json()) as { jobs: Array<{ job_key: string }> }).jobs.map((j) => j.job_key);
    for (const k of ["productions_intro_note", "productions_customer_ideas", "productions_press_pitches"]) expect(keys).not.toContain(k);
    expect(keys).toContain("productions_monthly");

    const resume = await handleRequest(req("/api/jobs/productions_customer_ideas/status", "POST", { status: "ACTIVE", reason: "test" }), env);
    expect(resume.status).toBe(409);

    const run = await runJob(env, MP_ACTOR, "productions_press_pitches", { trigger: "MANUAL" });
    expect(String(run.run.status)).toBe("REFUSED");
    expect(String(run.run.outcome_summary)).toMatch(/RETIRED/);
  });
});

describe("the rebuild survives foreign keys from job_run", () => {
  it("replays 0172's rebuild (the live DDL, after 0169's) over a database that has runs, and every run still points at its job", async () => {
    const before = await t.db.prepare("SELECT COUNT(*) AS n FROM job_run").first<{ n: number }>();
    expect(before!.n, "the premise: runs exist before the rebuild").toBeGreaterThan(0);
    // The migration's scheduled_job statements: from the PRAGMA up to (not including) the seed of
    // the weekly job.
    const sql = readFileSync(new URL("../migrations/0172_weekly_hire_search.sql", import.meta.url), "utf8");
    const rebuild = sql.slice(0, sql.indexOf("-- Walker's weekly hire search"));
    const statements = rebuild
      .split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
      .split(";").map((s) => s.trim()).filter(Boolean)
      // The live table already carries day_of_week (this database ran 0172 once, and its seed put a
      // WEEKLY row in); the migration's copy list is written for the table BEFORE 0172, which had no
      // such column. Carry it here so the WEEKLY row survives its own CHECK — the mechanics under
      // test are DROP + FK, not the list.
      .map((s) => s.startsWith("INSERT INTO scheduled_job (") ? s.replaceAll("interval_minutes, daily_at_utc, day_of_month, target_kind", "interval_minutes, daily_at_utc, day_of_week, day_of_month, target_kind") : s);
    expect(statements[0]).toMatch(/^PRAGMA defer_foreign_keys/);
    await t.db.batch(statements.map((s) => t.db.prepare(s)));
    const orphans = await t.db.prepare("SELECT COUNT(*) AS n FROM job_run r WHERE NOT EXISTS (SELECT 1 FROM scheduled_job j WHERE j.id = r.job_id)").first<{ n: number }>();
    expect(orphans!.n).toBe(0);
    const after = await t.db.prepare("SELECT COUNT(*) AS n FROM job_run").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    const weekly = await t.db.prepare("SELECT day_of_week FROM scheduled_job WHERE job_key = 'productions_hire_search'").first<{ day_of_week: number }>();
    expect(weekly?.day_of_week, "the WEEKLY row came through the rebuild intact").toBe(1);
    // The WEEKLY CHECK is live on the rebuilt table.
    await expect(
      t.db.prepare("INSERT INTO scheduled_job (id, job_key, name, kind, schedule_kind, daily_at_utc, target_kind, created_by) VALUES ('sj_bad3','bad_weekly','x','EMPLOYEE_TASK','WEEKLY','14:00','SYSTEM','test')").run(),
    ).rejects.toThrow(/CHECK/);
    // And the foreign key is still enforced on the rebuilt table.
    await expect(
      t.db.prepare("INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, requested_by) VALUES ('jrun_orphan','sjb_nope','k','MANUAL','QUEUED','test')").run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });
});
