/**
 * THE ANSWER LINE — rank 0 on Home, in words, from ONE count (design/HOME_DESIGN.md §3.1).
 *
 * WHAT WAS WRONG (audit #4). The masthead keyed on decisions alone ("Nothing is waiting on your
 * signature.") while the band under it said "Waiting on you 1" from decisions + blockers +
 * previews. The same page, two counts, and the largest type on it contradicted the pill beneath.
 *
 * NOW: the answer is `needsHer` — decisions + blockers + previews — in words; the detail names the
 * kinds ("Not a signature — Scooter's brief failed and Willow has it."), then what arrived, then
 * today's brief. Every clause comes from a count the page already loads; a clause with nothing to
 * say is dropped, never printed as a zero. `tests/homeAnswerLine.test.ts` pins that the answer and
 * the Waiting pill can never disagree, because they are the same number.
 */

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function inWords(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n]! : String(n);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface HomeCounts {
  /** Decisions blocked on her signature — approval cards. */
  decisions: number;
  /** Things blocking the firm that are not hers to sign: dead letters, setup, a dark provider. */
  blockers: number;
  /** The headline of the first blocker, used verbatim in the detail when there is exactly one. */
  firstBlocker?: string | null;
  /** Previews waiting on "Approve and send" — finished work that decays if she does not answer. */
  previews?: number;
  /** Things that arrived since she last looked: deliverables for her, colleagues with news. */
  fresh: number;
  /** Colleagues with nothing new. Reported, because silence from a named person is information. */
  quiet: number;
  /** Today's brief, in one clause, from the brief band's own state line; null when unknown. */
  brief?: string | null;
}

/** ONE number, shared by the answer and the Waiting band's pill. */
export function needsHer(counts: Pick<HomeCounts, "decisions" | "blockers" | "previews">): number {
  return Math.max(0, counts.decisions) + Math.max(0, counts.blockers) + Math.max(0, counts.previews ?? 0);
}

export function answerLine(counts: HomeCounts): string {
  const n = needsHer(counts);
  if (n === 0) return "Nothing is waiting on you.";
  if (n === 1) return "One thing is waiting on you.";
  return `${capitalise(inWords(n))} things are waiting on you.`;
}

/** The kinds, so "one thing" is never a mystery: what it is, and whether it needs a signature. */
export function waitingKinds(counts: HomeCounts): string | null {
  const n = needsHer(counts);
  if (n === 0) return null;
  const parts: string[] = [];
  const previews = counts.previews ?? 0;
  if (previews > 0) parts.push(previews === 1 ? "a preview to approve and send" : `${inWords(previews)} previews to approve and send`);
  if (counts.decisions > 0) parts.push(counts.decisions === 1 ? "a decision on your signature" : `${inWords(counts.decisions)} decisions on your signature`);
  if (counts.blockers > 0) {
    parts.push(
      counts.blockers === 1 && counts.firstBlocker
        ? `${counts.firstBlocker.replace(/\.$/, "")}`
        : counts.blockers === 1
          ? "one thing unfinished"
          : `${inWords(counts.blockers)} things unfinished`,
    );
  }
  const joined = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  const signature = counts.decisions === 0 && previews === 0 ? "Not a signature — " : "";
  return `${signature}${capitalise(joined)}.`;
}

export function secondLine(counts: HomeCounts): string {
  const parts: string[] = [];
  const kinds = waitingKinds(counts);
  if (kinds) parts.push(kinds);

  parts.push(
    counts.fresh === 0
      ? "Nothing arrived since you last looked."
      : counts.fresh === 1
        ? "One arrived since you last looked."
        : `${capitalise(inWords(counts.fresh))} arrived since you last looked.`,
  );

  if (counts.brief) parts.push(counts.brief.replace(/\.?$/, "."));
  else if (counts.quiet === 1) parts.push("One colleague has nothing new.");
  else if (counts.quiet > 1) parts.push(`${capitalise(inWords(counts.quiet))} colleagues have nothing new.`);

  return parts.join(" ");
}
