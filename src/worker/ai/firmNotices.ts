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
        `SELECT title, body, author_type, author_id, created_at
           FROM internal_memo
          WHERE audience = 'FIRM' AND firm_scope = ?1
          ORDER BY created_at, id`,
      )
        .bind(firmScope)
        .all<NoticeRow>()
    ).results ?? [];
  if (rows.length === 0) return "";

  return [
    "NOTICES FROM THE FIRM. These apply to every piece of work you do here, including this one.",
    "They describe how West Peek already operates. Where anything below conflicts with a general",
    "habit you would otherwise follow, these win.",
    "",
    ...rows.flatMap((r) => [`${r.title} — ${r.body}`, `  (${noticeAuthor(r)}, ${r.created_at.slice(0, 10)})`, ""]),
  ].join("\n");
}
