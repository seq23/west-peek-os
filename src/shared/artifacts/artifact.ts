import { z } from "zod";
import { recordQueryPlanSchema, type RecordQueryPlan } from "../meetings/roomQuery";

/**
 * AN ARTIFACT BUILT ON DEMAND (owner, 19 Sep 2026): a dashboard, a deck or a document, made from the
 * firm's record and kept where it would be reused.
 *
 * ONE SHAPE FOR ALL THREE KINDS. An artifact is a list of PANELS — each one a read-only plan against
 * the room's allowlist (`roomQuery.ts`), run in code, with its rows and the rows' citations — plus,
 * for a deck or a document, a list of SECTIONS: a heading and a paragraph written about one panel.
 * A dashboard is the panels laid out; a deck is a title slide, a section slide per finding, a chart
 * slide per panel and a sources slide; a document is the sections as headings and prose with each
 * panel's figures under it. `render.ts` derives the slides and the document from this spec, and the
 * in-app page and both exports are rendered from the SAME derivation, which is what lets a test
 * prove "the export contains exactly what the page shows".
 *
 * EVERY NUMBER CITES ITS ROWS. A panel's `cites` are the row ids (or the groups) the compiler
 * returned; a section's prose may only carry numbers that appear in its panel's rows — `render.ts`'s
 * `checkCitations` refuses the spec otherwise, and the producer never saves a version that fails it.
 *
 * THE STATES ARE NAMED ON THE ROW, exactly as the brief's are (0211): a request, then a build with
 * its stage in words, then ready or failed with the reason. Nothing is inferred from silence.
 */

