import type { Env } from "../env";

/**
 * THE TWO SUBSCRIPTION SEATS — availability, the claimable queue, and the reaper that empties it.
 *
 * A SEAT is a coding agent running on the owner's own machine against a subscription she already
 * pays for: `claude_code` on her Claude Max plan, `codex` on her ChatGPT Plus plan. The two names
 * match `provider_registry.provider_key` exactly, so a seat has ONE name across the registry, the
 * queue, the heartbeat and the sentence on a partner's run.
 *
 * THEY ARE INDEPENDENT IN EVERY DIRECTION, and that is load-bearing rather than tidy. Each has its
 * own heartbeat rows, so one seat asleep says nothing about the other; each is offered work on its
 * own; and a claimer may serve one, the other, or both. The first time Claude Code hangs, Codex
 * must still answer.
 *
 * Migration 0187 carries the full reasoning. The short version, because the two halves of this
 * module answer different questions and are easy to conflate:
 *
 *   · AVAILABILITY is a HEARTBEAT. One indexed read, answered before any work is parked. Stale is
 *     the ordinary state — her Mac sleeps, the lid closes, she travels — so it must cost nothing.
 *   · DELIVERY is a CLAIM. The Worker cannot run Claude Code, so a run assigned here is parked and
 *     a launchd agent on her machine takes it.
 *
 * WHAT THIS MODULE REFUSES TO BE: a dependency. Every failure mode here — no device has ever
 * pinged, the heartbeat is stale, nobody claims, a claimer dies mid-run, the table is unreadable —
 * resolves to an outage-class throw inside `executeAttempt`, which is the chain migration 0184
 * already built. The free lanes and the paid head stand behind this lane unchanged. If the Mac
 * never wakes again, the firm's work is exactly as it was the day before this landed.
 */

/**
 * How often the claimer pings. Thirty seconds: frequent enough that four consecutive misses is a
 * two-minute verdict rather than a ten-minute one, cheap enough that a laptop pinging all day costs
 * 2,880 requests — a rounding error against the Worker's traffic, and nothing at all when asleep.
 */
export const HEARTBEAT_INTERVAL_S = 30;

/**
 * How recently the lane must have been seen to be offered work. Two minutes — four pings.
 *
 * ONE MISS IS NOISE. A Mac naps, a wifi hop drops a request, a launchd interval slips. Declaring
 * the lane away on a single miss would flap, and every flap is a card that took the paid lane for
 * no reason.
 *
 * FOUR MISSES IS A VERDICT. Two minutes of silence from a process that speaks every thirty seconds
 * is a machine that is genuinely gone.
 *
 * AND THE WINDOW IS SHORT BECAUSE THE ERRORS ARE NOT SYMMETRIC. Calling the lane away while it is
 * present costs a fraction of a cent on the lane that would have run anyway. Calling it present
 * while it is gone costs the card a parked run and up to `CLAIM_WAIT_MS` of waiting before the
 * chain rescues it. So the check is biased towards away, which is also the answer that keeps the
 * firm moving on the ordinary day when the laptop is shut.
 */
export const HEARTBEAT_FRESH_MS = 120_000;

/**
 * How long the router waits for a claimed run to come back before giving up on it and letting the
 * chain answer the card.
 *
 * NINETY SECONDS, and it is a ceiling rather than an expectation: a one-shot prompt to Claude Code
 * on a warm machine answers in well under a minute. The number is chosen from the other side —
 * what a partner will tolerate on a card that is visibly working — rather than from what the model
 * needs, because the consequence of exceeding it is not a failure. It is a handover to a lane that
 * costs a fraction of a cent and answers immediately.
 *
 * THIS IS NOT THE TIMEOUT THE HEARTBEAT REPLACED. The heartbeat's job is that a card pays NOTHING
 * when the Mac is away. This wait is only ever paid when a fresh device said, thirty seconds ago,
 * that it was there and ready — and then did not deliver. That is a rare case, not every card.
 */
export const CLAIM_WAIT_MS = 90_000;

/** How often the router looks for a result while waiting. 1.5s — 60 reads across the full wait. */
export const CLAIM_POLL_MS = 1_500;

