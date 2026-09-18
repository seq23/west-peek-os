import { PREVIEW_PARTNER, isPartnerEmail, partnerByEmail } from "../registry/partners";

/**
 * FINISHED WORK HAS TO LAND SOMEWHERE A PERSON CAN OPEN IT (18 Sep 2026).
 *
 * ─── WHAT HAPPENED ─────────────────────────────────────────────────────────────────────────────
 *
 * The owner asked for a one-off: Parker drafts an event kit for an October workshop with Kirx Diaz,
 * previewed to her before it goes to Scooter. She said, in caps, that the point was that he would
 * email it to her.
 *
 * Parker did the work. Five `ai_run` rows, all COMPLETED, all on a free reasoning lane at $0, and
 * the last one's `output_text` holds a genuinely complete kit — three angles, a recommendation with
 * reasoning, a full run of show with an on-screen column, a discussion guide, social drafts.
 *
 * Then:
 *
 *     work_card         state = DONE, work_attempts = 1
 *     deliverable       NO row
 *     work_packet       0 rows
 *     preview_approval  0 rows
 *     email to her      none
 *
 * The card closed DONE having produced nothing anybody can open. The kit existed only inside
 * `ai_run.output_text`, which is a table nobody reads and no page renders.
 *
 * THAT IS RULE 0 IN THIS REPO'S OWN WORDS — "no stage may exit 0 having done nothing" — landing on
 * the single piece of work the owner most wanted that day.
 *
 * ─── WHY THE EVENT-KIT STAGE WAS NEVER REACHED, WHICH IS NOT THE DEFECT ────────────────────────
 *
 * `services/eventKit.ts` and the `event_kit` deliverable kind both exist, and neither was involved.
 * They are not missing: `buildAndFileEventKit` is a STAGE OF THE MONTHLY PACKET MACHINE, called
 * from `services/roomPacket.ts` and sourced from an `evt_room_packet` row. A one-off card has no
 * packet, so there is no route from it into that stage and there should not be one — synthesising a
 * fake packet to reach a stage is how a machine acquires a second, unvalidated entrance.
 *
 * So the diagnosis is NOT "the wrong path was taken". Parker took the only path a one-off card has,
 * the generic employee loop, and PRODUCED THE ARTIFACT ANYWAY. The loss was in filing, not in
 * generation. The honest fix is therefore the one the generic loop was always missing: what an
 * employee finishes is filed, and a card cannot close without it.
 *
 * ─── THE TWO RULES THIS MODULE HOLDS ───────────────────────────────────────────────────────────
 *
 *   1 · A CARD CLOSES ONLY WITH PROOF. `CloseProof` is the type, and there are exactly two honest
 *       shapes: something was FILED, or the work was HANDED ON to another card. There is no third
 *       constructor, so "closed having done nothing" is not a state this code can express. The
 *       helper in `services/employeeWork.ts` takes one and there is no other statement in that file
 *       that writes `state = 'DONE'` — `scripts/validate/a-finished-card-files-its-work.mjs` fails
 *       the build if one appears.
 *
 *   2 · A RESULT ALWAYS HAS A PERSON. `recipientForResult` is TOTAL: every input returns a partner
 *       out of the registry. There is no "nobody", which is the state the Kirx card was in — its
 *       `result_recipient` and `preview_first` were both NULL, because it predates the change that
 *       made those writable, so the preview lane correctly did nothing and the work rested on a
 *       closed card where she never saw it. Correct in mechanism, useless in outcome.
 *
 * ─── THE RULE WAS ALREADY WRITTEN DOWN, AND NOTHING READ IT ────────────────────────────────────
 *
 * `services/workCards.ts`, above the `result_recipient` field, has said since migration 0183:
 *
 *     "`result_recipient` blank means IT IS FOR HER: it lands on Home, there is nothing to send and
 *      nothing to preview."
 *
 * Nothing implemented that sentence. A blank recipient meant the result landed NOWHERE. This is the
 * repo's named defect class — "a specification no code reads is a wish" — and the fix is not to
 * rewrite the sentence but to move it into a function something calls and a validator exercises.
 *
 * ─── WHY PROSE IN A BRIEF MAY ADD A PREVIEW AND MAY NEVER NAME AN ADDRESS ──────────────────────
 *
 * The Kirx card's brief says, in prose, "send it to me first for approval before Scooter". It is
 * tempting to parse that and address the result from it. THIS MODULE DELIBERATELY DOES NOT, and the
 * reason is the preview lane's own stated asymmetry in `shared/work/previewLane.ts`: a card "can
 * ADD a preview, never remove one".
 *
 * A recipient derived from prose is a SEND TARGET chosen by text that a model wrote and that
 * anybody who can create a card can influence. It would make the outbound address of firm mail a
 * function of an unvalidated string — the one thing the registry, `isPartnerEmail` and
 * `assertPreviewLane` exist to prevent. An address must come from a structured field a person set.
 *
 * The prose is still honoured, and completely, because of what it actually asks for: that SHE sees
 * it first. A result with no structured recipient is filed to her and goes nowhere else. Scooter
 * sees nothing. That is the whole of what she asked for, obtained without inventing a send target.
 */

