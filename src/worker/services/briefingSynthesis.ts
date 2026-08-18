import type { Env } from "../env";
import type { Actor } from "./authorize";
import { runAi } from "../ai/runAi";
import type { BriefingRow, IntelligenceItemRow } from "./intelligence";

/**
 * The Daily Brief synthesis (P30).
 *
 * Turns the day's ranked items into a short written read across ALL sources, in the Managing
 * Partner's own lens — instead of a list of headlines to scan.
 *
 * Three rules shape the prompt, and they are the difference between a useful brief and a
 * confident-sounding liability:
 *
 *   ONLY THE ITEMS. The model is given the day's items and told it may use nothing else. It has no
 *   web access here; anything it "knows" is untraceable, and this system does not publish claims it
 *   cannot attribute.
 *
 *   NO INVENTED NUMBERS. Prices, valuations, round sizes and dates may only be repeated if they
 *   appear in an item. RSS carries headlines, not market data, so a brief that quotes a share price
 *   is fabricating one.
 *
 *   SAY WHEN IT IS THIN. A quiet day must read as a quiet day. Manufacturing five important
 *   developments from three minor ones is the failure mode that makes a daily product worthless.
 *
 * The output is MODEL OUTPUT and is stored with its `ai_run` id, so the cost, provider, quarantine
 * state and audit trail stay attached to the words.
 */

/** Per-GP framing. Derived from configured categories, not from a hardcoded persona. */
function lensFor(categories: string[]): string {
  const has = (c: string) => categories.includes(c);
  const angles: string[] = [];
  if (has("SECONDARIES") || has("FUNDING_MA") || has("MARKET")) {
    angles.push(
      "Read as an investor who thinks in transaction economics: what security, at what price, " +
        "why the seller is selling, and whether a headline valuation is economically meaningful.",
    );
  }
  if (has("OPPORTUNITY") || has("COMPETITOR") || has("PORTFOLIO")) {
    angles.push(
      "Read as an early-stage investor and operator: what this implies for company building, " +
        "positioning, distribution and who is winning attention.",
    );
  }
  if (has("AI_TECH")) {
    angles.push(
      "For AI and technology, prioritise developments that change economics, competitive position, " +
        "capital requirements or market structure — not product launches.",
    );
  }
  if (has("LP_SIGNAL")) {
    angles.push("Flag anything that bears on LP sentiment or fundraising conditions.");
  }
  return angles.join(" ");
}

export function buildBriefingPrompt(
  fullName: string,
  categories: string[],
  items: IntelligenceItemRow[],
  briefingDate: string,
): string {
  const lines = items.map((i, n) => {
    const when = i.published_at ? ` (${String(i.published_at).slice(0, 10)})` : "";
    const body = (i.body ?? "").replace(/\s+/g, " ").slice(0, 400);
    return `[${n + 1}] ${i.category} — ${i.title}${when}\n    ${body}\n    source: ${i.url ?? "n/a"}`;
  });

  return [
    `You are writing the Daily Brief for ${fullName}, a Managing Partner at West Peek Ventures,`,
    `an earliest-stage venture fund. Date: ${briefingDate}.`,
    "",
    lensFor(categories),
    "",
    "WRITE:",
    "1. A two-to-three sentence opening: what actually changed since yesterday. If little changed, say so plainly.",
    "2. 'What matters' — up to five items. For each: one bold line naming the development, then 1-2 sentences",
    "   on why it matters to this firm, including the second-order consequence where there is a real one.",
    "   Reference the source number in square brackets, e.g. [3].",
    "3. 'One thing to watch' — a single forward-looking observation, and what would confirm or kill it.",
    "",
    "RULES:",
    "- Use ONLY the items below. You have no other information and no web access.",
    "- Never invent a price, valuation, round size, percentage or date. Repeat one only if it appears in an item.",
    "- If the items do not support a claim, do not make it. Fewer, truer points beat five padded ones.",
    "- If today is thin, say 'Quiet day' and give only what is real.",
    "- No preamble, no sign-off, no restating these instructions. Markdown, no headings above ###.",
    "",
    `ITEMS (${items.length}):`,
    ...lines,
  ].join("\n");
}

export interface SynthesisOutcome {
  state: "READY" | "FAILED" | "REFUSED";
  markdown: string | null;
  aiRunId: string | null;
  detail: string;
}

/**
 * Synthesise one briefing. Never throws: a failed brief must degrade to the item list, not break
 * Home. The reason is always recorded so a silent blank is impossible.
 */
export async function synthesiseBriefing(
  env: Env,
  actor: Actor,
  fullName: string,
  categories: string[],
  briefing: BriefingRow,
  items: IntelligenceItemRow[],
): Promise<SynthesisOutcome> {
  if (items.length === 0) {
    return {
      state: "REFUSED",
      markdown: null,
      aiRunId: null,
      detail: "no items for this date — nothing to summarise, and a brief will not be invented from an empty day",
    };
  }

  try {
    const { run } = await runAi(env, {
      purpose: `daily brief synthesis for ${fullName} (${briefing.briefing_date})`,
      actor,
      inputs: [buildBriefingPrompt(fullName, categories, items, briefing.briefing_date)],
      // Items are PUBLIC news; the brief inherits that. Never raise this: a higher label would
      // permit sending firm-sensitive material to the provider lane.
      sensitivity: "PUBLIC",
      budgetContext: { expectedOutputTokens: 900 },
      routing: { category: "INTELLIGENCE" },
    });

    if (run.status !== "COMPLETED" || !run.output_text) {
      return {
        state: "FAILED",
        markdown: null,
        aiRunId: run.id,
        detail: run.failure_reason ?? `synthesis run ended ${run.status}`,
      };
    }
    return {
      state: "READY",
      markdown: run.output_text.trim(),
      aiRunId: run.id,
      detail: `synthesised from ${items.length} item(s)${run.model ? ` on ${run.model}` : ""}`,
    };
  } catch (err) {
    // A brief is not worth failing Home over.
    return {
      state: "FAILED",
      markdown: null,
      aiRunId: null,
      detail: `synthesis unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