/**
 * How long a CLAIMED run may stay silent before the reaper returns it to the pool.
 *
 * Five minutes, which is deliberately longer than `CLAIM_WAIT_MS`: the router gives up first and
 * marks its own row terminal, so the reaper only ever sees rows WITH NO LIVE WAITER — a Worker
 * isolate that was evicted mid-wait, a deploy, a request the client dropped. Those are the rows
 * that stranded work in the sister system for two and a half days.
 */
export const CLAIM_TTL_MS = 5 * 60_000;

/**
 * How long a QUEUED run nobody has taken may sit before the reaper abandons it.
 *
 * Ten minutes. A queued row with no waiter is work the router already routed elsewhere; leaving it
 * for a claimer to find later would run it twice and spend the subscription on an answer nobody
 * will read.
 */
export const QUEUE_TTL_MS = 10 * 60_000;

/**
 * How many times one run may be handed out before it is abandoned.
 *
 * TWO. A run returned to the pool once deserves a second device — the first machine most likely
 * stopped with its lid, which says nothing about the work. A run that has now killed two claimers
 * will kill a third, and a queue that retries for ever is the "runs but inert" defect wearing a
 * loop.
 */
export const MAX_CLAIM_ATTEMPTS = 2;

/**
 * The seats, in the order the router offers them. See migration 0187.
 *
 * CLAUDE CODE FIRST, and the reason is the no-training basis rather than a preference between the
 * models. Anthropic's Commercial Terms §B is an unconditional contractual prohibition; OpenAI's
 * consumer terms exclude Codex-shaped traffic by DEFAULT, which is a setting rather than a bar. For
 * work that may not be trained on, the stronger guarantee goes first. `model_job_outcome` may
 * reorder them later on measured results; nothing here claims one is the better model.
 */
export const SEATS = ["claude_code", "codex"] as const;
export type Seat = (typeof SEATS)[number];

/** The provider row, and the model id, each seat is registered under. */
export const SEAT_REGISTRY: Record<Seat, { providerId: string; model: string; displayName: string }> = {
  claude_code: { providerId: "prov_claude_code", model: "claude-code-local", displayName: "Claude Code" },
  codex: { providerId: "prov_codex", model: "codex-local", displayName: "Codex CLI" },
};

export function isSeat(value: string): value is Seat {
  return (SEATS as readonly string[]).includes(value);
}

/**
 * The reason string a stale or unclaimed lane throws.
 *
 * SHAPED SO THE EXISTING CHAIN CLASSIFIES IT CORRECTLY AND THE BACK-OFF DOES NOT. `isProviderOutage`
 * recognises the prefix so the chain engages; `shouldBackOff` excludes it so a shut lid does not
 * arm a cooldown that would outlive her opening the laptop. Both rules live in
 * src/shared/ai/providerFailure.ts, next to every other failure classification in the system.
 */
export const SEAT_UNAVAILABLE = "subscription_seat_unavailable";

export interface DeviceRow {
  seat: string;
  device_id: string;
  hostname: string | null;
  agent_version: string | null;
  last_seen_at: string;
}

export interface LaneAvailability {
  seat: Seat;
  available: boolean;
  /** A sentence, always. It lands on the run's explanation, so it is written for a person. */
  reason: string;
  deviceId: string | null;
  lastSeenAt: string | null;
  ageMs: number | null;
}

