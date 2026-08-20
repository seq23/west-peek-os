import type { Env } from "../env";
import { appendEvent } from "../events";

/**
 * Recording a failure that was deliberately not allowed to fail the caller.
 *
 * THE FAILURE THIS EXISTS TO PREVENT, which happened. `deliver()` threw on every single call for a
 * day — a conflict target that did not match its partial index — and nothing anywhere said so,
 * because both callers wrap it in try/catch so a handover failure cannot fail the brief or the
 * research packet it belongs to. That non-fatal wrapping is RIGHT. The silence was not.
 *
 * A hostile pass over the codebase found four write paths with the same shape, all of them written
 * the same day, all of them capable of being dead forever with no trace. So: swallow the throw,
 * keep the caller alive, and put a line in the ledger. A feature that has quietly stopped working
 * becomes something you can find by looking at Activity rather than by noticing months later that
 * a table is empty.
 *
 * NOT A LOG LINE. `console.error` in a Worker reaches a tail nobody is watching. The event ledger
 * is the thing this firm already reads.
 */
export async function recordSwallowed(
  env: Env,
  where: string,
  err: unknown,
  context: Record<string, unknown> = {},
): Promise<void> {
  const detail = err instanceof Error ? err.message : String(err);
  try {
    await appendEvent(env, {
      eventType: "system.swallowed_failure",
      actorType: "system",
      actorId: "system",
      objectType: "system",
      objectId: where,
      payload: { where, detail: detail.slice(0, 500), ...context },
    });
  } catch {
    // The ledger itself is unavailable. There is nowhere left to report to, and taking the caller
    // down over a failed audit write would turn a missing brief into no brief at all.
  }
}
