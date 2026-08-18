import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { isMachinePaused } from "./machines";
import { notifyQuietly } from "./notifications";
import { runIntelligence } from "./intelligence";
import { evaluateCompanyAlerts } from "./portfolio";
import { runAi } from "../ai/runAi";
import { privacyLabelSchema } from "../../shared/privacy";
import { fetchFeed } from "../effects/feedClient";

/**
 * Governed orchestration + scheduled AI employees (P19; GAP-21, GAP-22).
 *
 * Architecture (ADR-017): D1 holds job and run state; ONE Cloudflare Cron Trigger provides the
 * clock; `POST /api/jobs/:key/run` provides an operator path that works offline. No Queues, no
 * Durable Objects.
 *
 * Refusals are first-class outcomes, not errors to be swallowed. A run that is refused because an
 * employee is not ACTIVE, a machine is paused, or the job is paused lands as `REFUSED` with the
 * reason recorded — it is not retried, because retrying a governance refusal would be wrong.
 * Genuine failures retry to the job's own limit and then land in `DEAD_LETTER`.
 */

export class JobError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof JobError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export interface ScheduledJobRow {
  id: string;
  job_key: string;
  name: string;
  kind: "INTELLIGENCE" | "PORTFOLIO_EVALUATION" | "EMPLOYEE_TASK";
  schedule_kind: "INTERVAL" | "DAILY_AT";
  interval_minutes: number | null;
  daily_at_utc: string | null;
  target_kind: "SYSTEM" | "MACHINE" | "EMPLOYEE";
  target_id: string | null;
  capability_key: string | null;
  task_class: string | null;
  budget_usd: number;
  data_class: string;
  payload_json: string;
  max_attempts: number;
  status: string;
  next_run_at: string | null;
  last_run_at: string | null;
  pause_reason: string | null;
  created_by: string;
  firm_scope: string;
  created_at: string;
}

/** Next occurrence for a job, from its own schedule. Pure, so it is directly testable. */
export function computeNextRun(job: Pick<ScheduledJobRow, "schedule_kind" | "interval_minutes" | "daily_at_utc">, from: Date): string {
  if (job.schedule_kind === "INTERVAL") {
    const minutes = job.interval_minutes ?? 60;
    return new Date(from.getTime() + minutes * 60_000).toISOString();
  }
  const [hh, mm] = (job.daily_at_utc ?? "06:00").split(":").map((n) => Number(n));
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  next.setUTCHours(hh ?? 6, mm ?? 0);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/**
 * The idempotency key for a scheduled occurrence: job + the window it belongs to. Two triggers
 * inside the same window produce the same key, and the UNIQUE constraint refuses the second.
 */
export function occurrenceKey(job: ScheduledJobRow, at: Date): string {
  if (job.schedule_kind === "DAILY_AT") return `${job.job_key}:${at.toISOString().slice(0, 10)}`;
  const minutes = job.interval_minutes ?? 60;
  const window = Math.floor(at.getTime() / (minutes * 60_000));
  return `${job.job_key}:w${window}`;
}

async function getJob(env: Env, keyOrId: string): Promise<ScheduledJobRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM scheduled_job WHERE job_key = ?1 OR id = ?1").bind(keyOrId).first<ScheduledJobRow>();
}

interface RunOutcome {
  status: "SUCCEEDED" | "FAILED" | "REFUSED";
  summary: string;
  error?: string;
  aiRunId?: string;
  artifacts: Array<{ kind: string; ref_type?: string; ref_id?: string; note?: string }>;
}

/**
 * Governance preconditions, checked before any work and before any spend. A refusal here is a
 * recorded outcome, never an exception: the operator needs to see WHY a scheduled job did nothing.
 */
async function checkPreconditions(env: Env, job: ScheduledJobRow): Promise<string | null> {
  if (job.status === "PAUSED") return `job is PAUSED: ${job.pause_reason ?? "no reason recorded"}`;

  if (job.target_kind === "EMPLOYEE") {
    const employee = await env.WP_OS_DB.prepare("SELECT id, name, status FROM ai_employee WHERE id = ?1")
      .bind(job.target_id!)
      .first<{ id: string; name: string; status: string }>();
    if (!employee) return `target employee ${job.target_id} does not exist`;
    if (employee.status !== "ACTIVE") {
      // GAP-22 in one line: existing is not the same as running.
      return `employee ${employee.name} is ${employee.status}, not ACTIVE — a scheduled job may never activate an employee (D10)`;
    }
  }

  const machineId =
    job.target_kind === "MACHINE" ? Number(job.target_id) : null;
  if (machineId !== null) {
    const paused = await isMachinePaused(env, machineId);
    if (paused.paused) return `machine ${machineId} is PAUSED: ${paused.reason ?? "no reason recorded"}`;
  }
  return null;
}

