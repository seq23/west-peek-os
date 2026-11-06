import type { Env } from "../env";

/**
 * WHAT IS CONFIDENTIAL ABOUT AN LP (owner ruling, 4 Nov 2026).
 *
 * Private-model-only means ONLY (a) the names of LPs who have COMMITTED to a West Peek fund and (b) deal
 * terms and fund figures. An LP PROSPECT is not confidential: outreach, intro emails, replies before a
 * commitment, meeting prep and research on a prospect may use the free models and Codex.
 *
 * A COMMITMENT IS READ FROM THE RECORDS THAT HOLD ONE, never guessed from words. Any of these makes an LP
 * committed, and every one of them is checked because they are written by different doors:
 *   · `lp_commitment` in state SOFT or SIGNED (0101; a verbal yes counts — it is still her LP's name);
 *   · `lp_record.status = 'COMMITTED'`;
 *   · `lp_engagement.state = 'COMMITTED'`;
 *   · `lp_opportunity.stage = 'COMMITTED'`.
 * A WITHDRAWN commitment alone does not.
 *
 * FAILS CLOSED. If the records cannot be read, every LP counts as committed and the caller is told so —
 * a false positive costs one seat run, a false negative would put a committed LP's name on a lane that trains.
 */

const COMMITTED_LP_SQL = `
  SELECT r.id, r.legal_name
    FROM lp_record r
   WHERE r.firm_scope = ?1
     AND (
           r.status = 'COMMITTED'
        OR EXISTS (SELECT 1 FROM lp_commitment c WHERE c.lp_record_id = r.id AND c.state IN ('SOFT','SIGNED'))
        OR EXISTS (SELECT 1 FROM lp_engagement e WHERE e.lp_record_id = r.id AND e.state = 'COMMITTED')
        OR EXISTS (SELECT 1 FROM lp_opportunity o WHERE o.lp_record_id = r.id AND o.stage = 'COMMITTED')
     )`;

export interface CommittedLpList {
  /** Legal names of committed LPs. Never logged, never put in a run's explanation. */
  names: string[];
  /** False when the records could not be read; the caller must then treat the content as private. */
  readable: boolean;
}

export async function committedLps(env: Env, firmScope: string): Promise<CommittedLpList> {
  try {
    const rows = await env.WP_OS_DB.prepare(COMMITTED_LP_SQL).bind(firmScope).all<{ id: string; legal_name: string }>();
    return { names: (rows.results ?? []).map((r) => r.legal_name).filter((n) => typeof n === "string" && n.trim().length > 0), readable: true };
  } catch {
    return { names: [], readable: false };
  }
}

/** Is this LP record committed? Unknown record or unreadable tables → true (fail closed). */
export async function isCommittedLp(env: Env, lpRecordId: string | null | undefined): Promise<boolean> {
  if (!lpRecordId) return false;
  try {
    const row = await env.WP_OS_DB.prepare(
      `SELECT r.id FROM lp_record r WHERE r.id = ?1 AND (
           r.status = 'COMMITTED'
        OR EXISTS (SELECT 1 FROM lp_commitment c WHERE c.lp_record_id = r.id AND c.state IN ('SOFT','SIGNED'))
        OR EXISTS (SELECT 1 FROM lp_engagement e WHERE e.lp_record_id = r.id AND e.state = 'COMMITTED')
        OR EXISTS (SELECT 1 FROM lp_opportunity o WHERE o.lp_record_id = r.id AND o.stage = 'COMMITTED'))`,
    )
      .bind(lpRecordId)
      .first<{ id: string }>();
    if (row) return true;
    const exists = await env.WP_OS_DB.prepare("SELECT id FROM lp_record WHERE id = ?1").bind(lpRecordId).first<{ id: string }>();
    // A link to an LP the records do not hold cannot be shown to be a prospect.
    return !exists;
  } catch {
    return true;
  }
}

/**
 * Is this meeting confidential for model routing? Only when it is about a COMMITTED LP. An LP-type meeting
 * with a prospect, or with nobody on record, is not — and any committed LP's name in the text still revokes
 * it at the router (`classifyContent`).
 */
export async function meetingIsConfidential(env: Env, meeting: { lp_record_id: string | null }): Promise<boolean> {
  return isCommittedLp(env, meeting.lp_record_id);
}

export { committedLpNamedIn } from "../../shared/ai/contentClass";
