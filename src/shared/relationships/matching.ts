/**
 * Introductions West Peek proposes (P51, docs/COMMUNITY.md).
 *
 * "Relationship OS algorithmically matches people who should meet, sporadically — but it is not a
 * full-time job" (operator, 17 Aug 2026).
 *
 * TUNED FOR PRECISION, NOT RECALL. Every matching feature ever built dies the same way: volume. A
 * member who receives a weekly "you should meet Dev" stops opening them, and each mediocre
 * suggestion was made in West Peek's name — so the feature does not merely fade, it spends
 * credibility on the way out. Three obviously-right suggestions a month beat forty plausible ones,
 * and a proposal a partner kills costs nothing. Hence MAX_SUGGESTIONS and a floor that most pairs
 * fail.
 *
 * COMPLEMENTARITY, NOT SIMILARITY. Two people in fintech have nothing to say to each other. The
 * matches that work are need meeting experience: someone weighing whether to leave their job and
 * someone who left eighteen months ago; someone making a first engineering hire and someone who
 * just made three. So a pair is scored by A's NEED against B's EXPERIENCE — deliberately
 * asymmetric, and scored both ways round because either direction can be the good one.
 *
 * THE SIGNAL COMES FROM USE, NOT FROM A FORM. Needs are the questions members ask at a Mastermind;
 * experience is what they answer and what they host. A profile form is stale in six months, and
 * the people who fill one in most diligently are not the people you most want to match.
 */

/** Never propose more than this in one run, however good the tail looks. */
export const MAX_SUGGESTIONS = 3;

/**
 * A pair below this is not proposed at all.
 *
 * Set high on purpose. The right failure mode for this feature is proposing nothing this month.
 */
export const MIN_STRENGTH = 0.28;

export interface MatchCandidate {
  personId: string;
  displayName: string;
  /** Questions they asked — what they are working through. */
  needs: string[];
  /** Answers they gave, and what they hosted or spoke on — what they have done. */
  experience: string[];
}

export interface MatchSuggestion {
  /** The person with the need. */
  personAId: string;
  /** The person with the experience. */
  personBId: string;
  strength: number;
  rationale: string;
  needSignal: string;
  experienceSignal: string;
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these", "those",
  "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "doing", "have", "has",
  "had", "i", "you", "we", "they", "he", "she", "it", "my", "our", "your", "their", "me", "us",
  "to", "of", "in", "on", "at", "for", "with", "from", "by", "about", "as", "into", "over",
  "how", "what", "when", "where", "who", "why", "which", "should", "would", "could", "can",
  "will", "just", "not", "no", "yes", "any", "some", "all", "more", "most", "much", "very",
  "get", "got", "make", "made", "take", "one", "two", "first", "new", "own", "out", "up", "so",
  "there", "here", "you're", "im", "ive", "dont", "really", "actually", "thing", "things",
]);

/**
 * Crude suffix stripping so "hiring" matches "hire" and "founders" matches "founder".
 *
 * The same approach as the intelligence pipeline's stem(): deliberately not a real stemmer, because
 * a real one is a dependency and a source of surprises, and the vocabulary here is small.
 */
export function stem(word: string): string {
  let w = word;
  for (const suffix of ["ing", "ers", "er", "ies", "ed", "es", "s"]) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  // Drop a trailing 'e' last. Without this, "hiring" strips to "hir" while "hire" stays "hire" and
  // the two never match — which is exactly the pairing this feature exists to find.
  if (w.length > 3 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^a-z0-9']+/)) {
    if (raw.length < 3 || STOPWORDS.has(raw)) continue;
    out.add(stem(raw));
  }
  return out;
}

/**
 * Overlap between one need and one piece of experience.
 *
 * Normalised by the NEED's size rather than by the union. A short, sharp question ("how do I choose
 * a cofounder?") against a long answer should score on how much of the question the answer covers —
 * Jaccard would punish the answer for being detailed, which is backwards.
 */
export function overlap(need: Set<string>, experience: Set<string>): number {
  if (need.size === 0 || experience.size === 0) return 0;
  let shared = 0;
  for (const token of need) if (experience.has(token)) shared += 1;
  return shared / need.size;
}

/** The best need/experience pairing between two people, in one direction. */
function bestPairing(
  needer: MatchCandidate,
  expert: MatchCandidate,
): { strength: number; needSignal: string; experienceSignal: string } | null {
  let best: { strength: number; needSignal: string; experienceSignal: string } | null = null;

  for (const need of needer.needs) {
    const needTokens = tokenise(need);
    // A single meaningful word carries no topic — "Any advice?" would match everything. Two is
    // the floor rather than three because stopword removal is aggressive: "how should I make my
    // first engineering hire?" is a specific question that reduces to just {engineer, hire}.
    if (needTokens.size < 2) continue;

    for (const exp of expert.experience) {
      const strength = overlap(needTokens, tokenise(exp));
      if (!best || strength > best.strength) {
        best = { strength, needSignal: need, experienceSignal: exp };
      }
    }
  }
  return best;
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name;
}

/** A sentence a partner could paste into an email without editing it. */
export function buildRationale(a: MatchCandidate, b: MatchCandidate, needSignal: string, experienceSignal: string): string {
  const trim = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);
  return `${firstName(a.displayName)} asked about “${trim(needSignal, 90)}”. ${firstName(b.displayName)} has been through it — ${trim(experienceSignal, 90)}`;
}

/**
 * Propose introductions.
 *
 * `alreadySuggested` holds pairs that have been proposed before, in either order. Re-proposing the
 * same two people every month is the single fastest way to make this noise, and a pair a partner
 * already dismissed should stay dismissed.
 */
export function proposeMatches(
  candidates: readonly MatchCandidate[],
  alreadySuggested: ReadonlySet<string> = new Set(),
  limit: number = MAX_SUGGESTIONS,
): MatchSuggestion[] {
  const suggestions: MatchSuggestion[] = [];

  for (const a of candidates) {
    for (const b of candidates) {
      if (a.personId === b.personId) continue;
      if (alreadySuggested.has(pairKey(a.personId, b.personId))) continue;

      const pairing = bestPairing(a, b);
      if (!pairing || pairing.strength < MIN_STRENGTH) continue;

      suggestions.push({
        personAId: a.personId,
        personBId: b.personId,
        strength: Number(pairing.strength.toFixed(3)),
        rationale: buildRationale(a, b, pairing.needSignal, pairing.experienceSignal),
        needSignal: pairing.needSignal,
        experienceSignal: pairing.experienceSignal,
      });
    }
  }

  suggestions.sort((x, y) => y.strength - x.strength || x.personAId.localeCompare(y.personAId));

  // One suggestion per person per run. Handing a partner three introductions that all involve the
  // same member is one introduction with extra steps, and it burns that member's goodwill fastest.
  const used = new Set<string>();
  const chosen: MatchSuggestion[] = [];
  for (const s of suggestions) {
    if (chosen.length >= limit) break;
    if (used.has(s.personAId) || used.has(s.personBId)) continue;
    used.add(s.personAId);
    used.add(s.personBId);
    chosen.push(s);
  }
  return chosen;
}

/** Order-independent key for a pair, so A→B and B→A are the same pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Whether a suggestion is ready to become an actual introduction.
 *
 * Double opt-in. A cold connection made in West Peek's name that either side resents costs more
 * than the introduction was worth, and West Peek's whole role here is being the person whose
 * introductions are worth opening.
 */
export function readyToConnect(s: { consentA: boolean; consentB: boolean; approvedBy: string | null }): boolean {
  return s.consentA && s.consentB && Boolean(s.approvedBy);
}