/** Pure, so the freshness rule is testable without a clock or a database. */
export function isFresh(lastSeenAt: string | null | undefined, now: Date): boolean {
  if (!lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  if (!Number.isFinite(seen)) return false;
  const age = now.getTime() - seen;
  /*
   * A FUTURE TIMESTAMP IS NOT FRESHNESS. A device with a badly set clock could otherwise claim
   * availability for ever by pinging once from next Tuesday. Clock skew of a few seconds is normal
   * and harmless, so the tolerance is one heartbeat interval rather than zero.
   */
  if (age < -(HEARTBEAT_INTERVAL_S * 1000)) return false;
  return age <= HEARTBEAT_FRESH_MS;
}

/**
 * IS THE LANE THERE RIGHT NOW? One row, one index, no network.
 *
 * NEVER THROWS, and unavailable is the answer when anything goes wrong. An unreadable device table
 * must not stop the firm thinking, and the safe direction here is unambiguous: absent means the
 * work goes to a lane that is definitely reachable.
 */
export async function laneAvailability(env: Env, seat: Seat, now: Date = new Date()): Promise<LaneAvailability> {
  const name = SEAT_REGISTRY[seat].displayName;
  let row: DeviceRow | null = null;
  try {
    row = await env.WP_OS_DB.prepare(
      "SELECT seat, device_id, hostname, agent_version, last_seen_at FROM subscription_seat_device WHERE seat = ?1 ORDER BY last_seen_at DESC LIMIT 1",
    )
      .bind(seat)
      .first<DeviceRow>();
  } catch {
    return {
      seat,
      available: false,
      reason: `the ${name} seat could not be read, so it was skipped and the work went to a lane that answers over the network`,
      deviceId: null,
      lastSeenAt: null,
      ageMs: null,
    };
  }
  if (!row) {
    return {
      seat,
      available: false,
      reason: `no machine has ever checked in on the ${name} seat, so it took no part in the run`,
      deviceId: null,
      lastSeenAt: null,
      ageMs: null,
    };
  }
  const ageMs = now.getTime() - Date.parse(row.last_seen_at);
  if (!isFresh(row.last_seen_at, now)) {
    return {
      seat,
      available: false,
      reason:
        `the ${name} seat on ${row.hostname ?? row.device_id} last checked in ${describeAge(ageMs)} ago, which is ` +
        `outside the ${Math.round(HEARTBEAT_FRESH_MS / 1000)}-second freshness window, so it was skipped with no delay`,
      deviceId: row.device_id,
      lastSeenAt: row.last_seen_at,
      ageMs,
    };
  }
  return {
    seat,
    available: true,
    reason: `the ${name} seat on ${row.hostname ?? row.device_id} checked in ${describeAge(ageMs)} ago, so it is awake and was offered this run`,
    deviceId: row.device_id,
    lastSeenAt: row.last_seen_at,
    ageMs,
  };
}

/**
 * EVERY SEAT'S ANSWER, in offer order, from ONE query.
 *
 * One read rather than one per seat: this runs inside the AI boundary on every private call, and a
 * per-seat lookup is how a cheap gate becomes the reason the firm's work is slow. It is the same
 * argument `laneHealth` makes for the same reason, and the table is two rows.
 *
 * NEVER THROWS. An unreadable device table reads as "no seat is available", which sends the work to
 * a lane that answers over the network — the safe direction, and the one the firm used yesterday.
 */
export async function allSeatAvailability(env: Env, now: Date = new Date()): Promise<LaneAvailability[]> {
  let rows: DeviceRow[] = [];
  try {
    rows =
      (
        await env.WP_OS_DB.prepare(
          "SELECT seat, device_id, hostname, agent_version, last_seen_at FROM subscription_seat_device ORDER BY last_seen_at DESC",
        ).all<DeviceRow>()
      ).results ?? [];
  } catch {
    rows = [];
  }
  const newest = new Map<string, DeviceRow>();
  for (const r of rows) if (!newest.has(r.seat)) newest.set(r.seat, r);

  return SEATS.map((seat) => {
    const name = SEAT_REGISTRY[seat].displayName;
    const row = newest.get(seat);
    if (!row) {
      return {
        seat,
        available: false,
        reason: `no machine has ever checked in on the ${name} seat, so it took no part in the run`,
        deviceId: null,
        lastSeenAt: null,
        ageMs: null,
      };
    }
    const ageMs = now.getTime() - Date.parse(row.last_seen_at);
    if (!isFresh(row.last_seen_at, now)) {
      return {
        seat,
        available: false,
        reason:
          `the ${name} seat on ${row.hostname ?? row.device_id} last checked in ${describeAge(ageMs)} ago, which is ` +
          `outside the ${Math.round(HEARTBEAT_FRESH_MS / 1000)}-second freshness window, so it was skipped with no delay`,
        deviceId: row.device_id,
        lastSeenAt: row.last_seen_at,
        ageMs,
      };
    }
    return {
      seat,
      available: true,
      reason: `the ${name} seat on ${row.hostname ?? row.device_id} checked in ${describeAge(ageMs)} ago, so it is awake and was offered this run`,
      deviceId: row.device_id,
      lastSeenAt: row.last_seen_at,
      ageMs,
    };
  });
}

/** Human-readable age, because "14400000ms" on a partner's run explanation helps nobody. */
export function describeAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} second${s === 1 ? "" : "s"}`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  return `${Math.round(h / 24)} days`;
}

/** The claimer said hello. Upsert: the row IS the availability signal, so there is nothing else to keep. */
export async function recordHeartbeat(
  env: Env,
  input: { seat: Seat; deviceId: string; hostname?: string | null; agentVersion?: string | null; capabilities?: string[] },
  now: Date = new Date(),
): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO subscription_seat_device (seat, device_id, hostname, agent_version, last_seen_at, capabilities_json, first_seen_at)
     VALUES (?6, ?1, ?2, ?3, ?4, ?5, ?4)
     ON CONFLICT (seat, device_id) DO UPDATE SET
       hostname          = excluded.hostname,
       agent_version     = excluded.agent_version,
       last_seen_at      = excluded.last_seen_at,
       capabilities_json = excluded.capabilities_json`,
  )
    .bind(
      input.deviceId,
      input.hostname ?? null,
      input.agentVersion ?? null,
      now.toISOString(),
      JSON.stringify(input.capabilities ?? []),
      input.seat,
    )
    .run();
}

