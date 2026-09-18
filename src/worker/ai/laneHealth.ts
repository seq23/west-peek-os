import type { Env } from "../env";

/**
 * CAN THIS LANE SERVE, AND HAS IT EVER? — the question price could not answer.
 *
 * ── WHAT WENT WRONG, CONFIRMED FROM PRODUCTION 17 Sep 2026 ───────────────────────────────────
 *
 * `prov_openrouter` and `prov_anthropic` both offer `claude-sonnet-5` for the identical task. The
 * direct lane prices lower — no OpenRouter margin — so it won the cost comparison. It had never
 * completed a single run in its life; OpenRouter had completed hundreds. It then answered HTTP 400
 * "Your credit balance is too low to access the Anthropic API." and the partner's card deferred.
 *
 * ── THE RULE THIS MODULE EXISTS TO MAKE STRUCTURAL ────────────────────────────────────────────
 *
 * A PRICE ON PAPER IS NOT A COST.
 *
 *   · A lane in back-off cannot complete the work at all, so its effective cost is INFINITE.
 *   · A lane that has never completed the work has an UNKNOWN cost, not a low one.
 *   · Cheaper-on-paper must never beat working-in-practice.
 *
 * ── AND THE THING IT REFUSES TO DO, WHICH IS THE OTHER HALF OF BEING HONEST ───────────────────
 *
 * A LANE WITH HISTORY IS NOT THEREBY GOOD. `completed_runs > 0` means the wire works, the key is
 * funded and the vendor answers — nothing whatever about quality. Quality is `model_job_outcome`'s
 * question, it is decided by a human accepting or discarding output, and it stays silent below
 * twenty decided outcomes on purpose. This module may only ever DEMOTE an untried lane below a
 * working one of equal adequacy; it may never promote anything past the capability filters, past a
 * routing policy, or past `orderByEvidence`'s proven tier. Unproven is unknown, not good — and
 * untried is unknown too, which is exactly why it must not win on a low number.
 *
 * ── WHY THE BACK-OFF IS A TIMESTAMP ───────────────────────────────────────────────────────────
 *
 * `cooldown_until` is an instant, not a flag, so recovery needs no human, no cron and no
 * half-open bookkeeping: when the clock passes it the lane is an ordinary candidate again. One
 * completion deletes the row and resets the doubling. There is no state here that can outlive the
 * clock, because a lane disabled forever by a transient outage is its own defect.
 */

export interface LaneHealthRow {
  provider_id: string;
  model: string;
  completed_runs: number;
  consecutive_outages: number;
  outage_runs: number;
  last_completed_at: string | null;
  last_outage_at: string | null;
  last_outage_reason: string | null;
  cooldown_until: string | null;
}

/**
 * First cooldown after one outage-class failure. Five minutes: long enough that a card retried
 * "minutes later" does not walk straight back into an unfunded lane, short enough that a vendor
 * having one bad minute is not written off for the evening.
 */
export const COOLDOWN_BASE_MS = 5 * 60 * 1000;

/**
 * The ceiling on the doubling. An hour, because the human fixes for these failures — top up the
 * account, rotate the key, wait out an incident — happen on that timescale, and a lane that has
 * been fixed should not sit idle for the rest of the day waiting for an exponential to elapse.
 */
export const COOLDOWN_MAX_MS = 60 * 60 * 1000;

/**
 * How long a lane sits out after `consecutive` outage-class failures in a row: 5, 10, 20, 40, 60,
 * 60… Doubling rather than a fixed delay because the two cases want opposite things — a blip wants
 * a short pause, and an account that has been unfunded for an hour wants to stop being asked.
 */
export function cooldownMsFor(consecutive: number): number {
  if (consecutive < 1) return 0;
  const ms = COOLDOWN_BASE_MS * 2 ** (consecutive - 1);
  return Math.min(ms, COOLDOWN_MAX_MS);
}

/** Pure, so the skip rule is testable without a clock or a database. */
export function isCoolingDown(row: LaneHealthRow | undefined, now: Date): boolean {
  if (!row?.cooldown_until) return false;
  const until = Date.parse(row.cooldown_until);
  return Number.isFinite(until) && until > now.getTime();
}

/** Has this lane ever finished a run? Absent row and zero count are the same answer: no. */
export function hasServedBefore(row: LaneHealthRow | undefined): boolean {
  return (row?.completed_runs ?? 0) > 0;
}

