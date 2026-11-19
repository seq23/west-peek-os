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
 *   3 · EVERY BUILT ASK SAYS WHEN IT IS DONE (owner's v1.0 bar, 13 Nov 2026: builds come out "v1.0 final with
 *       persistence and veteran UX/UI POV", not v0.1). A `build` line carries `done_when`: the checks that make it
 *       finished (real data source, survives a reload and a second device, sign-in, empty and error states, help,
 *       phone first). A BUILD reports each item against its checks (`buildProblems`); a check not met is refused
 *       unless something only the partner can supply is what holds it (a key, a file) or the partner dated it.
 *
 * WHAT THIS CANNOT SEE: whether the list is complete. An ask the plan never mentions is caught only
 * by the list being the plan's stated contract, which the partner and the card can read.
 */
export interface AskLine {
  ask: string;
  how: string;
  /** For a `build` line: the checks that make this ask finished (the prompt's "Definition of done"). */
  done_when?: readonly string[] | null;
}

/** One BUILD item, reported against the checks its plan line set. */
export interface DoneItem {
  item: string;
  state: string;
  done_when?: ReadonlyArray<{ check: string; met: boolean; note?: string }> | null;
  /** Why an item is not finished: only what the partner alone can supply, or work they dated themselves. */
  blocked_by?: string | null;
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
    else if (how === "build") {
      if (!(l.done_when ?? []).some((c) => String(c ?? "").trim())) problems.push(`${what} is to be built, but the plan does not say when it is done (no \`done_when\` checks)`);
    }
    else if (how === "question") {
      if ((input.asks ?? []).length === 0) problems.push(`${what} is marked as a question, but the plan asks the partner nothing`);
    } else if (how === "later") later++;
    else problems.push(`${what} is neither built in this job nor asked about (it says "${how.slice(0, 40) || "nothing"}")`);
  }
  if (later > datedCount) problems.push(`${later} ask${later === 1 ? " is" : "s are"} marked "later" without the partner's own dated words behind ${later === 1 ? "it" : "each"}`);
  return problems;
}

/**
 * Why this BUILD is not finished, in plain words; empty when it is. Every item reports its `done_when`
 * checks; each must be met. An item that is not met is accepted only when it is held by something the
 * partner alone can supply AND the report names it (`missing_secret` with a missing key listed,
 * `missing_material` with a missing file listed), or by work the partner dated (`partner_dated`; the
 * plan check already holds the dating to their words). Never a silent "partial".
 */
/**
 * A STEP THE PARTNER KEPT FOR HIMSELF IS HIS, NOT UNFINISHED WORK (partner tail, 14 Nov 2026). Scooter's brief said
 * "We will walk the rules before any money view ships" and "I approve each step". The BUILD did all seven asks and
 * reported the one check only he can meet ("walk the rules with Scooter") as not met, quoting him; the v1.0 bar
 * refused it as unfinished, no preview went to him, and the retries could only fail the same way. A check is held by
 * the partner when its note quotes words he actually wrote AND those words reserve the step to him ("we will…",
 * "I will…", "I approve…", "not … yet", "when I am ready").
 */
/*
 * 17 Nov 2026 (wc_c548d043): Scooter wrote "I'm working on the copy separately, so leave placeholders until I send it."
 * The BUILD did exactly that and reported the check as not met, quoting him; none of the phrases above matched
 * ("until I send it", "I'm working on"), so a finished build was REFUSED and retried on its last attempts. Words
 * that keep the next step for him until HE sends, shares or confirms something reserve it as well. And a quote's
 * own apostrophes ("I'm") no longer cut it short: single quotes count as quote marks only outside a word.
 */