export interface SeatRunRow {
  id: string;
  seat: string;
  ai_run_id: string | null;
  purpose: string;
  prompt: string;
  model_access: string;
  work_card_id: string | null;
  ai_employee_id: string | null;
  task_class: string | null;
  status: string;
  claimed_by: string | null;
  claimed_at: string | null;
  attempt_count: number;
  max_seconds: number;
  output_text: string | null;
  error: string | null;
  resolution: string | null;
  created_at: string;
  reported_at: string | null;
  /**
   * 0219. ANSWER is 0187's shape — a prompt answered with no tools. LOCAL_JOB is a duty script run
   * on the Mac with tools and a worktree (shared/work/localJobs.ts); `job_json` says what to do.
   * A claimer names the kinds it can run, and is never handed the other.
   */
  run_kind: "ANSWER" | "LOCAL_JOB";
  job_json: string | null;
  /** A long job says it is alive every minute; the reaper reads this, not the claim time. */
  progressed_at: string | null;
  progress_note: string | null;
}

export const RUN_KINDS = ["ANSWER", "LOCAL_JOB"] as const;
export type RunKind = (typeof RUN_KINDS)[number];
export function isRunKind(value: string): value is RunKind {
  return (RUN_KINDS as readonly string[]).includes(value);
}

/**
 * How long a LOCAL_JOB may go without a progress ping before it is returned to the pool.
 *
 * Longer than an answer's five minutes: the claimer pings every minute while the child runs, but a
 * Mac that sleeps mid-build wakes with the child still alive, and the next ping arrives a moment
 * later. Ten minutes of silence from a process that speaks every minute is a machine that is gone.
 */
export const JOB_SILENCE_MS = 10 * 60_000;

/** Park a run for the lane to claim. Returns the queue row's id. */
export async function parkRun(
  env: Env,
  input: {
    seat: Seat;
    purpose: string;
    prompt: string;
    modelAccess: string;
    aiRunId?: string | null;
    workCardId?: string | null;
    aiEmployeeId?: string | null;
    taskClass?: string | null;
    firmScope?: string;
    maxSeconds?: number;
    /** 0219. Defaults to ANSWER, which is every caller that existed before local jobs. */
    runKind?: RunKind;
    jobJson?: string | null;
  },
): Promise<string> {
  const id = `ccr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO subscription_seat_run
       (id, seat, ai_run_id, purpose, prompt, model_access, work_card_id, ai_employee_id, task_class, firm_scope, status, max_seconds, run_kind, job_json)
     VALUES (?1, ?11, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'QUEUED', ?10, ?12, ?13)`,
  )
    .bind(
      id,
      input.aiRunId ?? null,
      input.purpose,
      input.prompt,
      input.modelAccess,
      input.workCardId ?? null,
      input.aiEmployeeId ?? null,
      input.taskClass ?? null,
      input.firmScope ?? "west-peek",
      Math.max(30, Math.round(input.maxSeconds ?? CLAIM_TTL_MS / 1000)),
      input.seat,
      input.runKind ?? "ANSWER",
      input.jobJson ?? null,
    )
    .run();
  return id;
}

