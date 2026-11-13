/**
 * WHICH ROUTE A CALL RUNS ON: ONE RULE, ONE TABLE (owner, 26 Oct, 6 Nov, 11 Nov and 13 Nov 2026).
 *
 * The table is DATA: `modelOrder.json` beside this file, read here for the Worker and by scripts/lib/model-roles.mjs
 * for the Mac's job runner. It speaks of job class (HARD, CLEAR_BRIEF, SHORT), route tier (the free lanes, the Codex
 * seat on her ChatGPT plan, the Claude Code seat) and the privacy limit. No rule here names a model.
 *
 *   PRIVATE_HARD  private work (a committed LP's name, deal terms, fund figures; unknown confidentiality reads as
 *                 private) that is also HARD → the Claude Code seat only, then a named WAIT for it. Never Codex.
 *   PRIVATE       every other private call → Claude Code, then the Codex seat as its backup (13 Nov 2026: "all
 *                 private stuff can go through codex i need a backup to claude"), then a named stop.
 *                 NO PRIVATE ROW HAS A FREE LANE, whatever fails and whatever else marks the call.
 *   IMPORTANT     HARD work that is not private (a call its caller named `important`: anything a brand or partner
 *                 reads in her name) → Claude Code, then Codex, then a named wait for a seat.
 *   NAMED         (`seatFirst`: the brief, University, the market map, the Room packet, Fund deck edits) → Claude
 *                 Code, then Codex, then the free lanes, then what the spend lever allows.
 *   CLEAR_BRIEF   well-specified work with a clear brief → Codex, then Claude Code, then a named stop.
 *   ROUTINE       SHORT work that is not private (everything else) → the free lanes, then the Codex seat, then the
 *                 Claude Code seat, then a NAMED STOP.
 *
 * No paid lane is added by this table. The spend lever alone admits one, and at Free only (production since
 * 29 Sep 2026) nothing paid stands behind any class.
 * Pure, so the order is testable without a router. `runAi` reads this table and nothing else for the order.
 */
import ORDER_TABLE from "./modelOrder.json";

export type JobClass = "HARD" | "CLEAR_BRIEF" | "SHORT";
export type WorkClass = "PRIVATE_HARD" | "PRIVATE" | "IMPORTANT" | "NAMED" | "CLEAR_BRIEF" | "ROUTINE";

export interface ModelOrderRow {
  /** The subscription seats this class may use, in order. A seat not listed takes no part. */
  seats: readonly string[];
  /** Where the free (training-permitting) lanes stand: ahead of the seats, behind them, or nowhere. */
  free: "FIRST" | "BEHIND_SEATS" | "NEVER";
  /** The free lanes in the order they are tried; any other free lane follows in catalogue order. */
  freeLanes: readonly string[];
}

const { $comment: _orderComment, ...ORDER_ROWS } = ORDER_TABLE.order;
void _orderComment;
export const MODEL_ORDER: Readonly<Record<WorkClass, ModelOrderRow>> = Object.freeze(ORDER_ROWS as unknown as Record<WorkClass, ModelOrderRow>);

/** The row a job class takes. A class the table does not name is HARD; private is the stricter row of its class. */
export function workClassFor(jobClass: string | null | undefined, isPrivate: boolean): WorkClass {
  const classes = ORDER_TABLE.classes as unknown as Record<string, { open: WorkClass; private: WorkClass } | string>;
  const named = classes[String(jobClass ?? "")];
  const row = (typeof named === "object" ? named : classes[ORDER_TABLE.default_class]) as { open: WorkClass; private: WorkClass };
  return isPrivate ? row.private : row.open;
}

export interface ImportanceMarkers {
  /** classifyContent's verdict: false for private content (LP, deal terms, fund figures). */
  publicModelApproved: boolean;
  confidential?: boolean;
  important?: boolean;
}

export function isImportantWork(m: ImportanceMarkers): boolean {
  return !m.publicModelApproved || m.confidential === true || m.important === true;
}

/** Private: content not declared public, or a call its caller marked confidential (the legacy spelling of private). */
export function isPrivateWork(m: ImportanceMarkers): boolean {
  return !m.publicModelApproved || m.confidential === true;
}

/**
 * The job class of a Worker call, from what the call already says about itself (no classifier): HARD when its
 * caller named it `important` (a partner or outsider reads it), `seatFirst` (her "needs a strong model" list) or an
 * `interpretation` (it decides what a partner asked for); SHORT otherwise. No Worker call is CLEAR_BRIEF today.
 */
export function jobClassOf(m: { important?: boolean; seatFirst?: boolean; interpretation?: boolean }): JobClass {
  return m.important === true || m.seatFirst === true || m.interpretation === true ? "HARD" : "SHORT";
}

/** The class of a call. Private is decided first, so no other marker can widen where private content goes. */
export function workClassOf(m: ImportanceMarkers & { seatFirst?: boolean; interpretation?: boolean }): WorkClass {
  if (isPrivateWork(m)) return workClassFor(jobClassOf(m), true);
  if (m.important === true) return workClassFor("HARD", false);
  return m.seatFirst === true ? "NAMED" : "ROUTINE";
}

/** Why a seat took no part in a call whose class does not list it (private hard work: Codex). */
export const CLAUDE_ONLY_PRIVATE = "private hard work waits for Claude Code and never goes to Codex, so the Codex seat took no part in this call";

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

