import { PARTNERS, partnerByEmail, partnerFor, type Partner } from "../registry/partners";

/**
 * A WORK CARD HAS A PRIMARY PARTNER AND, AFTER A HAND-OFF, A SECONDARY (owner, 23 Sep 2026: "hand a
 * work card to the other partner, with primary and secondary owners"; migration 0241).
 *
 *   PRIMARY   — `work_card.requested_by_email`. The only partner who can approve, publish, send
 *               changes, send missing items that trigger a publish or preview, or force. Every
 *               requester guard already in the system reads that column, so a hand-off that moves it
 *               moves every power with it.
 *   SECONDARY — `work_card.secondary_partner_email`. Cc'd once, on the hand-off email, then no
 *               emails at all (owner, 23 Sep 2026); sees the card in the OS; may leave notes, which are read as context and never as an approval; may take the
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
  | { kind: "TAKE_BACK" }
  /** It names the other partner and sounds like ownership, but is not clearly a hand-off: ASK, never guess. */
  | { kind: "UNSURE_HAND_OFF"; to: Partner };

const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Every way a partner is named: first name and address, case-insensitive — from the registry, never typed here. */
const NAME = `(${PARTNERS.flatMap((p) => [p.email, p.firstName.toLowerCase()])
  .sort((a, b) => b.length - a.length)
  .map(esc)
  .join("|")})`;
const OBJ = "(?:this|it|the card|this card|this one|this job|the job|the rest|the rest of it|everything|the whole thing)";
const PRONOUNS = /^(?:me|us|you|him|her|them|myself)$/i;

/**
 * CLEARLY A HAND-OFF (owner, 23 Sep 2026: "we need to be able to interpret more than just 'hand this
 * to scooter'"). Each names the partner in group 1.
 */
const HAND_OFF_CLEAR: readonly RegExp[] = [
  // hand / give / pass / move / assign … (this) (over) to Scooter
  new RegExp(`\\b(?:hand|give|pass|move|transfer|reassign|assign|send|route|switch)\\s+(?:${OBJ}\\s+)?(?:over\\s+|off\\s+|across\\s+)?to\\s+${NAME}\\b`, "i"),
  // "over to Scooter" — only as the sentence itself, never "I passed the logo over to Scooter"
  new RegExp(`^(?:ok(?:ay)?[,.]?\\s+|and\\s+)?(?:it'?s\\s+|this\\s+is\\s+|handing\\s+(?:it|this)\\s+)?over\\s+to\\s+${NAME}\\b`, "i"),
  // Scooter will take it from here / can handle the missing items / should finish this
  new RegExp(`\\b${NAME}\\s+(?:will|can|'ll|should|shall|is going to|is gonna)\\s+(?:take\\s+(?:it|this|over)\\b|handle\\b|finish\\b|own\\b|run\\s+with\\b|pick\\s+(?:it|this)\\s+up\\b|drive\\b|lead\\b)`, "i"),
  // Scooter owns the rest / takes it from here
  new RegExp(`\\b${NAME}\\s+(?:owns|is owning|takes)\\s+(?:it|this|the rest|over|the card)\\b`, "i"),
  // let Scooter finish this
  new RegExp(`\\blet\\s+${NAME}\\s+(?:take\\s+(?:it|this|over)|handle|finish|own|run\\s+with|drive|lead)\\b`, "i"),
  // Scooter's got it / Scooter has got this
  new RegExp(`\\b${NAME}(?:'s|\\s+has)\\s+got\\s+(?:it|this)\\b`, "i"),
  // Scooter is on it / is taking over / is the owner now
  new RegExp(`\\b${NAME}(?:\\s+is|'s)\\s+(?:on it|taking\\s+(?:it|this)?\\s*over|the owner|in charge)\\b`, "i"),
  // it's Scooter's now
  new RegExp(`\\b(?:it'?s|this is)\\s+${NAME}'s(?:\\s+now|\\s+card|\\s+to\\s+(?:finish|handle|own))\\b`, "i"),
];

