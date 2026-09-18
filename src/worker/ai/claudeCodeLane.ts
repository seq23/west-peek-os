import type { Env } from "../env";

/**
 * THE LANE ON HER OWN MAC — availability, the claimable queue, and the reaper that empties it.
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

/** The provider row and model id this lane is registered under. See migration 0187. */
export const CLAUDE_CODE_PROVIDER_ID = "prov_claude_code";
export const CLAUDE_CODE_PROVIDER_KEY = "claude_code";
export const CLAUDE_CODE_MODEL = "claude-code-local";

/**
 * The reason string a stale or unclaimed lane throws.
 *
 * SHAPED SO THE EXISTING CHAIN CLASSIFIES IT CORRECTLY AND THE BACK-OFF DOES NOT. `isProviderOutage`
 * recognises the prefix so the chain engages; `shouldBackOff` excludes it so a shut lid does not
 * arm a cooldown that would outlive her opening the laptop. Both rules live in
 * src/shared/ai/providerFailure.ts, next to every other failure classification in the system.
 */
export const CLAUDE_CODE_UNAVAILABLE = "claude_code_unavailable";

export interface DeviceRow {
  device_id: string;
  hostname: string | null;
  agent_version: string | null;
  last_seen_at: string;
}

export interface LaneAvailability {
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
export async function laneAvailability(env: Env, now: Date = new Date()): Promise<LaneAvailability> {
  let row: DeviceRow | null = null;
  try {
    row = await env.WP_OS_DB.prepare(
      "SELECT device_id, hostname, agent_version, last_seen_at FROM claude_code_device ORDER BY last_seen_at DESC LIMIT 1",
    ).first<DeviceRow>();
  } catch {
    return {
      available: false,
      reason: "the Claude Code lane could not be read, so it was skipped and the work went to a lane that answers over the network",
      deviceId: null,
      lastSeenAt: null,
      ageMs: null,
    };
  }
  if (!row) {
    return {
      available: false,
      reason: "no machine has ever checked in as a Claude Code claimer, so this lane took no part in the run",
      deviceId: null,
      lastSeenAt: null,
      ageMs: null,
    };
  }
  const ageMs = now.getTime() - Date.parse(row.last_seen_at);
  if (!isFresh(row.last_seen_at, now)) {
    return {
      available: false,
      reason:
        `${row.hostname ?? row.device_id} last checked in ${describeAge(ageMs)} ago, which is outside the ` +
        `${Math.round(HEARTBEAT_FRESH_MS / 1000)}-second freshness window, so the Claude Code lane was skipped with no delay`,
      deviceId: row.device_id,
      lastSeenAt: row.last_seen_at,
      ageMs,
    };
  }
  return {
    available: true,
    reason: `${row.hostname ?? row.device_id} checked in ${describeAge(ageMs)} ago, so the Claude Code lane is awake and was offered this run first`,
    deviceId: row.device_id,
    lastSeenAt: row.last_seen_at,
    ageMs,
  };
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
  input: { deviceId: string; hostname?: string | null; agentVersion?: string | null; capabilities?: string[] },
  now: Date = new Date(),
): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO claude_code_device (device_id, hostname, agent_version, last_seen_at, capabilities_json, first_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?4)
     ON CONFLICT (device_id) DO UPDATE SET
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
    )
    .run();
}

export interface ClaudeCodeRunRow {
  id: string;
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
}

/** Park a run for the lane to claim. Returns the queue row's id. */
export async function parkRun(
  env: Env,
  input: {
    purpose: string;
    prompt: string;
    modelAccess: string;
    aiRunId?: string | null;
    workCardId?: string | null;
    aiEmployeeId?: string | null;
    taskClass?: string | null;
    firmScope?: string;
    maxSeconds?: number;
  },
): Promise<string> {
  const id = `ccr_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO claude_code_run
       (id, ai_run_id, purpose, prompt, model_access, work_card_id, ai_employee_id, task_class, firm_scope, status, max_seconds)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'QUEUED', ?10)`,
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
export async function claimRun(env: Env, deviceId: string, now: Date = new Date()): Promise<ClaudeCodeRunRow | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const next = await env.WP_OS_DB.prepare(
      "SELECT id FROM claude_code_run WHERE status = 'QUEUED' ORDER BY created_at ASC LIMIT 1",
    ).first<{ id: string }>();
    if (!next) return null;
    const res = await env.WP_OS_DB.prepare(
      `UPDATE claude_code_run
          SET status = 'CLAIMED', claimed_by = ?2, claimed_at = ?3,
              attempt_count = attempt_count + 1, updated_at = ?3
        WHERE id = ?1 AND status = 'QUEUED'`,
    )
      .bind(next.id, deviceId, now.toISOString())
      .run();
    if ((res.meta?.changes ?? 0) > 0) {
      return env.WP_OS_DB.prepare("SELECT * FROM claude_code_run WHERE id = ?1").bind(next.id).first<ClaudeCodeRunRow>();
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
    `UPDATE claude_code_run
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
    `UPDATE claude_code_run SET status = 'ABANDONED', resolution = ?2, updated_at = ?3
      WHERE id = ?1 AND status IN ('QUEUED', 'CLAIMED')`,
  )
    .bind(runId, resolution, now.toISOString())
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

/** Read one queue row. Used by the router's wait and by the report route's checks. */
export async function readRun(env: Env, runId: string): Promise<ClaudeCodeRunRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM claude_code_run WHERE id = ?1").bind(runId).first<ClaudeCodeRunRow>();
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
export async function reapClaudeCodeRuns(env: Env, now: Date = new Date()): Promise<ReapResult> {
  const out: ReapResult = { examined: 0, returnedToPool: [], abandoned: [] };
  let rows: ClaudeCodeRunRow[] = [];
  try {
    rows =
      (
        await env.WP_OS_DB.prepare(
          "SELECT * FROM claude_code_run WHERE status IN ('QUEUED', 'CLAIMED') ORDER BY created_at ASC LIMIT 200",
        ).all<ClaudeCodeRunRow>()
      ).results ?? [];
  } catch {
    return out;
  }

  for (const row of rows) {
    out.examined += 1;
    const nowMs = now.getTime();
    if (row.status === "CLAIMED") {
      const claimedMs = Date.parse(row.claimed_at ?? row.created_at);
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
        `UPDATE claude_code_run
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
