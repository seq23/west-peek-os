import type { Env } from "../env";
import { SEAT_WAIT_CODE } from "../../shared/ai/seatOrder";

/**
 * IMPORTANT WORK THAT WAITS FOR A SEAT, AND HOW LONG (owner, 5 Nov 2026).
 *
 * At Free only, important work leads on the Mac seats (Claude Code, then Codex). When neither is free:
 *   · CONFIDENTIAL work (a committed LP's name, deal terms, fund figures, a call marked confidential) keeps
 *     waiting for a seat. Nothing here touches it.
 *   · NON-CONFIDENTIAL important work waits at most the owner's per-task limit — `task_quality_floor.max_wait_minutes`,
 *     default SEAT_WAIT_DEFAULT_MINUTES — and then the best free model that passes the floor carries it.
 *
 * THE QUALITY FLOOR (`task_quality_floor`, migration 0295) is the owner's per-task decision. `min_free_tier`:
 *   SEAT_ONLY   never fall back; keep waiting for a seat
 *   FULL        only a free model the owner marked FULL (provider_model.quality_tier)
 *   UNMEASURED  FULL or UNMEASURED
 *   DEGRADED    any adequate free model
 * No row means the default: any free model that already passed the call's own adequacy bar, best tier first.
 *
 * The wait is measured from the first `seat_wait_important_work` refusal for the same work (the work card, or the
 * purpose when there is none) since that work last completed, within the last day.
 */
export const SEAT_WAIT_DEFAULT_MINUTES = 120;

export type FreeTierFloor = "SEAT_ONLY" | "FULL" | "UNMEASURED" | "DEGRADED";

export interface TaskQualityFloorRow {
  task_key: string;
  min_free_tier: FreeTierFloor;
  max_wait_minutes: number | null;
}

/** FULL is best; an unmeasured model is above one the owner has said is weaker. */
export function qualityRank(tier: string | null | undefined): number {
  return tier === "FULL" ? 3 : tier === "DEGRADED" ? 1 : 2;
}

export function freeLaneMeetsFloor(tier: string | null | undefined, floor: FreeTierFloor | null): boolean {
  if (floor === null) return true;
  if (floor === "SEAT_ONLY") return false;
  const need = floor === "FULL" ? 3 : floor === "UNMEASURED" ? 2 : 1;
  return qualityRank(tier) >= need;
}

/** The owner's floor for this task: the routing task class first, then the purpose. Unreadable → none. */
export async function taskQualityFloor(env: Env, firmScope: string, taskClass: string | null, purpose: string): Promise<TaskQualityFloorRow | null> {
  try {
    for (const key of [taskClass, purpose]) {
      if (!key) continue;
      const row = await env.WP_OS_DB.prepare(
        "SELECT task_key, min_free_tier, max_wait_minutes FROM task_quality_floor WHERE task_key = ?1 AND firm_scope = ?2 ORDER BY version_no DESC LIMIT 1",
      )
        .bind(key, firmScope)
        .first<TaskQualityFloorRow>();
      if (row) return row;
    }
  } catch {
    /* no floor table: the default applies */
  }
  return null;
}

/** When this work first started waiting for a seat (since it last completed, within a day), or null. */
export async function seatWaitStartedAt(env: Env, work: { workCardId: string | null; purpose: string }, now: Date): Promise<Date | null> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString();
  const match = work.workCardId ? "a.work_card_id = ?1" : "r.purpose = ?1";
  const key = work.workCardId ?? work.purpose;
  try {
    const row = await env.WP_OS_DB.prepare(
      `SELECT MIN(r.created_at) AS since
         FROM ai_run r LEFT JOIN ai_run_attribution a ON a.ai_run_id = r.id
        WHERE r.failure_reason LIKE ?2 AND ${match} AND r.created_at >= ?3
          AND r.created_at > COALESCE((
                SELECT MAX(r2.created_at) FROM ai_run r2 LEFT JOIN ai_run_attribution a ON a.ai_run_id = r2.id
                 WHERE r2.status = 'COMPLETED' AND ${match.replace("r.", "r2.")}), '')`,
    )
      .bind(key, `${SEAT_WAIT_CODE}:%`, dayAgo)
      .first<{ since: string | null }>();
    return row?.since ? new Date(row.since) : null;
  } catch {
    return null;
  }
}
