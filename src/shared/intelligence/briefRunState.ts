/**
 * THE NAMED STATE OF TODAY'S BRIEF — one answer, computed from the row, read by the server's
 * status route and by the Home band. Nothing on either side infers a state from silence.
 *
 * ── WHAT SHE SAW, 19 Sep 2026 (a Saturday) ────────────────────────────────────────────────────
 *
 * "there was no brief today when I woke up. I pushed the button to build a brief and I don't know
 * if it's coming or not or how long it takes — there is no progress bar — and I pushed the button
 * again and some other message came up."
 *
 * Three facts, all CONFIRMED from production:
 *
 *   1. No brief was ever owed. Both partners' profiles carried `weekends = 0` (the column's
 *      default), so the schedule skipped Saturday by design and the only place that said so was a
 *      small grey line under the button. The partner's own instruction that morning is that a
 *      brief is expected every day; migration 0211 turns weekends on and the code default follows.
 *
 *   2. The button ran the model call INSIDE her HTTP request. Her press at 13:29:30Z gathered and
 *      read the market in six seconds, then the write stage opened an `ai_run` on a free lane at
 *      13:29:37Z that was still RUNNING fifteen minutes later — the request had been cut and no
 *      code of ours ran to close anything. The row sat at GENERATING holding a ten-minute lease.
 *
 *   3. The "other message" was `stage: "busy"` → "Another run holds it…": the second press found
 *      its own dead lease. Correct, and useless, because the page could not say WHAT held it, since
 *      when, or what would happen next.
 *
 * ── THE RULE ──────────────────────────────────────────────────────────────────────────────────
 *
 * Every state is a NAMED state carried by the `intelligence_report` row — `status`, `attempts`,
 * `requested_at`, `stage_at`, `stage_lease_until`, `retry_after`, `error_message` — and this
 * function turns exactly that row into one of nine words plus a sentence for her. The client never
 * looks at the clock and decides for itself; it asks the row, through the server, every few
 * seconds while the state is one of the moving ones.
 *
 * Pure, so `tests/briefRunState.test.ts` and `validate:brief-lands` can drive every status the
 * schema's CHECK constraint permits, at every attempt count, leased and unleased, requested and
 * scheduled, and require that not one combination falls through to silence.
 */

import { MAX_BRIEF_ATTEMPTS, briefTerminality } from "./briefTerminality";

/** The fields of an `intelligence_report` row that decide the state. */
export interface BriefRunRow {
  status: string;
  report_date: string;
  attempts: number;
  started_at: string | null;
  stage_at: string | null;
  stage_lease_until: string | null;
  completed_at: string | null;
  requested_at?: string | null;
  requested_by?: string | null;
  retry_after?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  /** How many readable sections the report has. READY with zero is an empty card, not a brief. */
  section_count?: number;
}

/** What the schedule says when there is no row yet. */
export interface BriefSchedule {
  enabled: boolean;
  /** True when the partner's own calendar says today is a weekend AND weekends are off. */
  weekendOff: boolean;
  /** The next instant the clock will start a brief, as an ISO string, or null when it never will. */
  nextStartAt: string | null;
  /** "06:15" in the partner's zone — for the sentence. */
  earliestStartLocal: string;
}

/** Measured, not guessed: how long the write stage has actually taken, from real completed runs. */
export interface BriefExpectations {
  /** Median seconds for the whole build once it starts (gather + market + write), from real runs. */
  usualSeconds: number;
  /** The slow end (p90) from the same runs. */
  slowSeconds: number;
  /** How many completed runs the two figures were measured from. 0 means "no history; a floor". */
  measuredFrom: number;
}

export type BriefRunStateKind =
  /** There is a brief to read. */
  | "arrived"
  /** She pressed the button; the clock has not picked it up yet (≤ one tick). */
  | "requested"
  /** A stage is moving right now, under a live lease. */
  | "running"
  /** Between stages, no lease held — the next tick takes it. Still moving. */
  | "queued"
  /** It failed, attempts remain, and the clock will try again at `retryAt`. */
  | "retrying"
  /** It failed and the day's attempts are spent. Stated, and the button is the only door today. */
  | "failed_out"
  /** Nothing yet, and the clock will start it at `nextStartAt`. */
  | "scheduled"
  /** Nothing yet, and nothing will be built: switched off, or a weekend she turned off. */
  | "off"
  /** It stopped moving and nothing has closed it yet — the sweeper will within STALE minutes. */
  | "stalled";

