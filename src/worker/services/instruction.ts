import type { Env } from "../env";
import { json } from "../router";
import type { RouteContext } from "../router";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import type { Actor } from "./authorize";
import {
  INTERPRETATION_PROMPT_VERSION,
  buildInterpretationPrompt,
  isWorthInterpreting,
  parseInterpretation,
  steerBlock,
  type InstructionPiece,
  type InstructionReceipt,
  type Interpretation,
} from "../../shared/work/instruction";

/**
 * THE ONE PLACE A HUMAN'S WORDS BECOME SOMETHING A CHAIN CAN ACT ON (16 Sep 2026).
 *
 * See `src/shared/work/instruction.ts` for what went wrong and why this shape. In short: the
 * general employee loop always read her words; the six specialised chains never did, so an
 * instruction typed onto a Room packet, a Workshop, a Productions duty, a hire search, blog help
 * or a deck rework was stored and read by nothing.
 *
 * ─── The contract every chain now keeps ────────────────────────────────────────────────────────
 *
 *   1. Before its first stage runs, a chain calls `steerFor`.
 *   2. If a human has said anything about this card, exactly ONE governed model call reads all of
 *      it and returns UNDERSTOOD / STEER / CANNOT.
 *   3. The chain puts `steer.text` at the TOP of every stage prompt it builds, above its own brief.
 *   4. If `steer.cannot` is non-empty, or the model could not be read, the chain BLOCKS. It does
 *      not carry on with the default, which is the failure this whole file exists to remove.
 *   5. The receipt is stored either way, so she can see her words and what they turned into.
 *
 * ─── Why one call and not one per stage ────────────────────────────────────────────────────────
 *
 * A packet is six or seven stages, each already a model call, and re-interpreting the same three
 * sentences at every one would multiply cost for an answer that cannot change. The interpretation
 * is cached on the card for as long as nothing new has been said; the moment a note is left or a
 * block is answered, `steerFor` sees prose it has not interpreted and runs again. That is the
 * behaviour the operator asked for — a note left mid-run lands on the next stage, not after the
 * card closes.
 *
 * ─── Why the note is acknowledged here ─────────────────────────────────────────────────────────
 *
 * `work_card_note` refuses an acknowledgement with no response (the CHECK in 0134), for the good
 * reason that a flag on its own would let an employee dismiss an instruction without it touching
 * the work. The response written here is the model's own UNDERSTOOD line — which is exactly what
 * the note changed, in the model's words, and is what she reads on the thread.
 */

/** What a chain gets back. */
export interface Steer {
  /** The block to put at the top of every stage prompt. Empty string when there is nothing to say. */
  text: string;
  /** Null when nobody has said anything about this card — the normal case for a scheduled duty. */
  interpretation: Interpretation | null;
  /**
   * Set when the chain must STOP rather than run. Either she asked for something these steps
   * cannot do, or her words could not be interpreted at all. Never silently ignored.
   */
  cannot: string[];
  /** Why interpretation failed, when it did. The chain blocks with this rather than guessing. */
  failure: string | null;
  aiRunId: string | null;
}

const NOTHING_SAID: Steer = { text: "", interpretation: null, cannot: [], failure: null, aiRunId: null };

interface CardPromptRow {
  prompt: string | null;
  block_answer: string | null;
  requested_by_email: string | null;
}

/**
 * Every piece of human prose attached to this card, oldest first.
 *
 * WHAT IS DELIBERATELY NOT IN HERE. `work_card.description` on a chain card is written by the
 * system — `openPacketCard` composes it from the month, the packet id and a recital of the chain's
 * own stages. Feeding that to the interpreter would have it restating the chain's description of
 * itself as though it were an instruction, and every card in the firm would carry a steer nobody
 * wrote. A chain that holds a genuine human brief passes it in explicitly as `extra`.
 */
export async function gatherInstruction(
  env: Env,
  cardId: string,
  extra: InstructionPiece[] = [],
): Promise<{ pieces: InstructionPiece[]; noteIds: string[] }> {
  const card = await env.WP_OS_DB.prepare(
    "SELECT prompt, block_answer, requested_by_email FROM work_card WHERE id = ?1",
  )
    .bind(cardId)
    .first<CardPromptRow>();

  const notes = (
    await env.WP_OS_DB.prepare(
      `SELECT n.id, n.body, fu.full_name
         FROM work_card_note n
         LEFT JOIN firm_user fu ON fu.id = n.author_id
        WHERE n.work_card_id = ?1 AND n.acknowledged_at IS NULL
        ORDER BY n.created_at ASC`,
    )
      .bind(cardId)
      .all<{ id: string; body: string; full_name: string | null }>()
  ).results ?? [];

  const pieces: InstructionPiece[] = [
    ...extra,
    ...(card?.prompt?.trim() ? [{ source: "PROMPT" as const, text: card.prompt, who: card.requested_by_email ?? null }] : []),
    ...notes.map((n) => ({ source: "NOTE" as const, text: n.body, who: n.full_name ?? "A partner", noteId: n.id })),
    // LAST, BECAUSE IT OUTRANKS. The prompt asks the model to let a later instruction win where
    // they conflict, and what she typed to clear a block is the most recent thing she said.
    ...(card?.block_answer?.trim() ? [{ source: "BLOCK_ANSWER" as const, text: card.block_answer, who: null }] : []),
  ];
  return { pieces, noteIds: notes.map((n) => n.id) };
}