async function executeJobBody(env: Env, job: ScheduledJobRow, actor: Actor, runId: string, now: Date): Promise<RunOutcome> {
  const artifacts: RunOutcome["artifacts"] = [];

  // job_key is checked BEFORE kind. `kind` is a CHECK constraint that cannot be widened in D1:
  // SQLite cannot alter a CHECK in place, job_run holds foreign keys into scheduled_job, and
  // `PRAGMA foreign_keys=OFF` is a no-op inside the transaction D1 wraps a migration in — tried and
  // confirmed, not assumed. Dropping the CHECK would remove what stops a typo becoming a job that
  // silently never runs, so one documented special case is the better trade. See migration 0043.
  if (job.job_key === "weekly_mp_review") {
    const { generateReview } = await import("./weeklyReview");
    const out = await generateReview(env, actor, now);
    artifacts.push({ kind: "WEEKLY_REVIEW", ref_type: "weekly_review", ref_id: String(out.review.id) });
    return {
      status: "SUCCEEDED",
      summary: `Weekly review assembled: ${(out.items ?? []).length} agenda item(s) across sixteen headings.`,
      artifacts,
    };
  }

  // Parker's monthly Room proposal. Same job_key-before-kind reasoning as above, and the same
  // shape as weekly_mp_review: it fires daily and generates only when the current month has no
  // proposal yet. schedule_kind has no MONTHLY value and adding one would mean rebuilding
  // scheduled_job's CHECK; a month check in SQL costs one query and no migration risk.
  if (job.job_key === "monthly_room_proposal") {
    const { runMonthlyRoomProposal } = await import("./roomPacket");
    const out = await runMonthlyRoomProposal(env, actor, now.toISOString());
    if (out.packetId) {
      artifacts.push({ kind: "ROOM_PACKET", ref_type: "room_packet", ref_id: out.packetId });
    }
    return {
      status: "SUCCEEDED",
      // A skipped month is a success, not a no-op worth alerting on — the shelf is already stocked.
      summary: out.generated ? `Room proposed: ${out.detail}` : out.detail,
      artifacts,
    };
  }

  if (job.kind === "INTELLIGENCE") {
    const result = await runIntelligence(
      env,
      actor,
      { idempotencyKey: `job:${runId}`, triggerKind: "SCHEDULED" },
      {
        now,
        // The SECOND call site. P29 wired the feed client into the manual sweep only, so a
        // SCHEDULED sweep silently kept the old behaviour and reported every HTTP_FEED source as
        // "no outbound feed client is configured" — which read like an egress policy, not a bug.
        // Both entry points must inject the same client or the two paths disagree.
        feedFetch: (source) =>
          fetchFeed({ source_key: source.source_key, url: source.url, category: source.category }),
      },
    );
    artifacts.push({ kind: "INTELLIGENCE_RUN", ref_type: "intelligence_run", ref_id: result.run.id });
    for (const item of result.items.slice(0, 20)) {
      artifacts.push({ kind: "INTELLIGENCE_ITEM", ref_type: "intelligence_item", ref_id: item.id, note: item.title });
    }
    // The briefing is chained here rather than given its own job, because it READS what the sweep
    // just gathered. Two independent jobs could fire in either order, and a brief that ran first
    // would brief on yesterday's items while reporting today's date.
    //
    // A failed brief does NOT fail the sweep. The sweep genuinely succeeded and its items are
    // stored; marking the whole run failed would hide that and invite someone to re-run the
    // gathering unnecessarily.
    let briefingNote = "";
    if (result.run.status !== "FAILED") {
      try {
        const { runDailyForAll } = await import("./dailyIntelligence");
        const brief = await runDailyForAll(env, actor, now);
        briefingNote = ` Briefings: ${brief.generated} generated${brief.failed ? `, ${brief.failed} failed` : ""}.`;
        artifacts.push({ kind: "DAILY_BRIEFING", note: `${brief.generated} partner briefing(s)` });
      } catch (err) {
        briefingNote = ` Briefing step failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    return {
      status: result.run.status === "FAILED" ? "FAILED" : "SUCCEEDED",
      summary: `${result.run.status}: ${result.run.items_kept} item(s) kept, ${result.run.items_duplicate} duplicate, ${result.run.sources_failed} source failure(s).${briefingNote}`,
      error: result.run.failure_reason ?? undefined,
      artifacts,
    };
  }

  if (job.kind === "PORTFOLIO_EVALUATION") {
    const companies = (
      await env.WP_OS_DB.prepare("SELECT DISTINCT company_id FROM portfolio_metric_snapshot").all<{ company_id: string }>()
    ).results ?? [];
    let alerts = 0;
    for (const c of companies) {
      const result = await evaluateCompanyAlerts(env, actor, c.company_id, now);
      alerts += result.length;
      for (const r of result.slice(0, 10)) {
        artifacts.push({
          kind: "PORTFOLIO_ALERT",
          ref_type: "portfolio_alert",
          ref_id: r.alert.id,
          note: `${r.alert.severity} ${r.alert.alert_type} (${r.disposition})`,
        });
      }
    }
    return {
      status: "SUCCEEDED",
      summary: `evaluated ${companies.length} portfolio company/companies; ${alerts} alert row(s) touched`,
      artifacts,
    };
  }

  // EMPLOYEE_TASK: the employee does governed work through run_ai, with the job's own budget,
  // data class, capability, and task class applied.
  let payload: { prompt?: string } = {};
  try {
    payload = JSON.parse(job.payload_json) as { prompt?: string };
  } catch {
    payload = {};
  }
  const { run } = await runAi(env, {
    purpose: `scheduled job ${job.job_key}: ${job.name}`,
    actor: { type: "AI", aiEmployeeId: job.target_id ?? undefined, roles: [], firmScopes: [job.firm_scope] },
    inputs: [payload.prompt ?? job.name],
    sensitivity: (job.data_class as never) ?? "INTERNAL",
    capabilityRequirement: job.capability_key ?? undefined,
    aiEmployeeId: job.target_kind === "EMPLOYEE" ? job.target_id ?? undefined : undefined,
    budgetContext: { expectedOutputTokens: 512 },
    routing: {
      taskClass: job.task_class ?? undefined,
      machineId: job.target_kind === "MACHINE" ? Number(job.target_id) : undefined,
      category: "PROACTIVE",
    },
  });
  artifacts.push({ kind: "AI_RUN", ref_type: "ai_run", ref_id: run.id, note: run.status });
  return {
    status: run.status === "COMPLETED" ? "SUCCEEDED" : "FAILED",
    summary: `governed run ${run.status}${run.model ? ` on ${run.model}` : ""}`,
    error: run.failure_reason ?? undefined,
    aiRunId: run.id,
    artifacts,
  };
}

export interface RunJobResult {
  run: Record<string, unknown>;
  replayed: boolean;
}

/**
 * Run one occurrence. Idempotent by (job, window) for scheduled triggers; a manual run always
 * gets its own key so an operator can deliberately re-run.
 */
export async function runJob(
  env: Env,
  actor: Actor,
  jobKeyOrId: string,
  opts: { trigger: "SCHEDULED" | "MANUAL"; now?: Date; idempotencyKey?: string } ,
): Promise<RunJobResult> {
  const job = await getJob(env, jobKeyOrId);
  if (!job) throw new JobError(404, "not_found");
  const authz = await authorize(env, actor, "job_run.execute", { objectType: "scheduled_job", objectId: job.id });
  if (authz.decision !== "ALLOW") throw new JobError(403, "forbidden", authz.reason);

  const now = opts.now ?? new Date();
  const key =
    opts.idempotencyKey ??
    (opts.trigger === "SCHEDULED" ? occurrenceKey(job, now) : `${job.job_key}:manual:${crypto.randomUUID()}`);

  const existing = await env.WP_OS_DB.prepare("SELECT * FROM job_run WHERE idempotency_key = ?1").bind(key).first<Record<string, unknown>>();
  if (existing) return { run: existing, replayed: true };

  const refusal = await checkPreconditions(env, job);
  const runId = `jrun_${crypto.randomUUID()}`;
  const previous = await env.WP_OS_DB.prepare(
    "SELECT attempt, status FROM job_run WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 1",
  )
    .bind(job.id)
    .first<{ attempt: number; status: string }>();
  const attempt = previous && (previous.status === "FAILED") ? previous.attempt + 1 : 1;

  await env.WP_OS_DB.prepare(
    `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, attempt, requested_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, 'RUNNING', ?5, ?6, ?7)`,
  )
    .bind(runId, job.id, key, opts.trigger, attempt, actor.firmUserId ?? actor.aiEmployeeId ?? "system", job.firm_scope)
    .run();

  if (refusal) {
    await finishRun(env, runId, "REFUSED", refusal, refusal, null);
    await appendEvent(env, {
      eventType: "job_run.refused",
      actorType: "system",
      actorId: "scheduler",
      objectType: "scheduled_job",
      objectId: job.id,
      payload: { run_id: runId, reason: refusal },
    });
    return { run: (await env.WP_OS_DB.prepare("SELECT * FROM job_run WHERE id = ?1").bind(runId).first())!, replayed: false };
  }

  let outcome: RunOutcome;
  try {
    outcome = await executeJobBody(env, job, actor, runId, now);
  } catch (err) {
    outcome = {
      status: "FAILED",
      summary: "job body threw",
      error: err instanceof Error ? err.message : String(err),
      artifacts: [],
    };
  }

  // A genuine failure that has exhausted the job's attempts becomes a DEAD_LETTER: visible,
  // stopped, and waiting for a human rather than looping forever.
  const finalStatus =
    outcome.status === "FAILED" && attempt >= job.max_attempts ? "DEAD_LETTER" : outcome.status;

  for (const a of outcome.artifacts) {
    await env.WP_OS_DB.prepare(
      "INSERT INTO job_run_artifact (id, run_id, kind, ref_type, ref_id, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
    )
      .bind(`jart_${crypto.randomUUID()}`, runId, a.kind, a.ref_type ?? null, a.ref_id ?? null, a.note ?? "")
      .run();
  }

  await finishRun(env, runId, finalStatus, outcome.summary, outcome.error ?? null, outcome.aiRunId ?? null);
  await env.WP_OS_DB.prepare("UPDATE scheduled_job SET last_run_at = ?2, next_run_at = ?3 WHERE id = ?1")
    .bind(job.id, now.toISOString(), computeNextRun(job, now))
    .run();

  if (finalStatus === "DEAD_LETTER") {
    await notifyQuietly(env, {
      kind: "PROVIDER_FAILURE",
      severity: "CRITICAL",
      title: `Scheduled job stopped: ${job.name}`,
      body: `${job.job_key} failed ${attempt} time(s) and is now in DEAD_LETTER: ${outcome.error ?? outcome.summary}`,
      objectType: "job_run",
      objectId: runId,
      dedupeKey: `job_dead_letter:${runId}`,
      firmScope: job.firm_scope,
    });
  }

  await appendEvent(env, {
    eventType: finalStatus === "SUCCEEDED" ? "job_run.succeeded" : "job_run.failed",
    actorType: "system",
    actorId: "scheduler",
    objectType: "scheduled_job",
    objectId: job.id,
    payload: { run_id: runId, status: finalStatus, attempt, summary: outcome.summary },
  });

  return { run: (await env.WP_OS_DB.prepare("SELECT * FROM job_run WHERE id = ?1").bind(runId).first())!, replayed: false };
}

async function finishRun(
  env: Env,
  runId: string,
  status: string,
  summary: string,
  error: string | null,
  aiRunId: string | null,
): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE job_run SET status = ?2, outcome_summary = ?3, error = ?4, ai_run_id = ?5, finished_at = ?6 WHERE id = ?1",
  )
    .bind(runId, status, summary, error, aiRunId, new Date().toISOString())
    .run();
}

/**
 * The scheduled tick. Selects due ACTIVE jobs and runs each one. Called by the Worker's
 * `scheduled()` handler in deployed environments; callable directly in tests, which is how the
 * whole path is proven offline (a Cron Trigger cannot fire in local `wrangler dev`).
 */
export async function runDueJobs(env: Env, now: Date): Promise<Array<{ job_key: string; status: string; summary: string }>> {
  const due = (
    await env.WP_OS_DB.prepare(
      "SELECT * FROM scheduled_job WHERE status = 'ACTIVE' AND (next_run_at IS NULL OR next_run_at <= ?1)",
    )
      .bind(now.toISOString())
      .all<ScheduledJobRow>()
  ).results ?? [];

  const systemActor: Actor = { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] };
  const results: Array<{ job_key: string; status: string; summary: string }> = [];
  for (const job of due) {
    try {
      const { run } = await runJob(env, systemActor, job.id, { trigger: "SCHEDULED", now });
      results.push({ job_key: job.job_key, status: String(run.status), summary: String(run.outcome_summary ?? "") });
    } catch (err) {
      results.push({ job_key: job.job_key, status: "ERROR", summary: err instanceof Error ? err.message : String(err) });
    }
  }
  return results;
}

// ── HTTP handlers ──

const jobSchema = z.object({
  job_key: z.string().trim().min(1),
  name: z.string().trim().min(1),
  kind: z.enum(["INTELLIGENCE", "PORTFOLIO_EVALUATION", "EMPLOYEE_TASK"]),
  schedule_kind: z.enum(["INTERVAL", "DAILY_AT"]),
  interval_minutes: z.number().int().positive().optional(),
  daily_at_utc: z.string().trim().regex(/^\d{2}:\d{2}$/).optional(),
  target_kind: z.enum(["SYSTEM", "MACHINE", "EMPLOYEE"]),
  target_id: z.string().trim().min(1).optional(),
  capability_key: z.string().trim().min(1).optional(),
  task_class: z.string().trim().min(1).optional(),
  budget_usd: z.number().nonnegative().default(0),
  data_class: privacyLabelSchema.default("INTERNAL"),
  payload: z.record(z.unknown()).default({}),
  max_attempts: z.number().int().min(1).max(10).default(3),
});

export async function handleCreateJob(ctx: RouteContext): Promise<Response> {
  const parsed = jobSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return errorResponse(new JobError(403, "forbidden", "recurring work is defined by humans"));
  const authz = await authorize(ctx.env, actor, "scheduled_job.create", { objectType: "scheduled_job" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const b = parsed.data;
  if (b.schedule_kind === "INTERVAL" && !b.interval_minutes) {
    return json({ error: "invalid_input", detail: "INTERVAL schedules need interval_minutes" }, { status: 400 });
  }
  if (b.schedule_kind === "DAILY_AT" && !b.daily_at_utc) {
    return json({ error: "invalid_input", detail: "DAILY_AT schedules need daily_at_utc" }, { status: 400 });
  }
  if (b.target_kind !== "SYSTEM" && !b.target_id) {
    return json({ error: "invalid_input", detail: `${b.target_kind} jobs need a target_id` }, { status: 400 });
  }
  if (b.target_kind === "EMPLOYEE") {
    const employee = await ctx.env.WP_OS_DB.prepare("SELECT id FROM ai_employee WHERE id = ?1").bind(b.target_id!).first();
    if (!employee) return json({ error: "employee_not_found" }, { status: 404 });
  }
  if (b.target_kind === "MACHINE") {
    const machine = await ctx.env.WP_OS_DB.prepare("SELECT id FROM machine WHERE id = ?1").bind(Number(b.target_id)).first();
    if (!machine) return json({ error: "machine_not_found" }, { status: 404 });
  }

  const id = `sjob_${crypto.randomUUID()}`;
  try {
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO scheduled_job
         (id, job_key, name, kind, schedule_kind, interval_minutes, daily_at_utc, target_kind, target_id,
          capability_key, task_class, budget_usd, data_class, payload_json, max_attempts, status, pause_reason, next_run_at, created_by)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, 'PAUSED', ?16, NULL, ?17)`,
    )
      .bind(
        id,
        b.job_key,
        b.name,
        b.kind,
        b.schedule_kind,
        b.interval_minutes ?? null,
        b.daily_at_utc ?? null,
        b.target_kind,
        b.target_id ?? null,
        b.capability_key ?? null,
        b.task_class ?? null,
        b.budget_usd,
        b.data_class,
        JSON.stringify(b.payload),
        b.max_attempts,
        "created paused: recurring work starts only when an operator switches it on",
        ctx.identity!.id,
      )
      .run();
  } catch (err) {
    if (String(err).includes("UNIQUE")) return json({ error: "duplicate_job_key" }, { status: 409 });
    throw err;
  }

  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM scheduled_job WHERE id = ?1").bind(id).first(), { status: 201 });
}

