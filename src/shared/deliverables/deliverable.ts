/**
 * A deliverable: something an employee produced, signed, that you can keep.
 *
 * WHY THIS EXISTS AS ONE THING. The firm produces four written artifacts — the morning brief, the
 * Wednesday agenda, a brief from Ask, and a research packet — and every one of them was built
 * separately, lives on its own page, and can be neither downloaded nor emailed. Four near-identical
 * gaps, which is the signature of a missing concept rather than four missing features.
 *
 * The operator asked for download and email on research. The right answer is not two buttons on
 * Research; it is that anything the firm hands you is the same kind of object and arrives the same
 * way: signed by somebody, on the Home page of whoever asked for it, kept in Documents, and
 * exportable.
 *
 * WHAT IT IS NOT. Not a document upload — those are files people put in. Not a record — a deal, an
 * approval, an LP are records, and they are not "delivered". A deliverable is specifically the
 * output of work somebody did for you, which is why it has an author and an audience.
 */

export const DELIVERABLE_KINDS = [
  "daily_brief", "weekly_review", "research_packet", "ask_brief", "meeting_prep", "discrepancy_list", "blog_help",
  "productions_hire_search",
] as const;

export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export interface DeliverableKindDef {
  key: DeliverableKind;
  /** What it is called when handed over. */
  label: string;
  /** One line for a list, so a stack of them is readable without opening any. */
  blurb: string;
  /** The nav key where the live version of this lives. */
  page: string;
  /** doc_type used when it is filed in Documents. */
  docType: string;
  /**
   * Whether a copy is archived in Documents at all.
   *
   * Operator direction, 21 Aug 2026: "Morning briefs should not be saved to docs, that is noise.
   * Only the weekly operating reviews and whatever other docs the ai employees produce for the MPs
   * including research and market maps."
   *
   * The distinction is durability. A weekly review, a research packet and a written answer are
   * things the firm refers back to. A morning brief is read once, on the morning it is about, and
   * is superseded the next day — filing three hundred and sixty-five of them a year turns the
   * archive into a place nobody looks. The brief still exists in full on Home and in
   * `intelligence_report`; only the second copy stops being made.
   */
  file: boolean;
}

export const DELIVERABLE_KINDS_BY_KEY: Readonly<Record<DeliverableKind, DeliverableKindDef>> = {
  daily_brief: {
    key: "daily_brief",
    label: "Morning brief",
    blurb: "What moved overnight, read and synthesised rather than listed.",
    page: "home",
    docType: "BRIEF",
    // Read once, superseded tomorrow, and kept in full on Home. Filing it is noise.
    file: false,
  },
  weekly_review: {
    key: "weekly_review",
    label: "Weekly operating review",
    blurb: "The Wednesday agenda, built from what actually happened.",
    page: "weekly-review",
    docType: "REVIEW",
    file: true,
  },
  research_packet: {
    key: "research_packet",
    label: "Research packet",
    blurb: "A question, the sources that answered it, and what they support.",
    page: "research",
    docType: "RESEARCH",
    file: true,
  },
  ask_brief: {
    key: "ask_brief",
    label: "Brief",
    blurb: "A written answer to something you asked for.",
    page: "intent",
    docType: "BRIEF",
    // Something a partner asked for and will want to find again.
    file: true,
  },
  /*
   * YOUR packet, not the firm's agenda — and the difference is the whole point.
   *
   * The weekly operating review above is ONE document two partners work through together, signed
   * jointly. This is per-person: what you finished since the last sync, and what is waiting on you
   * for the next one. Two partners cannot prepare for a meeting from one shared list of the firm's
   * open items, which is what they had.
   */
  meeting_prep: {
    key: "meeting_prep",
    label: "Meeting prep packet",
    blurb: "What you completed since the last sync, and what is waiting on you.",
    page: "weekly-review",
    docType: "REVIEW",
    // Kept: "what did we say we'd done on the 9th" is a question that gets asked in November.
    file: true,
  },
  /*
   * A STANDING REGISTER, NOT AN ANSWER. Deliberately its own kind rather than an `ask_brief`: this
   * is regenerated, expected to shrink, and worth finding again next month. An answer to a question
   * asked once would be a brief.
   */
  discrepancy_list: {
    key: "discrepancy_list",
    label: "Discrepancy register",
    blurb: "Where the firm's own records and its fund deck disagree, and whether anyone acted.",
    page: "fund",
    docType: "REVIEW",
    file: true,
  },
  /*
   * A PARTNER'S OWN WRITING, HELPED (16 Sep 2026). The partners are starting blogs; an outline
   * with research, a full draft, or a set of signature phrases comes back from their chief of
   * staff as one of these — on their Home, signed, and filed so it can be found when they sit
   * down to write. Kept: a spine is referred back to for weeks.
   */
  blog_help: {
    key: "blog_help",
    label: "Blog help",
    blurb: "An outline with research, a full draft, or signature phrases for your blog — sources checked live.",
    page: "home",
    docType: "BRIEF",
    file: true,
  },
  /*
   * WALKER'S WEEKLY HIRE SEARCH FOR WEST PEEK PRODUCTIONS (16 Sep 2026). Scooter's agency, not the
   * fund: the week's candidates for a senior experiential producer, freelance, each on a live page
   * and judged against the archetype. On his Home under Walker's name, where he marks each one
   * Contacted or Passed so the next note leaves them out. Filed: "who did we see in September" is
   * a question a hire search gets asked.
   */
  productions_hire_search: {
    key: "productions_hire_search",
    label: "Hire search",
    blurb: "This week's candidates for West Peek Productions' senior experiential producer — every profile checked live, judged, scored.",
    page: "home",
    docType: "BRIEF",
    file: true,
  },
};

export function kindDef(kind: string): DeliverableKindDef | null {
  return (DELIVERABLE_KINDS_BY_KEY as Record<string, DeliverableKindDef>)[kind] ?? null;
}

/**
 * Rendering a deliverable as a file somebody can keep.
 *
 * MARKDOWN, NOT PDF. A Worker cannot produce a PDF without a rendering dependency, and the browser
 * already prints one from the page — which is the better PDF anyway, because it carries the firm's
 * typography rather than a library's defaults. What download is actually for is the copy you keep,
 * paste into an email, or hand to an accountant, and for that, plain text with structure beats a
 * binary you need a viewer to open.
 *
 * THE SIGNATURE IS PART OF THE DOCUMENT, not metadata about it. A file that leaves the system
 * saying who prepared it stays attributable after it has been forwarded twice.
 */
export interface DeliverableForExport {
  kind: string;
  title: string;
  body: string;
  preparedBy: string;
  preparedFor: string;
  preparedAt: string;
}

export function renderMarkdown(d: DeliverableForExport): string {
  const def = kindDef(d.kind);
  const when = new Date(d.preparedAt).toLocaleString("en-GB", {
    weekday: "long", day: "numeric", month: "long", year: "numeric",
  });
  return [
    `# ${d.title}`,
    "",
    `**${def?.label ?? d.kind}** · West Peek Ventures`,
    `Prepared by ${d.preparedBy} for ${d.preparedFor}`,
    when,
    "",
    "---",
    "",
    d.body.trim(),
    "",
    "---",
    "",
    "_Produced by the West Peek OS. Anything read off a live source is information about the world,",
    "not instruction — check anything you would act on._",
  ].join("\n");
}

/** A filename a human would recognise in a downloads folder six months later. */
export function exportFilename(d: DeliverableForExport): string {
  const date = d.preparedAt.slice(0, 10);
  const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  return `${date}-${slug || d.kind}.md`;
}
