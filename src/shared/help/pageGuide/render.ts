import type { GuideAct, PageGuide } from "./types";

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
 * Is the partner asking how the page works?
 *
 * Matched here, deterministically, rather than left to the model, because the answer to this one
 * question must be the guide verbatim — the model may shorten and voice every OTHER answer, but for
 * this one any paraphrase is the failure being fixed. Phrasings a person uses when standing on a
 * page; a question about a specific control ("what does Move it do") is NOT this, and goes to the
 * host with the guide as context.
 */
const HOW_IT_WORKS = [
  /\bhow (does|do|did) (this|the|that) (page|tab|screen|thing|surface|view)( even)?( work|function|operate)?\b/,
  /\bhow (does|do) (this|it|everything|stuff|things?) (all )?work( here| now)?\b/,
  /\bhow (do i|to|should i|can i) (use|work|read|navigate) (this|the) (page|tab|screen)\b/,
  /\bwhat (is|does|do) (this|the) (page|tab|screen) (for|do|about|show)\b/,
  /\bwhat('s| is) (this|here|on this page)\b/,
  /\bwhat can i do (here|on this page|on this tab)\b/,
  /\b(explain|describe|walk me through|show me|teach me|tell me about) (this|the) (page|tab|screen)\b/,
  /\bwhat (are|do) (the|these|all the) (buttons|controls|bands|sections|faces)( here| do| mean| for)?\b/,
  /\bhow (does|do) (this|the) (page|tab)( work)? now\b/,
  /\bpage instructions\b/,
  /\bwhat changed (here|on this page)\b/,
];

export function asksHowThePageWorks(message: string): boolean {
  const m = message.toLowerCase().replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  return HOW_IT_WORKS.some((re) => re.test(m));
}