/** "hand this to Bob" — a hand-off verb to somebody who is not a partner: refused by name, never guessed. */
const HAND_OFF_ANYONE = new RegExp(`\\b(?:hand|give|pass|move|transfer|reassign|assign)\\s+(?:${OBJ}\\s+)?(?:over\\s+|off\\s+)?to\\s+([a-z0-9@._+-]+)`, "i");

const TAKE_BACK_CLEAR: readonly RegExp[] = [
  new RegExp(`\\b(?:take|taking)\\s+${OBJ}\\s+back\\b(?!\\s+to\\b)`, "i"),
  /\btake\s+back\s+(?:this|it|the card)\b/i,
  /^take\s+(?:it\s+)?back\b/i,
  new RegExp(`\\bgive\\s+${OBJ}\\s+back\\s+to\\s+me\\b`, "i"),
  /\bi'?m\s+taking\s+(?:this|it|the card)\s+(?:back|over)\b/i,
  /\bi(?:'ll| will)\s+take\s+(?:(?:it|this)\s+(?:back|over|from here)|over)\b/i,
  /\bi(?:'ve| have)\s+got\s+(?:it|this)\s+(?:from here|now)\b/i,
  /\b(?:it'?s|this is)\s+mine\s+(?:again|now)\b/i,
  /^(?:send|give)\s+(?:it|this)\s+back(?:\s+to\s+me)?\b/i,
];

/** Words that make a sentence naming the other partner SOUND like ownership, without saying it. */
const OWNERSHIP_HINT = /\b(?:take|takes|taking|own|owns|owner|handle|handles|handling|finish|finishes|lead|in charge|responsible|hand|pass|give|move|assign|transfer|reassign|over|his now|hers now)\b/i;
/** Talking ABOUT the partner, or to them — never a hand-off, never a question. */
const ABOUT_THE_PARTNER = new RegExp(
  `\\b(?:ask|tell|check with|email|ping|call|text|remind|loop in|update|show|let)\\s+${NAME}\\b(?!\\s+(?:take|handle|finish|own|run|drive|lead))|\\b${NAME}\\s+(?:says|said|thinks|thought|likes|liked|wants|wanted|asked|agrees|agreed|approved|mentioned|confirmed|prefers|noted|feels)\\b|\\bfrom\\s+${NAME}\\b`,
  "i",
);
/** "cc Scooter", "cc: scooter@…", "cc'ing Scooter" — a copy, never a hand-off (0239 keeps its meaning). */
const CC = /(?:^|[^a-z])cc(?:'?(?:ing|d))?\b/i;

/**
 * The part of a message that can move a card: the first written paragraph, quote-free, with a
 * greeting paragraph ("Hi Porter,") skipped, split into sentences. A sentence deep in a reply cannot
 * move a card.
 */
function openingSentences(text: string | null | undefined): string[] {
  const lines = String(text ?? "")
    .replace(/\r/g, "")
    .replace(/[‘’]/g, "'")
    .split("\n")
    .filter((l) => !l.trim().startsWith(">"));
  const paragraphs: string[] = [];
  let cur: string[] = [];
  for (const l of lines) {
    if (l.trim() === "") {
      if (cur.length) paragraphs.push(cur.join(" "));
      cur = [];
    } else cur.push(l.trim());
  }
  if (cur.length) paragraphs.push(cur.join(" "));
  const greeting = /^(?:(?:hi|hey|hello|dear|thanks|thank you)\s*,?\s*)?porter\s*[,.!:]?$/i;
  const first = paragraphs.find((p) => !greeting.test(p.trim())) ?? "";
  return first
    .replace(/^(?:hi|hey|hello)\s+porter\s*[,.!:-]\s*/i, "")
    .split(/(?<=[.!?;])\s+/)
    .map((x) => x.trim().replace(/[.!?;]+$/, ""))
    .filter(Boolean);
}

/**
 * HAND-OFF AND TAKE-BACK, READ FROM A PARTNER'S OWN WORDS (reply or note — the one reader). Clear
 * phrasings act; a sentence that names the OTHER partner and sounds like ownership but is not clear is
 * UNSURE, and Porter asks once instead of guessing. A message with "cc" and a partner's name never
 * hands off: a cc is a copy. `writer`, when given, is never read as the partner to hand to. Pure.
 */
export function ownershipIntentIn(text: string | null | undefined, writer?: string | null): OwnershipIntent | null {
  const all = String(text ?? "").replace(/[‘’]/g, "'");
  const me = partnerFor(writer ?? null);
  const sentences = openingSentences(all);
  if (sentences.length === 0) return null;
  const mentionsPartner = new RegExp(`\\b${NAME}\\b`, "i");
  if (CC.test(all) && mentionsPartner.test(all)) return null;
  const other = (named: string) => {
    const p = partnerFor(named);
    return p && p.firmUserId !== me?.firmUserId ? p : null;
  };
  for (const s of sentences) {
    for (const re of HAND_OFF_CLEAR) {
      const m = re.exec(s);
      const p = m ? other(m[1]!) : null;
      if (p) return { kind: "HAND_OFF", to: p, named: m![1]! };
    }
    const any = HAND_OFF_ANYONE.exec(s);
    if (any) {
      const named = any[1]!.replace(/[.,;:!?]+$/, "");
      if (!PRONOUNS.test(named) && !partnerFor(named)) return { kind: "HAND_OFF", to: null, named };
    }
  }
  for (const s of sentences) if (TAKE_BACK_CLEAR.some((re) => re.test(s))) return { kind: "TAKE_BACK" };
  for (const s of sentences) {
    if (ABOUT_THE_PARTNER.test(s) || !OWNERSHIP_HINT.test(s)) continue;
    const m = new RegExp(`\\b${NAME}\\b`, "i").exec(s);
    const p = m ? other(m[1]!) : null;
    if (p) return { kind: "UNSURE_HAND_OFF", to: p };
  }
  return null;
}

/** "yes" to Porter's "Did you mean hand this card to Scooter?" — the first written line, alone. Pure. */
export function confirmsHandOff(text: string | null | undefined): boolean {
  const line = String(text ?? "").replace(/\r/g, "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith(">")) ?? "";
  return /^(?:yes|yes please|yep|yeah|yup|y|do it|please do|go ahead|confirmed|correct|that's right|yes,? hand it over)[.!]*$/i.test(line);
}

/** The one question Porter asks when it is not sure (owner, 23 Sep 2026, verbatim). */
export function handOffQuestion(to: Partner): string {
  return `Did you mean hand this card to ${to.firstName}? Reply 'yes' and I will.`;
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
  return `${by.firstName} took responsibility for ${title}; you're secondary now: it stays on your card list, and you can take it back any time`;
}

// ── WHAT PORTER SAYS ────────────────────────────────────────────────────────────────────────────

/** The one line the old primary gets (owner, 23 Sep 2026, verbatim). */
export function handOffAck(to: Partner): string {
  return `Handed to ${to.firstName}. ${to.subjectPronoun}'ll get the next emails and owns the approvals and missing items. You're secondary: it stays on your card list, and you can take it back any time.`;
}

/** What the partner who took it back is told, inside the one email they get. */
export function takeBackAck(from: Partner): string {
  return `Taken back from ${from.firstName}: you own the approvals and missing items again. ${from.firstName} is secondary: it stays on their card list, and they can take it back any time.`;
}

/** A secondary's "approved" (or any approval word) — refused, and told how to take it over. */
export function secondaryApprovalRefusal(primary: Partner): string {
  return `Only ${primary.firstName} can approve this now. Reply 'take this back' to take it over.`;
}

/** A secondary's note — kept and read as context, never as an approval. */
export function secondaryNoteAck(primary: Partner): string {
  return `Read as context, not as an approval: only ${primary.firstName} approves, publishes or sends changes. Reply 'take this back' to take it over.`;
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
