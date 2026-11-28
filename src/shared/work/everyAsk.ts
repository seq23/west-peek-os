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
 *       unless the fresh-eyes review ruled it held (`review_holds`, below) or a list proves what holds it.
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
  note?: string | null;
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

/*
 * WHO SAYS AN UNMET CHECK IS NOT THE BUILDER'S TO FINISH: THE FRESH-EYES REVIEW, NEVER A KEYWORD (partner tail,
 * 28 Nov 2026, wc_9f7312e4). Scooter asked for homepage items 1-7 and said "I don't want one to hold up the other".
 * The BUILD finished them and reported two checks it could not meet in this repo ("form answers deleted after 24
 * months": the site keeps none, they live in Network OS; "a Give and Take screen inside Network OS": another repo),
 * each put to him with a recommendation. The bar refused the whole build, so his homepage preview never came.
 * It was the SIXTH phrasing the keyword exceptions misread, after five patches: "we will…/I approve" (14 Nov),
 * "until I send it" (17 Nov, #476), "its own item after this" (18 Nov, #502), "after the merge / on production"
 * (19 Nov, #526), "RUNBOOK_FORBIDS" (19 Nov, #537). Patch twice → rebuild, so the meaning is now read by a model.
 *
 * THE LAW. The review (a second model turn in a fresh context, not the builder) rules on every unmet check in the
 * builder's result: `held: true` with `by` = partner | landing | another_job | runbook and a plain `why`, or
 * `held: false` (the builder could finish it here, so it goes back to the builder as a blocking finding). The runner
 * writes the review's rulings onto the report as `review_holds`, overwriting anything the builder wrote there. Code
 * only checks structure: an unmet check passes when a held ruling names it, or when a list proves what holds it
 * (`missing_secret` with a key in `missing_secrets`, `missing_material` with a file in `missing_materials`,
 * `partner_dated`, which the plan check ties to his own dated words). An unmet check nobody ruled on is refused.
 */
export const HOLD_BY = ["partner", "landing", "another_job", "runbook"] as const;
export type HoldBy = (typeof HOLD_BY)[number];
/** The `check` a ruling carries for an item reported not done although every check is met. */
export const ITEM_STATE = "state";
export interface ReviewHold {
  item: string;
  check: string;
  held: boolean;
  by?: HoldBy | string | null;
  why?: string | null;
  /** For `another_job`: the open card that already carries this work (one of the build's OTHER OPEN JOBS). */
  on_card?: string | null;
}

const norm = (s: string | null | undefined): string => tokens(s).join(" ");
/** Same text, allowing one side to be the other cut short (the runner bounds both at 200 characters). */
function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 24 && long.startsWith(short);
}

/** The review's ruling on this item's check, or null when the review ruled on it nowhere. */
export function reviewRuling(holds: readonly ReviewHold[] | null | undefined, item: string, check: string): ReviewHold | null {
  return (holds ?? []).find((h) => sameText(h.item, item) && sameText(h.check, check)) ?? null;
}

const heldBy = (h: ReviewHold | null): h is ReviewHold => Boolean(h && h.held === true && (HOLD_BY as readonly string[]).includes(String(h.by ?? "")) && String(h.why ?? "").trim());

/**
 * The BUILD items the review ruled are another job's (another repo, or split off by him or an approved answer): filed as
 * their own site job, never dropped, UNLESS the review named the open card that already carries them (`on_card`; 28 Nov
 * 2026, wc_9f7312e4: 8h and 8i were already on the Network OS card wc_e1d13d5c, and filing them again opened two
 * duplicate cards that would have planned and emailed Scooter a second time).
 */
export function splitOffItems(items: readonly DoneItem[] | null | undefined, holds: readonly ReviewHold[] | null | undefined): Array<{ item: string; words: string; on_card: string | null }> {
  const out: Array<{ item: string; words: string; on_card: string | null }> = [];
  for (const i of items ?? []) {
    if (i.state === "done") continue;
    const unmet = (i.done_when ?? []).filter((c) => String(c?.check ?? "").trim() && c.met !== true);
    if (!unmet.length) continue;
    const rulings = unmet.map((c) => reviewRuling(holds, i.item, c.check));
    if (rulings.every((r) => heldBy(r) && r.by === "another_job")) {
      const on = rulings.map((r) => String(r?.on_card ?? "")).find((c) => /^wc_[A-Za-z0-9-]+$/.test(c)) ?? null;
      out.push({ item: String(i.item ?? ""), words: String(rulings[0]!.why).slice(0, 300), on_card: on });
    }
  }
  return out;
}

/** Why this BUILD is not finished, in plain words; empty when it is. */
export function buildProblems(input: { items?: readonly DoneItem[] | null; missingSecrets?: number; missingMaterials?: number; reviewHolds?: readonly ReviewHold[] | null }): string[] {
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
    if (unmet.length === 0) {
      // Every check met but reported "partial" / "not_done": the review rules on the item itself (`check: "state"`).
      if (i.state === "done" || heldBy(reviewRuling(input.reviewHolds, i.item, ITEM_STATE))) continue;
      problems.push(`${what} is not finished (its state is "${String(i.state).slice(0, 20)}"${reviewRuling(input.reviewHolds, i.item, ITEM_STATE) ? "" : " and the review ruled on it nowhere"})`);
      continue;
    }
    const by = String(i.blocked_by ?? "");
    const listed = (by === "missing_secret" && (input.missingSecrets ?? 0) > 0) || (by === "missing_material" && (input.missingMaterials ?? 0) > 0) || by === "partner_dated";
    if (listed) continue;
    const open = unmet.filter((c) => !heldBy(reviewRuling(input.reviewHolds, i.item, c.check)));
    if (open.length === 0) continue;
    const said = open.map((c) => {
      const r = reviewRuling(input.reviewHolds, i.item, c.check);
      return `${c.check.slice(0, 80)}${r ? (r.held === false ? " (the review: the build can finish it here)" : "") : " (the review ruled on it nowhere)"}`;
    });
    problems.push(`${what} is not finished (${said.join(", ")})${by ? ` and "${by.slice(0, 40)}" is not something only the partner can supply` : ""}`);
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
