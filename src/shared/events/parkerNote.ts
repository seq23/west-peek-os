import type { ExecEmailInput } from "../email/execEmail";

/**
 * PARKER EMITS A MESSAGE, NOT A BARE PACKET (18 Sep 2026).
 *
 * ─── THE GAP THIS CLOSES ───────────────────────────────────────────────────────────────────────
 *
 * Parker's monthly Room and Workshop packets are real, researched, priced and filed as a PDF. They
 * are addressed to NOBODY: `emailPacket` sends one copy to the two partners and stops. So the
 * moment a partner wants a packet to reach the person it is actually about — a sponsor, a venue, a
 * speaker — there is nothing in the system to send. The only move left is to forward it from her
 * own mailbox.
 *
 * Her words: "a forward puts her name on his work, which is the opposite of what having employees
 * is for." A forward is also a worse message: it arrives with her signature on top of an internal
 * memo written for two people who already know what a West Peek Room is.
 *
 * ─── WHAT THE LANE NEEDS, AND WHY THIS IS A SEPARATE COMPOSITION ───────────────────────────────
 *
 * `preview_approval` stores the FINISHED MESSAGE byte for byte and "Send it" puts those exact
 * bytes on the wire from the employee's own address. That is only honest if the bytes were written
 * for the person who receives them. The partners' copy is a status report — "here is what I built,
 * keep it or say no" — and the addressed note is a letter to a stranger: who West Peek is, what
 * the Room is, what it would mean for them, and one clear ask. Same facts, different message,
 * because they answer different questions.
 *
 * So this is composed ONCE, at the point the work finishes, and never re-rendered — the same rule
 * `sendApproved` follows for every other preview. What she approves is what leaves.
 *
 * ─── NOTHING IN HERE REACHES ANYBODY BY ITSELF ─────────────────────────────────────────────────
 *
 * This module is pure: it returns an `ExecEmailInput` and sends nothing. The message goes into
 * `sendOrPreview`, the recipient is outside the firm, so `previewFirstFor` puts it in the lane and
 * the send boundary refuses it until an approval naming that exact address rides on the env. The
 * composer cannot be the thing that leaks, because the composer cannot send.
 */

export interface ParkerAddressedNoteInput {
  /** The person this is written TO. Outside the firm, which is why it goes through the lane. */
  recipient: string;
  /** "Room" or "Workshop" — the two things Parker plans. */
  what: "Room" | "Workshop";
  /** "March", "April" — the month it is proposed for, in words. */
  monthName: string;
  /** The packet's title, already stripped of any "Workshop: " prefix. */
  title: string;
  /** The one question the Room turns on, or the Workshop's promise. One sentence. */
  premise: string;
  /** Where it is, when it is known. */
  venue?: string | null;
  /** How many people are expected in the room. */
  targetMin?: number | null;
  targetMax?: number | null;
  /** A public link to the packet PDF, when one filed. */
  packetUrl?: string | null;
  /**
   * The ONE thing Parker is asking this person for. Written by the caller because it differs by
   * who they are — a sponsor is asked about a slot, a venue about a date, a speaker about a stage.
   */
  theAsk: string;
}

/**
 * The covering note, addressed.
 *
 * WRITTEN AS A LETTER, INSIDE THE FORMAT THE TRANSPORT ALREADY SPEAKS. The renderer signs every
 * employee message "— Parker, Event Marketing Coordinator", so the note ends correctly without
 * this module writing a signature that could drift from the roster.
 *
 * IT NAMES NOTHING THE RECIPIENT SHOULD NOT SEE. The partners' copy carries the firm's economics
 * — what the Room costs, what the firm keeps, which sponsors were ranked above which. None of that
 * belongs in a note to one of those sponsors, and the way to guarantee it does not appear is that
 * this function is never handed it: its input has no economics field at all.
 */
export function parkerAddressedNote(input: ParkerAddressedNoteInput): ExecEmailInput {
  const size =
    input.targetMin && input.targetMax
      ? `${input.targetMin}–${input.targetMax} people`
      : "a small, invited room";
  return {
    employee: "Parker",
    what: `West Peek's ${input.monthName} ${input.what} — ${input.title}`,
    tldr:
      `I'm Parker, West Peek's Event Marketing Coordinator, and I'm writing to you about our ` +
      `${input.monthName} ${input.what}: ${input.title}. ${input.theAsk}`,
    sections: [
      {
        label: `The ${input.what}`,
        bullets: [
          input.premise,
          `${input.monthName}, ${size}${input.venue ? `, at ${input.venue}` : ""}.`,
          ...(input.packetUrl ? [`The full packet: ${input.packetUrl}`] : []),
        ],
      },
      {
        label: "Why I am writing to you",
        bullets: [input.theAsk],
      },
      {
        label: "If you would rather not",
        bullets: [
          "Say so and I will not write again about this one.",
          "Reply to this email and it reaches West Peek — I'll see it and follow up.",
        ],
      },
    ],
  };
}

/**
 * What Parker asks a SPONSOR PROSPECT for. The default ask, kept beside the note so the two are
 * read together rather than assembled at a call site that cannot see this file.
 */
export function parkerSponsorAsk(input: { what: "Room" | "Workshop"; monthName: string }): string {
  return (
    `Would you like one of the sponsor slots on the ${input.monthName} ${input.what}? ` +
    "Tell me yes or no and I will take it from there — nothing is committed by replying."
  );
}
