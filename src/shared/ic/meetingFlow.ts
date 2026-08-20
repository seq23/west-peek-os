/**
 * What actually happens when the firm runs an investment committee.
 *
 * WRITTEN FOR AN EMPTY SYSTEM, which is the state it will be in for a while — there are no IC
 * packets and no meetings recorded. The operator's report was that the section is confusing when
 * there is no packet, and the fix is not a better empty message: it is that the page should teach
 * the sequence whether or not anything has reached it yet.
 *
 * "Nothing has reached this stage" and "this is broken" look identical unless the page says which
 * one it is, and an IC is exactly the kind of process nobody wants to discover the shape of for the
 * first time on the morning it matters.
 *
 * EACH STEP NAMES WHO DOES IT. That is the difference between a diagram and an instruction: the
 * partners decide, Poppy assembles and records, Pierce carries the deal in. A step with no name
 * against it is one nobody has actually agreed to do.
 */

export interface FlowStep {
  key: string;
  title: string;
  /** What happens, in a sentence a person would say. */
  what: string;
  /** Who does it — a roster name, a partner, or both. */
  who: string;
  /** What has to be true before this step can happen at all. */
  needs: string;
}

export const IC_FLOW: readonly FlowStep[] = [
  {
    key: "ready",
    title: "A deal gets to the point of deciding",
    what:
      "Diligence is done enough to decide. Not finished — decided-on. The open questions that remain " +
      "are ones you are willing to carry, and that judgement is the actual gate.",
    who: "Pierce, with whichever partner is carrying the deal",
    needs: "A deal in the pipeline past screening.",
  },
  {
    key: "packet",
    title: "The packet is assembled",
    what:
      "One document holding what the committee needs: the company, the memo, the market, the people, " +
      "the terms, the arithmetic, and every contradiction the record has not resolved. The " +
      "contradictions travel with it deliberately — a packet that quietly drops them is how a " +
      "committee agrees on something the evidence does not support.",
    who: "Poppy assembles it",
    needs: "A deal marked ready. Nothing here is written by hand from scratch.",
  },
  {
    key: "meet",
    title: "The committee meets",
    what:
      "You work through the packet. Poppy raises the contradiction nobody wants to raise, and " +
      "records the dissent as dissent rather than smoothing it into consensus. Her job is that the " +
      "disagreement survives the meeting; she never decides anything.",
    who: "Both Managing Partners decide. Poppy facilitates and records.",
    needs: "A packet.",
  },
  {
    key: "decide",
    title: "The decision and its reasoning are recorded",
    what:
      "Yes, no, or not yet — with the reasoning, the dissent, and the assumptions the decision " +
      "rests on. Those assumptions are what gets checked back against reality at three, six and " +
      "twelve months, which is the only way a firm learns from its own decisions rather than its " +
      "outcomes.",
    who: "The partners decide; the record is written for them.",
    needs: "A meeting that reached a conclusion.",
  },
];

/**
 * Which step the firm can actually start from right now.
 *
 * Returns the first step whose precondition is not met, so the page can say "you are here" instead
 * of showing four steps and leaving the operator to work out which one is blocked.
 */
export function currentStep(counts: { readyDeals: number; packets: number; meetings: number; decisions: number }): string {
  if (counts.readyDeals === 0) return "ready";
  if (counts.packets === 0) return "packet";
  if (counts.meetings === 0) return "meet";
  if (counts.decisions === 0) return "decide";
  return "decide";
}