const laneKey = (providerId: string, model: string): string => `${providerId} ${model}`;

/**
 * Every lane's health, keyed `providerId model`.
 *
 * ONE QUERY, not one per candidate. This runs inside the AI boundary on every routed call, and a
 * per-candidate lookup is how a gate becomes the reason the firm's work is slow. The table has one
 * row per (provider, model) actually used, which is single digits here and would be low hundreds in
 * the worst imaginable catalogue.
 */
export async function laneHealth(env: Env): Promise<Map<string, LaneHealthRow>> {
  const out = new Map<string, LaneHealthRow>();
  try {
    const rows =
      (
        await env.WP_OS_DB.prepare(
          `SELECT provider_id, model, completed_runs, consecutive_outages, outage_runs,
                  last_completed_at, last_outage_at, last_outage_reason, cooldown_until
             FROM provider_lane_health`,
        ).all<LaneHealthRow>()
      ).results ?? [];
    for (const r of rows) out.set(laneKey(r.provider_id, r.model), r);
  } catch {
    /*
     * AN UNREADABLE HEALTH TABLE MUST NOT STOP THE FIRM THINKING. This is a ranking input, not a
     * gate: with no rows every lane reads as untried, every lane ties, and selection falls back to
     * exactly the capability-and-price behaviour it had before this module existed. Failing open
     * here is the conservative direction precisely because the module can only ever demote.
     */
  }
  return out;
}

/**
 * A lane finished a run. Clears the back-off outright rather than decrementing it: the question the
 * cooldown answers is "is this lane failing RIGHT NOW", and a completion is a definitive no.
 *
 * NEVER THROWS. Bookkeeping attached to work that has already succeeded must not be able to undo
 * it. A dropped row costs the ranking one data point; a thrown error would cost the firm the run.
 */
export async function recordLaneCompleted(env: Env, providerId: string | null, model: string | null): Promise<boolean> {
  if (!providerId || !model) return false;
  try {
    await env.WP_OS_DB.prepare(
      `INSERT INTO provider_lane_health (provider_id, model, completed_runs, consecutive_outages, last_completed_at, cooldown_until, updated_at)
       VALUES (?1, ?2, 1, 0, ?3, NULL, ?3)
       ON CONFLICT (provider_id, model) DO UPDATE SET
         completed_runs      = provider_lane_health.completed_runs + 1,
         consecutive_outages = 0,
         last_completed_at   = excluded.last_completed_at,
         cooldown_until      = NULL,
         updated_at          = excluded.updated_at`,
    )
      .bind(providerId, model, new Date().toISOString())
      .run();
    return true;
  } catch {
    return false;
  }
}

/**
 * A lane failed outage-class. Arms — or lengthens — the back-off.
 *
 * ONLY outage-class failures reach here, and that distinction is the whole of the design. A
 * capability refusal (`provider_cannot_read_documents:…`) or a genuinely malformed request is OUR
 * fault, and cooling a working vendor because we sent it a bad body would take capacity away for a
 * bug that would follow us to the next vendor anyway.
 */
export async function recordLaneOutage(
  env: Env,
  providerId: string | null,
  model: string | null,
  reason: string,
  now: Date = new Date(),
): Promise<string | null> {
  if (!providerId || !model) return null;
  try {
    const existing = await env.WP_OS_DB.prepare(
      "SELECT consecutive_outages FROM provider_lane_health WHERE provider_id = ?1 AND model = ?2",
    )
      .bind(providerId, model)
      .first<{ consecutive_outages: number }>();
    const consecutive = (existing?.consecutive_outages ?? 0) + 1;
    const until = new Date(now.getTime() + cooldownMsFor(consecutive)).toISOString();
    await env.WP_OS_DB.prepare(
      `INSERT INTO provider_lane_health
         (provider_id, model, completed_runs, consecutive_outages, outage_runs, last_outage_at, last_outage_reason, cooldown_until, updated_at)
       VALUES (?1, ?2, 0, ?3, 1, ?4, ?5, ?6, ?4)
       ON CONFLICT (provider_id, model) DO UPDATE SET
         consecutive_outages = ?3,
         outage_runs         = provider_lane_health.outage_runs + 1,
         last_outage_at      = excluded.last_outage_at,
         last_outage_reason  = excluded.last_outage_reason,
         cooldown_until      = excluded.cooldown_until,
         updated_at          = excluded.updated_at`,
    )
      .bind(providerId, model, consecutive, now.toISOString(), reason.slice(0, 500), until)
      .run();
    return until;
  } catch {
    return null;
  }
}