export const ARTIFACT_KINDS = ["dashboard", "deck", "document"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_STATES = ["REQUESTED", "BUILDING", "READY", "FAILED"] as const;
export type ArtifactState = (typeof ARTIFACT_STATES)[number];

export const ARTIFACT_STAGES = ["planning", "reading", "writing", "rendering"] as const;
export type ArtifactStage = (typeof ARTIFACT_STAGES)[number];

/** The stage, in words a partner reads on the row while it moves. */
export const STAGE_WORDS: Readonly<Record<ArtifactStage, string>> = {
  planning: "choosing what to read from the record",
  reading: "reading the record",
  writing: "writing the findings",
  rendering: "laying it out",
};

export const KIND_WORDS: Readonly<Record<ArtifactKind, { label: string; a: string; blurb: string }>> = {
  dashboard: { label: "Dashboard", a: "a dashboard", blurb: "Several views of the record on one page, refreshed when it is opened." },
  deck: { label: "Deck", a: "a deck", blurb: "Real slides: a title, a slide per finding, a chart per query, the sources. Exports as .pptx." },
  document: { label: "Document", a: "a document", blurb: "A memo or one-pager: headings, prose from the record, every figure cited. Exports as .docx." },
};

export const PANEL_CHARTS = ["table", "bar", "line", "pie"] as const;
export type PanelChart = (typeof PANEL_CHARTS)[number];

/** How a builder (the room's blocks, or the planning model) proposes a panel. Rows come later, in code. */
export const panelPlanSchema = z.object({
  title: z.string().trim().min(1).max(120),
  chart: z.enum(PANEL_CHARTS).default("table"),
  plan: recordQueryPlanSchema,
});
export type PanelPlan = z.infer<typeof panelPlanSchema>;

export const panelPlansSchema = z.array(panelPlanSchema).min(1).max(8);

/** What the planning model returns for a brief. */
export const planningReplySchema = z.object({
  title: z.string().trim().min(1).max(120),
  panels: panelPlansSchema,
});

/** What the writing model returns: one section per panel it chose to write about. */
export const writingReplySchema = z.object({
  summary: z.string().trim().max(600).nullish(),
  sections: z
    .array(
      z.object({
        panel: z.string().trim().min(1).max(40),
        heading: z.string().trim().min(1).max(120),
        prose: z.string().trim().min(1).max(1200),
      }),
    )
    .min(1)
    .max(12),
});

export interface ArtifactPanel {
  /** `p1`, `p2`, … — what a section names. */
  id: string;
  title: string;
  chart: PanelChart;
  plan: RecordQueryPlan;
  table: string;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  /** `table:id` or `table:col=value` per row — what the panel cites. */
  cites: string[];
  sql: string;
  confidential: boolean;
  /** Set when the record held nothing matching, so the panel says so instead of showing a blank. */
  note: string | null;
}

export interface ArtifactSection {
  heading: string;
  prose: string;
  panel_id: string | null;
}

export interface ArtifactAbout {
  company_id: string | null;
  opportunity_id: string | null;
  meeting_id: string | null;
  fund_id: string | null;
  lp_record_id: string | null;
  /** What the object is called, resolved when the artifact is built, so the title slide can say it. */
  label: string;
}

export interface ArtifactSpec {
  kind: ArtifactKind;
  title: string;
  brief: string;
  about: ArtifactAbout;
  built_by: string;
  built_at: string;
  version_no: number;
  /** One line above the findings, written by the model for a deck or a document; null on a dashboard. */
  summary: string | null;
  panels: ArtifactPanel[];
  sections: ArtifactSection[];
  /** The union of every panel's cites, deduplicated — the sources slide / the sources section. */
  sources: string[];
}

/** Whether a build still moves. */
export function isTerminal(state: string): boolean {
  return state === "READY" || state === "FAILED";
}

/** The state of a build, in the words the row wears. */
export function stateInWords(input: { state: string; stage: string | null; error_message?: string | null }): string {
  switch (input.state) {
    case "REQUESTED":
      return "requested — waiting its turn";
    case "BUILDING":
      return `building — ${input.stage && (STAGE_WORDS as Record<string, string>)[input.stage] ? STAGE_WORDS[input.stage as ArtifactStage] : "starting"}`;
    case "READY":
      return "ready";
    case "FAILED":
      return `failed — ${input.error_message ?? "the build stopped without saying why"}`;
    default:
      return input.state.toLowerCase();
  }
}

/**
 * Which of the five "about" columns an object id belongs on, from the prefix every id in this
 * system carries. `cc_` companies, `opp_` deals, `mtg_` meetings, `fund_` funds, `lpr_` LPs.
 */
export function aboutColumnFor(objectId: string): keyof Omit<ArtifactAbout, "label"> | null {
  if (/^cc_/.test(objectId)) return "company_id";
  if (/^opp_/.test(objectId)) return "opportunity_id";
  if (/^mtg_/.test(objectId)) return "meeting_id";
  if (/^fund_/.test(objectId)) return "fund_id";
  if (/^lpr_/.test(objectId)) return "lp_record_id";
  return null;
}

/** The words the room and the card recognise as a request to build one of the three kinds. */
export function kindFromWords(text: string): ArtifactKind | null {
  const t = text.toLowerCase();
  if (/\b(dashboard|dash board)\b/.test(t)) return "dashboard";
  if (/\b(deck|slides?|slide deck|presentation)\b/.test(t)) return "deck";
  if (/\b(one[- ]?pager|memo|document|write[- ]?up)\b/.test(t)) return "document";
  return null;
}

/** The kind words, as one alternation, for the recognisers below. Kept beside `kindFromWords` so they cannot drift. */
const KIND_WORD = "(?:dashboard|dash board|deck|slides?|slide deck|presentation|one[- ]?pager|memo|document|write[- ]?up)";

/**
 * Recognise "Wyatt, build me a one-pager on the Sensori round" for what it is, from her words on
 * the card. Deterministic and cheap; the model's turn comes in `steerFor`, which reads the same
 * words before any stage runs and can still stop the build.
 */
export function artifactAskFromWords(text: string): { kind: ArtifactKind } | null {
  const t = text.trim();
  // A build verb, then within a few words the thing to build: "build me a one-pager", "make this a
  // dashboard", "turn these into a deck", "put together a memo". "Review their deck" is not an ask.
  const ask = new RegExp(`\\b(?:build|make|put together|prepare|write|draft|create|turn|give me)\\b(?:\\s+(?:me|us))?(?:\\s+(?:this|that|these|those|it|them))?(?:\\s+into)?(?:\\s+(?:a|an|the|one|quick|short|new))*\\s+${KIND_WORD}\\b`, "i");
  const m = ask.exec(t);
  if (!m) return null;
  const kind = kindFromWords(m[0]);
  return kind ? { kind } : null;
}

