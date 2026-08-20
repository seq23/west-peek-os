/**
 * Writing the thesis sentence from the fields underneath it.
 *
 * OPERATOR DIRECTION: "we be able to edit and refresh and get a new thesis that spits out in nice
 * font". The fields already say everything — sectors, stage, cheque size, target ownership, what is
 * excluded — and turning that into one sentence a person would actually say is a language task, not
 * a template. A template produces "West Peek invests in AI, health tech at pre-seed, seed with
 * cheques of $250,000 to $750,000", which is a data dump wearing a sentence's punctuation.
 *
 * IT PROPOSES, IT DOES NOT SAVE. The sentence lands in the field for the partner to edit and then
 * save as a version like any other. A model silently rewriting the firm's mandate would be putting
 * words in two partners' mouths on the one document an LP is most likely to read.
 *
 * NOTHING IS INVENTED. The prompt is explicit that every fact must come from the fields given — a
 * thesis statement mentioning a sector the firm did not list is worse than no statement, because it
 * will be believed.
 */

export const THESIS_PROMPT_VERSION = "thesis-statement-v2-lp";

export interface ThesisInputs {
  fundName: string;
  sectors: readonly string[];
  stage: readonly string[];
  geography: readonly string[];
  crossCuttingFilter: string | null;
  checkMinUsd: number | null;
  checkMaxUsd: number | null;
  targetOwnershipPct: number | null;
  targetPositions: number | null;
  openQuestion: string | null;
}

function usd(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}m`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}k`;
  return `$${n}`;
}

export function buildStatementPrompt(input: ThesisInputs): string {
  const facts: string[] = [];
  if (input.sectors.length) facts.push(`Sectors: ${input.sectors.join(", ")}`);
  if (input.stage.length) facts.push(`Stage: ${input.stage.join(", ")}`);
  if (input.geography.length) facts.push(`Geography: ${input.geography.join(", ")}`);
  if (input.crossCuttingFilter) facts.push(`Applied across every sector: ${input.crossCuttingFilter}`);
  const lo = usd(input.checkMinUsd);
  const hi = usd(input.checkMaxUsd);
  if (lo && hi) facts.push(`Initial cheque: ${lo} to ${hi}`);
  else if (lo) facts.push(`Initial cheque: from ${lo}`);
  if (input.targetOwnershipPct !== null) facts.push(`Target ownership: ${input.targetOwnershipPct}%`);
  if (input.targetPositions !== null) facts.push(`Target positions in the fund: ${input.targetPositions}`);
  if (input.openQuestion) facts.push(`Still unresolved: ${input.openQuestion}`);

  return [
    `You are writing the investment thesis statement for ${input.fundName}, an earliest-stage`,
    "venture fund raising its first institutional fund.",
    "",
    "WHO READS IT. A limited partner deciding whether this firm is worth a meeting. They have read",
    "several hundred of these, and almost all of them said nothing — which means the bar is not",
    "eloquence, it is whether the sentence could be false. An LP is scanning for one thing: does this",
    "firm have a specific view, or an appetite dressed as a view?",
    "",
    "WHAT MAKES ONE WORK, and all three of these are about specificity rather than style:",
    "- It could be wrong. 'We back exceptional founders building category-defining companies' cannot",
    "  be wrong, which is why it persuades nobody. A thesis names something another reasonable",
    "  investor would decline to back.",
    "- It says what this firm sees that the market has not priced yet. Not a claim of being better",
    "  at the same job — a claim about where they are looking.",
    "- It shows discipline, not just appetite. What is excluded is as informative as what is in, and",
    "  an LP reads the exclusion as evidence there is a real filter behind the cheque.",
    "",
    "THE FIELDS THE PARTNERS HAVE FILLED IN:",
    ...facts.map((f) => `  ${f}`),
    "",
    "RULES:",
    "- Use ONLY the facts above. Do not add a sector, a stage, a geography or a conviction that is",
    "  not listed, and do not invent an edge the partners have not claimed. An invented detail in a",
    "  thesis will be believed, repeated, and eventually asked about in diligence.",
    "- One or two sentences. No preamble, no heading, no quotation marks, no sign-off.",
    "- Write what the firm BACKS. Naming the thing beats 'we invest in' every time.",
    "- Do not recite the numbers back. Cheque size and ownership sit on the page beneath this",
    "  sentence; include one only if it genuinely carries the idea — a concentrated fund of twenty",
    "  positions is a statement about conviction, whereas a cheque range is just a number.",
    "- Plain words. An LP discounts a manager who writes like a press release.",
    "- Banned outright, because they are the exact phrases that make a first-time manager sound like",
    "  every other first-time manager: category-defining, transformative, the future of, paradigm,",
    "  disruptive, world-class, best-in-class, at the intersection of, mission-driven, we partner",
    "  with exceptional founders, outsized returns, venture-scale outcomes.",
    "- Never claim a track record, a proprietary network, or unique access. Those are diligence",
    "  claims, and asserting one the partners did not write is the worst thing this can do.",
    "- If the fields are too thin to say anything true and specific, say exactly:",
    "  NOT_ENOUGH — and then name which field would make the difference.",
    "",
    "Return only the sentence.",
  ].join("\n");
}

/**
 * Read the model's answer back.
 *
 * Returns the refusal rather than a sentence when it declined, so the page can say which field to
 * fill in instead of saving a refusal into the firm's mandate.
 */
export function parseStatement(raw: string): { statement: string } | { needs: string } | null {
  const text = raw.trim().replace(/^["'“]|["'”]$/g, "").trim();
  if (!text) return null;
  if (text.startsWith("NOT_ENOUGH")) {
    const needs = text.replace(/^NOT_ENOUGH\s*[—:-]?\s*/, "").trim();
    return { needs: needs || "more of the fields below" };
  }
  // A "sentence" of 600 characters is a paragraph, and a thesis that does not fit on the banner is
  // not doing the job the banner exists for.
  if (text.length > 600) return { statement: text.slice(0, 600).trim() };
  return { statement: text };
}
