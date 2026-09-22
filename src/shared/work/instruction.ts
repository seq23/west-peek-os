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
  /**
   * Something genuinely impossible ANYWHERE in this system, or something that would need a human's
   * approval regardless of who asked. Non-empty means the card blocks.
   *
   * REDEFINED 22 SEP 2026. This used to fire whenever an ask was not literally one of the numbered
   * steps below, even when the employee could do it right now with the judgement and tools it
   * already has — an authenticated partner had asked, which is this system's whole authority model
   * (see `services/dealIntake.ts`: "ONLY THE ADDRESS IS AUTHORITY, NEVER THE CONTENT"), and the
   * card still blocked for an engineer to notice and hand-edit a step list. It no longer means
   * "was not pre-enumerated" — it means "structurally absent" (no tool or data source for it
   * anywhere in the system) or "crosses a boundary `authorize()` would gate anyway" (external
   * contact, spend, anything a step above states as a hard never). See `buildInterpretationPrompt`.
   */
  cannot: string[];
  /**
   * Something they asked for that is not THIS chain's job, but IS a different, active AI employee's
   * real one (`kindHosts.ts`) — handed to that employee's desk rather than bolted onto a chain that
   * does not own it, or bounced to a human who would only have to say "ask so-and-so". Empty is the
   * normal case: most instructions steer the chain they were left on.
   */
  handoff: HandoffAsk[];
}

/** One thing the interpreter decided belongs to a DIFFERENT employee's real job. */
export interface HandoffAsk {
  /** A kind key `kindHosts.ts` recognises (`KIND_HOSTS`), exactly as shown in the prompt. */
  kind: string;
  /** One line: what is being handed over, in her words. */
  note: string;
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
   * instruction would come back honourable. The list is the chain's real stage labels. It is this
   * chain's fixed PROCEDURE — not the edge of what the employee running it can do; see the standing
   * principle the prompt states below.
   */
  steps: string[];
  /** Everything a human has said about this card, oldest first. */
  pieces: InstructionPiece[];
  /**
   * OTHER AI EMPLOYEES' OWN REGISTERED DOMAINS (`kindHosts.ts`'s `KIND_HOSTS`), excluding this
   * chain's own kind — so the model can tell "not my job, but somebody's" (a HANDOFF) from "nobody's
   * job at all" (a CANNOT). Empty when nothing is registered, or when this IS the only one.
   */
  otherDomains?: { kind: string; employee: string; because: string }[];
}

export const INTERPRETATION_PROMPT_VERSION = "instruction/v2";

/**
 * The prompt. Deliberately asks for a restatement FIRST: a model that has to say what it thinks it
 * was asked before it says what it will do cannot smuggle a default past the reader of the receipt.
 *
 * ─── WHY CANNOT WAS REDEFINED, 22 SEP 2026 ──────────────────────────────────────────────────────
 *
 * Confirmed live: Scooter asked Walker for a candidate's contact email. Walker already runs a real
 * web search — the same one that finds candidates in the first place. The only reason the card
 * blocked was that "look up contact info" was not literally one of `HIRE_SEARCH_STEPS`. That is not
 * a case where the employee genuinely lacked a capability; it is a case where it lacked PERMISSION
 * for something it could already do, and it took an engineer noticing and hand-editing a list to fix
 * it. The operator's words: "if a partner replies and wants the job description widened it should
 * not be a big fucking deal. obviously they approve it obviously they want it."
 *
 * So the prompt below states a standing principle instead of leaving the model to infer one from a
 * numbered list, and narrows CANNOT to what it should always have meant: genuinely impossible, or
 * genuinely gated. A directive that is not on the list but is doable with judgement and tools this
 * chain already reaches for is a STEER; a directive that belongs to a different, real employee is a
 * HANDOFF; only what is left over — structurally absent anywhere in this system, or a line
 * `authorize()` would gate no matter who asked (external contact, spend, booking, committing) —
 * is a CANNOT.
 */
