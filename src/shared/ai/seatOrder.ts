/**
 * WHICH MODEL A CALL RUNS ON: ONE RULE, ONE TABLE (owner, 26 Oct, 6 Nov and 11 Nov 2026).
 *
 * 26 Oct: "i prefer claude first for important jobs". 6 Nov, newer, and it wins for routine work: "Gemini free →
 * OpenRouter free → Codex → Claude → a named stop; never a paid API, never waiting for a reset while a later step
 * can run". Private, LP and deal work stays Claude-only.
 *
 *   PRIVATE    (LP names, deal terms, fund figures; unknown confidentiality reads as private)
 *              → the Claude Code seat only, then WAIT for it. Never Codex, never a free lane.
 *   IMPORTANT  (a confidential call, or a call its caller named `important`: TLC brand drafts and anything brand- or
 *              partner-facing in her name) → Claude Code seat, then the Codex seat, then WAIT for a seat.
 *   NAMED      (`seatFirst`: the brief, University, the market map, the Room packet — her "needs a strong model"
 *              list) → Claude Code, then Codex, then the free lanes, then what the spend lever allows.
 *   ROUTINE    (everything else) → the free lanes (Gemini free, then OpenRouter free), then the Codex seat, then the
 *              Claude Code seat, then a NAMED STOP. A live-search call or one carrying a file has no free lane that
 *              can serve it, so it starts at the seats.
 *
 * No paid lane is added by this table. The spend lever alone admits one, and at Free only (production since
 * 29 Sep 2026) nothing paid stands behind any class.
 * Pure, so the order is testable without a router. `runAi` reads this table and nothing else for the order.
 */
export type WorkClass = "PRIVATE" | "IMPORTANT" | "NAMED" | "ROUTINE";

export interface ModelOrderRow {
  /** The subscription seats this class may use, in order. A seat not listed takes no part. */
  seats: readonly string[];
  /** Where the free (training-permitting) lanes stand: ahead of the seats, behind them, or nowhere. */
  free: "FIRST" | "BEHIND_SEATS" | "NEVER";
  /** The free lanes in the order they are tried; any other free lane follows in catalogue order. */
  freeLanes: readonly string[];
}

export const MODEL_ORDER: Readonly<Record<WorkClass, ModelOrderRow>> = Object.freeze({
  PRIVATE: { seats: ["claude_code"], free: "NEVER", freeLanes: [] },
  IMPORTANT: { seats: ["claude_code", "codex"], free: "NEVER", freeLanes: [] },
  NAMED: { seats: ["claude_code", "codex"], free: "BEHIND_SEATS", freeLanes: ["openrouter_free", "google_free"] },
  ROUTINE: { seats: ["codex", "claude_code"], free: "FIRST", freeLanes: ["google_free", "openrouter_free"] },
});

export interface ImportanceMarkers {
  /** classifyContent's verdict: false for private content (LP, deal terms, fund figures). */
  publicModelApproved: boolean;
  confidential?: boolean;
  important?: boolean;
}

export function isImportantWork(m: ImportanceMarkers): boolean {
  return !m.publicModelApproved || m.confidential === true || m.important === true;
}

/** The class of a call. Private is decided first, so no other marker can widen where private content goes. */
export function workClassOf(m: ImportanceMarkers & { seatFirst?: boolean }): WorkClass {
  if (!m.publicModelApproved) return "PRIVATE";
  if (isImportantWork(m)) return "IMPORTANT";
  return m.seatFirst === true ? "NAMED" : "ROUTINE";
}

/** Why the Codex seat took no part in a private call. */
export const CLAUDE_ONLY_PRIVATE = "private, LP and deal work stays Claude-only, so the Codex seat took no part in this call";

/**
 * Seat verdicts in her order: the seats this class may use, in order; any other seat is marked as taking no part,
 * with the reason, so the run's explanation still names it.
 */
export function orderSeats<T extends { seat: string; available: boolean; reason: string }>(verdicts: readonly T[], workClass: WorkClass): T[] {
  const order = MODEL_ORDER[workClass].seats;
  const rank = (s: string) => (order.indexOf(s) < 0 ? order.length : order.indexOf(s));
  return [...verdicts]
    .map((v) => (order.includes(v.seat) ? v : { ...v, available: false, reason: CLAUDE_ONLY_PRIVATE }))
    .sort((a, b) => rank(a.seat) - rank(b.seat));
}

/** Free lanes in this class's order (none for a class that may never use one); unlisted lanes keep their place after. */
export function orderFreeLanes<T>(lanes: readonly T[], workClass: WorkClass, keyOf: (lane: T) => string): T[] {
  const row = MODEL_ORDER[workClass];
  if (row.free === "NEVER") return [];
  const rank = (l: T) => (row.freeLanes.indexOf(keyOf(l)) < 0 ? row.freeLanes.length : row.freeLanes.indexOf(keyOf(l)));
  return [...lanes].sort((a, b) => rank(a) - rank(b));
}

/**
 * THE WHOLE CHAIN FOR ONE CALL, in the order it is tried. `free` and `seats` are the lanes that may serve this call,
 * already in this class's order; `behind` is whatever the spend lever leaves after them. `behindIsFree` says every
 * lane in `behind` costs nothing (the lever is at Free only), so for a free-first class it stands with the free
 * lanes, ahead of the seats. When the chain runs out the run stops with the last lane's named reason.
 */
export function ladderFor<T>(workClass: WorkClass, lanes: { free: readonly T[]; seats: readonly T[]; behind: readonly T[]; behindIsFree: boolean }): T[] {
  const row = MODEL_ORDER[workClass];
  const free = row.free === "NEVER" ? [] : lanes.free;
  if (row.free !== "FIRST") return [...lanes.seats, ...free, ...lanes.behind];
  return lanes.behindIsFree ? [...free, ...lanes.behind, ...lanes.seats] : [...free, ...lanes.seats, ...lanes.behind];
}

/**
 * IMPORTANT WORK WITH NO SEAT FREE WAITS FOR ONE. The router refuses with this code instead of handing the work to a
 * free lane; the sweep reads it as a technical wait (requeue, retry by itself), never a block on the owner and
 * never a STUCK email.
 */
export const SEAT_WAIT_CODE = "seat_wait_important_work";
export const isSeatWait = (text: string | null | undefined): boolean => (text ?? "").includes(SEAT_WAIT_CODE);
