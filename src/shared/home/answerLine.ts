/**
 * RANK 0 ON HOME: the one line that answers the question the page exists to answer.
 *
 * Home used to open with "This evening, Sequoia" — a greeting, set in the largest type on the
 * page — while the thing a partner actually came for ("is anything blocked on me?") was spelled
 * out in three places further down at three different weights, one of which was a grey line
 * floated into the far right corner. The operator's words on 18 Sep 2026 were "i can't keep up"
 * and "the headings have no visual weight".
 *
 * So the largest type now states the answer, and the greeting is the eyebrow above it. Both lines
 * are derived from counts Home has already computed — `waiting.count`, the operator-attention
 * list, and the deliveries that are NEW since she last looked. Nothing here fetches anything and
 * nothing here rounds: a page that says "two decisions" when there are three is worse than a page
 * that says nothing.
 *
 * PURE, AND IN `shared/`, because the sentence is the product decision — the grammar of "one
 * decision is" against "two decisions are", and the rule that a blocker is not a signature — and a
 * product decision that lives inside a JSX expression is a product decision nobody can test.
 */

/** One to nine in words; ten and up stay as digits, where a numeral reads faster than a word. */
const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function inWords(n: number): string {
  return n >= 0 && n < WORDS.length ? WORDS[n]! : String(n);
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface HomeCounts {
  /** Decisions blocked on her signature — approvals, and only approvals. */
  decisions: number;
  /** Things blocking the firm that are not hers to sign: dead letters, setup, a dark provider. */
  blockers: number;
  /** The headline of the first blocker, used verbatim in the second line when there is exactly one. */
  firstBlocker?: string | null;
  /** Colleagues with something NEW since she last looked. Quiet is not new. */
  fresh: number;
  /** Colleagues with nothing new. Reported, because silence from a named person is information. */
  quiet: number;
}

/**
 * The answer line.
 *
 * KEYED ON DECISIONS ALONE. A blocker is real and it is on the page, but it is not waiting on her
 * SIGNATURE, and a headline that conflates the two teaches her to discount it. The zero case is
 * stated here rather than as a headed, empty "Waiting on you (0)" section — that section no longer
 * renders at all, because a screenful that says nothing is the worst use of the top of this page.
 */
export function answerLine(counts: HomeCounts): string {
  if (counts.decisions <= 0) return "Nothing is waiting on your signature.";
  if (counts.decisions === 1) return "One decision is waiting on you.";
  return `${capitalise(inWords(counts.decisions))} decisions are waiting on you.`;
}

/**
 * The second line: what is unfinished, what the firm produced, and who was silent.
 *
 * Every clause is dropped when its count is zero rather than rendered as "0 blockers" — the whole
 * point of the rewrite is that empty states shrink instead of occupying.
 */
export function secondLine(counts: HomeCounts): string {
  const parts: string[] = [];

  if (counts.blockers === 1) {
    parts.push(
      counts.firstBlocker
        ? `One thing is unfinished — ${counts.firstBlocker.replace(/\.$/, "")}.`
        : "One thing is unfinished.",
    );
  } else if (counts.blockers > 1) {
    parts.push(`${capitalise(inWords(counts.blockers))} things are unfinished.`);
  }

  parts.push(
    counts.fresh === 0
      ? "Nothing new from your team since you last looked."
      : counts.fresh === 1
        ? "One of your team has something new for you."
        : `${capitalise(inWords(counts.fresh))} of your team have something new for you.`,
  );

  if (counts.quiet === 1) parts.push("One colleague has nothing new.");
  else if (counts.quiet > 1) parts.push(`${capitalise(inWords(counts.quiet))} colleagues have nothing new.`);

  return parts.join(" ");
}