export interface LaneRanked<T extends { providerId: string; providerKey?: string; model: string; estimatedCostUsd: number }> {
  /** Lanes that may run, in effective-cost order. */
  ordered: T[];
  /** Lanes removed because they are in back-off. Named on the run, never silently dropped. */
  cooling: T[];
  /** One clause for the run's explanation. Never silent, even when it changed nothing. */
  note: string;
  /** True only when lane health actually changed the order or the set. */
  applied: boolean;
}

/**
 * EFFECTIVE COST, NOT PAPER PRICE.
 *
 * Reorders — and only reorders — candidates that have ALREADY passed every capability, privacy and
 * evidence filter. Three tiers, price ordering preserved inside each:
 *
 *   1. Lanes that have completed work before. Working-in-practice.
 *   2. Lanes that have never completed anything. Unknown cost, so they may not undercut tier 1 —
 *      but they are not punished either: with no tier-1 lane present they run exactly as before,
 *      which is how a newly registered model ever gets its first run.
 *   3. Nothing. Lanes in back-off are not a tier; they are removed and reported.
 *
 * STABLE WITHIN A TIER. The input order is preserved rather than re-sorted, because the caller has
 * already applied the ordering that matters (cheapest-first, dearest-first, or a proven-first
 * evidence ordering) and re-sorting here would silently overrule it.
 *
 * DEGRADES RATHER THAN REFUSES. If back-off would empty the list, the cooling lanes are handed back
 * untouched with a note saying so: a firm whose every lane is cooling should get its work attempted
 * and an explanation an operator can act on, not a blocked run it cannot interpret.
 */
export function orderByLaneHealth<T extends { providerId: string; providerKey?: string; model: string; estimatedCostUsd: number }>(
  candidates: T[],
  health: Map<string, LaneHealthRow>,
  now: Date,
): LaneRanked<T> {
  const cooling = candidates.filter((c) => isCoolingDown(health.get(laneKey(c.providerId, c.model)), now));
  const usable = candidates.filter((c) => !cooling.includes(c));

  if (usable.length === 0) {
    return {
      ordered: candidates,
      cooling: [],
      applied: false,
      note:
        cooling.length > 0
          ? ` Every candidate lane is in outage back-off (${cooling
              .map((c) => `${c.providerId}/${c.model}`)
              .join(", ")}), so one was attempted anyway rather than refusing the work.`
          : "",
    };
  }

  const served = usable.filter((c) => hasServedBefore(health.get(laneKey(c.providerId, c.model))));
  const untried = usable.filter((c) => !served.includes(c));
  const ordered = [...served, ...untried];

  const parts: string[] = [];
  if (cooling.length > 0) {
    const first = cooling[0]!;
    const row = health.get(laneKey(first.providerId, first.model));
    parts.push(
      `${cooling.map((c) => `${c.providerId}/${c.model}`).join(", ")} ${cooling.length === 1 ? "is" : "are"} in outage ` +
        `back-off until ${row?.cooldown_until ?? "shortly"}${row?.last_outage_reason ? ` (${row.last_outage_reason})` : ""} ` +
        `and took no part in this selection; the back-off expires on its own.`,
    );
  }
  if (served.length > 0 && untried.length > 0) {
    const head = served[0]!;
    const row = health.get(laneKey(head.providerId, head.model))!;
    parts.push(
      `${untried.map((c) => `${c.providerKey ?? c.providerId}/${c.model}`).join(", ")} ` +
        `${untried.length === 1 ? "has" : "have"} never completed a run, so ${untried.length === 1 ? "its" : "their"} cost is ` +
        `unknown rather than low and ${untried.length === 1 ? "it was" : "they were"} not allowed to undercut ` +
        `${head.providerKey ?? head.providerId}/${head.model}, which has completed ${row.completed_runs}. ` +
        `A price on paper is not a cost.`,
    );
  }

  const changed = cooling.length > 0 || (served.length > 0 && untried.length > 0 && ordered[0] !== candidates[0]);
  return { ordered, cooling, applied: changed, note: parts.length > 0 ? ` ${parts.join(" ")}` : "" };
}
