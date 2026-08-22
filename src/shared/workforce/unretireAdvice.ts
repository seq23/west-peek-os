/**
 * Advice on whether bringing somebody back is a good idea.
 *
 * OPERATOR DIRECTION: "i would like some LLM intelligence in that section to help guide us on
 * unretiring someone and making sure its a smart decision. idk how to do that."
 *
 * The honest way to do it is not to ask a model "should we un-retire Priya?", which invites a
 * confident opinion about a firm it knows nothing about. It is to give the model the specific facts
 * that make this decision non-obvious and ask it to reason about ONE thing: does this seat answer a
 * question the current roster cannot?
 *
 * That is the actual test, and it is the test the roster was consolidated on. Thirty-one seats
 * became seventeen because several pairs were the same job wearing two titles, and every un-retire
 * risks recreating exactly that. Whitney and Percy both passed it: a Market Intelligence Coach
 * re-pointed at teaching, and a Marketing Lead re-pointed at whether somebody else's page works —
 * in both cases the half of an old job that did NOT survive its merge.
 *
 * WHAT IT IS NOT ALLOWED TO DO. It does not decide, and it does not activate. It produces a
 * recommendation a partner reads before pressing a button that still requires a Managing Partner
 * receipt. A model that could bring an employee back would be a model that can change who works
 * here, which is the opposite of how every other lifecycle change in this system works.
 */

export const UNRETIRE_ADVICE_VERSION = "unretire-advice-v1";

export interface UnretireContext {
  candidate: { name: string; role: string; layer: string; retiredReason: string | null };
  /** Everyone currently employed, so overlap is judged against reality rather than memory. */
  current: ReadonlyArray<{ name: string; role: string; status: string }>;
  /** What the partner says they need. Optional — the advice is sharper with it. */
  need: string | null;
}

export function buildUnretirePrompt(ctx: UnretireContext): string {
  return [
    "You are advising the two Managing Partners of West Peek Ventures, an earliest-stage venture",
    "fund, on whether to bring a retired AI employee back.",
    "",
    "WHY THIS IS NOT OBVIOUS. This firm's roster was deliberately consolidated from thirty-one seats",
    "to seventeen, because several pairs turned out to be the same job wearing two titles — a Chief",
    "of Staff and an Executive Assistant, a Principal and an Associate, three separate people for",
    "marketing, PR and content. Every un-retirement risks recreating that. A roster nobody can hold",
    "in their head is worse than a roster with a gap in it.",
    "",
    "THE TEST, and it is the only one that matters:",
    "  Does this seat answer a question the current roster cannot?",
    "",
    "Two seats have passed it recently, and both for the same reason — the half of the old job that",
    "did NOT survive its merge was the half the firm needed. A Market Intelligence Coach came back to",
    "teach; a Marketing Lead came back to judge whether somebody else's landing page works.",
    "",
    "THE CANDIDATE:",
    `  ${ctx.candidate.name} — ${ctx.candidate.role} (${ctx.candidate.layer})`,
    ctx.candidate.retiredReason ? `  Retired because: ${ctx.candidate.retiredReason}` : "  No reason was recorded for the retirement.",
    "",
    "WHO ALREADY WORKS HERE:",
    ...ctx.current.map((e) => `  ${e.name} — ${e.role}${e.status === "ACTIVE" ? " (working now)" : " (employed, not switched on)"}`),
    "",
    ctx.need ? `WHAT THE PARTNERS SAY THEY NEED:\n  ${ctx.need}` : "The partners have not said what they need this for.",
    "",
    "ANSWER IN THIS SHAPE, and nothing else:",
    "",
    "VERDICT: one of BRING_BACK / RE_POINT / DECLINE",
    "  BRING_BACK — the seat as it stands answers something nobody currently does.",
    "  RE_POINT   — the person is right but the ROLE should change; say what to.",
    "  DECLINE    — somebody employed already covers this. Name them.",
    "",
    "WHY: two or three sentences. Name the specific overlap or the specific gap. If you say DECLINE,",
    "name who covers it and how. If you say RE_POINT, write the new role title.",
    "",
    "WATCH FOR: one sentence on what would make this a mistake in six months.",
    "",
    "RULES:",
    "- Reason only from the roster above. Do not invent an employee, a need, or a capability.",
    // Counted from what was actually passed in, not written as a word. It read "a firm with
    // nineteen seats does not usually need a twentieth" and was stale within a day of the LP
    // seats merging — a hardcoded roster size in a live prompt tells the model something false
    // about the firm, and nothing would ever have said so.
    `- Prefer DECLINE and RE_POINT. A firm with ${ctx.current.length} seats does not usually need`,
    "  another one, and the burden is on the un-retirement.",
    "- If the partners have not said what they need, say that the answer depends on it and give the",
    "  best reading you can — do not pretend to more certainty than the input supports.",
    "- No preamble, no flattery, no restating the question.",
  ].join("\n");
}

export interface UnretireAdvice {
  verdict: "BRING_BACK" | "RE_POINT" | "DECLINE";
  why: string;
  watchFor: string;
  /** Present only for RE_POINT. */
  newRole: string | null;
}

/**
 * Read the advice back.
 *
 * Returns null rather than guessing a verdict. This is shown to a partner as a recommendation about
 * who works at their firm, and a half-parsed one they act on is worse than none.
 */
export function parseUnretireAdvice(raw: string): UnretireAdvice | null {
  const verdict = /VERDICT:\s*(BRING_BACK|RE_POINT|DECLINE)/i.exec(raw);
  if (!verdict) return null;
  const why = /WHY:\s*([\s\S]*?)(?:\n\s*WATCH FOR:|$)/i.exec(raw);
  const watch = /WATCH FOR:\s*([\s\S]*?)$/i.exec(raw);
  const role = /RE_POINT[^\n]*?(?:to|as)\s+["“]?([^"”\n.]{3,80})/i.exec(raw);
  return {
    verdict: verdict[1]!.toUpperCase() as UnretireAdvice["verdict"],
    why: (why?.[1] ?? "").trim().slice(0, 900) || "No reasoning was given.",
    watchFor: (watch?.[1] ?? "").trim().slice(0, 400),
    newRole: verdict[1]!.toUpperCase() === "RE_POINT" ? (role?.[1]?.trim() ?? null) : null,
  };
}
