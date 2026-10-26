/**
 * WHICH SUBSCRIPTION SEAT LEADS, AND WHETHER A FREE LANE MAY STAND BEHIND IT (owner, 26 Oct 2026).
 *
 * Her ruling: "i prefer claude first for important jobs and then anything else can use Open ai /codex then free
 * models". Her ChatGPT plan ($20/mo) was "unused basically", so it carries routine work; the Claude seat is kept
 * for the work that matters.
 *
 *   IMPORTANT  (private content — LP names, deal terms, fund figures — a confidential call, or a call its caller
 *              named `important`: TLC brand drafts and anything brand- or partner-facing in her name)
 *              → Claude Code seat, then the Codex seat, then WAIT for a seat. Never a free lane.
 *   NAMED      (`seatFirst`: the brief, University, the market map, the Room packet — her earlier "needs a strong
 *              model" list) → Claude Code, then Codex, then the ladder it always had behind the seats.
 *   ROUTINE    (everything else that is judgement work)
 *              → the Codex seat, then the free lanes. The Claude seat takes no part.
 *
 * No paid lane is added by this order; a paid lane stays exactly where the spend lever puts it.
 * Pure, so the order is testable without a router.
 */
export const IMPORTANT_SEAT_ORDER = ["claude_code", "codex"] as const;
export const ROUTINE_SEAT_ORDER = ["codex"] as const;

export interface ImportanceMarkers {
  /** classifyContent's verdict: false for private content (LP, deal terms, fund figures). */
  publicModelApproved: boolean;
  confidential?: boolean;
  important?: boolean;
}

export function isImportantWork(m: ImportanceMarkers): boolean {
  return !m.publicModelApproved || m.confidential === true || m.important === true;
}

export function seatOrderFor(important: boolean): readonly string[] {
  return important ? IMPORTANT_SEAT_ORDER : ROUTINE_SEAT_ORDER;
}

/** Why a seat took no part in a routine call. */
export const KEPT_FOR_IMPORTANT = "the Claude Code seat is kept for important work, so this routine call did not use it";

/**
 * Seat verdicts in her order: the seats this call may use first, in order; any other seat is marked as taking no
 * part, with the reason, so the run's explanation still names it.
 */
export function orderSeats<T extends { seat: string; available: boolean; reason: string }>(verdicts: readonly T[], important: boolean): T[] {
  const order = seatOrderFor(important);
  const rank = (s: string) => (order.indexOf(s) < 0 ? order.length : order.indexOf(s));
  return [...verdicts]
    .map((v) => (order.includes(v.seat) ? v : { ...v, available: false, reason: KEPT_FOR_IMPORTANT }))
    .sort((a, b) => rank(a.seat) - rank(b.seat));
}

/**
 * IMPORTANT WORK WITH NO SEAT FREE WAITS FOR ONE. The router refuses with this code instead of handing the work to a
 * free lane; the sweep reads it as a technical wait (requeue, retry by itself), never a block on the owner and
 * never a STUCK email.
 */
export const SEAT_WAIT_CODE = "seat_wait_important_work";
export const isSeatWait = (text: string | null | undefined): boolean => (text ?? "").includes(SEAT_WAIT_CODE);
