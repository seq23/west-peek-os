import type { WorkCardRow } from "./types";

const TRIES = 3;

/**
 * THE REAL TRY COUNT (23 Sep 2026). A website job's tries are its Mac runs, per phase — the sweep's
 * counter said "try 1 of 3" on a card whose plan had taken two runs. Any other employee card counts
 * the sweep's own attempts, which is what caps it at three.
 */
export function triesWords(c: Pick<WorkCardRow, "owner_type" | "work_attempts" | "site_tries">, finished: boolean): string {
  if (c.site_tries && c.site_tries.length > 0) return ` · tries: ${c.site_tries.map((t) => `${t.phase.toLowerCase()} ${t.tries}`).join(", ")}`;
  if (c.owner_type !== "AI" || finished) return "";
  return ` · try ${Math.min(TRIES, Math.max(1, c.work_attempts ?? 1))} of ${TRIES}`;
}
