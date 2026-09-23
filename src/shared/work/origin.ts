import { partnerByEmail, partnerByFirmUserId } from "../registry/partners";

/**
 * WHERE A CARD CAME FROM, answered from the row itself (22 Sep 2026).
 *
 * A card is a consequence of something. It can be an email somebody sent, a thing you wrote, a
 * commitment a meeting produced, something you captured, a colleague handing work on, or a job
 * opening it on a clock. The row has carried the evidence for all six since migration 0199 —
 * `created_by`, `requested_by_email`, `capture_id`, `meeting_id`, `assigned_from_card_id` — and
 * nothing ever read them together, so the page could only say "from something you captured" and
 * only for one of the six.
 *
 * PURE, AND WITH NO CONSUMERS YET. This is the fact the card-detail surface will show. It is a
 * function over a row so that surface, the desk and anything later all answer the question the
 * same way instead of each deciding for itself.
 */

/** The six real origins, plus SYSTEM for a card a job or a seat opened. */
export type OriginKind = "EMAIL" | "YOU" | "PARTNER" | "MEETING" | "CAPTURE" | "ANOTHER_CARD" | "SYSTEM";

export interface Origin {
  kind: OriginKind;
  /**
   * Who or what it came from, in the most readable form the row supports: an address, a partner's
   * name, or the id of the meeting, capture or card it came out of. Never null — a card always
   * came from something, and "we do not know" is said as the created_by value rather than blank.
   */
  who: string;
  /** When the card was opened. */
  at: string;
}

export interface OriginCard {
  created_by?: string | null;
  requested_by_email?: string | null;
  capture_id?: string | null;
  meeting_id?: string | null;
  assigned_from_card_id?: string | null;
  created_at?: string | null;
}

/**
 * THE ORDER IS THE ANSWER, and it runs most specific first.
 *
 * A card handed on by a colleague carries the email address of whoever asked in the FIRST place
 * (`employeeWork.ts` copies `requested_by_email` onto the new card deliberately, so the reply
 * still reaches the right person). Reading that first would say "an email from Scooter" about a
 * card Wren handed to Wyatt this morning, which is true of its ancestor and false of it. The
 * thing that opened THIS row wins, and the chain is still reachable through `who`.
 */
export function originOf(card: OriginCard, viewerFirmUserId?: string | null): Origin {
  const at = card.created_at ?? "";
  if (card.assigned_from_card_id) return { kind: "ANOTHER_CARD", who: card.assigned_from_card_id, at };
  if (card.meeting_id) return { kind: "MEETING", who: card.meeting_id, at };
  if (card.capture_id) return { kind: "CAPTURE", who: card.capture_id, at };
  const asked = (card.requested_by_email ?? "").trim();
  if (asked) return { kind: "EMAIL", who: asked.toLowerCase(), at };
  const by = (card.created_by ?? "").trim();
  const partner = partnerByFirmUserId(by);
  if (partner) {
    // YOU and PARTNER are the same fact read from two seats. Without a viewer nobody is "you",
    // so the answer is the partner by name rather than a guess.
    return { kind: viewerFirmUserId && by === viewerFirmUserId ? "YOU" : "PARTNER", who: partner.fullName, at };
  }
  // An employee seat, a job, or anything else that opened the row. It is still somebody's name in
  // the record, so it is reported rather than swallowed.
  return { kind: "SYSTEM", who: by || "the system", at };
}

/**
 * ONE SHORT PHRASE FOR AN ORIGIN BADGE (Wave C, 22 Sep 2026) — the desk's answer to "where did this
 * come from" at a glance, in the same four words the card page already reads out in full sentences
 * (`originLabel` in `WorkCardPage.tsx`). Kept here, alongside `originOf`, rather than duplicated
 * into the desk, so the desk and any future surface read the same four categories she asked for:
 * from an email (naming the sender), from her directly, from an AI employee, from the scheduled
 * sweep.
 *
 * `createdByName` is the one fact `originOf` cannot resolve on its own — it is a name, not
 * something derivable from the row's ids — so a caller that has already joined it (the desk board
 * query does) passes it through; without it a SYSTEM origin still says something honest rather than
 * nothing.
 */
export function originBadgeText(origin: Origin, createdByName?: string | null): string {
  switch (origin.kind) {
    case "YOU":
      return "from you";
    case "PARTNER":
      return `from ${origin.who}`;
    case "EMAIL":
      return `from ${origin.who}`;
    case "MEETING":
      return "from a meeting";
    case "CAPTURE":
      return "captured";
    case "ANOTHER_CARD":
      return "handed off";
    case "SYSTEM":
    default:
      if (createdByName) return `from ${createdByName}`;
      if (origin.who.toLowerCase().includes("sweep")) return "from the scheduled sweep";
      return "from the system";
  }
}

/**
 * WHO ACTUALLY ASKED, IN WORDS (23 Sep 2026, the work-card redesign).
 *
 * The card page said "Requested by a hand-off" on Porter's website job — true of the row (the
 * intake card handed it to him) and useless to her, because she is the one who asked, by email.
 * `originOf` answers "which door did the row come through", which the Record's filter needs; this
 * answers "who asked", which is what a person reading the card wants. The requester's address is
 * read FIRST, ahead of the hand-off, because a hand-off carries it forward.
 */
export function askedBy(
  card: OriginCard & { created_by_ai_name?: string | null },
  viewer: { id?: string | null; email?: string | null } = {},
): { who: string; how: string | null; you: boolean } {
  const email = (card.requested_by_email ?? "").trim().toLowerCase();
  if (email) {
    const partner = partnerByEmail(email);
    const viewerPartner = partnerByEmail(viewer.email ?? "") ?? partnerByFirmUserId(viewer.id ?? "");
    const you = Boolean(partner && viewerPartner && partner.firmUserId === viewerPartner.firmUserId) || email === (viewer.email ?? "").toLowerCase();
    return { who: you ? "You" : (partner?.fullName ?? email), how: "by email", you };
  }
  const by = (card.created_by ?? "").trim();
  const partner = partnerByFirmUserId(by);
  if (partner) {
    const you = Boolean(viewer.id) && by === viewer.id;
    return { who: you ? "You" : partner.fullName, how: null, you };
  }
  if (card.meeting_id) return { who: "A meeting", how: "a promise made in it", you: false };
  if (card.capture_id) return { who: "Something you captured", how: null, you: false };
  if (card.created_by_ai_name) return { who: card.created_by_ai_name, how: null, you: false };
  if (by.toLowerCase().includes("sweep") || by.toLowerCase().includes("job")) return { who: "The scheduled work", how: null, you: false };
  return { who: "The firm's own machinery", how: null, you: false };
}
