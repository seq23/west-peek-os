/**
 * DOES A REPLY CONTAIN A REAL QUESTION, SEPARATE FROM ANY STEERING IN IT (22 Sep 2026)?
 *
 * ─── THE GAP THIS CLOSES ────────────────────────────────────────────────────────────────────────
 *
 * On 21 Sep, Scooter replied to Walker's weekly hire-search deliverable — a DONE card — with two
 * things in one message: a steering instruction ("prefer candidates with a music background going
 * forward") and a genuine question ("What's her email, do you have it, this first candidate?").
 * `steerFromReply` (`services/emailThread.ts`) correctly filed the steering half into `work_steer`.
 * It had nothing at all to do with a DONE card — its two branches only fire for `BLOCKED` (answers
 * a block) or `OPEN`/`IN_PROGRESS` (leaves a note) — so the question was silently dropped. No error,
 * no card, nothing a person would ever see. This is the detector that closes that: is there a
 * question IN HERE that needs answering, mixed in with the steering or standing alone.
 *
 * ─── WHY THIS IS NOT THE SAME JOB AS `ACTIONABILITY_VERDICTS` ─────────────────────────────────────
 *
 * `webPropertyChange.ts`'s three-way classifier (`ACTIONABLE_WORK` / `QUESTION_NEEDS_REPLY` /
 * `BANTER_NO_ACTION`) answers "what is this WHOLE message, as one thing" — and Scooter's real
 * message is exactly the case it cannot answer correctly: it contains a real instruction (steering)
 * AND a real question in the same breath, so a classifier forced to pick ONE verdict for the whole
 * text, biased hard toward `ACTIONABLE_WORK`, would call it actionable work (there IS a real ask —
 * the steering) and never surface that a question also needs a reply. This detector asks a
 * different, narrower question — "does the text contain an interrogative that wants an answer,
 * regardless of what else is in it" — which is answerable without a model call at all.
 *
 * ─── WHY A HEURISTIC, NOT ANOTHER MODEL CALL ───────────────────────────────────────────────────────
 *
 * "Is there a question mark, or a sentence that opens with an interrogative word" is a mechanical,
 * deterministic fact about the text — not a judgement call the way "is this actionable work" is.
 * A heuristic here is testable exhaustively, costs nothing, and cannot itself hallucinate an answer
 * into existence the way a model asked "is this a question" occasionally does by answering the
 * question instead of classifying it. The actual ANSWERING of a detected question (`emailThread.ts`
 * → `answerQuestionForCard`, `services/questionRouting.ts`, Addendum 12) is where a grounded model
 * call belongs, and that step already carries its own "never guess" discipline.
 *
 * ─── THE BIAS, MATCHING ADDENDUM 10'S POSTURE ──────────────────────────────────────────────────────
 *
 * Same rule as `defaultClassifyActionability`: when genuinely unsure, treat it as the thing that
 * gets a human's attention rather than the thing that goes quiet. A literal "?" anywhere in the
 * written text is enough on its own. Short of that, a sentence opening with a wh-word or a common
 * auxiliary/modal verb ("What...", "Do you...", "Can you...", "Is there...") is read as a question
 * even with no closing mark, because a reply typed on a phone in a hurry — exactly how Scooter's
 * was sent — routinely drops the punctuation. A false positive here costs nothing but an extra,
 * clearly-labelled note or notice a person can ignore in a second; a false negative is the bug that
 * started this.
 */

/**
 * A sentence-ish chunk starts a genuine question when it opens with one of these, case-insensitive.
 *
 * `'?s?` AFTER THE BASE WORD, not a plain `\b` — because "whats her email" (no apostrophe, typed on
 * a phone in a hurry — the exact shape a real reply arrives in) must read as a question exactly like
 * "what's her email" does. A bare `\bwhat\b` does not match "whats" at all: the trailing "s" is a
 * word character, so there is no boundary between them and the alternative simply fails.
 */
const QUESTION_OPENERS =
  /^(?:so\s+|and\s+|but\s+)?(what|who|whom|whose|where|when|why|how|which|is|isn't|are|aren't|am|was|wasn't|were|weren't|do|don't|does|doesn't|did|didn't|can|can't|could|couldn't|would|wouldn't|will|won't|shall|should|shouldn't|may|might|have|haven't|has|hasn't)'?s?\b/i;

/** Split written text into sentence-ish chunks on `.`, `!`, `?`, and newlines — good enough for a heuristic scan. */
function chunksOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((c) => c.trim())
    .filter((c) => c.length > 0);
}

/**
 * True when the written text (the person's own words, never the quoted original — see
 * `replyBody.ts`) contains something that reads as a genuine question needing an answer.
 *
 * Biased toward yes: a literal "?" anywhere is sufficient by itself. Failing that, any chunk that
 * OPENS with an interrogative word — a real leading word, not one merely present anywhere in the
 * text, so "I know what you mean" is not mis-read as a question — counts.
 */
export function containsGenuineQuestion(written: string): boolean {
  const text = (written ?? "").trim();
  if (!text) return false;
  if (text.includes("?")) return true;
  return chunksOf(text).some((chunk) => QUESTION_OPENERS.test(chunk));
}
