import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { isMachinePaused } from "./machines";
import { notifyPartners } from "./notifications";
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
 * Find an employee by whichever way the caller addressed them, and return the CANONICAL row.
 *
 * THE RULE (migration 0087): a reference to an employee is their id; a byline is their name. Stored
 * references are ids, so this resolver exists for the boundary — a human typing "Parker" into the
 * job form, or a row written before the rule existed. It accepts either and hands back the id, so
 * nothing downstream has to care which form arrived.
 *
 * THIS EXISTS BECAUSE OF A REAL REFUSAL. `scheduled_job.target_id` holds the roster NAME —
 * "Parker" — which is how the rest of the system addresses an AI employee: the actor carries
 * `aiEmployeeId: "Pierce"`, the jobs list resolves status with `statusByName.get(target_id)`, and
 * the job's own display name is "Monthly Room proposal (Parker)". The precondition check queried
 * `WHERE id = ?1` instead, so it looked for an employee whose id was "Parker", found nothing, and
 * refused the job twice a day with "target employee Parker does not exist" — about an employee who
 * exists, is ACTIVE, and whose id is `aie_parker`.
 *
 * That is the fourth bug of this exact family: two pieces of code disagreeing about what a column
 * holds, both sides typed `string`, so nothing could catch it but running it. Matching on either
 * form is the honest fix — the column's contents are a convention, not a constraint — and it makes
 * a job addressed by id work too rather than trading one half of the bug for the other.
 */
async function resolveEmployee(
  env: Env,
  ref: string,
): Promise<{ id: string; name: string; status: string } | null> {
  return await env.WP_OS_DB.prepare("SELECT id, name, status FROM ai_employee WHERE name = ?1 OR id = ?1")
    .bind(ref)
    .first<{ id: string; name: string; status: string }>();
}

/**
 * Governance preconditions, checked before any work and before any spend. A refusal here is a
 * recorded outcome, never an exception: the operator needs to see WHY a scheduled job did nothing.
 */