/**
 * Hand the oldest queued run to a device.
 *
 * THE CLAIM IS A CONDITIONAL UPDATE, not a read followed by a write. Two claimers polling the same
 * second must not both get the same row, and `WHERE status = 'QUEUED'` inside the UPDATE is what
 * makes that true without a transaction — the loser updates zero rows and takes the next one.
 */
export async function claimRun(
  env: Env,
  deviceId: string,
  seats: Seat[],
  now: Date = new Date(),
  /**
   * WHICH KINDS THIS MACHINE CAN RUN. Defaults to ANSWER, so the claimer that shipped with 0187 —
   * which runs `claude -p` with no tools — is never handed a job that needs a worktree, and a
   * job claimer is never handed a question it would try to answer by editing a repository.
   */
  kinds: readonly RunKind[] = ["ANSWER"],
): Promise<SeatRunRow | null> {
  /*
   * ONLY THE SEATS THIS MACHINE CAN ACTUALLY SERVE. A laptop with Claude Code installed and Codex
   * not must never be handed a Codex run: it would take it, fail, and the reaper would spend two
   * attempts discovering what the claimer already knew. The claimer declares its seats; the queue
   * believes it, because being wrong here costs a failed run rather than any authority.
   */
  if (seats.length === 0 || kinds.length === 0) return null;
  const placeholders = seats.map((_, i) => `?${i + 1}`).join(", ");
  const kindPlaceholders = kinds.map((_, i) => `?${seats.length + i + 1}`).join(", ");
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await env.WP_OS_DB.prepare(
      `SELECT id FROM subscription_seat_run WHERE status = 'QUEUED' AND seat IN (${placeholders}) AND run_kind IN (${kindPlaceholders}) ORDER BY created_at ASC LIMIT 1`,
    )
      .bind(...seats, ...kinds)
      .first<{ id: string }>();
    if (!next) return null;
    const res = await env.WP_OS_DB.prepare(
      `UPDATE subscription_seat_run
          SET status = 'CLAIMED', claimed_by = ?2, claimed_at = ?3,
              attempt_count = attempt_count + 1, updated_at = ?3
        WHERE id = ?1 AND status = 'QUEUED'`,
    )
      .bind(next.id, deviceId, now.toISOString())
      .run();
    if ((res.meta?.changes ?? 0) > 0) {
      return env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE id = ?1").bind(next.id).first<SeatRunRow>();
    }
    // Somebody else took it between the read and the write. Try the next one.
  }
  return null;
}

/**
 * The device reported. Terminal either way.
 *
 * SCOPED TO THE CLAIMING DEVICE, so a claimer that comes back from the dead after the reaper
 * returned its run to the pool cannot overwrite the answer a second device has since produced.
 * `changes === 0` means exactly that, and it is reported rather than swallowed.
 */
export async function reportRun(
  env: Env,
  input: { runId: string; deviceId: string; outputText?: string | null; error?: string | null },
  now: Date = new Date(),
): Promise<{ accepted: boolean; detail: string }> {
  const ok = typeof input.outputText === "string" && input.outputText.length > 0;
  const res = await env.WP_OS_DB.prepare(
    `UPDATE subscription_seat_run
        SET status = ?2, output_text = ?3, error = ?4, reported_at = ?5, updated_at = ?5,
            resolution = ?6
      WHERE id = ?1 AND status = 'CLAIMED' AND claimed_by = ?7`,
  )
    .bind(
      input.runId,
      ok ? "REPORTED" : "FAILED",
      ok ? input.outputText : null,
      ok ? null : (input.error ?? "the claimer reported no output and no reason"),
      now.toISOString(),
      ok ? `${input.deviceId} completed this run` : `${input.deviceId} could not complete this run`,
      input.deviceId,
    )
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    return {
      accepted: false,
      detail:
        "this run is no longer claimed by you — it was most likely returned to the pool after going quiet, " +
        "and the work has already been answered elsewhere. Nothing was recorded.",
    };
  }
  return { accepted: true, detail: ok ? "recorded" : "recorded as a failure" };
}

/**
 * "STILL HERE." A long job's claimer pings while the child runs; the reaper reads the last ping.
 *
 * Scoped to the claiming device and to CLAIMED rows, like `reportRun`: a machine pinging for a run
 * it no longer holds is told so and stops. Never raises the row's status — a ping cannot revive an
 * abandoned run.
 */
