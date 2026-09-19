import type { GuideAct, GuideStep, GuideWalkthrough, PageGuide } from "./types";

/**
 * The guide, spoken.
 *
 * ONE RENDERER FOR TWO PLACES. The host card's answer to "how does this page work" and the page's
 * section on the Help tab are the same text from the same guide, so they cannot disagree — the
 * disease this replaces was three descriptions of Meetings (the purpose block, the host's prompt,
 * the Help Center) each true on a different day.
 *
 * THE SHAPE, and why it is fixed: a one-line purpose; the bands, numbered, top to bottom, so the
 * reader's eye can walk the page as they read; the acts as bullets with the control name in bold,
 * the human act first; what runs on its own; where the rest lives. Nothing is a paragraph. The
 * owner's report was that the old answer was "all jumbled" — one paragraph with three bolded
 * phrases — and a fixed shape is the only thing that cannot become that.
 */

/** Primary acts first, then the rest in page order — the human act is the one they came to find. */
export function actsInSpeakingOrder(acts: readonly GuideAct[]): GuideAct[] {
  return [...acts.filter((a) => a.primary), ...acts.filter((a) => !a.primary)];
}

function actLine(a: GuideAct): string {
  const tail = [a.then, a.who ? `(${a.who})` : ""].filter(Boolean).join(" ");
  return `- **${a.label}** — ${a.does}${tail ? ` ${tail}` : ""}`;
}

/**
 * The full guide as Markdown — every band, every act, every job, every link. This is what the Help
 * tab shows and what the host says when asked how the page works.
 */
export function renderGuideMarkdown(g: PageGuide): string {
  const lines: string[] = [];
  lines.push(`**${g.title}.** ${g.purpose}`);
  if (g.archived) lines.push("", g.archived);

  if (g.bands.length > 0) {
    lines.push("", "## What you see, top to bottom");
    g.bands.forEach((b, i) => lines.push(`${i + 1}. **${b.name}** — ${b.shows}`));
  }

  if (g.acts.length > 0) {
    lines.push("", "## What you can do here");
    for (const a of actsInSpeakingOrder(g.acts)) lines.push(actLine(a));
  }

  if (g.auto.length > 0) {
    lines.push("", "## What happens on its own");
    for (const j of g.auto) lines.push(`- ${j.what} — ${j.when}.`);
  }

  if (g.elsewhere.length > 0) {
    lines.push("", "## Where the rest lives");
    for (const l of g.elsewhere) lines.push(`- **${titleOf(l.page)}** — ${l.why}`);
  }
  return lines.join("\n");
}

/**
 * The same guide as the host's answer: a one-line opener in their name, then the guide. Nothing
 * is shortened, because the test that guards this asserts every act in the spec is in the answer,
 * and a page with twelve controls is a page with twelve controls — the shape is what keeps it
 * readable on a phone, not the length.
 */
export function renderGuideAnswer(g: PageGuide): string {
  return `This is how ${g.title} works, top to bottom.\n\n${renderGuideMarkdown(g)}`;
}

// ── The walkthrough ───────────────────────────────────────────────────────────────────────────

/**
 * "WALK ME THROUGH A REAL MEETING" — the scenario, step by step, from the guide and not from the
 * host's memory (owner, 19 Sep 2026: she asked Walter to walk her through a fake meeting and "he
 * skipped over the screen I get to when I open the room and can seat AI employees … these
 * responses are not enough"). A model walking a page from a description skips steps and invents
 * others; a walkthrough written once, with every bold control checked against the page, does
 * neither. One numbered list per scenario; the step says what you do, what happens next, and what
 * does NOT happen.
 */
function stepLine(i: number, s: GuideStep): string {
  const not = s.not ? ` What does not happen: ${s.not}` : "";
  return `${i + 1}. ${s.do}${s.then ? ` — ${s.then}` : ""}${not}`;
}

