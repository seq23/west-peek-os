/**
 * WHAT SHE TYPED, AND WHAT IT TURNED INTO (16 Sep 2026).
 *
 * ─── The operator's words, twice ───────────────────────────────────────────────────────────────
 *
 *   "when I give a task, the agent should use an LLM that is highly intelligent to interpret the
 *    ask" — and — "make sure everything I say reaches a thinking model."
 *
 * ─── What was actually true before this file existed ───────────────────────────────────────────
 *
 * TWO KINDS OF WORK, AND ONLY ONE OF THEM COULD HEAR HER.
 *
 *   • The general employee loop (`services/employeeWork.ts`) puts `work_card.prompt` and every
 *     unanswered steering note straight into the step prompt. Her words reach a model there, and
 *     the employee has to acknowledge them in writing before it may carry on.
 *
 *   • The specialised CHAINS — Parker's Room and Workshop packets, Walker's Productions duties and
 *     hire search, a partner's blog help, Preston's deck rework — are dispatched by `work_card.kind`
 *     in `services/workSweep.ts` and never run that loop. Each is a fixed sequence of research and
 *     judgement steps. Every one of them read the packet row, the month and the roster, and NONE of
 *     them read `work_card.prompt`, a steering note, or the answer she typed into a block.
 *
 * So she could type an instruction onto a chain card, press send, and it would be stored and never
 * read by anything. That is how Parker built the wrong thing and then blocked: she asked for
 * "a packet on workshops, much like he does for rooms", and that sentence reached nothing.
 *
 * ─── The fix, and why it is not "pass the string through" ──────────────────────────────────────
 *
 * DELETING THE CHAINS WAS NEVER THE ANSWER. Their steps are real: what a named sponsor actually
 * sponsors, who runs its partnerships, three concepts compared, a venue with a reason, a run of
 * show to the minute. A one-prompt packet was tried and the operator's verdict was "sub par".
 *
 * So the human's words STEER the chain rather than replace it. Exactly one model call, before the
 * chain's first stage, reads everything she has said about this card and returns three things:
 *
 *   UNDERSTOOD  — one sentence restating what she asked for, in her terms. This is the receipt.
 *   STEER       — the directives the stages must carry, each tied to the stage it changes.
 *   CANNOT      — anything in her words this chain has no step for.
 *
 * A NON-EMPTY `CANNOT` STOPS THE WORK. That is the whole difference between steering and theatre:
 * a step whose input includes prose it cannot honour says so, rather than silently doing the
 * default and reporting success. Rule 0 applies to a stage that read an instruction and ignored it.
 *
 * WHY THE PARSE IS STRICT AND SILENT FAILURE IS NOT ALLOWED. `parseInterpretation` returns null for
 * anything it cannot read. The caller must then block the card — never carry on with an empty
 * steer, which would be indistinguishable from the defect this replaces.
 */

/** Where one piece of human prose attached to a card came from. */
export const INSTRUCTION_SOURCES = ["PROMPT", "BRIEF", "NOTE", "BLOCK_ANSWER", "DESCRIPTION"] as const;
export type InstructionSource = (typeof INSTRUCTION_SOURCES)[number];

export interface InstructionPiece {
  source: InstructionSource;
  /** The words, exactly as the human typed them. Never paraphrased before storage. */
  text: string;
  /** Who said it, for the prompt and for the receipt. */
  who?: string | null;
  /** Set for a NOTE, so it can be acknowledged once it has been interpreted. */
  noteId?: string;
}

/** What the model made of it. */
export interface Interpretation {
  /** One sentence, in her terms. The left-hand side of the receipt is her words; this is the right. */
  understood: string;
  /** Directives the chain's stages must carry. Empty is legitimate — "carry on as normal". */
  steer: string[];
  /** Anything asked for that this chain has no step for. Non-empty means the card blocks. */
  cannot: string[];
}

/** How a source reads on the page and in the prompt. */
export const SOURCE_LABELS: Readonly<Record<InstructionSource, string>> = {
  PROMPT: "How you said you wanted it done",
  BRIEF: "What you asked for when you requested it",
  NOTE: "A note you left while the work was running",
  BLOCK_ANSWER: "Your answer when it came back to you blocked",
  DESCRIPTION: "The request as it was written down",
};

/**
 * Prose that is not an instruction.
 *
 * A chain card's `description` is written BY THE SYSTEM — `openPacketCard` composes it from the
 * month, the packet id and a recital of the chain's own stages. Feeding that back to a model as
 * "what the human asked for" would have the interpreter solemnly restating the chain's own
 * description of itself, and every card would carry a steer nobody wrote. Only the parts of a
 * description that quote a human survive, which the services do by passing BRIEF/PROMPT explicitly.
 */
export function isWorthInterpreting(pieces: InstructionPiece[]): boolean {
  return pieces.some((p) => p.text.trim().length >= MIN_INSTRUCTION_CHARS);
}

/** Below this, a "note" is an acknowledgement or a typo, not an instruction worth a model call. */
export const MIN_INSTRUCTION_CHARS = 4;

