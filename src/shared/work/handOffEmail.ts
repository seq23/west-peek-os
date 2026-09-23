import type { ExecEmailInput, ExecEmailSection } from "../email/execEmail";
import { SECTION_MAX_LINES, SUBJECT_MAX } from "../email/execEmail";
import type { Partner } from "../registry/partners";

/**
 * THE ONE EMAIL A PARTNER GETS WHEN A CARD BECOMES THEIRS (owner, 23 Sep 2026; migration 0241).
 *
 * Exactly one, at the hand-off (and one at a take-back): no retroactive re-sends of the notices the
 * other partner already had, and no forwarded thread. Everything they need to act is in this one
 * message, CURRENT STATE FIRST:
 *
 *   1 · what the job is;                       5 · their reply options;
 *   2 · where it stands;                       6 · "Decided so far" — each plan decision in one line,
 *   3 · the current preview (one link per          what was chosen and who approved it;
 *       changed site, the branch alias);        7 · "How we got here" — a compact dated trail, one
 *   4 · "Still missing (optional)";                line per prior exchange with the previous primary.
 *
 * PURE: the service reads the card and hands the lines in; this only arranges them, in the exec
 * format `lintExecEmail` enforces (labels and bullets above the rule, no section over six lines).
 */

export interface TrailEntry {
  /** ISO time of the exchange. */
  at: string;
  /** "Porter", or the partner's first name. */
  from: string;
  to: string;
  said: string;
}

export interface HandOffEmailInput {
  action: "HAND_OFF" | "TAKE_BACK" | "CLAIM";
  /** The partner who now holds the card — the recipient. */
  to: Partner;
  /** The partner who held it until now (secondary from here on). */
  from: Partner;
  title: string;
  job: string;
  stands: string;
  /** One entry per changed site ("community: https://work-wpc-….pages.dev"), or empty before a preview exists. */
  previewLinks: readonly string[];
  missing: readonly string[];
  replyOptions: readonly string[];
  decided: readonly string[];
  trail: readonly TrailEntry[];
  cardLink: string;
  /** The one sentence for the previous primary, who is in Cc: "Handed to Scooter. He'll get…". */
  changed?: string | null;
}

const EMPLOYEE = "Porter";

function clip(text: string, max: number): string {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(1, max - 1));
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:.—-]+$/, "")}…`;
}

/** "Sep 23" in Central time, the partners' clock. Pure. */
export function trailDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "earlier";
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric" }).format(d);
}

/** "Sep 23 · Porter → Sequoia: Preview ready". Pure. */
export function trailLine(e: TrailEntry): string {
  return `${trailDate(e.at)} · ${e.from} → ${e.to}: ${clip(e.said, 110)}`;
}

/** A list as sections of at most six bullets: "Label", "Label (cont.)". Pure. */
function sectionsOf(label: string, bullets: readonly string[]): ExecEmailSection[] {
  const out: ExecEmailSection[] = [];
  for (let i = 0; i < bullets.length; i += SECTION_MAX_LINES) {
    out.push({ label: i === 0 ? label : `${label} (cont.)`, bullets: bullets.slice(i, i + SECTION_MAX_LINES) });
  }
  return out;
}

export function handOffEmail(input: HandOffEmailInput): ExecEmailInput {
  const suffix = input.action === "TAKE_BACK" ? " — yours again" : " — now yours";
  const room = SUBJECT_MAX - `${EMPLOYEE}: `.length - suffix.length;
  const what = `${clip(input.title, room)}${suffix}`;
  const tldr =
    input.action === "HAND_OFF"
      ? `${input.from.firstName} handed you this card; you own the approvals and missing items. ${clip(input.stands, 160)}`
      : input.action === "CLAIM"
        ? `You took responsibility for this card; you own the approvals and missing items. ${clip(input.stands, 160)}`
        : `You took this card back from ${input.from.firstName}; you own the approvals and missing items again. ${clip(input.stands, 160)}`;
  const sections: ExecEmailSection[] = [
    { label: "The job", bullets: [clip(input.job, 300)] },
    {
      label: "Where it stands",
      bullets: [
        ...(input.changed ? [input.changed] : []),
        clip(input.stands, 300),
        `${input.from.firstName} is secondary: sees the card in the OS and can take it back any time (a "take this back" reply, the card's button, or Take responsibility).`,
      ],
    },
  ];
  if (input.previewLinks.length) sections.push(...sectionsOf("Current preview", input.previewLinks));
  if (input.missing.length) sections.push(...sectionsOf("Still missing (optional)", input.missing.map((m) => clip(m, 140))));
  if (input.replyOptions.length) sections.push(...sectionsOf("Your reply options", input.replyOptions));
  if (input.decided.length) sections.push(...sectionsOf("Decided so far", input.decided.map((d) => clip(d, 160))));
  if (input.trail.length) sections.push(...sectionsOf("How we got here", input.trail.map(trailLine)));
  sections.push({ label: "The card", bullets: [input.cardLink] });
  return { employee: EMPLOYEE, what, tldr, sections, details: null };
}