export interface BriefRunState {
  kind: BriefRunStateKind;
  /** True ONLY when there is a brief on screen to read. Nothing else may claim this. */
  arrived: boolean;
  /** One sentence for the partner. Never a status code, never empty. */
  line: string;
  /** What is happening next, in words, or null when nothing is. */
  next: string | null;
  /** The stage in her words, for the moving states. */
  stage: string | null;
  /** Seconds since this run started, for the moving states. */
  elapsedSeconds: number | null;
  /** The measured usual duration, for the moving states. */
  usualSeconds: number | null;
  /** ISO instant the clock will act, for `retrying` and `scheduled`. */
  actAt: string | null;
  /** The button's label and whether pressing it does anything. */
  button: { label: string; enabled: boolean };
}

/** The stages in her words rather than the column's. */
export function briefStageWords(status: string): string {
  switch (status) {
    case "QUEUED": return "queued";
    case "GATHERING": return "reading the last 48 hours";
    case "RANKING": return "ranking what it found";
    case "GENERATING": return "writing it";
    case "VERIFYING": return "checking every claim against its sources";
    default: return status.toLowerCase();
  }
}

/** Minutes and seconds, the way a person says them: "1m 20s", "45s", "12m". */
export function elapsedWords(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m >= 10 || rest === 0) return `${m}m`;
  return `${m}m ${rest}s`;
}

/** "usually 3–4 minutes" from measured seconds; never a spinner, never a guess dressed as a fact. */
export function usualWords(exp: BriefExpectations): string {
  const lo = Math.max(1, Math.round(exp.usualSeconds / 60));
  const hi = Math.max(lo, Math.round(exp.slowSeconds / 60));
  const range = lo === hi ? `about ${lo} minute${lo === 1 ? "" : "s"}` : `${lo}–${hi} minutes`;
  return exp.measuredFrom > 0 ? `usually ${range}` : `${range} at a guess — no run has been timed yet`;
}

function clockWords(iso: string, timeZone?: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "shortly";
  try {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) });
  } catch {
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
}

/**
 * The stale threshold: a row that has not moved for this long and holds no live lease is not
 * running. Kept equal to the sweeper's STALE_AFTER_MINUTES in dailyIntelligence.ts — the two are
 * read against each other by `validate:brief-lands` so they cannot drift.
 */
export const STALLED_AFTER_MINUTES = 30;

