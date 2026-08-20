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

export const DELIVERABLE_KINDS = ["daily_brief", "weekly_review", "research_packet", "ask_brief"] as const;

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
}

export const DELIVERABLE_KINDS_BY_KEY: Readonly<Record<DeliverableKind, DeliverableKindDef>> = {
  daily_brief: {
    key: "daily_brief",
    label: "Morning brief",
    blurb: "What moved overnight, read and synthesised rather than listed.",
    page: "home",
    docType: "BRIEF",
  },
  weekly_review: {
    key: "weekly_review",
    label: "Weekly operating review",
    blurb: "The Wednesday agenda, built from what actually happened.",
    page: "weekly-review",
    docType: "REVIEW",
  },
  research_packet: {
    key: "research_packet",
    label: "Research packet",
    blurb: "A question, the sources that answered it, and what they support.",
    page: "research",
    docType: "RESEARCH",
  },
  ask_brief: {
    key: "ask_brief",
    label: "Brief",
    blurb: "A written answer to something you asked for.",
    page: "intent",
    docType: "BRIEF",
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