/** The kind a finished generic work card files under. Widened into `deliverable.kind` by 0196. */
export const WORK_RESULT_KIND = "work_result";

/**
 * Why a card was allowed to close. Two constructors, both requiring an id that has to exist.
 *
 * THE TYPE IS THE GUARD. A boolean `filed: true` would have been satisfied by a caller that passed
 * `true` and filed nothing, which is the same defect one layer up. Demanding the id of the thing
 * that was produced means the proof cannot be written without the thing existing first.
 */
export type CloseProof =
  | { readonly closed: "FILED"; readonly deliverableId: string }
  | { readonly closed: "HANDED_ON"; readonly toCardId: string };

export interface ResultRecipientInput {
  /** `work_card.result_recipient` — the address a person typed into "Who is this for?". */
  resultRecipient?: string | null;
  /** `work_card.requested_by_email` — the authenticated address the work was asked for from. */
  requestedByEmail?: string | null;
}

export interface ResultRecipient {
  /** Whose Home it lands on. Always a real partner out of the registry; never null, never blank. */
  firmUserId: string;
  /** The outside address the card named, when it named one. Null when nobody was named. */
  namedRecipient: string | null;
  /**
   * True when somebody outside still has to receive this after she says yes — i.e. the result
   * belongs in the preview lane rather than merely on a Home page.
   */
  onwardSend: boolean;
  /** One line, for the card, the event and her Home. */
  why: string;
}

/**
 * Who does a finished result go to? TOTAL — every input returns a partner.
 *
 * THE THREE CASES, AND WHY THE MIDDLE ONE IS NOT "SEND IT".
 *
 *   · NOBODY NAMED → it is the asker's, and hers when nobody asked. This is the sentence from
 *     `workCards.ts` finally executing. Nothing is sent, because nothing was addressed.
 *   · A PARTNER NAMED → that partner's Home. Inside the firm, so there is no preview to hold and
 *     nothing to approve; it is already with the person it is for.
 *   · SOMEBODY OUTSIDE NAMED → prepared for HER, with `onwardSend` set. It lands on her Home as a
 *     draft addressed to that person, and it moves only when she says so. Her stated default rule:
 *     "anything to anyone other than sequoia@ and scooter@ should be default preview."
 *
 * The asker is preferred over her for an unaddressed result so that Scooter's own one-off cards
 * come back to Scooter, matching `previewOwnerFor` in `services/previewApproval.ts`. It can only
 * ever resolve to a partner, because `partnerByEmail` only answers out of the registry.
 */
export function recipientForResult(input: ResultRecipientInput): ResultRecipient {
  const named = (input.resultRecipient ?? "").trim().toLowerCase();
  const asker = partnerByEmail(input.requestedByEmail) ?? PREVIEW_PARTNER;

  if (named === "") {
    return {
      firmUserId: asker.firmUserId,
      namedRecipient: null,
      onwardSend: false,
      why:
        `Nobody was named as the recipient, so the result is ${asker.firstName}'s: it lands on ` +
        `${asker.firstName}'s Home and is sent to nobody.`,
    };
  }

  if (isPartnerEmail(named)) {
    const partner = partnerByEmail(named)!;
    return {
      firmUserId: partner.firmUserId,
      namedRecipient: named,
      onwardSend: false,
      why: `${partner.fullName} is a Managing Partner, so the result is filed straight onto ${partner.firstName}'s Home.`,
    };
  }

  return {
    firmUserId: PREVIEW_PARTNER.firmUserId,
    namedRecipient: named,
    onwardSend: true,
    why:
      `${named} is not one of the two partners, so the result goes to ${PREVIEW_PARTNER.firstName} ` +
      `first and reaches ${named} only when she says so.`,
  };
}

/**
 * The title a filed result carries on a Home page.
 *
 * The card's own title, because that is the sentence the partner wrote when they asked for the
 * work, and it is the one string guaranteed to mean something to the person reading the list.
 */
export function resultTitleFor(cardTitle: string): string {
  const trimmed = cardTitle.trim();
  return (trimmed === "" ? "Finished work" : trimmed).slice(0, 200);
}
