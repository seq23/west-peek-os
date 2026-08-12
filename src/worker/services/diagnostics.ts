import type { RouteContext } from "../router";
import { json } from "../router";

/**
 * Approval volume diagnostics (D7 / ADR-008): daily approval-card counts for the
 * last 14 days plus a weekly rollup, flagged against the ≤15 human cards/day
 * steady-state design target. OBSERVATIONAL ONLY — this metric never auto-approves,
 * batches, or suppresses anything. Silence is never approval.
 */

const TARGET_PER_DAY = 15;

export async function handleApprovalVolume(ctx: RouteContext): Promise<Response> {
  const db = ctx.env.WP_OS_DB;

  const daily = await db.prepare(
    `SELECT date(created_at) AS day, COUNT(*) AS count
       FROM approval_card
      WHERE date(created_at) >= date('now', '-13 days')
      GROUP BY date(created_at)`,
  ).all<{ day: string; count: number }>();
  const byDay = new Map((daily.results ?? []).map((r) => [r.day, r.count]));

  const days: Array<{ date: string; count: number; overTarget: boolean }> = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const count = byDay.get(date) ?? 0;
    days.push({ date, count, overTarget: count > TARGET_PER_DAY });
  }

  const weekly = await db.prepare(
    `SELECT strftime('%Y-W%W', created_at) AS week, COUNT(*) AS count
       FROM approval_card
      WHERE date(created_at) >= date('now', '-13 days')
      GROUP BY strftime('%Y-W%W', created_at)
      ORDER BY week`,
  ).all<{ week: string; count: number }>();

  return json({
    targetPerDay: TARGET_PER_DAY,
    days,
    weekly: (weekly.results ?? []).map((w) => ({ ...w, overTarget: w.count > TARGET_PER_DAY * 7 })),
    daysOverTarget: days.filter((d) => d.overTarget).map((d) => d.date),
  });
}