async function checkPreconditions(env: Env, job: ScheduledJobRow): Promise<string | null> {
  if (job.status === "PAUSED") return `job is PAUSED: ${job.pause_reason ?? "no reason recorded"}`;

  if (job.target_kind === "EMPLOYEE") {
    const employee = await resolveEmployee(env, job.target_id!);
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

/**
 * How much one tick may take on, given ten milliseconds of CPU.
 *
 * These are the numbers that turn a job which cannot finish into one that finishes across a few
 * ticks of the cron that already runs. They are deliberately small: the cost of being too
 * conservative is that a brief lands twenty minutes later, and the cost of being too ambitious is
 * that it never lands at all — which is the state this is fixing.
 */
const SOURCES_PER_TICK = 2;
const PARTNERS_PER_TICK = 1;

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

  /*
   * The Wednesday prep packets and the deck discrepancy register.
   *
   * ON THE SAME DAILY SHAPE AS `weekly_mp_review` and deliberately EARLIER in the day than the
   * meeting: a packet that lands at 11:05 is a minute of the meeting rather than preparation for
   * it. The job is idempotent — `deliver()` keys on (source_type, source_id) and the source is the
   * meeting date plus the partner — so firing more than once a day updates the same packet.
   *
   * A FAILURE HERE IS A FAILED RUN. `runWednesdayPrep` collects per-packet failures rather than
   * throwing on the first, because one partner's packet failing should not cost the other theirs;
   * the run then reports FAILED so the health board sees it. A job that returns SUCCEEDED having
   * written nothing is the exact stage Rule 0 forbids.
   */
  if (job.job_key === "wednesday_prep") {
    const { runWednesdayPrep } = await import("./meetingPrep");
    const out = await runWednesdayPrep(env, actor, now);
    for (const p of out.packets) {
      artifacts.push({ kind: "MEETING_PREP", ref_type: "firm_user", ref_id: p.firmUserId });
    }
    const empties = out.packets.filter((p) => p.empty).length;
    return {
      status: out.failures.length > 0 ? "FAILED" : "SUCCEEDED",
      // An empty packet is named as empty in the summary too, so the run log carries the same
      // distinction the packet does.
      summary:
        `${out.packets.length} prep packet(s) for ${out.meetingDate}` +
        `${empties > 0 ? ` (${empties} with nothing completed, delivered and marked as such)` : ""}` +
        `${out.register ? `; discrepancy register: ${out.register.recorded} recorded, ${out.register.derived} newly noticed` : "; NO discrepancy register"}` +
        `${out.failures.length > 0 ? `. FAILED: ${out.failures.map((f) => `${f.what} — ${f.detail}`).join("; ")}` : ""}`,
      artifacts,
    };
  }

  /*
   * Diagnostics, on the clock. Item 22.
   *
   * INTERVAL DECIDED: every tick, fifteen minutes. The checks are a handful of COUNT queries and
   * cost nothing, and what they catch — a dead binding, a job whose employee is switched off, a
   * provider with no credential — is exactly the class that sits unnoticed for days. There is no
   * argument for checking less often than the cheapest thing on the schedule.
   */
  if (job.job_key === "diagnostics_sweep") {
    const { runHealthEscalation } = await import("./healthEscalation");
    const out = await runHealthEscalation(env, now);
    return {
      status: "SUCCEEDED",
      // A clean sweep is a success worth recording quietly, not an alert. The interesting line is
      // the one that names what was escalated.
      summary:
        out.escalated.length > 0 || out.recovered.length > 0
          ? `${out.checked} checked · ${out.down} down · escalated ${out.escalated.join(", ") || "none"}${out.recovered.length ? ` · recovered ${out.recovered.join(", ")}` : ""}`
          : `${out.checked} checked · ${out.down} down · nothing new`,
      artifacts,
    };
  }

  /*
   * Wyatt reading the decks that arrived. Lazily imported like every other job body so the module
   * is not pulled into an invocation that will never run it.
   *
   * ON A JOB RATHER THAN ON ARRIVAL because reading a deck is a model call, and the email handler
   * has 10ms of CPU. The bytes were stored when the mail landed — nearly free — and this reads them
   * with its own budget. Store now, read later.
   */
  /*
   * THE COMMUNITY LOADS ON A TICK, because until now nothing loaded it at all.
   *
   * Every part of the Network OS pull was built — adapter, client, cursor, receipts, conflicts, and
   * a Community page with a progress bar reading "Reading your community from Network OS". No job
   * ever ran it. The single pull on record was triggered by hand to prove the connection worked.
   */
  if (job.job_key === "network_sync") {
    const { runNetworkSync } = await import("./networkAdapter");
    const out = await runNetworkSync(env);
    /*
     * A FAILED SYNC IS A FAILED RUN, and this returned SUCCEEDED unconditionally.
     *
     * `runNetworkSync` catches its own errors and returns them as `detail` — which is right, because
     * a sync that cannot reach Network OS must not kill the tick and take the other jobs with it.
     * But this then reported SUCCEEDED with the error sitting in the summary line, so every run for
     * two hours read as a success while the CHECK constraint below rejected the cursor write and the
     * community sat at 250. Nothing anywhere said otherwise.
     *
     * I wrote this dispatch, in this session, immediately after removing the same defect from four
     * other places. It is the easiest mistake in this codebase to make.
     */
    return {
      status: out.ok ? "SUCCEEDED" : "FAILED",
      // The detail is carried whether or not anything was applied: "nobody new" and "could not
      // reach Network OS" are opposite facts and a bare count says neither.
      summary: `${out.resource}: ${out.detail}`,
      artifacts,
    };
  }

  if (job.job_key === "deck_reading") {
    const { runDeckReading } = await import("./deckQueue");
    const out = await runDeckReading(env);
    /*
     * AN EMPTY LANE IS SAID OUT LOUD, WITH ITS AGE.
     *
     * This reported the bare words "no decks waiting" 310 times in the seven days to 9 Sep 2026,
     * over a queue that has had no arrival since 23 August. Two green facts — "I read everything"
     * and "nothing has come in for a fortnight" — wearing one sentence. The operator discovered it
     * by asking Wyatt to start, which is the only way an inert lane CAN be discovered when its
     * status line looks like health.
     *
     * The health board carries the judgement (`deck_intake`); this makes the run log stop lying by
     * omission, because a run log that reads identically on day one and day sixteen is a log nobody
     * can learn anything from.
     */
    const quiet = await env.WP_OS_DB.prepare(
      "SELECT MAX(created_at) AS last FROM pending_deck",
    ).first<{ last: string | null }>().catch(() => null);
    const daysQuiet = quiet?.last
      ? Math.floor((now.getTime() - new Date(quiet.last).getTime()) / 86_400_000)
      : null;
    const emptyDetail =
      daysQuiet === null
        ? "no decks waiting — and none has ever arrived"
        : `no decks waiting — nothing has arrived for ${daysQuiet} day${daysQuiet === 1 ? "" : "s"}`;
    return {
      status: "SUCCEEDED",
      // A deck that could not be read is reported, never swallowed: "the deck said nothing about
      // revenue" and "nobody read the deck" look identical on a company card unless one is said.
      summary:
        out.skipped === -1
          ? "no document store is configured, so no deck can be read"
          : out.read === 0 && out.failed === 0 && out.skipped === 0
            ? emptyDetail
            // A deck waiting on a company nobody has opened yet is SAID. Reporting "no decks
            // waiting" while decks wait is a status line that is true of the query and false about
            // the firm.
            : `${out.read} read${out.failed ? ` · ${out.failed} could not be read` : ""}${out.skipped ? ` · ${out.skipped} waiting for a company to be opened` : ""}`,
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
    /*
     * A BOUNDED SWEEP, because this tick has ten milliseconds of CPU.
     *
     * Parsing a feed is the most CPU-expensive thing this codebase does, and sweeping every source
     * in one invocation is what killed the scheduled brief before it ever reached the brief. Two
     * sources per tick, least recently checked first, rotates through all of them on the existing
     * fifteen-minute cron without any tick doing enough work to be killed.
     *
     * Kept out of the argument list deliberately: `tests/feed-client.test.ts` proves every call
     * site injects `feedFetch` by scanning a window from `await runIntelligence(`, and a comment
     * inside the arguments pushes the deps object out of it.
     */
    const result = await runIntelligence(
      env,
      actor,
      { idempotencyKey: `job:${runId}`, triggerKind: "SCHEDULED", maxSources: SOURCES_PER_TICK },
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
        // ONE PARTNER PER TICK, same reason. Two partners on a fifteen-minute cron means both
        // briefs are built within half an hour, and neither tick does enough to be killed.
        const brief = await runDailyForAll(env, actor, now, undefined, PARTNERS_PER_TICK);
        briefingNote =
          ` Briefings: ${brief.generated} generated${brief.failed ? `, ${brief.failed} failed` : ""}` +
          `${brief.remaining > 0 ? `, ${brief.remaining} still to build` : ""}.`;
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
  // Resolved here rather than read from the row, so attribution is the canonical id whichever
  // form the column happens to carry. Preconditions already proved the employee exists and is on.
  const employeeId =
    job.target_kind === "EMPLOYEE" && job.target_id
      ? (await resolveEmployee(env, job.target_id))?.id ?? job.target_id
      : null;

  const { run } = await runAi(env, {
    purpose: `scheduled job ${job.job_key}: ${job.name}`,
    /*
     * THE CANONICAL ID, resolved, never the raw column. This passed `target_id` straight through,
     * so a scheduled job that succeeded would have written "Parker" into `ai_run.ai_employee_id`
     * where every other writer puts "aie_parker" — splitting one employee's spend across two keys
     * on the cost centre. It had never shown up because the job had never once succeeded.
     */
    actor: { type: "AI", aiEmployeeId: employeeId ?? undefined, roles: [], firmScopes: [job.firm_scope] },
    inputs: [payload.prompt ?? job.name],
    sensitivity: (job.data_class as never) ?? "INTERNAL",
    capabilityRequirement: job.capability_key ?? undefined,
    aiEmployeeId: employeeId ?? undefined,
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

  /*
   * A REPLAY IS A FINISHED OCCURRENCE, NOT ANY OCCURRENCE.
   *
   * `occurrenceKey` for a DAILY_AT job is `job_key:YYYY-MM-DD`, and this used to return `replayed`
   * for a row with that key whatever its status. So the first failure of the day claimed the key
   * and every later tick answered "already ran" — which made the max_attempts and DEAD_LETTER
   * machinery below unreachable code for every daily job in the firm. The morning brief failed at
   * 06:00 and was never retried, not because retrying was refused but because nothing asked.
   *
   * A run that SUCCEEDED or was REFUSED is genuinely done and must not repeat. One that FAILED or
   * was abandoned should be retried, up to max_attempts. The sweeper does not help here: a swept
   * row is FAILED and still holds the key.
   */
  const existing = await env.WP_OS_DB.prepare(
    "SELECT * FROM job_run WHERE idempotency_key = ?1 ORDER BY started_at DESC LIMIT 1",
  )
    .bind(key)
    .first<Record<string, unknown>>();
  if (existing && (existing.status === "SUCCEEDED" || existing.status === "REFUSED")) {
    return { run: existing, replayed: true };
  }
  if (existing && (existing.status === "RUNNING" || existing.status === "QUEUED")) {
    // Somebody else holds this occurrence right now. The sweeper releases a dead one after
    // ABANDONED_AFTER_MINUTES; until then, leave it alone rather than running it twice.
    return { run: existing, replayed: true };
  }

  const refusal = await checkPreconditions(env, job);
  const runId = `jrun_${crypto.randomUUID()}`;
  /*
   * TWO DIFFERENT QUESTIONS WERE BEING ANSWERED BY ONE NUMBER.
   *
   * `attempt` is how many consecutive tries this JOB has had - what max_attempts is compared
   * against and what sends a job to DEAD_LETTER. A manual re-run mints a fresh occurrence key every
   * time, so that count must chain off the job's last run or the dead-letter machinery can never
   * reach its limit.
   *
   * The idempotency KEY suffix is a different question: how many rows this OCCURRENCE already has.
   * The two coincide for a daily job retried the same day, which is why one number served both,
   * and they come apart the moment a job has run on more than one day. Retrying an earlier failed
   * occurrence read a LATER run, usually SUCCEEDED, numbered the retry 1, and rebuilt the key the
   * failed row still holds: UNIQUE constraint failed: job_run.idempotency_key.
   *
   * The consequence is worse than a lost retry. The insert throws out of runJob, so one old failed
   * occurrence takes down the tick that was trying to recover it and every job behind it in that
   * sweep.
   *
   * Counted separately now, and `attempt` prefers the occurrence's own history when it has one -
   * a scheduled retry continues that day's numbering - falling back to the job's last run when the
   * occurrence is empty, which is the manual path DEAD_LETTER depends on.
   */
  const previous = await env.WP_OS_DB.prepare(
    "SELECT attempt, status FROM job_run WHERE job_id = ?1 ORDER BY started_at DESC LIMIT 1",
  )
    .bind(job.id)
    .first<{ attempt: number; status: string }>();

  /*
   * `instr(...) = 1` rather than `LIKE ?2 || '#%'`: D1 rejects a LIKE whose pattern is built by
   * concatenation with "LIKE or GLOB pattern too complex", and a prefix test is what was meant.
   * The `#` is part of the needle so `key#2` matches while a different key that merely begins with
   * the same characters does not.
   */
  const family = await env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS n, MAX(attempt) AS max_attempt FROM job_run
      WHERE job_id = ?1 AND (idempotency_key = ?2 OR instr(idempotency_key, ?2 || '#') = 1)`,
  )
    .bind(job.id, key)
    .first<{ n: number; max_attempt: number | null }>();
  const priorInFamily = family?.n ?? 0;
  const attempt =
    priorInFamily > 0
      ? (family?.max_attempt ?? 0) + 1
      : previous && previous.status === "FAILED"
        ? previous.attempt + 1
        : 1;

  await env.WP_OS_DB.prepare(
    `INSERT INTO job_run (id, job_id, idempotency_key, trigger_kind, status, attempt, requested_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, 'RUNNING', ?5, ?6, ?7)`,
  )
    .bind(
      runId,
      job.id,
      // The occurrence key is UNIQUE, so a retry carries a suffix counted from that OCCURRENCE's
      // own rows - not from `attempt`, which counts the job's consecutive failures and can be 1
      // while the occurrence already holds a row. The occurrence stays identifiable by its prefix.
      priorInFamily > 0 ? `${key}#${priorInFamily + 1}` : key,
      opts.trigger,
      attempt,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
      job.firm_scope,
    )
    .run();

  /*
   * THE CLOCK MOVES WHEN THE WORK IS CLAIMED, NOT WHEN IT FINISHES.
   *
   * `next_run_at` used to advance only on the completion path. A run that died mid-flight never
   * reached it, so the job stayed permanently due — production had daily_intelligence pinned at
   * 06:00 for thirteen hours while every tick declined to re-run it. Advancing here means a job
   * that dies is due again tomorrow rather than wedged in yesterday.
   */
  await env.WP_OS_DB.prepare("UPDATE scheduled_job SET last_run_at = ?2, next_run_at = ?3 WHERE id = ?1")
    .bind(job.id, now.toISOString(), computeNextRun(job, now))
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
  // The schedule already advanced when this run was claimed. Advancing again here would skip a day
  // every time a job completed normally.

  if (finalStatus === "DEAD_LETTER") {
    await notifyPartners(env, {
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
/**
 * How long a RUNNING row may plausibly still be running.
 *
 * A Worker invocation — cron or request — is bounded far below this. A row still marked RUNNING
 * half an hour later is therefore not slow; the invocation that owned it is gone and will never
 * come back to write a terminal state. Thirty minutes is deliberately generous: the cost of
 * reaping late is a stale row for a few extra minutes, and the cost of reaping early would be
 * marking live work dead.
 */
const ABANDONED_AFTER_MINUTES = 30;

/**
 * Close out work whose invocation died mid-flight.
 *
 * WHY THIS EXISTS. `daily_intelligence` takes roughly four and a half minutes and `runDueJobs`
 * runs jobs one after another inside a single `ctx.waitUntil`. The invocation ends before the job
 * does, so nothing ever writes the closing row — and the evidence is in production: scheduled
 * `job_run` rows sitting in RUNNING with no error and an empty summary, one of them from the
 * previous day, alongside `ai_run` rows RUNNING for over twenty-four hours.
 *
 * That is not only untidy. A RUNNING ai_run counts as COMMITTED spend at its estimate for as long
 * as it exists, so an abandoned row inflates the firm's committed total and eats the daily cap
 * permanently. And a job that never finishes never reports failure, which is why four of the last
 * eight morning briefs failed on the cron and nothing anywhere said so.
 *
 * This is the sweeper, not the cure. The cure is that the brief should not need to finish inside
 * one invocation at all — recorded in BACKLOG.md. Until then the firm at least learns that it
 * failed instead of believing it ran.
 *
 * `abandoned` is kept as a distinct reason from an ordinary failure, matching the vocabulary
 * `closeAbandonedReports` already uses: "this stopped part-way" and "this ran and failed on its
 * merits" are different facts and a reader should not have to guess which happened.
 */
export async function closeAbandonedRuns(
  env: Env,
  now: Date = new Date(),
): Promise<{ jobRuns: number; aiRuns: number; rescheduled: number; unrepairable: string[] }> {
  const cutoff = new Date(now.getTime() - ABANDONED_AFTER_MINUTES * 60_000).toISOString();

  // The database's own clock, read before the sweep, so "reaped just now" means exactly the rows
  // this call stamped. A JS timestamp would be a different clock from the one the UPDATE uses.
  const sweepStart = (
    await env.WP_OS_DB.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS t").first<{ t: string }>()
  )!.t;

  const jobs = await env.WP_OS_DB.prepare(
    `UPDATE job_run
        SET status = 'FAILED',
            finished_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            error = 'abandoned: the run stopped part-way through and never finished',
            outcome_summary = CASE WHEN outcome_summary = '' THEN 'FAILED: abandoned part-way' ELSE outcome_summary END
      WHERE status IN ('QUEUED','RUNNING') AND started_at < ?1`,
  )
    .bind(cutoff)
    .run();

  // Left RUNNING, an ai_run is counted as committed spend for ever — see costCenter.
  const ai = await env.WP_OS_DB.prepare(
    `UPDATE ai_run
        SET status = 'FAILED',
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            failure_reason = 'abandoned: the invocation ended before this call returned'
      WHERE status IN ('QUEUED','RUNNING') AND created_at < ?1`,
  )
    .bind(cutoff)
    .run();

  /*
   * RELEASING THE RUN IS NOT ENOUGH; THE SCHEDULE HAS TO BE REPAIRED TOO.
   *
   * A job whose run died before the claim-time advance existed still has `next_run_at` in the past.
   * Closing the run without moving the clock leaves it permanently due and re-attempted on every
   * tick for ever. Any job still overdue after its runs were swept is moved to its next real
   * occurrence.
   */
  /*
   * ONLY THE JOBS WHOSE RUNS WERE JUST REAPED. Rescheduling every overdue job would push a healthy
   * one — one that is merely due and waiting for this very tick to run it — into tomorrow, and the
   * job would never run again.
   *
   * THE COMMENT SAID THAT; THE QUERY DID NOT. The EXISTS matched an abandoned run from ANY point in
   * history, so a job abandoned once in March and legitimately due today was treated as freshly
   * reaped and pushed to tomorrow — the precise failure this paragraph exists to prevent, on the
   * jobs most likely to have died before. `r.finished_at >= sweepStart` is what makes the code say
   * what the comment claims: only rows THIS call stamped.
   */
  const overdue =
    (
      await env.WP_OS_DB.prepare(
        `SELECT j.* FROM scheduled_job j
          WHERE j.status = 'ACTIVE'
            AND j.next_run_at IS NOT NULL
            AND j.next_run_at < ?1
            AND EXISTS (
              SELECT 1 FROM job_run r
               WHERE r.job_id = j.id
                 AND r.error = 'abandoned: the run stopped part-way through and never finished'
                 AND r.finished_at >= ?2
            )`,
      )
        .bind(cutoff, sweepStart)
        .all<ScheduledJobRow>()
    ).results ?? [];
  let rescheduled = 0;
  const unrepairable: string[] = [];
  for (const job of overdue) {
    const next = computeNextRun(job, now);
    if (next && next > now.toISOString()) {
      await env.WP_OS_DB.prepare("UPDATE scheduled_job SET next_run_at = ?2 WHERE id = ?1").bind(job.id, next).run();
      rescheduled += 1;
    } else {
      // A job whose schedule cannot produce a future time stays overdue for ever and is retried on
      // every tick. Silently skipping it is how a permanently broken job looks like a working one.
      unrepairable.push(job.job_key);
    }
  }

  return { jobRuns: jobs.meta?.changes ?? 0, aiRuns: ai.meta?.changes ?? 0, rescheduled, unrepairable };
}

export async function runDueJobs(env: Env, now: Date): Promise<Array<{ job_key: string; status: string; summary: string }>> {
  /*
   * SWEEP BEFORE RUNNING, every tick. `closeAbandonedReports` was already written and correct, but
   * its only caller was the top of the once-daily brief — so a brief that died at 06:00 stayed
   * "still generating" until the next morning, and Home showed a half-finished report as though it
   * were the whole thing. Running the sweep on the tick that already exists costs two statements
   * and closes that window to fifteen minutes.
   */
  const swept = await closeAbandonedRuns(env, now);
  // Dynamic, matching the runDailyForAll import below — dailyIntelligence reaches back into this
  // module, and a top-level import here would close that cycle at load time.
  const { closeAbandonedReports } = await import("./dailyIntelligence");
  const sweptReports = await closeAbandonedReports(env, now);

  const due = (
    await env.WP_OS_DB.prepare(
      "SELECT * FROM scheduled_job WHERE status = 'ACTIVE' AND (next_run_at IS NULL OR next_run_at <= ?1)",
    )
      .bind(now.toISOString())
      .all<ScheduledJobRow>()
  ).results ?? [];

  const systemActor: Actor = { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] };
  const results: Array<{ job_key: string; status: string; summary: string }> = [];

  // Reported rather than done quietly: a tick that closed abandoned work is a fact the operator
  // wants, and a tick that closes some every time is a symptom rather than housekeeping.
  if (swept.jobRuns > 0 || swept.aiRuns > 0 || sweptReports > 0 || swept.rescheduled > 0 || swept.unrepairable.length > 0) {
    results.push({
      job_key: "_sweep",
      // A job whose schedule cannot yield a future time is not housekeeping — it will be retried on
      // every tick for ever and nothing else would say so.
      status: swept.unrepairable.length > 0 ? "SWEPT_WITH_PROBLEM" : "SWEPT",
      summary:
        `closed ${swept.jobRuns} abandoned job run(s), ${swept.aiRuns} AI run(s), ${sweptReports} report(s); ` +
        `rescheduled ${swept.rescheduled} overdue job(s)` +
        (swept.unrepairable.length > 0
          ? `. Could NOT reschedule ${swept.unrepairable.join(", ")} — the schedule produced no future time, so it stays overdue and is retried every tick.`
          : ""),
    });
  }
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
    const employee = await resolveEmployee(ctx.env, b.target_id!);
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
  // WHETHER THE EMPLOYEE THIS JOB DEPENDS ON IS ACTUALLY SWITCHED ON. An EMPLOYEE_TASK job whose
  // employee is INACTIVE is enabled and cannot run, and until this was returned the page had no way
  // to say so — it showed a green ACTIVE badge on a job that does nothing. Parker's Monthly Room
  // proposal had been in exactly that state.
  const employees = (
    await ctx.env.WP_OS_DB.prepare("SELECT id, name, status FROM ai_employee").all<{ id: string; name: string; status: string }>()
  ).results ?? [];
  /*
   * Keyed by BOTH id and name. The column holds ids after 0087, and the map used to be keyed on
   * name alone — which is the same disagreement in the other direction, and would have blanked
   * every job's employee status the moment the migration landed.
   */
  const statusByRef = new Map<string, string>();
  for (const e of employees) {
    statusByRef.set(e.id, e.status);
    statusByRef.set(e.name, e.status);
  }

  return json({
    jobs: jobs.map((j) => ({
      ...j,
      target_employee_status: j.target_kind === "EMPLOYEE" && j.target_id ? statusByRef.get(j.target_id) ?? null : null,
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