export async function progressRun(
  env: Env,
  input: { runId: string; deviceId: string; note?: string | null },
  now: Date = new Date(),
): Promise<{ accepted: boolean; detail: string }> {
  const res = await env.WP_OS_DB.prepare(
    `UPDATE subscription_seat_run SET progressed_at = ?3, progress_note = ?4, updated_at = ?3
      WHERE id = ?1 AND status = 'CLAIMED' AND claimed_by = ?2`,
  )
    .bind(input.runId, input.deviceId, now.toISOString(), (input.note ?? "").slice(0, 400) || null)
    .run();
  if ((res.meta?.changes ?? 0) === 0) {
    return { accepted: false, detail: "this run is no longer claimed by you — stop working on it; it was returned to the pool or closed" };
  }
  return { accepted: true, detail: "noted" };
}

/**
 * NOBODY IS WAITING FOR THIS ANY MORE. Called by the router when it stops waiting.
 *
 * Terminal on purpose, and this is the decision that stops the lane doing duplicate work: the chain
 * is about to answer this card on another lane, so a claimer finding the row ten seconds later
 * would spend the owner's subscription producing an answer nothing will ever read.
 *
 * Narrowed to rows that are still QUEUED or CLAIMED, so a report that landed in the same instant
 * wins the race and is kept.
 */
export async function abandonRun(env: Env, runId: string, resolution: string, now: Date = new Date()): Promise<boolean> {
  const res = await env.WP_OS_DB.prepare(
    `UPDATE subscription_seat_run SET status = 'ABANDONED', resolution = ?2, updated_at = ?3
      WHERE id = ?1 AND status IN ('QUEUED', 'CLAIMED')`,
  )
    .bind(runId, resolution, now.toISOString())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Read one queue row. Used by the router's wait and by the report route's checks. */
export async function readRun(env: Env, runId: string): Promise<SeatRunRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE id = ?1").bind(runId).first<SeatRunRow>();
}

export interface ReapResult {
  /** Rule 0: what the sweep actually looked at, so a pass over nothing is visible. */
  examined: number;
  returnedToPool: string[];
  abandoned: string[];
}

/**
 * A CLAIM THAT GOES QUIET RETURNS TO THE POOL, AND A QUEUE ROW NOBODY WANTS IS CLOSED.
 *
 * This is the third party that did not exist in the sister system, where a run claimed at 22:10 was
 * never reported and its task read "running" for two days and eleven hours — the report route
 * refused a run that was not running, the claim route skipped a run that was claimed, and nothing
 * anywhere could end it.
 *
 * Two rules, and both are reachable:
 *
 *   1. A CLAIMED row silent past `CLAIM_TTL_MS` goes back to QUEUED, so a machine that wakes up can
 *      finish the work. Only rows with NO LIVE WAITER ever get here — the router gives up at
 *      ninety seconds and marks its own rows ABANDONED — so this is the evicted-isolate and
 *      dropped-request case, which is real and is exactly what stranded work before.
 *   2. The SECOND silence, or a QUEUED row older than `QUEUE_TTL_MS`, is ABANDONED with a sentence.
 *      Nothing loops for ever, and nothing terminal is ever reopened.
 *
 * Runs on the every-minute tick beside the other sweeps. NEVER THROWS: housekeeping that can break
 * the tick is worse than housekeeping that skips a minute.
 */
