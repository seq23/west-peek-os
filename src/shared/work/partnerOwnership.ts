import { PARTNERS, partnerByEmail, partnerFor, type Partner } from "../registry/partners";

/**
 * A WORK CARD HAS A PRIMARY PARTNER AND, AFTER A HAND-OFF, A SECONDARY (owner, 23 Sep 2026: "hand a
 * work card to the other partner, with primary and secondary owners"; migration 0241).
 *
 *   PRIMARY   — `work_card.requested_by_email`. The only partner who can approve, publish, send
 *               changes, send missing items that trigger a publish or preview, or force. Every
 *               requester guard already in the system reads that column, so a hand-off that moves it
 *               moves every power with it.
 *   SECONDARY — `work_card.secondary_partner_email`. Cc'd on every preview and the finished email;
 *               may leave notes, which are read as context and never as an approval; may take the
 *               card back.
 *
 * PURE. Who may do what is decided here and nowhere else — the reply door, the note door, the two
 * routes and the runner all ask these functions, so the three ways in can never disagree. Partners
 * are resolved ONLY through the partner registry (`shared/registry/partners.ts`, the list
 * `isPartnerEmail` / `ASSIGNING_PARTNERS` are derived from): a name or address that is not on it is
 * nobody, whatever the row or the message says.
 *
 * `tests/partnerHandOff.test.ts` pins every rule; `validate:no-land-without-approval` gate 14 pins
 * that the Worker's approval paths go through the primary only.
 */

export interface OwnedCard {
  requested_by_email: string | null;
  secondary_partner_email?: string | null;
}

export interface Ownership {
  primary: Partner | null;
  secondary: Partner | null;
}

/** The two partners on a card, read from the registry. A secondary equal to the primary is no secondary. */
export function ownershipOf(card: OwnedCard | null | undefined): Ownership {
  const primary = partnerByEmail(card?.requested_by_email ?? null);
  const secondary = partnerByEmail(card?.secondary_partner_email ?? null);
  return { primary, secondary: secondary && secondary.firmUserId !== primary?.firmUserId ? secondary : null };
}

export type OwnershipRole = "PRIMARY" | "SECONDARY" | "NONE";

/** `who` is an address, a `firm_user` id or a partner's name. */
export function roleOf(card: OwnedCard | null | undefined, who: string | null | undefined): OwnershipRole {
  const p = partnerFor(who ?? null);
  if (!p) return "NONE";
  const own = ownershipOf(card);
  if (own.primary?.firmUserId === p.firmUserId) return "PRIMARY";
  if (own.secondary?.firmUserId === p.firmUserId) return "SECONDARY";
  return "NONE";
}

/**
 * APPROVE, PUBLISH, SEND CHANGES, SEND MISSING ITEMS THAT TRIGGER A BUILD, FORCE — the primary only.
 * A card no partner asked for by email has no primary; either partner may act on it, which is the
 * rule that stood before hand-offs existed ("a card with no requester on it is cleared by either
 * partner", emailThread.ts).
 */
export function canApprove(card: OwnedCard | null | undefined, who: string | null | undefined): boolean {
  const p = partnerFor(who ?? null);
  if (!p) return false;
  const own = ownershipOf(card);
  return own.primary ? own.primary.firmUserId === p.firmUserId : true;
}
export const canPublish = canApprove;
export const canForce = canApprove;
export const canSteer = canApprove;

// ── THE WORDS ───────────────────────────────────────────────────────────────────────────────────

export type OwnershipIntent =
  | { kind: "HAND_OFF"; to: Partner | null; named: string }
  | { kind: "TAKE_BACK" };

/** The first line the partner wrote: no quote, no signature below it. */
function firstLine(text: string | null | undefined): string {
  return (
    String(text ?? "")
      .replace(/\r/g, "")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith(">")) ?? ""
  );
}

