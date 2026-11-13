/**
 * EVERY ASK IS BUILT IN THE JOB, OR THE PARTNER IS ASKED. NOTHING ELSE. (Owner ruling, 13 Nov 2026,
 * #363: "he needs to never silently drop things we ask for and move them around.")
 *
 * A partner asked for a website and a dashboard in one email. The plan built the website and, on its
 * own judgement, moved the dashboard to "17 Nov, its own card". The partner had dated nothing. These
 * are the rules a plan is held to before the OS accepts it; a plan that breaks one is REFUSED (a
 * failed attempt that says why) and planned again with the ask included. Pure, so both the Worker
 * and the tests read the same law.
 *
 *   1 · PER-ASK ACCOUNTING. The plan lists each thing the partner asked for (`accounting`), and each
 *       line is `build` (done in this job), `question` (the partner is asked, in the plan's `asks`),
 *       or `later` (see 2). No list, an empty list, or any other fate → refused.
 *   2 · `later` AND `deferred` ARE ONLY FOR WORK THE PARTNER DATED. Each deferred item must quote the
 *       partner's own words, those words must be words the partner actually wrote (the request, their
 *       replies, a file they shared), and they must say WHEN. An employee never dates, re-dates,
 *       splits off or re-scopes an ask by itself.
 *
 * WHAT THIS CANNOT SEE: whether the list is complete. An ask the plan never mentions is caught only
 * by the list being the plan's stated contract, which the partner and the card can read.
 */
export interface AskLine {
  ask: string;
  how: string;
}

export interface DeferredLine {
  ask: string;
  due_at: string;
  words?: string | null;
}

/** Words that say WHEN: a date, a weekday, a month, "next week", "later", "after the launch". */
const SAYS_WHEN =
  /\b(?:later|tomorrow|eventually|for now|not yet|down the road|next\s+(?:week|month|quarter|year|sprint)|(?:the\s+)?(?:week|month)\s+(?:after|of)|after\s+(?:the|we|that|this|launch|it)|in\s+(?:a|an|one|two|three|four|five|six|\d+)\s+(?:days?|weeks?|months?)|(?:mon|tues|wednes|thurs|fri|satur|sun)day|january|february|march|april|june|july|august|september|october|november|december|(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)\.?\s+\d{1,2}|\d{1,2}\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)|\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}|phase\s+(?:2|two|ii)|v2|second phase)\b/i;

const tokens = (s: string | null | undefined): string[] => String(s ?? "").toLowerCase().normalize("NFKD").match(/[a-z0-9]+/g) ?? [];

/** Are these words the partner's own? Every word of the quote appears in what the partner wrote. */
export function partnerWrote(words: string | null | undefined, partnerText: string): boolean {
  const quote = tokens(words);
  if (quote.length < 2) return false;
  const said = new Set(tokens(partnerText));
  return quote.every((t) => said.has(t));
}

/** Did the PARTNER date this work for later, in their own words? */
export function partnerDated(d: DeferredLine, partnerText: string): boolean {
  return SAYS_WHEN.test(String(d.words ?? "")) && partnerWrote(d.words, partnerText);
}

/** Why this plan cannot be accepted, in plain words; empty when it can. */
export function planProblems(input: { partnerText: string; accounting?: readonly AskLine[] | null; asks?: ReadonlyArray<unknown> | null; deferred?: readonly DeferredLine[] | null }): string[] {
  const problems: string[] = [];
  const deferred = input.deferred ?? [];
  const undated = deferred.filter((d) => !partnerDated(d, input.partnerText));
  for (const d of undated) {
    problems.push(`it put "${String(d.ask).slice(0, 120)}" off to ${String(d.due_at).slice(0, 10) || "later"}, but the partner did not date that for later in their own words`);
  }
  const lines = input.accounting ?? [];
  if (lines.length === 0) {
    problems.push("it did not account for each thing the partner asked for (no `accounting` list)");
    return problems;
  }
  const datedCount = deferred.length - undated.length;
  let later = 0;
  for (const l of lines) {
    const how = String(l.how ?? "").toLowerCase();
    const what = `"${String(l.ask ?? "").slice(0, 120)}"`;
    if (!String(l.ask ?? "").trim()) problems.push("an `accounting` line names no ask");
    else if (how === "build") continue;
    else if (how === "question") {
      if ((input.asks ?? []).length === 0) problems.push(`${what} is marked as a question, but the plan asks the partner nothing`);
    } else if (how === "later") later++;
    else problems.push(`${what} is neither built in this job nor asked about (it says "${how.slice(0, 40) || "nothing"}")`);
  }
  if (later > datedCount) problems.push(`${later} ask${later === 1 ? " is" : "s are"} marked "later" without the partner's own dated words behind ${later === 1 ? "it" : "each"}`);
  return problems;
}

/** The line a refused plan leaves on the card and hands to the next PLAN. */
export function refusalLine(problems: readonly string[]): string {
  return `PLAN REFUSED — every ask is built in this job or the partner is asked, nothing else: ${problems.join("; ")}. Plan again with every ask included: build it now, or put it to the partner as a question with your recommendation.`;
}
