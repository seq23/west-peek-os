import type { Env } from "../env";

/**
 * Firmwide notices, as the first thing an employee reads on every run.
 *
 * WHY THIS FILE EXISTS. `internal_memo` shipped in 0014 with a create route, a list route and an
 * append-only trigger, and it held zero rows because nothing ever read it into a prompt. The
 * repository has learned this defect twice already — a workshops document that contradicted its
 * code, a report specification nothing checked — and both passed every test. A specification no
 * code reads is a wish. So the table is not the feature: THIS FUNCTION is the feature, and
 * `tests/firmNotices.test.ts` exists to stop it quietly ceasing to be called.
 *
 * A firmwide notice is an `internal_memo` with audience='FIRM'. A DEPARTMENT memo is not a notice
 * and is deliberately not read here — it is addressed to a department, not to the firm.
 */

interface NoticeRow {
  id: string;
  supersedes_id: string | null;
  title: string;
  body: string;
  author_type: string;
  author_id: string;
  created_at: string;
}

/** How a notice's author is named to an employee. A seeded row has no person behind it. */
export function noticeAuthor(row: { author_type: string; author_id: string }): string {
  if (row.author_type === "SYSTEM") return "the firm's standing practice";
  return row.author_id;
}

/**
 * The firm's notices as prompt lines, or "" when there are none.
 *
 * Empty means EMPTY — an employee told "NOTICES FROM THE FIRM:" followed by nothing has been told
 * something false about a firm that has not written anything down.
 */
export async function firmNoticesBlock(env: Env, firmScope = "west-peek"): Promise<string> {
  const rows =
    (
      await env.WP_OS_DB.prepare(
        `SELECT id, supersedes_id, title, body, author_type, author_id, created_at
           FROM internal_memo
          WHERE audience = 'FIRM' AND firm_scope = ?1
          ORDER BY created_at, id`,
      )
        .bind(firmScope)
        .all<NoticeRow>()
    ).results ?? [];
  if (rows.length === 0) return "";

  /*
   * A RESTATED RULE IS READ ONCE, NOT TWICE.
   *
   * `internal_memo` is append-only by trigger (0014, D15) — a noticeboard somebody can quietly
   * rewrite is not a record — so a notice that is no longer how the firm says it is not edited and
   * not deleted. A later notice NAMES the one it replaces, and this drops the replaced row from the
   * prompt. The row survives in the table for anyone reading the history; the employee reads one
   * rule instead of two that overlap and having to guess which wins.
   *
   * Notice 4 ("LP names and deal terms never reach a model that may train on the prompt") is the
   * first of these: still true, but now carried by a label on the card, so notice 13 states both
   * halves together and supersedes it.
   */
  const superseded = new Set(rows.map((r) => r.supersedes_id).filter((v): v is string => Boolean(v)));
  const live = rows.filter((r) => !superseded.has(r.id));
  if (live.length === 0) return "";

  return [
    "NOTICES FROM THE FIRM. These apply to every piece of work you do here, including this one.",
    "They describe how West Peek already operates. Where anything below conflicts with a general",
    "habit you would otherwise follow, these win.",
    "",
    ...live.flatMap((r) => [`${r.title} — ${r.body}`, `  (${noticeAuthor(r)}, ${r.created_at.slice(0, 10)})`, ""]),
  ].join("\n");
}