export interface SteerRequest {
  cardId: string;
  cardKind: string | null;
  /** The card's title, so the model knows what the words are about. */
  title: string;
  employee: string;
  /** One line: "Parker's Room packet", "Walker's weekly hire search for West Peek Productions". */
  chain: string;
  /** The chain's real stages, named. Without these the model cannot tell a steer from a CANNOT. */
  steps: string[];
  firmScope: string;
  /** Prose the chain holds outside the card's own columns — a packet brief, a requester's email. */
  extra?: InstructionPiece[];
}

/** Injectable so a chain's tests can prove their steering without a provider. */
export type Interpreter = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; aiRunId: string | null; model: string | null; detail: string }>;

/**
 * The model call. `interpretation: true` is the whole point of this function existing separately
 * from every other runAi caller in the repo — see RunAiBudgetContext in ai/runAi.ts for why
 * `judgement` alone was not enough, and why price may order the candidates but may not choose them.
 */
const defaultInterpreter: Interpreter = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "interpreting what a partner asked for",
    actor,
    inputs: [prompt],
    sensitivity: "INTERNAL" as never,
    budgetContext: {
      expectedOutputTokens: 600,
      // Reading an owner's instruction is the highest-stakes small call this system makes: every
      // stage downstream carries whatever this decides she meant. It is never the cheap tier, and
      // no pricing row may re-elect a model for it.
      interpretation: true,
      // Not "critical" in the budget sense (it is not an LP wire or an IC deadline), but it must
      // survive CRITICAL_ONLY: a firm that has throttled to critical work only still has to know
      // what its owner asked for before doing any of it.
      critical: true,
    },
    routing: { category: "OPERATIONS", taskClass: "instruction-interpretation" },
  });
  return {
    ok: run.status === "COMPLETED" && Boolean(run.output_text),
    text: run.output_text ?? "",
    aiRunId: run.id,
    model: run.model ?? null,
    detail: run.failure_reason ?? run.status,
  };
};

/**
 * Has anything been said about this card that has NOT already been interpreted?
 *
 * The cache key is the words themselves. Re-interpreting identical prose on every stage would cost
 * six model calls a packet for an answer that cannot change; not re-interpreting when she leaves a
 * note would be the original defect with a cache in front of it.
 */
async function cached(env: Env, cardId: string, pieces: InstructionPiece[]): Promise<{ row: { interpreted_json: string | null; failure_reason: string | null; ai_run_id: string | null }; hit: boolean } | null> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT said_json, interpreted_json, failure_reason, ai_run_id FROM work_card_instruction WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1",
  )
    .bind(cardId)
    .first<{ said_json: string; interpreted_json: string | null; failure_reason: string | null; ai_run_id: string | null }>();
  if (!row) return null;
  return { row, hit: row.said_json === saidJson(pieces) };
}

function saidJson(pieces: InstructionPiece[]): string {
  return JSON.stringify(pieces.map((p) => ({ source: p.source, text: p.text.trim(), who: p.who ?? null })));
}

/**
 * THE FUNCTION EVERY CHAIN CALLS. Returns the steer, or the reason it must stop.
 *
 * Never throws: a chain that cannot interpret must block with a sentence a partner can read, not
 * die inside a sweep tick where the card would be left at its attempt cap with nothing on it.
 */