const HAND_OFF = /\b(?:hand|give|pass|transfer|reassign|move)\s+(?:(?:this|it|the card|this card|this one|this job|the job)\s+)?(?:over\s+|off\s+|across\s+)?to\s+([a-z0-9@._+-]+)/i;
const TAKE_BACK = /\b(?:take|taking)\s+(?:this|it|the card|this card|this one|this job)\s+back\b|\btake\s+back\s+(?:this|the card)\b|^take\s+back\b/i;

/**
 * "hand this to Scooter", "give this to Sequoia", "pass it over to scooter@…" — or "take this back".
 * Read from the FIRST written line only, so a sentence deep in a reply ("we may take this back to the
 * drawing board next month") cannot move a card. `to` is null when the name is not a partner, and the
 * caller refuses it by name. Pure.
 */
export function ownershipIntentIn(text: string | null | undefined): OwnershipIntent | null {
  const line = firstLine(text);
  if (!line) return null;
  if (TAKE_BACK.test(line)) return { kind: "TAKE_BACK" };
  const m = HAND_OFF.exec(line);
  if (!m) return null;
  const named = m[1]!.replace(/[.,;:!?]+$/, "");
  return { kind: "HAND_OFF", to: partnerFor(named), named };
}

// ── THE DECISIONS ───────────────────────────────────────────────────────────────────────────────

export type OwnershipDecision =
  | { ok: true; action: "HAND_OFF" | "TAKE_BACK" | "CLAIM"; by: Partner; primary: Partner; secondary: Partner; ack: string }
  | { ok: false; status: 400 | 403 | 409; reason: string };

/** Partners only; only the CURRENT primary hands off; only to the other partner. Pure. */
export function decideHandOff(card: OwnedCard | null | undefined, actor: string | null | undefined, target: string | null | undefined): OwnershipDecision {
  const by = partnerFor(actor ?? null);
  if (!by) return { ok: false, status: 403, reason: "Only a partner can hand a card off." };
  const own = ownershipOf(card);
  if (!own.primary) return { ok: false, status: 409, reason: "This card was not asked for by a partner, so there is no primary to hand it from." };
  if (own.primary.firmUserId !== by.firmUserId) {
    return {
      ok: false,
      status: 403,
      reason:
        own.secondary?.firmUserId === by.firmUserId
          ? `Only ${own.primary.firstName} can hand this card off. Reply 'take this back' to take it over.`
          : `Only ${own.primary.firstName} can hand this card off.`,
    };
  }
  const to = partnerFor(target ?? null);
  if (!to) return { ok: false, status: 400, reason: `${String(target ?? "").trim() || "Nobody"} is not a partner; a card can only be handed to a partner.` };
  if (to.firmUserId === by.firmUserId) return { ok: false, status: 409, reason: "It's already yours." };
  return { ok: true, action: "HAND_OFF", by, primary: to, secondary: by, ack: handOffAck(to) };
}

/** Only the CURRENT secondary takes back; the roles swap. Pure. */
export function decideTakeBack(card: OwnedCard | null | undefined, actor: string | null | undefined): OwnershipDecision {
  const by = partnerFor(actor ?? null);
  if (!by) return { ok: false, status: 403, reason: "Only a partner can take a card back." };
  const own = ownershipOf(card);
  if (own.primary?.firmUserId === by.firmUserId) return { ok: false, status: 409, reason: "It's already yours." };
  if (!own.secondary || own.secondary.firmUserId !== by.firmUserId || !own.primary) {
    return { ok: false, status: 403, reason: own.secondary ? `Only ${own.secondary.firstName} can take this card back.` : "Nobody is secondary on this card, so there is nothing to take back." };
  }
  return { ok: true, action: "TAKE_BACK", by, primary: by, secondary: own.primary, ack: takeBackAck(own.primary) };
}

/**
 * "TAKE RESPONSIBILITY" ON A WORK CARD'S NOTIFICATION CLAIMS THE CARD (owner, 23 Sep 2026). The
 * partner who presses it becomes primary and the other partner secondary — from any starting point,
 * including a card no partner asked for. Already primary: `already` is true and nothing moves (the
 * press is still recorded, as it always was). Partners only. Pure.
 */