export interface InterpretationContext {
  /** The card's title, so the model knows what the words are about. */
  title: string;
  /** Who is carrying it. */
  employee: string;
  /** What this chain is, in one line: "Parker's Room packet", "Walker's weekly hire search". */
  chain: string;
  /**
   * THE STEPS THE CHAIN ACTUALLY HAS, named. Without this the model cannot tell the difference
   * between "widen the sponsor search" (a steer) and "also book the venue" (a CANNOT), and every
   * instruction would come back honourable. The list is the chain's real stage labels.
   */
  steps: string[];
  /** Everything a human has said about this card, oldest first. */
  pieces: InstructionPiece[];
}

export const INTERPRETATION_PROMPT_VERSION = "instruction/v1";

/**
 * The prompt. Deliberately asks for a restatement FIRST: a model that has to say what it thinks it
 * was asked before it says what it will do cannot smuggle a default past the reader of the receipt.
 */
export function buildInterpretationPrompt(ctx: InterpretationContext): string {
  return [
    `You are interpreting an instruction given by a partner of West Peek Ventures to ${ctx.employee}, who is carrying out ${ctx.chain}.`,
    "",
    `THE WORK: ${ctx.title}`,
    "",
    "THE STEPS THIS WORK HAS, and it has no others:",
    ...ctx.steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    "WHAT THE PARTNERS HAVE SAID ABOUT IT, oldest first, in their own words:",
    ...ctx.pieces.map((p) => `  [${SOURCE_LABELS[p.source]}${p.who ? `, ${p.who}` : ""}] ${p.text.trim()}`),
    "",
    "YOUR JOB. Work out what they actually want, including anything they meant but did not spell out.",
    "A later instruction outranks an earlier one where they conflict. Answer in exactly this shape,",
    "with no preamble and nothing after the last line:",
    "",
    "UNDERSTOOD: one sentence, in their words, saying what they are asking for. Never more than one sentence.",
    "STEER: a directive that changes how one of the numbered steps is carried out. Start it with the step number.",
    "STEER: another, if there is one. Write as many STEER lines as the instruction genuinely needs, or none at all.",
    "CANNOT: something they asked for that none of the numbered steps can do. One per line. Omit entirely if there is nothing.",
    "",
    "RULES THAT MATTER MORE THAN BEING HELPFUL:",
    "  • Do not invent a steer. If they only confirmed or thanked, write no STEER lines at all.",
    "  • Do not quietly downgrade something you cannot do into something you can. If they asked for",
    "    a thing these steps do not do, that is a CANNOT, and saying so is the correct answer.",
    "  • A CANNOT stops the work and puts the card back in front of the partner, so be sure: a step",
    "    that can be carried out differently is a STEER, not a CANNOT.",
    "  • Never write anything you were not told. You are reading an instruction, not doing the work.",
  ].join("\n");
}

/**
 * Read the model back. Returns null when the shape is not there — the caller MUST treat that as a
 * failure to interpret and block, never as "no steer".
 */
export function parseInterpretation(output: string | null | undefined): Interpretation | null {
  if (!output) return null;
  const lines = output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  let understood: string | null = null;
  const steer: string[] = [];
  const cannot: string[] = [];
  for (const line of lines) {
    const m = /^(?:[-*•]\s*)?(UNDERSTOOD|STEER|CANNOT)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const body = m[2]!.trim();
    if (!body || /^(none|n\/a|nothing|-)$/i.test(body)) continue;
    const key = m[1]!.toUpperCase();
    if (key === "UNDERSTOOD") understood ??= body;
    else if (key === "STEER") steer.push(body);
    else cannot.push(body);
  }
  if (!understood) return null;
  return { understood: understood.slice(0, 600), steer: steer.map((s) => s.slice(0, 600)), cannot: cannot.map((s) => s.slice(0, 600)) };
}

/**
 * The block of text a chain stage puts into its own prompt.
 *
 * ABOVE THE CHAIN'S OWN BRIEF, WORDED AS AN ORDER, for the same reason the employee loop puts a
 * steering note above the original instruction: a partner who steers work in motion means it to
 * outrank what was there before, and a directive quoted politely beside the default loses.
 */
export function steerBlock(interp: Interpretation | null): string {
  if (!interp || interp.steer.length === 0) return "";
  return [
    "WHAT THE PARTNER HAS ASKED FOR ON THIS PARTICULAR ONE — this outranks anything below it:",
    `  They want: ${interp.understood}`,
    ...interp.steer.map((s) => `  • ${s}`),
  ].join("\n");
}

/**
 * The receipt, as a person reads it: her words on one side, what they turned into on the other.
 * Shared so the page, the API and the tests cannot drift into three different answers.
 */
export interface InstructionReceipt {
  cardId: string;
  /** Exactly what she typed, unedited, with where each piece came from. */
  said: InstructionPiece[];
  /** What the model made of it, or null if it could not be read. */
  interpretation: Interpretation | null;
  /** The governed run that did the interpreting, so the model and its cost are answerable. */
  aiRunId: string | null;
  /** Which model actually read her words. The whole point of the exercise. */
  model: string | null;
  /** Present only when there is no interpretation, saying why. A receipt is never silently empty. */
  failure?: string;
  at: string;
}
