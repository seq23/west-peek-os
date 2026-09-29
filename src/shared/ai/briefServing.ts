/**
 * WHO WROTE THIS BRIEF, AND IS IT THE USUAL WRITER? (29 Sep 2026)
 *
 * The brief is normally written by Claude Sonnet. The owner's ladder puts her subscription seats
 * ahead of it (Claude Code, then Codex) and, at the $0 posture, lets a free reasoning model stand in
 * when nothing stronger is available — provided the report SAYS so. This is the one place that turns
 * the model recorded on the report row into that sentence, so the page, the tests and the record
 * agree, and nobody has to remember which model ids mean "weaker".
 *
 * DERIVED FROM THE MODEL ON THE ROW, not stored separately. `intelligence_report.model` already
 * records the lane that completed the run, so a second "degraded" flag would be a second source of
 * truth that could disagree with the first. Nothing here can be wrong about a report it was not
 * given: a null model reads as UNKNOWN, with no note, rather than as either good or bad.
 *
 * A "DEGRADED" MODEL IS ONE WE HAVE NO REASON TO TRUST AT SONNET'S JOB. The named strong writers are
 * Sonnet (at OpenRouter or Anthropic directly) and the two subscription seats. Anything else — the
 * free reasoning lanes, a small local model — is marked, by default, so a new model id added to the
 * catalogue is flagged until somebody decides it is good enough and adds it here.
 */

/** The model the brief is written by at MODERATE and OPEN. Mirrors BRIEF_MODEL in dailyIntelligence.ts. */
export const BRIEF_USUAL_MODEL = "anthropic/claude-sonnet-5";

/** The model ids the two subscription seats record on a run (provider_model, migration 0187). */
export const SEAT_MODEL_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "claude-code-local": "Claude Code (her Claude Max seat)",
  "codex-local": "Codex (her ChatGPT Plus seat)",
});

/** Sonnet by either road: through OpenRouter, or at Anthropic directly. */
const SONNET_IDS: ReadonlySet<string> = new Set([BRIEF_USUAL_MODEL, "claude-sonnet-5"]);

export type BriefServingKind = "USUAL" | "SEAT" | "DEGRADED" | "UNKNOWN";

export interface BriefServing {
  kind: BriefServingKind;
  /** True only for a model we have no reason to trust at the brief's job. */
  degraded: boolean;
  /** A short label for the masthead detail line. Null when the model is unknown. */
  label: string | null;
  /** A sentence for a partner, present ONLY when the brief was written by a weaker model. */
  note: string | null;
}

export function briefServing(model: string | null | undefined): BriefServing {
  const id = (model ?? "").trim();
  if (!id) return { kind: "UNKNOWN", degraded: false, label: null, note: null };
  if (SONNET_IDS.has(id)) return { kind: "USUAL", degraded: false, label: id, note: null };
  const seat = SEAT_MODEL_LABELS[id];
  if (seat) return { kind: "SEAT", degraded: false, label: seat, note: null };
  return {
    kind: "DEGRADED",
    degraded: true,
    label: id,
    note:
      `This brief was written by ${id}, not by Claude, because the lanes ahead of it were not available ` +
      `(the Claude Code and Codex seats were away or out of usage, and paid models are off at this setting). ` +
      `It passed the brief's own checks, but treat it as a weaker draft. Press Build again once a seat is awake, ` +
      `or move the spend lever to Open, for the usual writer.`,
  };
}
