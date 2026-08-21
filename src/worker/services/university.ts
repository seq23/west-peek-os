import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { runAi } from "../ai/runAi";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import {
  UNIVERSITY_PROMPT_VERSION, isLearningMode, openingInstruction, professorPrompt, trimHistory,
  type LearningMode,
} from "../../shared/university/professor";

/**
 * West Peek University (P45).
 *
 * Every AI call goes through runAi, so a lesson is budgeted, ledgered and kill-switchable exactly
 * like any other governed run — no second call path, no separate provider wiring.
 *
 * PRIVACY IS ENFORCED ON READ, NOT ASSUMED. Every query filters by firm_user_id. Someone working
 * through what they do not yet understand is doing something private, and a partner should not be
 * able to browse what the other has been studying. The brief asks for it and it is one WHERE clause
 * — the kind of thing that only gets missed when nobody writes it down.
 *
 * A FAILED CALL NEVER LOSES THE SESSION. The provider failing is recorded as a visible turn and the
 * conversation continues from there. The brief is explicit, and it is also the difference between a
 * tool people trust and one they stop opening.
 */

export class UniversityError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

interface SessionRow {
  id: string;
  firm_user_id: string;
  topic: string;
  mode: LearningMode;
  status: string;
  firm_scope: string;
}

interface TurnRow {
  id: string;
  turn_no: number;
  role: string;
  body: string;
  state: string;
  detail: string | null;
  created_at: string;
}

/** Load a session the caller is allowed to see. Another learner's session is a 404, not a 403 — */
/** telling someone a session exists but is not theirs leaks that they were studying something.   */
async function ownSession(env: Env, actor: Actor, sessionId: string): Promise<SessionRow> {
  const row = await env.WP_OS_DB.prepare(
    "SELECT * FROM university_session WHERE id = ?1 AND firm_user_id = ?2",
  )
    .bind(sessionId, actor.firmUserId ?? "")
    .first<SessionRow>();
  if (!row) throw new UniversityError(404, "not_found", "no such session");
  return row;
}

async function turnsFor(env: Env, sessionId: string): Promise<TurnRow[]> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT id, turn_no, role, body, state, detail, created_at FROM university_turn WHERE session_id = ?1 ORDER BY turn_no",
  )
    .bind(sessionId)
    .all<TurnRow>();
  return rows.results ?? [];
}

