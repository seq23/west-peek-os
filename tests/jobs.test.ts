import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { computeNextRun, occurrenceKey, runDueJobs, runJob, type ScheduledJobRow } from "../src/worker/services/jobs";

/**
 * P19 — Governed orchestration + scheduled AI employees (GAP-21, GAP-22).
 *
 * Rules under test:
 * - A new job is created PAUSED. Recurring work never starts itself.
 * - The seeded Daily Intelligence job is PAUSED for the same reason.
 * - "Employee exists" is NOT "employee runs": a job targeting a non-ACTIVE employee records a
 *   REFUSED run naming D10, and never activates anybody.
 * - A paused machine and a paused job both refuse, with the reason recorded.
 * - Idempotency: two scheduled ticks inside the same window produce ONE run.
 * - Failures retry to the job's own limit and then land in DEAD_LETTER.
 * - Runs produce durable artifacts pointing at the records they created.
 * - The scheduled path is the SAME code the cron trigger calls; running it locally proves the
 *   path, not that Cloudflare fired it.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

/**
 * Activate through the ONLY governed path: reserved card → approval → receipt.
 *
 * The contract is "this employee is ACTIVE when I return", not "I performed the activation".
 * Migration 0136 employed the whole roster, so insisting on doing it makes the helper 409 on a
 * seat that is already working — and that is the seed's business, not this suite's.
 */
async function activate(employeeId: string): Promise<void> {
  const already = await t.db.prepare("SELECT status FROM ai_employee WHERE id = ?1").bind(employeeId).first<{ status: string }>();
  if (already?.status === "ACTIVE") return;

  const card = await call<{ id: string }>(`/api/ai/employees/${employeeId}/request-activation`, MP, "POST", { reason: "P19" });
  await call(`/api/approvals/${card.body.id}/decide`, MP, "POST", { decision: "approved", note: "ok" });
  const res = await call<{ status: string }>(`/api/ai/employees/${employeeId}/activate`, MP, "POST", {
    approval_receipt_id: card.body.id,
    reason: "P19",
  });
  expect(res.body.status).toBe("ACTIVE");
}

/**
 * Stand a seat down, so a test that needs an unemployed employee CREATES that precondition.
 *
 * The mirror of `activate`, and needed for the same reason: since migration 0136 employed the whole
 * roster, "an employee who is not ACTIVE" is not something a test can find lying around. Inheriting
 * it from the seed made the D10 test below assert the seed rather than the rule, and it went red the
 * day the partners employed everybody.
 */