const pauseSchema = z.object({ status: z.enum(["ACTIVE", "PAUSED"]), reason: z.string().trim().min(1) });

export async function handlePauseJob(ctx: RouteContext): Promise<Response> {
  const parsed = pauseSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "only a human may start or stop recurring work" }, { status: 403 });
  const job = await getJob(ctx.env, ctx.params.key!);
  if (!job) return json({ error: "not_found" }, { status: 404 });
  const authz = await authorize(ctx.env, actor, "scheduled_job.pause", { objectType: "scheduled_job", objectId: job.id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  if (job.status === parsed.data.status) return json({ error: "already_in_state" }, { status: 409 });

  const now = new Date();
  await ctx.env.WP_OS_DB.prepare("UPDATE scheduled_job SET status = ?2, pause_reason = ?3, next_run_at = ?4 WHERE id = ?1")
    .bind(
      job.id,
      parsed.data.status,
      parsed.data.status === "PAUSED" ? parsed.data.reason : null,
      parsed.data.status === "ACTIVE" ? computeNextRun(job, now) : null,
    )
    .run();

  await appendEvent(ctx.env, {
    eventType: parsed.data.status === "ACTIVE" ? "scheduled_job.activated" : "scheduled_job.paused",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "scheduled_job",
    objectId: job.id,
    payload: { reason: parsed.data.reason },
  });
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM scheduled_job WHERE id = ?1").bind(job.id).first());
}

export async function handleListJobs(ctx: RouteContext): Promise<Response> {
  const jobs = (await ctx.env.WP_OS_DB.prepare("SELECT * FROM scheduled_job ORDER BY job_key").all<ScheduledJobRow>()).results ?? [];
  const runs = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM job_run ORDER BY started_at DESC LIMIT 200").all<Record<string, unknown>>()
  ).results ?? [];
  return json({
    jobs: jobs.map((j) => ({
      ...j,
      recent_runs: runs.filter((r) => r.job_id === j.id).slice(0, 5),
      dead_letters: runs.filter((r) => r.job_id === j.id && r.status === "DEAD_LETTER").length,
    })),
    runs,
    architecture:
      "D1 for durable state, one Cloudflare Cron Trigger for the clock, and a manual run route so the path is provable offline (ADR-017). No Queues, no Durable Objects.",
  });
}

