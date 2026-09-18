/**
 * THE ONE SENTENCE THE WORK PAGE OPENS WITH.
 *
 * The page used to open with a count — "2 waiting on you" — set in the same 18px/700 as the two
 * band headings underneath it and the three in-flight rows below those. Measured on the live page
 * on 18 Sep 2026: every `h3` and every `h4` inside `work-cards-page` rendered at 18px/700. There
 * were three ranks of meaning on that page and one rank of type, which is the operator's "the
 * headings have no visual weight", said again about a second surface.
 *
 * A COUNT IS NOT AN ANSWER. "2" is a number she still has to interpret against a page five
 * thousand pixels tall. The Home redesign settled this the week before — rank 0 is a sentence that
 * answers the question she opened the page with — and Work is asked the same question: is there
 * anything here that needs me?
 *
 * SAID IN BOTH DIRECTIONS. "Nothing is waiting on you." is the answer on most days and it is worth
 * as much as the other one: it is what lets her close the page. The old header said "0 waiting on
 * you" in one branch and "17 open, none waiting on you" in another, both of which make her count.
 */

export interface DeskCounts {
  /** Cards that are blocked, unowned, or hers — nothing moves until she acts. */
  waiting: number;
  /** Decks proposed and awaiting her approve-or-send-back. */
  decks: number;
  /** Cards employees or her partner are carrying right now. */
  inFlight: number;
  /** Cards that have already failed at least once and are still retrying. */
  failing: number;
}

export interface DeskAnswer {
  /** The sentence, rank 0 on the page. */
  line: string;
  /** Whether anything at all needs her — drives the header pill's tone. */
  clear: boolean;
  /** The count the header pill shows beside it. */
  count: number;
}

const WORDS = ["Nothing", "One thing", "Two things", "Three things", "Four things", "Five things", "Six things"];

/** `3` → `Three things`; beyond six it is a numeral, because "Seventeen things" reads as prose. */
function things(n: number): string {
  return n < WORDS.length ? WORDS[n]! : `${n} things`;
}

export function deskAnswer(counts: DeskCounts): DeskAnswer {
  const needed = counts.waiting + counts.decks;
  if (needed > 0) {
    const subject = things(needed);
    const verb = needed === 1 ? "is" : "are";
    return {
      line: `${subject} ${verb} stopped until you answer.`,
      clear: false,
      count: needed,
    };
  }
  /*
   * A CARD THAT IS FAILING IS NOT YET WAITING ON HER — the sweep is still retrying it — but it is
   * the thing most likely to become the next block, and saying nothing about it while the page
   * reads "nothing is waiting" is how she found out about the 17 Sep credit failure by asking.
   */
  if (counts.failing > 0) {
    return {
      line:
        counts.failing === 1
          ? "Nothing is waiting on you yet — one card has failed once and is being tried again."
          : `Nothing is waiting on you yet — ${counts.failing} cards have failed and are being tried again.`,
      clear: false,
      count: 0,
    };
  }
  return { line: "Nothing is waiting on you.", clear: true, count: 0 };
}

/**
 * The line under the answer: what the rest of the page is doing while she is not needed.
 *
 * Returns null when there is nothing to say, so the page renders no empty paragraph — an element
 * that is sometimes blank is a layout shift with a semantic excuse.
 */
export function deskSubline(counts: DeskCounts): string | null {
  if (counts.inFlight === 0) return null;
  return counts.inFlight === 1
    ? "One card is being worked right now."
    : `${counts.inFlight} cards are being worked right now.`;
}