async function standDown(employeeId: string): Promise<void> {
  await t.db.prepare("UPDATE ai_employee SET status = 'INACTIVE' WHERE id = ?1").bind(employeeId).run();
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("schedule arithmetic is pure and testable", () => {
  it("advances an INTERVAL job by its own period", () => {
    const next = computeNextRun({ schedule_kind: "INTERVAL", interval_minutes: 30, daily_at_utc: null }, new Date("2026-08-12T10:00:00.000Z"));
    expect(next).toBe("2026-08-12T10:30:00.000Z");
  });

  it("moves a DAILY_AT job to tomorrow once today's time has passed", () => {
    const before = computeNextRun({ schedule_kind: "DAILY_AT", interval_minutes: null, daily_at_utc: "06:00" }, new Date("2026-08-12T05:00:00.000Z"));
    expect(before).toBe("2026-08-12T06:00:00.000Z");
    const after = computeNextRun({ schedule_kind: "DAILY_AT", interval_minutes: null, daily_at_utc: "06:00" }, new Date("2026-08-12T07:00:00.000Z"));
    expect(after).toBe("2026-08-13T06:00:00.000Z");
  });

  it("gives every trigger inside one window the same occurrence key", () => {
    const job = { job_key: "k", schedule_kind: "INTERVAL", interval_minutes: 60, daily_at_utc: null } as ScheduledJobRow;
    const a = occurrenceKey(job, new Date("2026-08-12T10:05:00.000Z"));
    const b = occurrenceKey(job, new Date("2026-08-12T10:55:00.000Z"));
    const c = occurrenceKey(job, new Date("2026-08-12T11:05:00.000Z"));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("recurring work never starts itself", () => {
  it("seeds the Daily Intelligence job PAUSED with the reason recorded", async () => {
    const res = await call<{ jobs: any[]; architecture: string }>("/api/jobs", MP);
    expect(res.status).toBe(200);
    const daily = res.body.jobs.find((j: any) => j.job_key === "daily_intelligence")!;
    expect(daily.status).toBe("PAUSED");
    expect(daily.pause_reason).toContain("operator must switch recurring work on");
    expect(res.body.architecture).toContain("No Queues, no Durable Objects");
  });

  it("creates every new job PAUSED", async () => {
    const res = await call<{ status: string; pause_reason: string }>("/api/jobs", MP, "POST", {
      job_key: "portfolio_sweep",
      name: "Portfolio alert sweep",
      kind: "PORTFOLIO_EVALUATION",
      schedule_kind: "INTERVAL",
      interval_minutes: 720,
      target_kind: "SYSTEM",
    });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("PAUSED");
    expect(res.body.pause_reason).toContain("operator switches it on");
  });

  it("refuses a duplicate job key and a target that does not exist", async () => {
    const dupe = await call("/api/jobs", MP, "POST", {
      job_key: "portfolio_sweep",
      name: "again",
      kind: "PORTFOLIO_EVALUATION",
      schedule_kind: "INTERVAL",
      interval_minutes: 60,
      target_kind: "SYSTEM",
    });
    expect(dupe.status).toBe(409);

    const ghost = await call("/api/jobs", MP, "POST", {
      job_key: "ghost_job",
      name: "ghost",
      kind: "EMPLOYEE_TASK",
      schedule_kind: "INTERVAL",
      interval_minutes: 60,
      target_kind: "EMPLOYEE",
      target_id: "aie_nobody",
    });
    expect(ghost.status).toBe(404);
  });

  it("a PAUSED job that is run anyway records a REFUSED run rather than doing the work", async () => {
    const res = await call<{ run: { status: string; outcome_summary: string } }>("/api/jobs/daily_intelligence/run", MP, "POST");
    expect(res.status).toBe(201);
    expect(res.body.run.status).toBe("REFUSED");
    expect(res.body.run.outcome_summary).toContain("job is PAUSED");
  });
});

describe("a scheduled job can never activate an employee (GAP-22 / D10)", () => {
  it("REFUSES to run for an employee who is not ACTIVE, and leaves them inactive", async () => {
    // The precondition is created, not inherited. See `standDown` above.
    await standDown("aie_wells");

    const created = await call<{ job_key: string }>("/api/jobs", MP, "POST", {
      job_key: "wells_daily_note",
      name: "Knowledge manager daily note",
      kind: "EMPLOYEE_TASK",
      schedule_kind: "DAILY_AT",
      daily_at_utc: "07:00",
      target_kind: "EMPLOYEE",
      target_id: "aie_wells",
      payload: { prompt: "Summarise yesterday's promoted knowledge." },
    });
    expect(created.status).toBe(201);
    await call("/api/jobs/wells_daily_note/status", MP, "POST", { status: "ACTIVE", reason: "switching the loop on" });

    const run = await call<{ run: { status: string; outcome_summary: string } }>("/api/jobs/wells_daily_note/run", MP, "POST");
    expect(run.body.run.status).toBe("REFUSED");
    expect(run.body.run.outcome_summary).toContain("not ACTIVE");
    expect(run.body.run.outcome_summary).toContain("D10");

    const employee = await t.db.prepare("SELECT status FROM ai_employee WHERE id = 'aie_wells'").first<{ status: string }>();
    expect(employee!.status).toBe("INACTIVE");
  });

  it("runs once the employee has been activated through the reserved receipt path", async () => {
    await activate("aie_wells");
    const run = await call<{ run: { status: string; ai_run_id: string | null } }>("/api/jobs/wells_daily_note/run", MP, "POST");
    expect(["SUCCEEDED", "FAILED", "DEAD_LETTER"]).toContain(run.body.run.status);
    expect(run.body.run.ai_run_id).not.toBeNull();

    // The governed run is attributed to the employee, so its cost lands on their scorecard.
    const aiRun = await t.db.prepare("SELECT ai_employee_id FROM ai_run WHERE id = ?1").bind(run.body.run.ai_run_id).first<{ ai_employee_id: string }>();
    expect(aiRun!.ai_employee_id).toBe("aie_wells");
  });
});

describe("a paused machine stops its scheduled work too", () => {
  it("REFUSES a job whose target machine is paused", async () => {
    await call("/api/machines/33/pause", MP, "POST", { status: "PAUSED", reason: "content freeze" });
    await call("/api/jobs", MP, "POST", {
      job_key: "content_loop",
      name: "Content machine loop",
      kind: "EMPLOYEE_TASK",
      schedule_kind: "INTERVAL",
      interval_minutes: 60,
      target_kind: "MACHINE",
      target_id: "33",
    });
    await call("/api/jobs/content_loop/status", MP, "POST", { status: "ACTIVE", reason: "on" });

    const run = await call<{ run: { status: string; outcome_summary: string } }>("/api/jobs/content_loop/run", MP, "POST");
    expect(run.body.run.status).toBe("REFUSED");
    expect(run.body.run.outcome_summary).toContain("machine 33 is PAUSED");

    await call("/api/machines/33/pause", MP, "POST", { status: "ACTIVE", reason: "freeze lifted" });
  });
});

describe("the scheduled tick is idempotent and produces artifacts", () => {
  it("runs the intelligence job and records what it produced", async () => {
    await call("/api/jobs/daily_intelligence/status", MP, "POST", { status: "ACTIVE", reason: "operator switched it on" });
    const now = new Date("2026-08-12T06:30:00.000Z");
    const first = await runJob(env, MP_ACTOR, "daily_intelligence", { trigger: "SCHEDULED", now });
    expect(first.replayed).toBe(false);
    expect(first.run.status).toBe("SUCCEEDED");

    const detail = await call<{ artifacts: Array<{ kind: string; ref_type: string }> }>(`/api/jobs/runs/${first.run.id}`, MP);
    expect(detail.body.artifacts.some((a) => a.kind === "INTELLIGENCE_RUN")).toBe(true);
  });

  it("a second tick inside the same window replays instead of running twice", async () => {
    /*
     * `daily_intelligence` now runs on the tick rather than once a day, because a Cron Trigger gets
     * 10 ms of CPU on the Workers Free plan and the whole sweep plus every partner's brief does not
     * fit inside one invocation. So the occurrence is a fifteen-minute WINDOW, not a date — a tick
     * three hours later is a different occurrence and is supposed to run.
     *
     * What stops duplicate work now is the per-partner report guard, not the occurrence key: a
     * partner with a terminal report for their local date today is skipped. That is asserted in
     * the daily-intelligence suite; here we only check that the same window does not run twice.
     */
    const withinSameWindow = new Date("2026-08-12T06:31:00.000Z");
    const again = await runJob(env, MP_ACTOR, "daily_intelligence", { trigger: "SCHEDULED", now: withinSameWindow });
    expect(again.replayed).toBe(true);

    const laterWindow = new Date("2026-08-12T09:00:00.000Z");
    const next = await runJob(env, MP_ACTOR, "daily_intelligence", { trigger: "SCHEDULED", now: laterWindow });
    expect(next.replayed).toBe(false);
  });

  it("runDueJobs is the same path the cron trigger calls", async () => {
    const results = await runDueJobs(env, new Date("2026-08-14T08:00:00.000Z"));
    expect(Array.isArray(results)).toBe(true);
    // The daily intelligence job is due again on a later day and runs.
    expect(results.some((r) => r.job_key === "daily_intelligence")).toBe(true);
  });

  it("the operator tick route says plainly what it does and does not prove", async () => {
    const res = await call<{ ran: any[]; note: string }>("/api/jobs/tick", MP, "POST");
    expect(res.status).toBe(200);
    expect(res.body.note).toContain("does not prove that Cloudflare fired it");
  });
});

describe("failures retry to the limit and then dead-letter", () => {
  it("moves a repeatedly failing job to DEAD_LETTER instead of looping", async () => {
    // An EMPLOYEE_TASK for an ACTIVE employee whose data class can never egress: every run is
    // blocked by the governed pipeline, which is a genuine failure rather than a refusal.
    await activate("aie_pierce");
    await call("/api/jobs", MP, "POST", {
      job_key: "always_fails",
      name: "A job that cannot succeed",
      kind: "EMPLOYEE_TASK",
      schedule_kind: "INTERVAL",
      interval_minutes: 5,
      target_kind: "EMPLOYEE",
      target_id: "aie_pierce",
      data_class: "MNPI_SENSITIVE",
      max_attempts: 2,
      payload: { prompt: "handle material non-public information" },
    });
    await call("/api/jobs/always_fails/status", MP, "POST", { status: "ACTIVE", reason: "on" });

    // Force the FRONTIER path so the egress policy actually blocks (LOCKDOWN would succeed locally).
    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
         VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 25.0, 2.0, 'fu_scooter_taylor')`,
      )
      .bind(`bp_${crypto.randomUUID()}`)
      .run();

    const first = await call<{ run: { status: string; attempt: number } }>("/api/jobs/always_fails/run", MP, "POST");
    expect(first.body.run.status).toBe("FAILED");
    expect(first.body.run.attempt).toBe(1);

    const second = await call<{ run: { status: string; attempt: number } }>("/api/jobs/always_fails/run", MP, "POST");
    expect(second.body.run.attempt).toBe(2);
    expect(second.body.run.status).toBe("DEAD_LETTER");

    const listed = await call<{ jobs: any[] }>("/api/jobs", MP);
    expect(listed.body.jobs.find((j: any) => j.job_key === "always_fails")!.dead_letters).toBe(1);

    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, set_by)
         VALUES (?1, 'west-peek', 'NORMAL', 'LOCKDOWN', 25.0, 2.0, 'fu_scooter_taylor')`,
      )
      .bind(`bp_${crypto.randomUUID()}`)
      .run();
  });

  it("refuses to cancel a run that has already finished", async () => {
    const finished = await t.db.prepare("SELECT id FROM job_run WHERE status = 'SUCCEEDED' LIMIT 1").first<{ id: string }>();
    const res = await call(`/api/jobs/runs/${finished!.id}/cancel`, MP, "POST");
    expect(res.status).toBe(409);
  });
});

/*
 * ADDRESSING AN EMPLOYEE THE WAY PRODUCTION ACTUALLY DOES.
 *
 * Every test above targets an employee by id — "aie_wells", "aie_pierce". Production does not:
 * `scheduled_job.target_id` holds the roster NAME, because that is how the whole system addresses
 * an AI employee. So the precondition check's `WHERE id = ?1` matched nothing, and the Monthly Room
 * proposal refused itself twice a day with "target employee Parker does not exist" — about an
 * employee who exists, is ACTIVE, and whose id is `aie_parker`.
 *
 * The tests passed throughout, because the fixtures encoded a convention the real rows do not use.
 * That is the actual lesson: a test that addresses data differently from production proves the code
 * works on data that will never arrive.
 */
describe("an employee addressed by name, which is what the rows hold", () => {
  it("finds them, rather than refusing a job for an employee who plainly exists", async () => {
    const employee = await t.db.prepare("SELECT id, name FROM ai_employee WHERE id = 'aie_wells'")
      .first<{ id: string; name: string }>();
    expect(employee, "fixture must have the employee this test addresses").toBeTruthy();

    const created = await call<{ job_key: string }>("/api/jobs", MP, "POST", {
      job_key: "by_name_job",
      name: `Task for ${employee!.name}`,
      kind: "EMPLOYEE_TASK",
      schedule_kind: "DAILY_AT",
      daily_at_utc: "09:00",
      target_kind: "EMPLOYEE",
      // The name, exactly as scheduled_job rows carry it in production.
      target_id: employee!.name,
      payload: { prompt: "Do the thing." },
    });
    expect(created.status, "a job addressed by name must be creatable").toBe(201);

    await call("/api/jobs/by_name_job/status", MP, "POST", { status: "ACTIVE", reason: "switching it on" });
    const run = await call<{ run: { status: string; outcome_summary: string } }>("/api/jobs/by_name_job/run", MP, "POST");

    // It may still refuse for a real reason — but never for this one.
    expect(run.body.run.outcome_summary ?? "").not.toContain("does not exist");
  });

  /*
   * THE LATENT BUG THE INCONSISTENCY WAS HIDING. `jobs.ts` passed `target_id` straight through as
   * the run's `aiEmployeeId`, so a job addressed by name that SUCCEEDED would have written "Parker"
   * into `ai_run.ai_employee_id`, where employeeWork.ts and every other writer put "aie_parker".
   * One employee, two keys, spend split across both on the cost centre. Nobody had seen it because
   * the broken lookup refused the job before it could ever succeed — fixing the lookup alone would
   * have traded a visible refusal for a silent accounting error.
   */
  it("attributes the run to the employee's id even when the job names them", async () => {
    const employee = await t.db.prepare("SELECT id, name FROM ai_employee WHERE id = 'aie_wells'")
      .first<{ id: string; name: string }>();
    // Already switched on by the D10 test above; activation is a once-only reserved receipt.

    await call("/api/jobs", MP, "POST", {
      job_key: "attribution_by_name",
      name: `Task for ${employee!.name}`,
      kind: "EMPLOYEE_TASK",
      schedule_kind: "DAILY_AT",
      daily_at_utc: "11:00",
      target_kind: "EMPLOYEE",
      target_id: employee!.name,
      payload: { prompt: "Do the thing." },
    });
    await call("/api/jobs/attribution_by_name/status", MP, "POST", { status: "ACTIVE", reason: "on" });

    const run = await call<{ run: { ai_run_id: string | null } }>("/api/jobs/attribution_by_name/run", MP, "POST");
    expect(run.body.run.ai_run_id).not.toBeNull();

    const aiRun = await t.db.prepare("SELECT ai_employee_id FROM ai_run WHERE id = ?1")
      .bind(run.body.run.ai_run_id)
      .first<{ ai_employee_id: string }>();
    expect(aiRun?.ai_employee_id, "spend must land on the id, never on the display name").toBe(employee!.id);
    expect(aiRun?.ai_employee_id).not.toBe(employee!.name);
  });

  it("still refuses a target that genuinely is not there", async () => {
    const created = await call<{ error?: string }>("/api/jobs", MP, "POST", {
      job_key: "ghost_job",
      name: "Task for nobody",
      kind: "EMPLOYEE_TASK",
      schedule_kind: "DAILY_AT",
      daily_at_utc: "09:00",
      target_kind: "EMPLOYEE",
      target_id: "Nobodyham",
      payload: { prompt: "Do the thing." },
    });
    // 404 employee_not_found — the route's own answer for a target that is not there.
    expect(created.status, "matching on either form must not make every name valid").toBe(404);
  });
});

/*
 * WHY THIS BLOCK EXISTS. Four of the last eight morning briefs failed on the cron and nothing
 * anywhere said so. The cause was not that they failed — it was that they never finished: the
 * invocation ended mid-job and no closing row was ever written, so production held scheduled
 * job_run rows in RUNNING with no error and an empty summary, one of them from the previous day,
 * alongside ai_run rows RUNNING for over twenty-four hours. A RUNNING ai_run is counted as
 * committed spend at its estimate for as long as it exists, so each one ate the daily cap for ever.
 */
describe("work whose invocation died is closed out rather than left running", () => {
  const longAgo = new Date(Date.UTC(2026, 7, 20, 6, 0, 0)).toISOString();
  const justNow = new Date().toISOString();

  it("closes an abandoned job run and says it was abandoned, not that it failed on its merits", async () => {
    const job = await t.db.prepare("SELECT id FROM scheduled_job LIMIT 1").first<{ id: string }>();
    await t.db
      .prepare(
        `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, started_at, requested_by)
         VALUES (?1, ?2, ?3, 'SCHEDULED', 'RUNNING', ?4, 'system')`,
      )
      .bind("jrun_abandoned", job!.id, `abandoned_${crypto.randomUUID()}`, longAgo)
      .run();

    const { closeAbandonedRuns } = await import("../src/worker/services/jobs");
    const swept = await closeAbandonedRuns(env, new Date());
    expect(swept.jobRuns).toBeGreaterThanOrEqual(1);

    const row = await t.db
      .prepare("SELECT status, error, finished_at FROM job_run WHERE id = 'jrun_abandoned'")
      .first<{ status: string; error: string; finished_at: string }>();
    expect(row?.status).toBe("FAILED");
    expect(row?.error).toContain("abandoned");
    expect(row?.finished_at).toBeTruthy();
  });

  it("closes an abandoned AI run, because a RUNNING one is charged as committed spend for ever", async () => {
    await t.db
      .prepare(
        `INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, status, input_hash, trace_id, created_at, firm_scope)
         VALUES (?1, 'stuck brief', 'SYSTEM', 'system', 'INTERNAL', 'FRONTIER', 'NORMAL', 'RUNNING', 'h', 'tr_abandoned', ?2, 'west-peek')`,
      )
      .bind("air_abandoned", longAgo)
      .run();

    const { closeAbandonedRuns } = await import("../src/worker/services/jobs");
    await closeAbandonedRuns(env, new Date());

    const row = await t.db
      .prepare("SELECT status, failure_reason, completed_at FROM ai_run WHERE id = 'air_abandoned'")
      .first<{ status: string; failure_reason: string; completed_at: string }>();
    expect(row?.status).toBe("FAILED");
    expect(row?.failure_reason).toContain("abandoned");
    expect(row?.completed_at).toBeTruthy();
  });

  it("leaves work that only just started alone — reaping early would mark live work dead", async () => {
    const job = await t.db.prepare("SELECT id FROM scheduled_job LIMIT 1").first<{ id: string }>();
    await t.db
      .prepare(
        `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, started_at, requested_by)
         VALUES (?1, ?2, ?3, 'SCHEDULED', 'RUNNING', ?4, 'system')`,
      )
      .bind("jrun_live", job!.id, `live_${crypto.randomUUID()}`, justNow)
      .run();

    const { closeAbandonedRuns } = await import("../src/worker/services/jobs");
    await closeAbandonedRuns(env, new Date());

    const row = await t.db.prepare("SELECT status FROM job_run WHERE id = 'jrun_live'").first<{ status: string }>();
    expect(row?.status).toBe("RUNNING");
  });

  it("does not push a healthy job into tomorrow because it died once months ago", async () => {
    /*
     * The comment above this query has always said "ONLY THE JOBS WHOSE RUNS WERE JUST REAPED",
     * and the query matched an abandoned run from ANY point in history. So a job that died once in
     * the past and is legitimately due right now — waiting for this very tick to run it — was read
     * as freshly reaped and moved to tomorrow. It never ran again, and it hit hardest the jobs most
     * likely to have died before. The comment was stricter than the code, which is the shape of
     * every bug this file has had.
     */
    const job = await t.db.prepare("SELECT id, next_run_at FROM scheduled_job LIMIT 1").first<{ id: string; next_run_at: string }>();
    // Overdue by more than the 30-minute abandonment window, which is what puts a job in front of
    // this repair at all — anything more recent is simply waiting for the next tick.
    const dueNow = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    await t.db.prepare("UPDATE scheduled_job SET status = 'ACTIVE', next_run_at = ?2 WHERE id = ?1").bind(job!.id, dueNow).run();
    // An abandonment already closed long ago — outside this sweep.
    await t.db
      .prepare(
        `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, started_at, finished_at, error, requested_by)
         VALUES (?1, ?2, ?3, 'SCHEDULED', 'FAILED', ?4, ?4, 'abandoned: the run stopped part-way through and never finished', 'system')`,
      )
      .bind("jrun_old_abandon", job!.id, `old_${crypto.randomUUID()}`, longAgo)
      .run();

    const { closeAbandonedRuns } = await import("../src/worker/services/jobs");
    const swept = await closeAbandonedRuns(env, new Date());
    expect(swept.rescheduled).toBe(0);

    const after = await t.db.prepare("SELECT next_run_at FROM scheduled_job WHERE id = ?1").bind(job!.id).first<{ next_run_at: string }>();
    expect(after?.next_run_at).toBe(dueNow);
  });
});

/*
 * The morning brief failed at 06:00 and was never retried — not because retrying was refused, but
 * because nothing asked. `occurrenceKey` for a DAILY_AT job is `job_key:YYYY-MM-DD`, and any row
 * with that key returned `replayed` whatever its status. So the day's first failure claimed the key
 * and every later tick answered "already ran", which made the max_attempts and DEAD_LETTER
 * machinery in this same file unreachable code for every daily job the firm has.
 *
 * Separately, `next_run_at` advanced only on the completion path, so a run that died never moved
 * the clock: production had daily_intelligence pinned at 06:00 for thirteen hours.
 */
describe("a failed occurrence can be tried again, and a dead one does not wedge the clock", () => {
  it("advances the schedule when the work is CLAIMED, so a run that dies is due again tomorrow", async () => {
    await call("/api/jobs/weekly_mp_review/status", MP, "POST", { status: "ACTIVE", reason: "on for this test" });
    const before = await t.db
      .prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'weekly_mp_review'")
      .first<{ next_run_at: string }>();

    const now = new Date("2026-09-02T12:30:00.000Z");
    await runJob(env, MP_ACTOR, "weekly_mp_review", { trigger: "SCHEDULED", now });

    const after = await t.db
      .prepare("SELECT next_run_at FROM scheduled_job WHERE job_key = 'weekly_mp_review'")
      .first<{ next_run_at: string }>();
    expect(after!.next_run_at).not.toBe(before!.next_run_at);
    expect(after!.next_run_at > now.toISOString()).toBe(true);
  });

  it("treats a SUCCEEDED occurrence as done and refuses to run it twice", async () => {
    const now = new Date("2026-09-03T12:30:00.000Z");
    const first = await runJob(env, MP_ACTOR, "weekly_mp_review", { trigger: "SCHEDULED", now });
    expect(first.replayed).toBe(false);

    const second = await runJob(env, MP_ACTOR, "weekly_mp_review", { trigger: "SCHEDULED", now });
    expect(second.replayed).toBe(true);
  });

  it("lets a FAILED occurrence be attempted again on a later tick of the same day", async () => {
    const job = await t.db.prepare("SELECT * FROM scheduled_job WHERE job_key = 'weekly_mp_review'").first<{ id: string; firm_scope: string }>();
    // A failure earlier today, holding the day's occurrence key — the exact production shape.
    await t.db
      .prepare(
        `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, attempt, started_at, finished_at, error, requested_by, firm_scope)
         VALUES (?1, ?2, 'weekly_mp_review:2026-09-04', 'SCHEDULED', 'FAILED', 1, ?3, ?3, 'it fell over', 'system', ?4)`,
      )
      .bind(`jrun_${crypto.randomUUID()}`, job!.id, "2026-09-04T12:00:00.000Z", job!.firm_scope)
      .run();

    const retry = await runJob(env, MP_ACTOR, "weekly_mp_review", {
      trigger: "SCHEDULED",
      now: new Date("2026-09-04T12:30:00.000Z"),
    });

    // Before this change it answered "already ran" and the day was lost.
    expect(retry.replayed).toBe(false);
    expect(retry.run.attempt).toBe(2);
  });

  it("leaves an occurrence alone while somebody is still running it", async () => {
    const job = await t.db.prepare("SELECT * FROM scheduled_job WHERE job_key = 'weekly_mp_review'").first<{ id: string; firm_scope: string }>();
    await t.db
      .prepare(
        `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, attempt, started_at, requested_by, firm_scope)
         VALUES (?1, ?2, 'weekly_mp_review:2026-09-05', 'SCHEDULED', 'RUNNING', 1, ?3, 'system', ?4)`,
      )
      .bind(`jrun_${crypto.randomUUID()}`, job!.id, new Date().toISOString(), job!.firm_scope)
      .run();

    const concurrent = await runJob(env, MP_ACTOR, "weekly_mp_review", {
      trigger: "SCHEDULED",
      now: new Date("2026-09-05T12:30:00.000Z"),
    });
    expect(concurrent.replayed).toBe(true);
  });
});