export function decideClaim(
  card: OwnedCard | null | undefined,
  actor: string | null | undefined,
): OwnershipDecision | { ok: true; already: true; by: Partner } {
  const by = partnerFor(actor ?? null);
  if (!by) return { ok: false, status: 403, reason: "Only a partner can take responsibility for a card." };
  const own = ownershipOf(card);
  if (own.primary?.firmUserId === by.firmUserId) return { ok: true, already: true, by };
  const other = PARTNERS.find((p) => p.firmUserId !== by.firmUserId)!;
  return { ok: true, action: "CLAIM", by, primary: by, secondary: other, ack: "" };
}

/** The one line the other partner gets when a card is claimed (owner, 23 Sep 2026, verbatim). */
export function claimAck(by: Partner, title: string): string {
  return `${by.firstName} took responsibility for ${title}; you're secondary now: cc'd, and you can take it back any time`;
}

// ── WHAT PORTER SAYS ────────────────────────────────────────────────────────────────────────────

/** The one line the old primary gets (owner, 23 Sep 2026, verbatim). */
export function handOffAck(to: Partner): string {
  return `Handed to ${to.firstName}. ${to.subjectPronoun}'ll get the next emails and owns the approvals and missing items. You're secondary: cc'd, and you can take it back any time.`;
}

/** What the partner who took it back is told, inside the one email they get. */
export function takeBackAck(from: Partner): string {
  return `Taken back from ${from.firstName}: you own the approvals and missing items again. ${from.firstName} is secondary: cc'd, and can take it back any time.`;
}

/** A secondary's "approved" (or any approval word) — refused, and told how to take it over. */
export function secondaryApprovalRefusal(primary: Partner): string {
  return `Only ${primary.firstName} can approve this now. Reply 'take this back' to take it over.`;
}

/** A secondary's note — kept and read as context, never as an approval. */
export function secondaryNoteAck(primary: Partner): string {
  return `Read as context, not as an approval: only ${primary.firstName} approves, publishes or sends changes. Reply 'take this back' to take it over.`;
}

/**
 * The cc on a PREVIEW or a finished email: the partners the primary asked to cc, plus the secondary,
 * never the recipient, partners only. Pure.
 */
export function ccWithSecondary(cc: readonly string[], card: OwnedCard | null | undefined, to: string | null | undefined): string[] {
  const own = ownershipOf(card);
  const recipient = String(to ?? "").trim().toLowerCase();
  const all = [...cc, ...(own.secondary ? [own.secondary.email] : [])].map((a) => a.trim().toLowerCase());
  return [...new Set(all)].filter((a) => a && a !== recipient && partnerByEmail(a) !== null);
}

// ── THE DESK ────────────────────────────────────────────────────────────────────────────────────

export interface PartnerView {
  firm_user_id: string;
  email: string;
  first_name: string;
  full_name: string;
}

export interface OwnershipView {
  primary_partner: PartnerView | null;
  secondary_partner: PartnerView | null;
  /** "Owner: Sequoia · Secondary: Scooter", "Owner: Sequoia", or null when no partner asked. */
  partner_owner_line: string | null;
}

const view = (p: Partner | null): PartnerView | null => (p ? { firm_user_id: p.firmUserId, email: p.email, first_name: p.firstName, full_name: p.fullName } : null);

/** What the card-list and card routes serve: primary first, then secondary. Pure. */
export function ownershipView(card: OwnedCard | null | undefined): OwnershipView {
  const own = ownershipOf(card);
  return {
    primary_partner: view(own.primary),
    secondary_partner: view(own.secondary),
    partner_owner_line: own.primary ? `Owner: ${own.primary.firstName}${own.secondary ? ` · Secondary: ${own.secondary.firstName}` : ""}` : null,
  };
}
