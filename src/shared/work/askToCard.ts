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

/**
 * THREE HONEST OUTCOMES, because a request is not always work.
 *
 * The operator's instinct was that Ask should route rather than always produce a deliverable, and
 * that some asks genuinely do produce one. Both are right, and the distinction is what the request
 * IS:
 *
 *   GO   — the answer already exists on a page. "What have we spent?" is not work; it is a page
 *          somebody has not found. Making a card for it would create a task to go and look at
 *          something that is already there.
 *   WORK — nobody has done this and somebody must. That is a card.
 *   TELL — the system holds the answer and can just say it.
 *   BRIEF — the answer has to be RESEARCHED and written up, and what you want back is a document.
 *
 * Forcing everything into a card is how a board fills with items that were only ever questions.
 *
 * WHY BRIEF IS SEPARATE FROM WORK, which is the distinction that took longest to see. A card is
 * work somebody CARRIES: it has an owner, a next action, and it sits on a board until it is done.
 * A brief is a document you asked for and will receive — nobody carries it, and putting it on the
 * board as a card means a board full of things that are really just questions with a deadline.
 *
 * This is what the "work packet" flow always was. It was built first, wears builder vocabulary —
 * lens stack, acceptance criteria, output definition — and had produced exactly zero packets,
 * because no partner ever thinks in those words. Same machinery, asked for the way somebody would
 * actually ask, and delivered the way everything else here is delivered: signed, filed, downloadable.
 */
export type AskOutcome = "GO" | "WORK" | "TELL" | "BRIEF";

export interface AskAnswer {
  outcome: AskOutcome;
  /** For GO: the nav key to send them to, and what they will find. */
  page?: string | null;
  /** One or two sentences: the answer, or why this page, or why this is work. */
  says: string;
  /** For WORK: the card to read and accept. */
  card?: CardDraft | null;
  /** For BRIEF: what to research and write up, and who should sign it. */
  brief?: BriefRequest | null;
}

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

export interface BriefRequest {
  /** What the finished document is called. */
  title: string;
  /** The question it answers, stated once so the writer cannot drift off it. */
  question: string;
  /** Employee NAME the model thinks should write it; resolved by the caller. */
  suggested_author: string | null;
  /** Whether answering it plainly requires reading things on the web. */
  needs_browser: boolean;
  /** Why a document rather than a card — shown so the partner can disagree with the shape. */
  reasoning: string;
}

export const ASK_PROMPT_VERSION = "ask-to-card-v2-brief";

export function buildDraftPrompt(
  request: string,
  roster: Array<{ name: string; role: string }>,
  pages: Array<{ key: string; purpose: string }>,
): string {
  return [
    "First decide WHICH OF FOUR THINGS this request is. Getting this right matters more than the",
    "rest: a board that fills with items which were only ever questions stops being read.",
    "",
    '  GO   — the answer already exists on a page of this system. Choose this whenever somebody is',
    "         asking where something is, or for a figure or list a page already shows. Making work",
    "         out of it would create a task to go and look at something already there.",
    "",
    '  WORK — nobody has done this and somebody has to. Finding something out, checking something,',
    "         producing something that does not exist yet.",
    "",
    '  TELL — you can answer it outright from what is in the request and general knowledge, and no',
    "         page and no work is involved. Use this sparingly; prefer GO when a page holds it.",
    "",
    '  BRIEF — what they want back is a DOCUMENT. The answer has to be researched and written up,',
    "         and when it is finished they want to read it, keep it, and probably send it to their",
    "         partner. Nobody carries a brief the way somebody carries a task.",
    "",
    "         WORK vs BRIEF is the distinction to get right. A card is work somebody CARRIES: it has",
    "         an owner, a next action, and it sits on a board until it is done. A brief is something",
    "         they asked for and will RECEIVE. 'Check whether Psyflo still lists a VP of Sales' is a",
    "         card — one act, one answer, then it is over. 'What are comparable seed valuations in",
    "         devtools right now' is a brief — it needs gathering, weighing and writing up, and what",
    "         they want at the end is a page they can read. When in doubt ask: would they be",
    "         satisfied by a sentence, or do they want something to read?",
    "",
    "THE PAGES OF THIS SYSTEM:",
    ...pages.map((p) => `  ${p.key} — ${p.purpose}`),
    "",
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
    "Return ONLY JSON.",
    'For GO:   {"outcome":"GO","page":"<one key from the list>","says":"what they will find there"}',
    'For TELL: {"outcome":"TELL","says":"the answer"}',
    'For WORK: {"outcome":"WORK","says":"one sentence on why this is work",',
    '           "card":{"title":"…","next_action":"…","prompt":"…","suggested_owner":"Name or null",',
    '                   "needs_browser":true,"reasoning":"why this shape"}}',
    'For BRIEF:{"outcome":"BRIEF","says":"one sentence on what they will get back",',
    '           "brief":{"title":"…","question":"the one question it answers","suggested_author":"Name or null",',
    '                    "needs_browser":true,"reasoning":"why a document rather than a card"}}',
  ].join("\n");
}

/** Read the answer back, whichever of the three it is. */
export function parseAnswer(raw: string, validPages: ReadonlySet<string>): AskAnswer | null {
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

  const outcome = String(d.outcome ?? "").toUpperCase();
  const says = typeof d.says === "string" ? d.says.trim().slice(0, 1200) : "";
  if (!says) return null;

  if (outcome === "GO") {
    const page = typeof d.page === "string" ? d.page.trim() : "";
    // A page that does not exist would send somebody nowhere, which is worse than saying so.
    if (!validPages.has(page)) return null;
    return { outcome: "GO", page, says };
  }
  if (outcome === "TELL") return { outcome: "TELL", says };
  if (outcome === "WORK") {
    const card = d.card && typeof d.card === "object" ? parseDraft(JSON.stringify(d.card)) : null;
    if (!card) return null;
    return { outcome: "WORK", says, card };
  }
  if (outcome === "BRIEF") {
    const b = d.brief as Record<string, unknown> | undefined;
    if (!b || typeof b !== "object") return null;
    const title = typeof b.title === "string" ? b.title.trim().slice(0, 160) : "";
    const question = typeof b.question === "string" ? b.question.trim().slice(0, 600) : "";
    // A brief with no question is a document with no job. Refused rather than half-built: the
    // partner is about to commission a piece of writing and needs to see what it will answer.
    if (!title || !question) return null;
    return {
      outcome: "BRIEF",
      says,
      brief: {
        title,
        question,
        suggested_author: typeof b.suggested_author === "string" && b.suggested_author.trim()
          ? b.suggested_author.trim().slice(0, 80)
          : null,
        needs_browser: b.needs_browser === true,
        reasoning: typeof b.reasoning === "string" ? b.reasoning.trim().slice(0, 600) : "",
      },
    };
  }
  return null;
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