export async function steerFor(
  env: Env,
  actor: Actor,
  req: SteerRequest,
  interpret: Interpreter = defaultInterpreter,
): Promise<Steer> {
  const { pieces, noteIds } = await gatherInstruction(env, req.cardId, req.extra ?? []);
  if (!isWorthInterpreting(pieces)) return NOTHING_SAID;

  const prior = await cached(env, req.cardId, pieces);
  if (prior?.hit) {
    const interpretation = prior.row.interpreted_json ? (JSON.parse(prior.row.interpreted_json) as Interpretation) : null;
    return {
      text: steerBlock(interpretation),
      interpretation,
      cannot: interpretation?.cannot ?? (prior.row.failure_reason ? [prior.row.failure_reason] : []),
      failure: interpretation ? null : prior.row.failure_reason,
      aiRunId: prior.row.ai_run_id,
    };
  }

  const prompt = buildInterpretationPrompt({
    title: req.title,
    employee: req.employee,
    chain: req.chain,
    steps: req.steps,
    pieces,
  });

  let out: Awaited<ReturnType<Interpreter>>;
  try {
    out = await interpret(env, actor, prompt);
  } catch (err) {
    out = { ok: false, text: "", aiRunId: null, model: null, detail: err instanceof Error ? err.message : String(err) };
  }

  const interpretation = out.ok ? parseInterpretation(out.text) : null;
  const failure = interpretation
    ? null
    : out.ok
      ? "the reply did not say what it understood the instruction to be"
      : `no model could be reached to read it: ${out.detail}`.slice(0, 400);

  await record(env, req, pieces, interpretation, failure, out.aiRunId, out.model);

  // ACKNOWLEDGED IN THE MODEL'S OWN WORDS. 0134's CHECK refuses a flag with no response, because a
  // note marked seen and not answered is exactly how an instruction gets dismissed. Only on a
  // successful interpretation: a note nothing could read stays unanswered, and is picked up again
  // the moment the card is retried.
  if (interpretation && noteIds.length > 0) {
    for (const id of noteIds) {
      await env.WP_OS_DB.prepare(
        "UPDATE work_card_note SET acknowledged_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), response = ?2 WHERE id = ?1 AND acknowledged_at IS NULL",
      )
        .bind(id, interpretation.understood.slice(0, 900))
        .run();
    }
  }

  return {
    text: steerBlock(interpretation),
    interpretation,
    cannot: interpretation ? interpretation.cannot : [failure ?? "her instruction could not be read"],
    failure,
    aiRunId: out.aiRunId,
  };
}

async function record(
  env: Env,
  req: SteerRequest,
  pieces: InstructionPiece[],
  interpretation: Interpretation | null,
  failure: string | null,
  aiRunId: string | null,
  model: string | null,
): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card_instruction
       (id, work_card_id, card_kind, said_json, interpreted_json, failure_reason, ai_run_id, model, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
  )
    .bind(
      `wci_${crypto.randomUUID()}`,
      req.cardId,
      req.cardKind,
      saidJson(pieces),
      interpretation ? JSON.stringify(interpretation) : null,
      failure,
      aiRunId,
      model,
      req.firmScope,
    )
    .run();

  await appendEvent(env, {
    eventType: "work_card.instruction_interpreted",
    actorType: "system",
    actorId: "instruction",
    objectType: "work_card",
    objectId: req.cardId,
    firmScope: req.firmScope,
    payload: {
      prompt_version: INTERPRETATION_PROMPT_VERSION,
      pieces: pieces.map((p) => p.source),
      model,
      steer: interpretation?.steer.length ?? 0,
      cannot: interpretation?.cannot.length ?? 0,
      failed: failure,
    },
  });
}

/**
 * The sentence a chain blocks with when her words name something it has no step for.
 *
 * Held to `plainLanguageProblems` like every other block reason: it names no stage, no column and
 * no model. What she reads is that part of what she asked for is not something this piece of work
 * can do — and the doors let her answer, rewrite it, or drop it.
 */
export function cannotDetail(employee: string, cannot: string[]): string {
  return cannot.length > 0
    ? `${employee} can do the rest, but not this part of it: ${cannot.join("; ")}. Say how you want that handled, or rewrite the job without it.`.slice(0, 900)
    : `Say again what you want ${employee} to do here.`;
}

// ── The receipt ───────────────────────────────────────────────────────────────────────────────

/**
 * WHAT SHE TYPED AND WHAT IT TURNED INTO, side by side.
 *
 * Her question was "tell me what my instructions turned into", asked of an agent, about a database.
 * She should never have to ask it that way again: every card carries its own answer.
 */
export async function receiptsFor(env: Env, cardId: string): Promise<InstructionReceipt[]> {
  const rows = (
    await env.WP_OS_DB.prepare(
      `SELECT id, work_card_id, said_json, interpreted_json, failure_reason, ai_run_id, model, created_at
         FROM work_card_instruction WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 20`,
    )
      .bind(cardId)
      .all<{ said_json: string; interpreted_json: string | null; failure_reason: string | null; ai_run_id: string | null; model: string | null; created_at: string }>()
  ).results ?? [];
  return rows.map((r) => ({
    cardId,
    said: safeParse<InstructionPiece[]>(r.said_json) ?? [],
    interpretation: r.interpreted_json ? safeParse<Interpretation>(r.interpreted_json) : null,
    aiRunId: r.ai_run_id,
    model: r.model,
    at: r.created_at,
    ...(r.failure_reason ? { failure: r.failure_reason } : {}),
  }));
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** GET /api/work-cards/:id/instructions — the receipt, for the panel on the card. */
export async function handleWorkCardInstructions(ctx: RouteContext): Promise<Response> {
  const cardId = ctx.params.id;
  if (!cardId) return json({ error: "invalid_input" }, { status: 400 });
  const receipts = await receiptsFor(ctx.env, cardId);
  return json({
    receipts,
    note:
      receipts.length > 0
        ? "Your words on the left, exactly as you typed them; what the model understood on the right. The model that read them is named on each one."
        : "Nothing has been typed onto this card yet, so there is nothing to interpret.",
  });
}
