/**
 * Institutional Lens Bench (P18, GAP-09).
 *
 * The reasoning ROLES West Peek runs work through. A lens is a named review stance with a
 * declared job and a declared output — not a hidden prompt and not a personality.
 *
 * What a lens may produce, and what it may never produce:
 * - MAY produce: a verdict, a written critique, references to evidence, a short summary.
 * - MAY NEVER produce or persist: private chain-of-thought. The `lens_output` table has no
 *   column for reasoning traces, and the service writes only these declared fields.
 *
 * The No Pedestal Law is a lens, not a footnote: something must be responsible for saying that a
 * respected name, a hot sector, or a confident founder is not itself evidence.
 */

export const LENS_KEYS = [
  "LEAD",
  "SUPPORTING",
  "COUNTER",
  "HOSTILE_REVIEWER",
  "TRUTH_COMPLIANCE_GATE",
  "NO_PEDESTAL",
] as const;

export type LensKey = (typeof LENS_KEYS)[number];

export interface LensDef {
  key: LensKey;
  name: string;
  /** What this lens is responsible for. */
  job: string;
  /** What it must output. */
  produces: string;
  /** True when the lens can veto: its ADVERSE verdict blocks the packet from executing. */
  blocking: boolean;
}

export const LENS_BENCH: readonly LensDef[] = [
  {
    key: "LEAD",
    name: "Lead Lens",
    job: "Own the substantive answer: what is being asked, what would a good result look like, what does the work actually require.",
    produces: "A position with its reasoning stated as conclusions and evidence, never as private deliberation.",
    blocking: false,
  },
  {
    key: "SUPPORTING",
    name: "Supporting Lens",
    job: "Strengthen the lead position: what corroborates it, what would make it more useful, what is missing that could be supplied.",
    produces: "Corroboration, additions, and named gaps.",
    blocking: false,
  },
  {
    key: "COUNTER",
    name: "Counter Lens",
    job: "Argue the other side in good faith: what would have to be true for this to be wrong.",
    produces: "The strongest honest counter-case and the conditions that would decide it.",
    blocking: false,
  },
  {
    key: "HOSTILE_REVIEWER",
    name: "Hostile Reviewer",
    job: "Attack the work the way an unfriendly outside reader would: unsupported claims, convenient assumptions, missing sources.",
    produces: "Specific, quotable objections. Vagueness is a failure of this lens.",
    blocking: false,
  },
  {
    key: "TRUTH_COMPLIANCE_GATE",
    name: "Truth / Compliance Gate",
    job: "Check that nothing in the output asserts a legal, regulatory, valuation, or LP-marketing conclusion the firm is not authorized to make, and that claims are evidence-backed.",
    produces: "PASS, or a named refusal that blocks execution until the work is changed.",
    blocking: true,
  },
  {
    key: "NO_PEDESTAL",
    name: "No Pedestal Law",
    job: "Refuse deference: a famous investor, a hot sector, a confident founder, or a well-known logo is not evidence. Say so when it is doing the persuasive work.",
    produces: "A finding naming any place where reputation is standing in for evidence.",
    blocking: false,
  },
] as const;

export const LENS_VERDICTS = ["PASS", "CONCERN", "ADVERSE"] as const;
export type LensVerdict = (typeof LENS_VERDICTS)[number];

/** The default stack for ordinary governed work. Operators may select any subset plus the gate. */
export const DEFAULT_LENS_STACK: readonly LensKey[] = ["LEAD", "COUNTER", "TRUTH_COMPLIANCE_GATE", "NO_PEDESTAL"];

export function lensDef(key: string): LensDef | undefined {
  return LENS_BENCH.find((l) => l.key === key);
}

/** Lenses whose ADVERSE verdict blocks execution. */
export const BLOCKING_LENSES: readonly LensKey[] = LENS_BENCH.filter((l) => l.blocking).map((l) => l.key);
