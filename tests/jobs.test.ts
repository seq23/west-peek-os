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

async function activate(employeeId: string): Promise<void> {
  const card = await call<{ id: string }>(`/api/ai/employees/${employeeId}/request-activation`, MP, "POST", { reason: "P19" });
  await call(`/api/approvals/${card.body.id}/decide`, MP, "POST", { decision: "approved", note: "ok" });
  const res = await call<{ status: string }>(`/api/ai/employees/${employeeId}/activate`, MP, "POST", {
    approval_receipt_id: card.body.id,
    reason: "P19",
  });
  expect(res.body.status).toBe("ACTIVE");
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
    const now = new Date("2026-08-12T09:00:00.000Z");
    const again = await runJob(env, MP_ACTOR, "daily_intelligence", { trigger: "SCHEDULED", now });
    expect(again.replayed).toBe(true);

    const runs = await t.db
      .prepare("SELECT COUNT(*) AS n FROM job_run WHERE idempotency_key = 'daily_intelligence:2026-08-12'")
      .first<{ n: number }>();
    expect(runs!.n).toBe(1);
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