export async function handleRunJob(ctx: RouteContext): Promise<Response> {
  try {
    const result = await runJob(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.key!, { trigger: "MANUAL" });
    return json(result, { status: result.replayed ? 200 : 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetJobRun(ctx: RouteContext): Promise<Response> {
  const run = await ctx.env.WP_OS_DB.prepare("SELECT * FROM job_run WHERE id = ?1").bind(ctx.params.id!).first();
  if (!run) return json({ error: "not_found" }, { status: 404 });
  const artifacts = (
    await ctx.env.WP_OS_DB.prepare("SELECT * FROM job_run_artifact WHERE run_id = ?1 ORDER BY created_at").bind(ctx.params.id!).all()
  ).results ?? [];
  return json({ run, artifacts });
}

export async function handleCancelJobRun(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const run = await ctx.env.WP_OS_DB.prepare("SELECT id, status FROM job_run WHERE id = ?1").bind(ctx.params.id!).first<{ id: string; status: string }>();
  if (!run) return json({ error: "not_found" }, { status: 404 });
  if (run.status !== "QUEUED" && run.status !== "RUNNING") {
    return json({ error: "illegal_state", detail: `a ${run.status} run cannot be cancelled` }, { status: 409 });
  }
  const authz = await authorize(ctx.env, actor, "job_run.cancel", { objectType: "job_run", objectId: run.id });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  await ctx.env.WP_OS_DB.prepare(
    "UPDATE job_run SET status = 'CANCELLED', finished_at = ?2, outcome_summary = ?3 WHERE id = ?1",
  )
    .bind(run.id, new Date().toISOString(), `cancelled by ${actor.firmUserId}`)
    .run();
  return json(await ctx.env.WP_OS_DB.prepare("SELECT * FROM job_run WHERE id = ?1").bind(run.id).first());
}

/** Operator-triggered tick, so the scheduled path is exercisable without waiting for cron. */
export async function handleRunDueJobs(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden" }, { status: 403 });
  const results = await runDueJobs(ctx.env, new Date());
  return json({
    ran: results,
    note: "This is the same code path the Cron Trigger calls. Running it here proves the path locally; it does not prove that Cloudflare fired it.",
  });
}