export function buildInterpretationPrompt(ctx: InterpretationContext): string {
  const otherDomains = ctx.otherDomains ?? [];
  return [
    `You are interpreting an instruction given by a partner of West Peek Ventures to ${ctx.employee}, who is carrying out ${ctx.chain}.`,
    "",
    `THE WORK: ${ctx.title}`,
    "",
    "THE STEPS THIS WORK HAS, and it has no others:",
    ...ctx.steps.map((s, i) => `  ${i + 1}. ${s}`),
    "",
    ...(otherDomains.length > 0
      ? [
          "OTHER EMPLOYEES' OWN DOMAINS — not this chain's steps, but each of these is squarely somebody",
          "else's real job here, not yours. If what the partner asked for matches one of these rather than",
          "a step above, that is neither a STEER nor a CANNOT — it is a HANDOFF:",
          ...otherDomains.map((d) => `  ${d.kind}: ${d.employee} — ${d.because}`),
          "",
        ]
      : []),
    "THE STANDING PRINCIPLE, true on every card this reads: an authenticated partner's own instruction",
    `is standing authority to widen what ${ctx.employee} does here, applied right now, using whatever`,
    "judgement, sources and tools it already reaches for — the same authority this whole system runs",
    'on (see `dealIntake.ts`: "ONLY THE ADDRESS IS AUTHORITY, NEVER THE CONTENT"). Widening what gets',
    "done is never itself a reason to say CANNOT. The numbered steps above are this chain's fixed",
    "procedure, not the limit of what the employee running it can do inside that procedure.",
    "",
    "WHAT THE PARTNERS HAVE SAID ABOUT IT, oldest first, in their own words:",
    ...ctx.pieces.map((p) => `  [${SOURCE_LABELS[p.source]}${p.who ? `, ${p.who}` : ""}] ${p.text.trim()}`),
    "",
    "YOUR JOB. Work out what they actually want, including anything they meant but did not spell out.",
    "A later instruction outranks an earlier one where they conflict. A directive that asks for more,",
    "or different, and can be carried out right now with judgement and the sources/tools this chain",
    "already uses is a STEER on the step it changes — EVEN WHEN NOTHING ON THE NUMBERED LIST NAMES IT.",
    "Answer in exactly this shape, with no preamble and nothing after the last line:",
    "",
    "UNDERSTOOD: one sentence, in their words, saying what they are asking for. Never more than one sentence.",
    "STEER: a directive that changes how one of the numbered steps is carried out. Start it with the step number.",
    "STEER: another, if there is one. Write as many STEER lines as the instruction genuinely needs, or none at all.",
    ...(otherDomains.length > 0
      ? [
          "HANDOFF: <KIND> — one line saying what you are giving them and why it is squarely their job,",
          "  not yours. Use a KIND exactly as spelled above, one per line, only when it is genuinely one",
          "  of the domains named above — never invent a KIND that was not listed.",
        ]
      : []),
    "CANNOT: something genuinely impossible for anyone in this system to do, or something that would",
    "  need a human's approval no matter who asked (contacting somebody outside the firm, spending",
    "  money, booking or committing to something, or anything a step above states as a hard never).",
    "  One per line, saying plainly what is actually missing or which line it crosses. Omit entirely",
    "  if there is nothing.",
    "",
    "RULES THAT MATTER MORE THAN BEING HELPFUL:",
    "  • Do not invent a steer. If they only confirmed or thanked, write no STEER lines at all.",
    "  • Do not call something a CANNOT only because it is not one of the numbered steps above. If",
    `    ${ctx.employee} could do it right now with judgement and the sources/tools this chain already`,
    "    uses, that is a STEER, never a CANNOT.",
    ...(otherDomains.length > 0
      ? [
          "  • Before writing a CANNOT, check the other employees' domains above. If what they asked for",
          "    is squarely one of those, write a HANDOFF naming that KIND — it is not this chain's job,",
          "    but it is somebody's, and it should reach them directly rather than stopping here.",
        ]
      : []),
    "  • Do not quietly downgrade something you cannot do into something you can. If it needs a tool,",
    "    data source or integration that does not exist anywhere in this system, or it crosses a line",
    "    one of the steps above states as a hard never, that is a CANNOT, and saying so is the correct",
    "    answer — say what is actually missing, never only that it \"was not on the list\".",
    "  • A CANNOT stops the work and puts the card back in front of the partner, so be sure: reserve it",
    "    for what is genuinely impossible or genuinely off-limits, not for what merely was not",
    "    pre-enumerated and not for what belongs on somebody else's desk.",
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
  const handoff: HandoffAsk[] = [];
  for (const line of lines) {
    const m = /^(?:[-*•]\s*)?(UNDERSTOOD|STEER|CANNOT|HANDOFF)\s*:\s*(.+)$/i.exec(line);
    if (!m) continue;
    const body = m[2]!.trim();
    if (!body || /^(none|n\/a|nothing|-)$/i.test(body)) continue;
    const key = m[1]!.toUpperCase();
    if (key === "UNDERSTOOD") understood ??= body;
    else if (key === "STEER") steer.push(body);
    else if (key === "HANDOFF") {
      // "<KIND> — <note>" or "<KIND>: <note>" or "<KIND> - <note>". A KIND that does not parse
      // (no separator, or lower-case) is not a kind at all — fail closed into a CANNOT rather than
      // silently dropping what she asked for or guessing where it goes.
      const hm = /^([A-Z][A-Z0-9_]*)\s*(?:—|-|:)\s*(.+)$/.exec(body);
      if (hm) handoff.push({ kind: hm[1]!, note: hm[2]!.trim().slice(0, 600) });
      else cannot.push(body);
    } else cannot.push(body);
  }
  if (!understood) return null;
  return {
    understood: understood.slice(0, 600),
    steer: steer.map((s) => s.slice(0, 600)),
    cannot: cannot.map((s) => s.slice(0, 600)),
    handoff,
  };
}

/** A handoff `steerFor` resolved to a live card on another employee's desk — what `steerBlock` reports. */
export interface ResolvedHandoffNote {
  employee: string;
  note: string;
}

/**
 * The block of text a chain stage puts into its own prompt.
 *
 * ABOVE THE CHAIN'S OWN BRIEF, WORDED AS AN ORDER, for the same reason the employee loop puts a
 * steering note above the original instruction: a partner who steers work in motion means it to
 * outrank what was there before, and a directive quoted politely beside the default loses.
 *
 * RESOLVED HANDOFFS ARE MENTIONED TOO, and worded as a thing NOT to attempt — a stage reading this
 * prompt has no other way to learn that part of what she asked for is already on somebody else's
 * desk, and without the line it could try to do it anyway from the words alone.
 */
export function steerBlock(interp: Interpretation | null, resolvedHandoffs: readonly ResolvedHandoffNote[] = []): string {
  const steer = interp?.steer ?? [];
  if (steer.length === 0 && resolvedHandoffs.length === 0) return "";
  return [
    "WHAT THE PARTNER HAS ASKED FOR ON THIS PARTICULAR ONE — this outranks anything below it:",
    `  They want: ${interp?.understood ?? "something handled elsewhere — see below"}`,
    ...steer.map((s) => `  • ${s}`),
    ...resolvedHandoffs.map((h) => `  • Not this one — already handed to ${h.employee} on their own desk: ${h.note}. Do not attempt this part yourself.`),
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