const RESERVES_A_STEP = /\b(?:i|we)(?:'ll|\s+will)\b|\bi\s+approve\b|\bnot\b[^.]{0,60}\byet\b|\bwhen\s+(?:i|we)(?:'m|'re|\s+am|\s+are)?\s+ready\b|\b(?:wait|waits)\s+(?:for|on)\s+me\b|\buntil\s+(?:i|we)\s+(?:send|share|give|confirm|say|provide|write|approve|decide|tell)\b|\b(?:i|we)(?:'m|'re|\s+am|\s+are)\s+(?:working\s+on|writing|drafting)\b/i;
const QUOTED = /[\u201C"]([^"\u201D]{8,400})[\u201D"]|(?<![\p{L}\d])['\u2018]((?:[^'\u2018\u2019]|(?<=\p{L})['\u2019](?=\p{L})){8,400}?)['\u2019](?![\p{L}\d])/gu;
export function partnerReserved(note: string | null | undefined, partnerText: string): boolean {
  for (const m of String(note ?? "").matchAll(QUOTED)) {
    const quote = (m[1] ?? m[2])!;
    if (RESERVES_A_STEP.test(quote) && partnerWrote(quote, partnerText)) return true;
  }
  return false;
}

/*
 * AN ITEM THE APPROVED ANSWER SPLIT OFF IS ITS OWN JOB, NOT THIS BUILD'S (partner tail, 18 Nov 2026, wc_d4b961bc).
 * Porter's GA4 plan asked "Add privacy pages?" and recommended "Yes, as its own item after this: the GA tags go live
 * now; drafted privacy wording comes to you on its own preview". That answer was adopted. The BUILD did the GA work
 * and reported the privacy item unmet, quoting the answer; the v1.0 bar refused the finished build and told the next
 * attempt (the card's last) to draft privacy pages inside the GA job, against the answer. Words in the partner's text
 * or the approved answers that send the item to its own item / card / job / preview, or "separately", split it off:
 * the build is judged without it and the OS files it as its own site job (`splitOffItems`), so it is never dropped.
 */
const SPLITS_OFF = /\b(?:its|their|a)\s+own\s+(?:item|card|job|pr|preview|piece|task)\b|\bseparately\b|\bas\s+a\s+separate\s+(?:item|card|job|pr|task)\b/i;
function quoteSplitsOff(note: string | null | undefined, partnerText: string): string | null {
  for (const m of String(note ?? "").matchAll(QUOTED)) {
    const quote = (m[1] ?? m[2])!;
    if (SPLITS_OFF.test(quote) && partnerWrote(quote, partnerText)) return quote;
  }
  return null;
}

/** The BUILD items an approved answer or the partner split off as their own job, with the words that did it. */
export function splitOffItems(items: readonly DoneItem[] | null | undefined, partnerText: string | undefined): Array<{ item: string; words: string }> {
  if (!partnerText) return [];
  const out: Array<{ item: string; words: string }> = [];
  for (const i of items ?? []) {
    if (i.state === "done") continue;
    const unmet = (i.done_when ?? []).filter((c) => String(c?.check ?? "").trim() && c.met !== true);
    if (!unmet.length) continue;
    const words = unmet.map((c) => quoteSplitsOff(c.note, partnerText));
    if (words.every((w) => w)) out.push({ item: String(i.item ?? ""), words: words[0]! });
  }
  return out;
}

/*
 * A CHECK THAT CAN ONLY BE MET AFTER THE MERGE IS LAND'S, NOT AN UNFINISHED BUILD (partner tail, 19 Nov 2026,
 * wc_c548d043). Scooter wrote "Please publish … after these final fixes … Please reply with the live links once
 * complete." The BUILD did all eight fixes and reported "Live links curled after the merge" unmet ("This belongs to
 * the LAND phase"); the v1.0 bar refused the finished build, no preview went to him, and every retry could only fail
 * the same way, because the merge waits on his "approved" to the preview. A check held by the landing itself
 * (`blocked_by: "after_land"`, or a check that names the merge, landing or the live site as its moment) is judged at
 * LAND, whose curl proof the DONE email lists as the live links.
 */
const AFTER_LAND = /\b(?:after|once|when)\b[^.;]{0,40}?\b(?:merge[ds]?|merging|land(?:s|ed|ing)?|goes\s+live|is\s+live|published|deployed)\b/i;
export function heldByLanding(check: { check?: string | null }, blockedBy?: string | null): boolean {
  return blockedBy === "after_land" || AFTER_LAND.test(String(check?.check ?? ""));
}

export function buildProblems(input: { items?: readonly DoneItem[] | null; missingSecrets?: number; missingMaterials?: number; partnerText?: string }): string[] {
  const items = input.items ?? [];
  if (items.length === 0) return ["it did not report each ask against its done-when checks (no `items` list)"];
  const problems: string[] = [];
  for (const i of items) {
    const what = `"${String(i.item ?? "").slice(0, 120)}"`;
    const checks = (i.done_when ?? []).filter((c) => String(c?.check ?? "").trim());
    const unmet = checks.filter((c) => c.met !== true);
    if (checks.length === 0) {
      problems.push(`${what} reports no done-when checks`);
      continue;
    }
    if (i.state === "done" && unmet.length === 0) continue;
    const by = String(i.blocked_by ?? "");
    const held = (by === "missing_secret" && (input.missingSecrets ?? 0) > 0) || (by === "missing_material" && (input.missingMaterials ?? 0) > 0) || by === "partner_dated";
    if (held) continue;
    if (unmet.length && unmet.every((c) => heldByLanding(c, by))) continue;
    if (unmet.length && input.partnerText && unmet.every((c) => partnerReserved(c.note, input.partnerText!))) continue;
    if (unmet.length && input.partnerText && unmet.every((c) => quoteSplitsOff(c.note, input.partnerText!))) continue;
    const named = unmet.length ? unmet.map((c) => c.check.slice(0, 80)).join(", ") : `its state is "${String(i.state).slice(0, 20)}"`;
    problems.push(`${what} is not finished (${named})${by ? ` and "${by.slice(0, 40)}" is not something only the partner can supply` : ""}`);
  }
  return problems;
}

/** The line a refused build leaves on the card and hands to the next BUILD. */
export function buildRefusalLine(problems: readonly string[]): string {
  return `BUILD REFUSED — not finished to the v1.0 bar (the prompt's Definition of done): ${problems.join("; ")}. Build again on the same branch until every done-when check is met.`;
}

/** The line a refused plan leaves on the card and hands to the next PLAN. */
export function refusalLine(problems: readonly string[]): string {
  return `PLAN REFUSED — every ask is built in this job or the partner is asked, nothing else: ${problems.join("; ")}. Plan again with every ask included: build it now, or put it to the partner as a question with your recommendation.`;
}