export function renderWalkthroughMarkdown(g: PageGuide): string {
  const lines: string[] = [];
  g.walkthroughs.forEach((w: GuideWalkthrough, k) => {
    if (k > 0) lines.push("");
    lines.push(`## ${w.scenario}`);
    w.steps.forEach((s, i) => lines.push(stepLine(i, s)));
  });
  return lines.join("\n");
}

export function renderWalkthroughAnswer(g: PageGuide): string {
  const one = g.walkthroughs.length === 1;
  return `Here is how you would use ${g.title}, start to finish${one ? "" : ` — ${g.walkthroughs.length} scenarios`}.\n\n${renderWalkthroughMarkdown(g)}`;
}

// ── The buttons, by band ──────────────────────────────────────────────────────────────────────

/**
 * "EXPLAIN WHAT ALL OF THE BUTTONS DO" — every act, grouped by the band it sits in, in page order.
 * On Meetings that is by face. An act with no band is listed last under the page's own name. The
 * same acts as the guide, re-cut; nothing here is written twice.
 */
export function actsByBand(g: PageGuide): Array<{ band: string; acts: GuideAct[] }> {
  const out: Array<{ band: string; acts: GuideAct[] }> = [];
  for (const b of g.bands) {
    const acts = g.acts.filter((a) => a.band === b.name);
    if (acts.length > 0) out.push({ band: b.name, acts: actsInSpeakingOrder(acts) });
  }
  const loose = g.acts.filter((a) => !a.band || !g.bands.some((b) => b.name === a.band));
  if (loose.length > 0) out.push({ band: out.length === 0 ? `On ${g.title}` : "Elsewhere on the page", acts: actsInSpeakingOrder(loose) });
  return out;
}

export function renderButtonsMarkdown(g: PageGuide): string {
  const lines: string[] = [];
  actsByBand(g).forEach((group, k) => {
    if (k > 0) lines.push("");
    lines.push(`## ${group.band}`);
    for (const a of group.acts) lines.push(actLine(a));
  });
  return lines.join("\n");
}

export function renderButtonsAnswer(g: PageGuide): string {
  return `Every control on ${g.title}, band by band.\n\n${renderButtonsMarkdown(g)}`;
}

/** Every `**bold**` span in a walkthrough, for the validator: each must be an act or a band. */
export function boldSpans(text: string): string[] {
  return [...text.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => m[1]!);
}

/**
 * Nav key → the name the nav shows. Kept here rather than imported from App.tsx (client code) so
 * the worker can speak it. `tests/pageGuide.test.ts` reads App.tsx and fails if these drift.
 */
export const NAV_TITLES: Readonly<Record<string, string>> = {
  home: "Home",
  intent: "Ask",
  capture: "Capture",
  approvals: "Approvals",
  work: "Work",
  notifications: "Notifications",
  thesis: "Thesis",
  dealflow: "Dealflow",
  companies: "Companies",
  meetings: "Meetings",
  secondaries: "Secondaries",
  portfolio: "Portfolio",
  "fund-strategy": "Fund strategy",
  lp: "LP",
  rooms: "Events & Rooms",
  community: "Community",
  employees: "Employees",
  record: "Record",
  research: "Research",
  university: "University",
  documents: "Documents",
  cockpit: "Cockpit",
  "ai-controls": "AI controls",
  "sources-and-sweeps": "Sources & sweeps",
  machines: "Machines",
  governance: "Governance",
  contradictions: "Contradictions",
  "cross-office": "Cross-office",
  activity: "Activity",
  integrations: "Integrations",
  network: "Network OS",
  diagnostics: "Diagnostics",
  setup: "Set up",
  help: "Help",
};

export function titleOf(navKey: string): string {
  return NAV_TITLES[navKey] ?? navKey;
}

