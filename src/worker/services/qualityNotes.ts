import type { Env } from "../env";

/**
 * THE DEGRADED-QUALITY WARNING, READ BACK (0251, 1 Oct 2026).
 *
 * `runAi` records, on a run served by a free lane whose model is not marked FULL, the sentence the deliverable should carry
 * (`ai_run.quality_degraded` / `quality_note`). These helpers are how a deliverable finds it — by the run that wrote it, or by
 * the work card the run was attributed to. A deliverable made by a seat, a paid model or a FULL free model has no note and
 * is returned exactly as it was.
 */

/** The note on one run, or null. */
export async function degradedNoteForRun(env: Env, runId: string | null | undefined): Promise<string | null> {
  if (!runId) return null;
  const row = await env.WP_OS_DB.prepare("SELECT quality_note FROM ai_run WHERE id = ?1 AND quality_degraded = 1")
    .bind(runId)
    .first<{ quality_note: string | null }>();
  return row?.quality_note ?? null;
}

/** Every distinct note on the completed runs attributed to this work card, newest first (at most three). */
export async function degradedNotesForCard(env: Env, cardId: string): Promise<string[]> {
  try {
    const rows =
      (
        await env.WP_OS_DB.prepare(
          `SELECT r.quality_note, MAX(r.created_at) AS at
             FROM ai_run r JOIN ai_run_attribution a ON a.ai_run_id = r.id
            WHERE a.work_card_id = ?1 AND r.quality_degraded = 1 AND r.status = 'COMPLETED' AND r.quality_note IS NOT NULL
            GROUP BY r.quality_note ORDER BY at DESC LIMIT 3`,
        )
          .bind(cardId)
          .all<{ quality_note: string }>()
      ).results ?? [];
    return rows.map((r) => r.quality_note);
  } catch {
    return [];
  }
}

/** The line put at the top of a deliverable's body. Idempotent: a body that already carries it is not given it twice. */
export function withQualityBanner(body: string, notes: readonly string[]): string {
  if (notes.length === 0) return body;
  const banner = `⚠ Quality note: ${notes.join(" ")}`;
  return body.startsWith(banner) ? body : `${banner}\n\n${body}`;
}
