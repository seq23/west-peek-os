/**
 * Turning a sentence into a work card somebody can read before agreeing to it (P53).
 *
 * WHY ASK AND WORK STOPPED BEING TWO THINGS. Ask produced "work packets" with their own lifecycle
 * running alongside work cards, so the same request had two homes and neither was authoritative.
 * The operator's read was that Ask is superfluous if it does not lead somewhere, and the fix they
 * proposed is the right one: Ask is the front door, a card is the record. Ask drafts a card, you
 * read it, you press Add.
 *
 * NOTHING IS CREATED BY ASKING. The draft is returned, not stored. A front door that silently fills
 * the board teaches people to stop typing into it.
 *
 * THE PROMPT IS THE POINT. These employees are LLM-powered, and the difference between a card that
 * gets done well and one that does not is usually the instruction — which sources to trust, what a
 * good answer looks like, what to leave alone. Most people will not write that from a blank field,
 * so Ask writes a first draft of it and the partner edits. A prompt field nobody fills is the same
 * as no prompt field.
 */

export interface CardDraft {
  title: string;
  next_action: string | null;
  /** The instruction for whoever works it. Written for an LLM, editable by a person. */
  prompt: string;
  /** Employee NAME as the model chose it; the caller resolves it to an id, or leaves it unassigned. */
  suggested_owner: string | null;
  /** Whether doing this plainly involves reading things on the web. */
  needs_browser: boolean;
  /** Why this shape — shown so the partner can disagree with the reasoning, not just the result. */
  reasoning: string;
}

export const ASK_PROMPT_VERSION = "ask-to-card-v1";

export function buildDraftPrompt(request: string, roster: Array<{ name: string; role: string }>): string {
  return [
    "You turn a Managing Partner's request at West Peek Ventures, an earliest-stage venture fund,",
    "into ONE work card they will read and approve before anything happens.",
    "",
    "A WORK CARD IS: one thing somebody owns, with a next action. Not a project, not a list. If the",
    "request contains several things, take the FIRST one that must happen and say so in reasoning —",
    "one good card beats a plan nobody executes.",
    "",
    "THE PEOPLE WHO COULD CARRY IT:",
    ...roster.map((r) => `  ${r.name} — ${r.role}`),
    "",
    "WRITE THE PROMPT CAREFULLY. Whoever works this card is an LLM that will read your prompt and",
    "then act: it can search live sources, open specific web pages and read them, write findings",
    "down, or stop and ask a person. Your prompt should tell it:",
    "  · what a good answer actually looks like, concretely",
    "  · which sources to trust and which to treat carefully",
    "  · what NOT to do — the wrong turn a reasonable worker would take",
    "  · when to stop and ask rather than guess",
    "Write it as instructions to a capable colleague who knows the fund but not this task. Do not",
    "restate the title. Do not pad it. Six to twelve lines is usually right.",
    "",
    "RULES:",
    "- Never invent a fact about the firm. If the request assumes something you were not told, put",
    "  it in the prompt as something to confirm rather than asserting it.",
    "- needs_browser is true when doing this plainly involves reading things on the web. Say false",
    "  when the work is judgement, drafting, or something only the partners know.",
    "- Choose an owner from the list by NAME, or null if no one obviously fits. A wrong owner is",
    "  worse than none: it looks decided.",
    "",
    "THE REQUEST:",
    request,
    "",
    "Return ONLY JSON:",
    '{"title":"…","next_action":"…","prompt":"…","suggested_owner":"Name or null",',
    ' "needs_browser":true,"reasoning":"one sentence on why this shape"}',
  ].join("\n");
}

export function parseDraft(raw: string): CardDraft | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? raw).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) return null;

  let d: Record<string, unknown>;
  try {
    d = JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }

  const str = (v: unknown, max: number): string | null => {
    if (typeof v !== "string") return null;
    const t = v.trim();
    return t && t.toLowerCase() !== "null" ? t.slice(0, max) : null;
  };

  const title = str(d.title, 200);
  const prompt = str(d.prompt, 4000);
  // A draft with no title is not a card, and one with no prompt is the field this exists to fill.
  if (!title || !prompt) return null;

  return {
    title,
    next_action: str(d.next_action, 300),
    prompt,
    suggested_owner: str(d.suggested_owner, 80),
    needs_browser: d.needs_browser === true,
    reasoning: str(d.reasoning, 400) ?? "",
  };
}