/**
 * THE ORDER CORRECTS ITSELF FROM THE RUN LOG (owner, 13 Nov 2026). The table gives each class its candidates in
 * today's order; what the log says about one kind of duty then re-ranks them, with no rule naming any model:
 *
 *   · a lane that failed this kind of duty TWICE RUNNING stops getting it for a day, so the work moves to the next
 *     candidate by itself: the next free lane first, and up to the Codex seat only when no free lane is left;
 *   · among the free lanes, the one that LAST COMPLETED this kind is tried first, then the others by how many times
 *     each completed it in the log's window.
 *
 *   · a free lane whose LAST TWO tries at this kind failed, however long ago, never LEADS it again by itself: once
 *     its day out is over it stands behind the seats, where a seat's own failure can still reach it and one
 *     completed run puts it back in front (13 Nov 2026: a partner's weekly search began every week on the lane that
 *     had failed it the week before).
 *
 * A failure is an attempt that ran and did not complete (a refusal, an error, an empty or malformed answer, the
 * duty's own check). A spent quota or an absent seat is a wait, not a failure (`isWaitNotFailure`). A seat keeps its place in the table's order; it can only be left out.
 * If leaving lanes out would leave nothing, the chain is returned as the table ordered it: a stale mark must never
 * be the reason a job cannot run. Pure.
 */
export interface LaneAttempt {
  /** `provider_key/model`, as the chain names its lanes. */
  lane: string;
  ok: boolean;
  /** ISO instant of the run the attempt belongs to. */
  at: string;
}
export const TWICE_FAILED_REST_MS = 24 * 60 * 60 * 1000;

export function rerankFromLog<T>(
  chain: readonly T[],
  keyOf: (lane: T) => string,
  isFree: (lane: T) => boolean,
  /** This duty kind's attempts, NEWEST FIRST. */
  attempts: readonly LaneAttempt[],
  now: Date,
  /** Which lanes are her seats. Without it no lane is moved behind them. */
  isSeat: (lane: T) => boolean = () => false,
): { chain: T[]; rested: string[]; remembered: string | null; behindSeats: string[] } {
  const byLane = new Map<string, LaneAttempt[]>();
  for (const a of attempts) byLane.set(a.lane, [...(byLane.get(a.lane) ?? []), a]);
  const restedSet = new Set<string>();
  const failedLastTwo = new Set<string>();
  for (const [lane, list] of byLane) {
    const [last, before] = list;
    if (!(last && before && !last.ok && !before.ok)) continue;
    if (now.getTime() - Date.parse(last.at) < TWICE_FAILED_REST_MS) restedSet.add(lane);
    else failedLastTwo.add(lane);
  }
  const kept = chain.filter((l) => !restedSet.has(keyOf(l)));
  if (kept.length === 0) return { chain: [...chain], rested: [], remembered: null, behindSeats: [] };
  const inChain = new Set(kept.filter(isFree).map(keyOf));
  const remembered = attempts.find((a) => a.ok && inChain.has(a.lane))?.lane ?? null;
  const completed = (lane: string): number => (byLane.get(lane) ?? []).filter((a) => a.ok).length;
  const free = kept
    .map((l, i) => ({ l, i }))
    .filter((x) => isFree(x.l))
    .sort((a, b) => Number(keyOf(b.l) === remembered) - Number(keyOf(a.l) === remembered) || completed(keyOf(b.l)) - completed(keyOf(a.l)) || a.i - b.i)
    .map((x) => x.l);
  let next = 0;
  const ordered = kept.map((l) => (isFree(l) ? free[next++]! : l));
  // A free lane that failed its last two tries does not lead: it goes to just behind the last seat, when there is one.
  const lastSeat = ordered.reduce((at, l, i) => (isSeat(l) ? i : at), -1);
  const moved = ordered.filter((l, i) => isFree(l) && failedLastTwo.has(keyOf(l)) && i < lastSeat);
  const out = moved.length === 0 ? ordered : [...ordered.slice(0, lastSeat + 1).filter((l) => !moved.includes(l)), ...moved, ...ordered.slice(lastSeat + 1)];
  return { chain: out, rested: [...restedSet].filter((k) => chain.some((l) => keyOf(l) === k)), remembered, behindSeats: moved.map(keyOf) };
}

/**
 * A ROUTE THAT WAS NOT THERE HAS NOT FAILED THE JOB. A spent quota or usage limit, a rate limit, a seat whose Mac is
 * asleep, a missing key or an account out of credit say nothing about whether the route can do this kind of work:
 * the call moves to the next candidate and the route is asked again next time. Only an attempt that ran and did not
 * produce a usable answer counts toward "failed it twice running".
 */
export function isWaitNotFailure(detail: string | null | undefined): boolean {
  // The $0 search lane's stop means EVERY route inside it was tried and none produced a sourced answer. Whatever
  // the routes said (a retired model, a spent allowance, an answer citing no page), the lane failed the search
  // (13 Nov 2026: read as a wait, it led a partner's weekly search twelve times running).
  if (/free_search_named_stop/.test(detail ?? "")) return false;
  const text = detail ?? "";
  return /\b429\b|rate.?limit|quota|usage limit|out of usage|queries are used up|SEAT_ASLEEP|subscription_seat_unavailable|NO_CREDENTIAL|credential_missing|is not set|OUT_OF_CREDIT|credit balance/i.test(text);
}

/** The kind of duty a call belongs to, from its purpose: the words before the first quoted title, bracket or id. */
export function dutyKindOf(purpose: string): string {
  return String(purpose ?? "").split(/["“(]/)[0]!.trim().slice(0, 80);
}
