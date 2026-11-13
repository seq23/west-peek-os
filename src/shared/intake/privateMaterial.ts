/**
 * A PARTNER'S "KEEP THIS PRIVATE" RIDES ON THE JOB AS A RULE (13 Nov 2026, wc_c548d043…, issue #357).
 *
 * Scooter's build request for westpeekproductions.com said one document in his Drive package was "for you two and me
 * only, so please don't copy or forward it". The job went to the Mac with `constraints: []` and built in a public repo;
 * only the plan's judgement kept the document out. Now the sentence he wrote is read here and the job carries it as a
 * standing constraint (never quote or copy that material into the repo, a commit, a PR, a preview or an email) and
 * runs private-model-only. Safety, not wording: this stays.
 */
const PRIVATE_SENTENCE =
  /(?:\b(?:do\s+not|don'?t|please\s+don'?t|never)\s+(?:copy|forward|share|publish|post)\b|\bfor\s+(?:you\s+two|the\s+(?:two|three)\s+of\s+us|us)\s+(?:and\s+me\s+)?only\b|\b(?:keep|kept)\s+(?:it|this|that|them)\s+(?:private|confidential)\b|\b(?:is|are)\s+(?:private|confidential)\b|\bconfidential\b)/i;

/** The partner's own sentence that asks for privacy, or null. Reads sentence by sentence so the rule quotes his words. */
export function privateMaterialSentence(texts: ReadonlyArray<string | null | undefined>): string | null {
  for (const t of texts) {
    const sentences = (t ?? "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/);
    const hit = sentences.find((s) => PRIVATE_SENTENCE.test(s));
    if (hit) return hit.trim().slice(0, 300);
  }
  return null;
}

/** The standing constraint a job carries when the request asked for privacy. */
export function privateMaterialConstraint(sentence: string): string {
  return (
    `PRIVATE MATERIAL — the partner wrote: "${sentence}". Use that material only to decide; never quote, copy or ` +
    `summarise its text into the repo, a commit, a PR, a preview page, a plan or any email.`
  );
}
