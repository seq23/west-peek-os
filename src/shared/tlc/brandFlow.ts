/**
 * THE TLC BRAND FLOW, START TO FINISH, ALL BY EMAIL (owner, 26 Oct 2026; her spec "Pinecone, start to finish",
 * artifact v8). This file is the durable copy of that spec: the five steps, the call branch, and the email at each
 * one as a template. The code reads it — `dripEmail` (steps 1–2), `samplesCoverEmail` (3), `proposalEmail` (4),
 * `confirmEmail` (5) and the call reply — and tests/tlcBrandFlow.test.ts reads it back. Brand words vary; tone,
 * structure and rules stay. Everything committed uses a FAKE brand; a real brand's instance lives only in the
 * production database.
 *
 * Her rules the templates keep: she approves every email with one "approved" before it goes; Wynn never asks for
 * a call (a brand may, and then he schedules it); no money before step 4; we host every segment or bring a host;
 * rooms of 25+ guests, sized to the brand's goals (owner, 1 Nov 2026); never take or process a payment (the invoice carries West Peek's own link).
 */
export interface FlowStep {
  n: 1 | 2 | 3 | 4 | 5;
  email: string;
  money: "No" | "First time" | "Yes";
  movesOnWhen: string;
  /** What Wynn attaches. */
  attaches: readonly string[];
}

export const BRAND_FLOW: readonly FlowStep[] = [
  { n: 1, email: "First pitch", money: "No", movesOnWhen: "They reply", attaches: [] },
  { n: 2, email: "Reply, or the one follow-up if they're silent (day 12, the only automatic send, by her rule): the 3-page samples PDF attached; it waits until the PDF is made. After it, nothing more", money: "No", movesOnWhen: "Interest or questions", attaches: ["the 3-page samples PDF"] },
  { n: 3, email: "One 3-page PDF, made for them", money: "No", movesOnWhen: "Interest or questions", attaches: ["the 3-page samples PDF"] },
  { n: 4, email: "Proposal: partner options (also straight away when they ask the price)", money: "First time", movesOnWhen: "They pick one", attaches: ["the partner-levels sheet made for this brand, every price per event"] },
  { n: 5, email: "Agreement + invoice", money: "Yes", movesOnWhen: "Signed and paid", attaches: ["a one-page agreement", "the invoice"] },
];

/** After the one follow-up, no more follow-ups. */
export const FOLLOW_UPS = 1;

/**
 * The templates, word for word, with {placeholders}. {first} is the contact's first name ("Hi," when unknown),
 * {brand} the brand as a person writes it, {topic} the club, {segment} the brand's 15-minute segment, {level} the
 * partnership level they picked, {times} the open times from her calendar, one per line.
 */
export const FLOW_TEMPLATES = {
  followUp:
    "{hi}\n\nOne follow-up on The Learning Club: rather than describe it, I've attached a short 3-page PDF built around {brand}.\nIt shows how the evening will run, what a series of six could look like, and who will be in the room.\nIf any of it fits, just reply and I'll take it from there.",
  cover:
    "{hi}\n\nHere's a short 3-page PDF, built around {brand}:\n\n1. Run of show: how the evening flows, and where {brand} comes in: \"{segment}\", a segment led by {brand} or by our host.\n2. A series of six: how the room could grow into {arc}.\n3. Who's in the room: the kinds of people we'd invite, shaped around who you told us you want to reach.\n\nEverything here can bend to your launches and your audience. Tell me what you'd change and I'll come back with options for how {brand} could take part.",
  proposal:
    "{hi}\n\nThanks for your note. Here's how {brand} could take part in The Learning Club: {topic}, built around \"{segment}\", led by {brand} or by our host. Every price is per event:\n\n{levels}\n\nLead is the level brands like {brand} would benefit most from. A series of six: the same per-event price for each club, as a founding partner. The attached sheet has the details.\n\nTo say yes, reply with the level; we send a one-page agreement and an invoice, payment due within 14 days, and then we set the date with you.",
  confirm:
    "{hi}\n\nWonderful, we're thrilled to have {brand} as {level}. Attached are a one-page agreement and the invoice. Once both are back, we'll lock the date with you and start shaping the guest list around your audience.",
  callTimes:
    "{hi}\n\nHappy to talk. Any of these work on my side (Eastern time):\n{times}\nPick whichever suits you and I'll send an invite.",
  callYes:
    "{hi}\n\nHappy to talk. {time} (Eastern time) works for me; I'll send an invite.",
} as const;

export type FlowTemplate = keyof typeof FLOW_TEMPLATES;

/** The proposal's level lines, the same levels and words as that brand's sheet (renderBrandPitch). */
export function proposalLevelLines(levels: ReadonlyArray<{ label: string; priceUsd: number | null; head: string; adds: readonly string[] }>): string {
  return levels.map((l) => `• ${l.label} · ${l.priceUsd ? `$${l.priceUsd.toLocaleString("en-US")} per event` : "in kind"}: ${l.head ? `${l.head.replace(/:$/, "")} ` : ""}${l.adds.join("; ")}.`).join("\n");
}

/** A template filled in. Every placeholder must be given: a missing one throws rather than send "{brand}". */
export function fillTemplate(name: FlowTemplate, values: Record<string, string>): string {
  return FLOW_TEMPLATES[name].replace(/\{(\w+)\}/g, (_, k: string) => {
    if (!(k in values)) throw new Error(`template ${name} needs {${k}}`);
    return values[k]!;
  });
}

export const hiLine = (contactName: string | null | undefined): string => (contactName?.trim() ? `Hi ${contactName.trim().split(/\s+/)[0]},` : "Hi,");

/** Which partnership level a brand picked from the proposal ("Presenting works for us", "let's do Partner"), or null. */
export function levelPicked(text: string): "TITLE" | "PRESENTING" | "LEAD" | "PARTNER" | "PRODUCT" | null {
  const t = text.toLowerCase().replace(/[’]/g, "'");
  if (!/\b(?:let'?s|we'?d (?:like|love)|we'?ll (?:go|take|do)|go with|works for us|sign us up|we want|we choose|we pick|happy (?:with|to go)|count us in|do the|we're in|in for)\b/.test(t)) return null;
  if (/\btitle\b/.test(t)) return "TITLE";
  if (/\bpresenting\b/.test(t)) return "PRESENTING";
  if (/\blead partner\b|\blead level\b/.test(t)) return "LEAD";
  if (/\bproduct partner\b|\bin[- ]kind\b|\bsupply product\b/.test(t)) return "PRODUCT";
  if (/\bpartner\b/.test(t)) return "PARTNER";
  return null;
}