async function addTurn(
  env: Env,
  sessionId: string,
  turn: { role: "LEARNER" | "INSTRUCTOR" | "SYSTEM"; body: string; state?: string; detail?: string | null; aiRunId?: string | null },
): Promise<TurnRow> {
  const next = await env.WP_OS_DB.prepare(
    "SELECT COALESCE(MAX(turn_no), 0) + 1 AS n FROM university_turn WHERE session_id = ?1",
  )
    .bind(sessionId)
    .first<{ n: number }>();
  const id = `unt_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO university_turn (id, session_id, turn_no, role, body, state, detail, ai_run_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
  )
    .bind(id, sessionId, next?.n ?? 1, turn.role, turn.body, turn.state ?? "OK", turn.detail ?? null, turn.aiRunId ?? null)
    .run();
  await env.WP_OS_DB.prepare(
    "UPDATE university_session SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(sessionId)
    .run();
  return (await env.WP_OS_DB.prepare("SELECT id, turn_no, role, body, state, detail, created_at FROM university_turn WHERE id = ?1")
    .bind(id)
    .first<TurnRow>())!;
}

/** Ask the professor. Injectable so tests exercise the flow without a paid call. */
export type Teach = (env: Env, actor: Actor, system: string, exchange: string, purpose: string) => Promise<{
  text: string; aiRunId: string | null; failure?: string;
}>;

const defaultTeach: Teach = async (env, actor, system, exchange, purpose) => {
  const { run } = await runAi(env, {
    purpose,
    actor,
    inputs: [`${system}\n\n${exchange}`],
    // A lesson about pro rata is not firm-confidential. PUBLIC keeps it out of the restricted lane;
    // it is never raised, and nothing about a live deal belongs in a teaching prompt.
    sensitivity: "PUBLIC" as never,
    budgetContext: { expectedOutputTokens: 1200 },
    // PINNED, and the pin is the whole point of this line. Without a taskClass no routing_policy
    // matches, selection falls to "cheapest priced capable model", and a first-time GP is taught
    // fund mechanics by the smallest open model the firm has. A lesson costs about a penny at
    // frontier rates against a $25 daily cap; being taught something wrong costs more than that.
    routing: { category: "INTELLIGENCE", taskClass: "university" },
  });
  return {
    text: run.output_text ?? "",
    aiRunId: run.id,
    failure: run.status === "COMPLETED" && run.output_text ? undefined : (run.failure_reason ?? `run ${run.status}`),
  };
};

const FAILURE_MESSAGE = "The University instructor couldn't respond. Your session is still saved. Try again.";

/** Start a session and produce the opening turn. */
export async function startSession(
  env: Env,
  actor: Actor,
  input: { topic: string; mode: LearningMode },
  teach: Teach = defaultTeach,
): Promise<{ session: SessionRow; turns: TurnRow[] }> {
  const authz = await authorize(env, actor, "ai.run", { objectType: "university_session", firmScope: actor.firmScopes[0] });
  if (authz.decision !== "ALLOW") throw new UniversityError(403, "forbidden", authz.reason);

  const topic = input.topic.trim();
  if (topic.length < 2) throw new UniversityError(400, "topic_required", "Say what you want to learn.");

  const id = `uns_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO university_session (id, firm_user_id, topic, mode, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5)`,
  )
    .bind(id, actor.firmUserId ?? "system", topic, input.mode, actor.firmScopes[0] ?? "west-peek")
    .run();

  const result = await teach(
    env, actor,
    professorPrompt(topic, input.mode),
    openingInstruction(topic),
    `university session ${id} (${input.mode})`,
  ).catch((err) => ({ text: "", aiRunId: null, failure: err instanceof Error ? err.message : String(err) }));

  // The session row already exists, so even a failed opening leaves something to return to.
  await addTurn(env, id, result.failure
    ? { role: "SYSTEM", body: FAILURE_MESSAGE, state: "FAILED", detail: result.failure }
    : { role: "INSTRUCTOR", body: result.text.trim(), aiRunId: result.aiRunId });

  await appendEvent(env, {
    eventType: "university.session_started",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "university_session", objectId: id,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: { topic, mode: input.mode, prompt_version: UNIVERSITY_PROMPT_VERSION },
  });

  const session = await ownSession(env, actor, id);
  return { session, turns: await turnsFor(env, id) };
}

/** Continue a session. History is what makes it teaching rather than a series of answers. */
export async function reply(
  env: Env,
  actor: Actor,
  sessionId: string,
  message: string,
  teach: Teach = defaultTeach,
): Promise<{ turns: TurnRow[] }> {
  const session = await ownSession(env, actor, sessionId);
  const text = message.trim();
  if (!text) throw new UniversityError(400, "empty_message", "Nothing to send.");

  await addTurn(env, sessionId, { role: "LEARNER", body: text });

  const history = trimHistory((await turnsFor(env, sessionId)).filter((t) => t.state === "OK"));
  const transcript = history
    .map((t) => `${t.role === "LEARNER" ? "LEARNER" : "PROFESSOR"}: ${t.body}`)
    .join("\n\n");

  const result = await teach(
    env, actor,
    professorPrompt(session.topic, session.mode),
    `${transcript}\n\nRespond as the professor. Continue the lesson; do not restart it.`,
    `university session ${sessionId} reply`,
  ).catch((err) => ({ text: "", aiRunId: null, failure: err instanceof Error ? err.message : String(err) }));

  await addTurn(env, sessionId, result.failure
    ? { role: "SYSTEM", body: FAILURE_MESSAGE, state: "FAILED", detail: result.failure }
    : { role: "INSTRUCTOR", body: result.text.trim(), aiRunId: result.aiRunId });

  return { turns: await turnsFor(env, sessionId) };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof UniversityError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const startSchema = z.object({ topic: z.string().min(2).max(200), mode: z.string().default("LEARN") });

export async function handleStartSession(ctx: RouteContext): Promise<Response> {
  const parsed = startSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const mode = isLearningMode(parsed.data.mode) ? parsed.data.mode : "LEARN";
  try {
    return json(await startSession(ctx.env, actorFromIdentity(ctx.identity!), { topic: parsed.data.topic, mode }), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleReply(ctx: RouteContext): Promise<Response> {
  const body = (await ctx.request.json().catch(() => null)) as { message?: string } | null;
  if (!ctx.params.id || !body?.message) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await reply(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, body.message), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

/** GET /api/university — this learner's sessions, most recent first. */
export async function handleListSessions(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, topic, mode, status, created_at, updated_at FROM university_session WHERE firm_user_id = ?1 ORDER BY updated_at DESC LIMIT 50",
  )
    .bind(actor.firmUserId ?? "")
    .all();
  return json({ sessions: rows.results ?? [] });
}

/** GET /api/university/:id — one session with its turns. */
export async function handleGetSession(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const actor = actorFromIdentity(ctx.identity!);
    const session = await ownSession(ctx.env, actor, ctx.params.id);
    return json({ session, turns: await turnsFor(ctx.env, session.id) });
  } catch (err) {
    return fail(err);
  }
}

const diarySchema = z.object({ topic: z.string().min(1).max(200), text: z.string().min(1).max(4000), session_id: z.string().max(80).nullish() });

/** POST /api/university/diary — keep one takeaway. */
export async function handleSaveDiary(ctx: RouteContext): Promise<Response> {
  const parsed = diarySchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const id = `und_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO university_diary (id, firm_user_id, session_id, topic, text, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  )
    .bind(id, actor.firmUserId ?? "system", parsed.data.session_id ?? null, parsed.data.topic, parsed.data.text, actor.firmScopes[0] ?? "west-peek")
    .run();
  return json({ id }, { status: 201 });
}

/** GET /api/university/diary — this learner's kept takeaways. */
export async function handleListDiary(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, topic, text, created_at FROM university_diary WHERE firm_user_id = ?1 ORDER BY created_at DESC LIMIT 100",
  )
    .bind(actor.firmUserId ?? "")
    .all();
  return json({ entries: rows.results ?? [] });
}