export function briefRunState(
  row: BriefRunRow | null,
  schedule: BriefSchedule,
  expectations: BriefExpectations,
  now: Date,
  /** The partner's zone, for the clock words. Optional so the pure function needs no environment. */
  timeZone?: string,
): BriefRunState {
  const usual = usualWords(expectations);
  const build = { label: "Build today's brief", enabled: true };

  if (!row) {
    if (!schedule.enabled) {
      return {
        kind: "off", arrived: false,
        line: "Your morning brief is switched off, so nothing is being built.",
        next: "Press the button and one is built now anyway.",
        stage: null, elapsedSeconds: null, usualSeconds: null, actAt: null, button: build,
      };
    }
    if (schedule.weekendOff) {
      return {
        kind: "off", arrived: false,
        line: "No brief today — weekends are off in your settings.",
        next: "Press the button and one is built now anyway.",
        stage: null, elapsedSeconds: null, usualSeconds: null, actAt: null, button: build,
      };
    }
    const at = schedule.nextStartAt ? clockWords(schedule.nextStartAt, timeZone) : schedule.earliestStartLocal;
    return {
      kind: "scheduled", arrived: false,
      line: `No brief yet today. The clock starts it at ${at} your time.`,
      next: `It ${usual} once it starts. Press the button to start it now.`,
      stage: null, elapsedSeconds: null, usualSeconds: expectations.usualSeconds, actAt: schedule.nextStartAt, button: build,
    };
  }

  const startedMs = row.started_at ? Date.parse(row.started_at) : NaN;
  const elapsed = Number.isFinite(startedMs) ? Math.max(0, (now.getTime() - startedMs) / 1000) : null;
  const requested = Boolean(row.requested_at) && (row.completed_at === null || (row.requested_at ?? "") > (row.completed_at ?? ""));

  if (row.status === "READY") {
    if ((row.section_count ?? 1) > 0) {
      const at = row.completed_at ? ` at ${clockWords(row.completed_at, timeZone)}` : "";
      return {
        kind: "arrived", arrived: true,
        line: `Today's brief arrived${at}.`,
        next: null, stage: null, elapsedSeconds: null, usualSeconds: null, actAt: null,
        button: { label: "Rebuild today's brief", enabled: true },
      };
    }
    return {
      kind: "failed_out", arrived: false,
      line: "No brief to read: every section was held back because the checks found claims its own sources did not support.",
      next: "Press the button to write it again — a second pass usually writes something the sources do support.",
      stage: null, elapsedSeconds: null, usualSeconds: null, actAt: null, button: { label: "Rebuild today's brief", enabled: true },
    };
  }

  if (row.status === "FAILED") {
    const why = (row.error_message ?? "").trim() || "the run did not record why";
    const t = briefTerminality(row.status, row.attempts);
    if (!t.terminal && row.retry_after) {
      const at = clockWords(row.retry_after, timeZone);
      return {
        kind: "retrying", arrived: false,
        line: `No brief yet — attempt ${row.attempts} of ${MAX_BRIEF_ATTEMPTS} failed: ${why}`,
        next: `The clock tries again at ${at}. Press the button to try now instead.`,
        stage: null, elapsedSeconds: null, usualSeconds: expectations.usualSeconds, actAt: row.retry_after, button: { label: "Try again now", enabled: true },
      };
    }
    if (!t.terminal) {
      return {
        kind: "retrying", arrived: false,
        line: `No brief yet — attempt ${row.attempts} of ${MAX_BRIEF_ATTEMPTS} failed: ${why}`,
        next: "The clock tries again on its next tick. Press the button to try now instead.",
        stage: null, elapsedSeconds: null, usualSeconds: expectations.usualSeconds, actAt: null, button: { label: "Try again now", enabled: true },
      };
    }
    const tomorrow = schedule.nextStartAt ? ` The clock tries again tomorrow at ${clockWords(schedule.nextStartAt, timeZone)}.` : "";
    return {
      kind: "failed_out", arrived: false,
      line: `No brief this morning. It was tried ${row.attempts} times and failed each time; the last reason: ${why}`,
      next: `Nothing more is tried automatically today.${tomorrow} Press the button to try again now.`,
      stage: null, elapsedSeconds: null, usualSeconds: expectations.usualSeconds, actAt: schedule.nextStartAt, button: { label: "Try again now", enabled: true },
    };
  }

  // A moving status: QUEUED, GATHERING, RANKING, GENERATING, VERIFYING — or one added later.
  const leased = Boolean(row.stage_lease_until) && (row.stage_lease_until ?? "") > now.toISOString();
  const movedMs = row.stage_at ? Date.parse(row.stage_at) : startedMs;
  const sinceMoveMin = Number.isFinite(movedMs) ? (now.getTime() - movedMs) / 60_000 : 0;
  const stage = briefStageWords(row.status);
  const since = elapsed !== null ? `started ${elapsedWords(elapsed)} ago` : "started just now";
  const already = { label: `Already building — ${since}`, enabled: false };

  if (!leased && sinceMoveMin > STALLED_AFTER_MINUTES) {
    return {
      kind: "stalled", arrived: false,
      line: `The brief stopped while ${stage}, ${elapsedWords(sinceMoveMin * 60)} ago, and has not moved since.`,
      next: `The sweeper closes it as failed within ${STALLED_AFTER_MINUTES} minutes and the clock tries again. Press the button to start over now.`,
      stage, elapsedSeconds: elapsed, usualSeconds: expectations.usualSeconds, actAt: null, button: { label: "Start over now", enabled: true },
    };
  }

  if (requested && row.status === "GATHERING" && !leased) {
    return {
      kind: "requested", arrived: false,
      line: "Requested. The clock picks it up on its next tick, within a minute.",
      next: `Then it reads the last 48 hours, fetches the numbers and writes — ${usual}.`,
      stage, elapsedSeconds: elapsed, usualSeconds: expectations.usualSeconds, actAt: null, button: already,
    };
  }

  if (leased) {
    return {
      kind: "running", arrived: false,
      line: `Building — ${stage}. ${since[0]!.toUpperCase()}${since.slice(1)}; ${usual}.`,
      next: row.status === "GENERATING" || row.status === "VERIFYING"
        ? "This is the long stage: one model call, then every claim is checked against its sources."
        : "Each stage hands to the next on the clock's tick.",
      stage, elapsedSeconds: elapsed, usualSeconds: expectations.usualSeconds, actAt: null, button: already,
    };
  }

  return {
    kind: "queued", arrived: false,
    line: `Between stages — ${stage} is done; the next tick takes it on. ${since[0]!.toUpperCase()}${since.slice(1)}; ${usual}.`,
    next: "Nothing to do; it moves within a minute.",
    stage, elapsedSeconds: elapsed, usualSeconds: expectations.usualSeconds, actAt: null, button: already,
  };
}