/**
 * THREE QUESTIONS THE GUIDE ANSWERS VERBATIM, matched here deterministically rather than left to
 * the model, because for these three any paraphrase is the failure being fixed:
 *
 *   how          "how does this page work"          → the guide, top to bottom
 *   walkthrough  "walk me through a real meeting"   → the scenario, step by step
 *   buttons      "explain what all of the buttons do" → every act, grouped by band
 *
 * Phrasings a person uses when standing on a page, including the owner's own words from 19 Sep
 * 2026. A question about a specific control ("what does Move it do") or about the firm's data is
 * NONE of these and goes to the host with the guide as context. `buttons` is tried first because
 * "explain the buttons on this page" would otherwise read as "explain this page"; `walkthrough`
 * before `how` for the same reason.
 */
export type GuideIntent = "how" | "walkthrough" | "buttons";

const BUTTONS = [
  /\b(explain|describe|tell me|list|go through|run through|walk me through)( me)?( what)? (all (of )?)?(the |these |every |each )?(buttons?|controls?)\b/,
  /\bwhat (are|do|does|is) (all (of )?)?(the|these|every|each|those) (buttons?|controls?)( here| do| mean| for| on this page)?\b/,
  /\bwhat (does|do) (each|every|all the|all of the) (button|control)s? (do|mean)\b/,
  /\b(buttons?|controls?) (explained|by (band|face|section))\b/,
  /\bexplain (each|every) (button|control)\b/,
];

const WALKTHROUGH = [
  /\bwalk me through\b/,
  /\b(take|run|talk|guide) me through\b/,
  /\bshow me how (i|i'd|i would|you'd|you would|to|one would) (use|run|do|work)\b/,
  /\bhow (would|do|should) i (actually )?(use|run|work) (this|it|the page|a (real )?meeting)\b/,
  /\b(a |an )?(scenario|example|dry run|worked example|walkthrough|walk-through|start to finish|step by step|end to end)\b/,
  /\bpretend (i|we)\b/,
  /\bfake (meeting|call|deal|run)\b/,
  /\bwhat would (i|we) (actually )?do (here|on this page|first|step by step)\b/,
];

const HOW_IT_WORKS = [
  /\bhow (does|do|did) (this|the|that) (page|tab|screen|thing|surface|view)( even)?( work|function|operate)?\b/,
  /\bhow (does|do) (this|it|everything|stuff|things?) (all )?work( here| now)?\b/,
  /\bhow (do i|to|should i|can i) (use|work|read|navigate) (this|the) (page|tab|screen)\b/,
  /\bwhat (is|does|do) (this|the) (page|tab|screen) (for|do|about|show)\b/,
  /\bwhat('s| is) (this|here|on this page)\b/,
  /\bwhat can i do (here|on this page|on this tab)\b/,
  /\b(explain|describe|show me|teach me|tell me about) (this|the) (page|tab|screen)\b/,
  /\bwhat (are|do) (the|these|all the) (bands|sections|faces)( here| do| mean| for)?\b/,
  /\bhow (does|do) (this|the) (page|tab)( work)? now\b/,
  /\bpage instructions\b/,
  /\bwhat changed (here|on this page)\b/,
];

function normalise(message: string): string {
  return message.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
}

export function guideIntent(message: string): GuideIntent | null {
  const m = normalise(message);
  if (BUTTONS.some((re) => re.test(m))) return "buttons";
  if (WALKTHROUGH.some((re) => re.test(m))) return "walkthrough";
  if (HOW_IT_WORKS.some((re) => re.test(m))) return "how";
  return null;
}

export function asksHowThePageWorks(message: string): boolean {
  return guideIntent(message) === "how";
}

/** The verbatim answer for a guide intent — no model, no paraphrase. */
export function renderIntentAnswer(g: PageGuide, intent: GuideIntent): string {
  switch (intent) {
    case "how": return renderGuideAnswer(g);
    case "walkthrough": return renderWalkthroughAnswer(g);
    case "buttons": return renderButtonsAnswer(g);
  }
}
