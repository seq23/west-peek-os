/**
 * A PARTNER'S WORDS ARE NEVER CUT SILENTLY (22 Oct 2026). Sequoia emailed a 5,725-character TLC
 * playbook; `openAssignmentCard` wrote `written.slice(0, 4000)` into the card, so the brief stopped
 * mid-word at "Sequoia and Scooter: decid" — the drip, WHERE WE DECIDE and the HARD RULES ("nothing
 * goes to any brand until I approve the one-pager") were gone from the card with nothing saying so,
 * and the hand-off cut the same description at 4,000 again. Text short of the cap is returned whole;
 * text past it says where it stops and where the rest is, so nobody works from a part believing it
 * is the whole.
 */
export function statedCut(text: string, cap: number, rest: string): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n[… cut here at ${cap.toLocaleString("en-US")} of ${text.length.toLocaleString("en-US")} characters — the rest is in ${rest}]`;
}

/**
 * How much of a partner's own words a card's description carries. Sized so the longest playbook a
 * partner has written fits with room, under the description's 16,000-character ceiling that the
 * "Stored message:" line and hand-off notes are appended within.
 */
export const PARTNER_WORDS_ON_CARD = 12_000;

/**
 * How much of the stored original an employee's prompt carries (`storedMessageFor`). It was 6,000;
 * the TLC playbook was 5,725, so the next longer one would have lost its end in the prompt as well.
 */
export const STORED_MESSAGE_IN_PROMPT = 20_000;
