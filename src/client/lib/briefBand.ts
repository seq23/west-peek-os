/**
 * THE BRIEF BAND'S WORDS AND TONES — pure functions of the server's named state, so the band can be
 * tested without a DOM and `validate:brief-lands` can drive every state through them.
 *
 * The server (`/api/daily-intelligence/status`) computes the state from the row with
 * `shared/intelligence/briefRunState.ts`; this file only decides how the band SHOWS it: which
 * notice tone, whether the live dot and the progress track appear, what the answer line says, and
 * what the button reads. It never re-derives a state from the clock or from silence.
 */

import type { BriefRunStateKind } from "../../shared/intelligence/briefRunState";

/** The state as the status route returns it — the shared state plus the row's own facts. */
export interface BriefStatusResponse {
  date: string;
  kind: BriefRunStateKind;
  arrived: boolean;
  line: string;
  next: string | null;
  stage: string | null;
  elapsedSeconds: number | null;
  usualSeconds: number | null;
  actAt: string | null;
  button: { label: string; enabled: boolean };
  report_id: string | null;
  status: string | null;
  attempts: number;
  requested_at: string | null;
  requested_by: string | null;
  started_at: string | null;
  completed_at: string | null;
  expectations: { usualSeconds: number; slowSeconds: number; measuredFrom: number };
}

/** The states in which the band keeps asking the server, every few seconds. */
export const MOVING_KINDS: ReadonlySet<BriefRunStateKind> = new Set(["requested", "running", "queued", "stalled"]);

export const POLL_EVERY_MS = 5_000;

/** Which notice class carries the state. Orange never; danger for the absence of the thing she came for. */
export function toneClassFor(kind: BriefRunStateKind): string {
  switch (kind) {
    case "arrived": return "notice notice-ok";
    case "failed_out": return "notice notice-bad";
    case "retrying":
    case "stalled": return "notice notice-gate";
    default: return "notice";
  }
}

/** True when a live dot belongs beside the line: work is happening now. */
export function showsLiveDot(kind: BriefRunStateKind): boolean {
  return kind === "running";
}

/**
 * How far along the build is, for the progress track — elapsed over the measured usual, capped so
 * the bar never claims "done" before the row does. Null when nothing is moving.
 */
export function progressFraction(state: Pick<BriefStatusResponse, "kind" | "elapsedSeconds" | "usualSeconds">): number | null {
  if (!MOVING_KINDS.has(state.kind)) return null;
  if (state.elapsedSeconds === null || !state.usualSeconds || state.usualSeconds <= 0) return 0.02;
  return Math.max(0.02, Math.min(0.95, state.elapsedSeconds / state.usualSeconds));
}

/**
 * The masthead's answer line: what a partner reads first. The arrived line includes the clock; every
 * other state is the shared sentence, which already names the stage, the elapsed time and the reason.
 */
export function answerLine(state: Pick<BriefStatusResponse, "kind" | "line">): string {
  return state.line;
}

/**
 * The masthead's detail: built when, by whom, from what. Every part is a fact the row carries;
 * a part that is not known is left out rather than guessed.
 */
export function examinedLine(input: {
  completedAt: string | null;
  preparedBy: string | null;
  rawCount: number | null;
  dedupedCount: number | null;
  candidateCount: number | null;
  model: string | null;
  requestedBy: string | null;
  requestedAt: string | null;
  viewerId: string | null;
}): string {
  const parts: string[] = [];
  if (input.completedAt) {
    const at = new Date(input.completedAt);
    if (!Number.isNaN(at.getTime())) parts.push(`built at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`);
  }
  if (input.preparedBy) parts.push(`by ${input.preparedBy}`);
  if (input.rawCount !== null && input.dedupedCount !== null && input.candidateCount !== null && input.rawCount > 0) {
    parts.push(`${input.rawCount} items → ${input.dedupedCount} events → ${input.candidateCount} considered`);
  }
  if (input.model) parts.push(input.model);
  if (input.requestedAt) {
    const who = input.requestedBy && input.viewerId && input.requestedBy === input.viewerId ? "you" : input.requestedBy ? "your partner" : "a partner";
    const at = new Date(input.requestedAt);
    parts.push(`requested by ${who}${Number.isNaN(at.getTime()) ? "" : ` at ${at.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`}`);
  }
  return parts.join(" · ");
}

/** What the button says after a press, from the server's answer, never from what the client hoped. */
export function pressOutcomeLine(res: { status: number; data: (Partial<BriefStatusResponse> & { already?: boolean; detail?: string; error?: string }) | null }): string {
  if (res.status === 202) return res.data?.line ?? "Requested. The clock picks it up within a minute.";
  if (res.status === 200 && res.data?.already) return res.data.line ?? "Already building.";
  return res.data?.detail ?? res.data?.error ?? `Could not ask for the brief (HTTP ${res.status}).`;
}