export async function reapSeatRuns(env: Env, now: Date = new Date()): Promise<ReapResult> {
  const out: ReapResult = { examined: 0, returnedToPool: [], abandoned: [] };
  let rows: SeatRunRow[] = [];
  try {
    rows =
      (
        await env.WP_OS_DB.prepare(
          "SELECT * FROM subscription_seat_run WHERE status IN ('QUEUED', 'CLAIMED') ORDER BY created_at ASC LIMIT 200",
        ).all<SeatRunRow>()
      ).results ?? [];
  } catch {
    return out;
  }

  for (const row of rows) {
    out.examined += 1;
    const nowMs = now.getTime();
    if (row.status === "CLAIMED") {
      const claimedMs = Date.parse(row.claimed_at ?? row.created_at);
      /*
       * A LOCAL JOB IS JUDGED BY ITS LAST PING AND ITS OWN CEILING, not by 0187's five minutes.
       * A build takes thirty; the claimer pings every minute while the child runs. Silence past
       * `JOB_SILENCE_MS` from the last ping, or the row's `max_seconds` from the claim whatever it
       * says, and it is returned or closed exactly like an answer.
       */
      if (row.run_kind === "LOCAL_JOB") {
        const lastMs = Date.parse(row.progressed_at ?? row.claimed_at ?? row.created_at);
        const silentFor = nowMs - (Number.isFinite(lastMs) ? lastMs : claimedMs);
        const overCeiling = Number.isFinite(claimedMs) && nowMs - claimedMs > row.max_seconds * 1000;
        if (!overCeiling && silentFor <= JOB_SILENCE_MS) continue;
        const why = overCeiling
          ? `${row.claimed_by ?? "a machine"} has held this job for ${describeAge(nowMs - claimedMs)}, past its ${describeAge(row.max_seconds * 1000)} ceiling`
          : `${row.claimed_by ?? "a machine"} took this job and went quiet for ${describeAge(silentFor)}`;
        // A job is not re-offered: half a build on a second machine is worse than none. One attempt, then the card decides.
        await abandonRun(env, row.id, `${why}. It is closed; the card records the failed attempt and decides what happens next.`, now);
        out.abandoned.push(row.id);
        continue;
      }
      if (!Number.isFinite(claimedMs) || nowMs - claimedMs <= CLAIM_TTL_MS) continue;
      const silent = describeAge(nowMs - claimedMs);
      if (row.attempt_count >= MAX_CLAIM_ATTEMPTS) {
        await abandonRun(
          env,
          row.id,
          `${row.claimed_by ?? "a machine"} took this run and went quiet for ${silent}, and it had already been handed ` +
            `out ${row.attempt_count} times. It is closed rather than offered again: a job that stops two claimers will ` +
            `stop a third. The work itself was answered on another lane at the time.`,
          now,
        );
        out.abandoned.push(row.id);
        continue;
      }
      const res = await env.WP_OS_DB.prepare(
        `UPDATE subscription_seat_run
            SET status = 'QUEUED', claimed_by = NULL, claimed_at = NULL, updated_at = ?2,
                resolution = ?3
          WHERE id = ?1 AND status = 'CLAIMED'`,
      )
        .bind(
          row.id,
          now.toISOString(),
          `${row.claimed_by ?? "a machine"} took this run and went quiet for ${silent} — most likely the lid closed. ` +
            `Returned to the pool for the next machine that wakes up.`,
        )
        .run();
      if ((res.meta?.changes ?? 0) > 0) out.returnedToPool.push(row.id);
      continue;
    }

    // QUEUED, and nobody has taken it.
    const createdMs = Date.parse(row.created_at);
    if (row.run_kind === "LOCAL_JOB") {
      // A card is not a run: a job waits for the Mac to wake, up to the ceiling the kind set on
      // the row (`job_json.queue_max_seconds`), and the card's own runner blocks it after that.
      const ceiling = queueCeilingSeconds(row.job_json);
      if (!Number.isFinite(createdMs) || nowMs - createdMs <= ceiling * 1000) continue;
      await abandonRun(
        env,
        row.id,
        `No machine claimed this job in ${describeAge(nowMs - createdMs)}. The card it belongs to says so and waits for a person.`,
        now,
      );
      out.abandoned.push(row.id);
      continue;
    }
    if (!Number.isFinite(createdMs) || nowMs - createdMs <= QUEUE_TTL_MS) continue;
    await abandonRun(
      env,
      row.id,
      `No machine claimed this run in ${describeAge(nowMs - createdMs)}. The card it belongs to was answered on ` +
        `another lane long ago, so running it now would spend the subscription on an answer nobody will read.`,
      now,
    );
    out.abandoned.push(row.id);
  }
  return out;
}

/** The queue ceiling a LOCAL_JOB carries on its own payload; the answer queue's ten minutes otherwise. */
export function queueCeilingSeconds(jobJson: string | null): number {
  try {
    const n = (JSON.parse(jobJson ?? "{}") as { queue_max_seconds?: unknown }).queue_max_seconds;
    if (typeof n === "number" && Number.isFinite(n) && n > 0) return n;
  } catch {
    /* fall through */
  }
  return QUEUE_TTL_MS / 1000;
}
