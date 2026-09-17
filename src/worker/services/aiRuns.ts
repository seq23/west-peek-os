import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause, type Actor } from "./authorize";
import { runAi, type AIRunRow, type RunAiDeps } from "../ai/runAi";
import { committedCostOf } from "../ai/spend";
import { privacyLabelSchema } from "../../shared/privacy";
import { aiOutboundSwitches } from "../../shared/policy/aiOutbound";

/**
 * AI run routes (P4). POST /api/ai/run is available to any authenticated firm
 * user; the run itself is gated by the runAi pipeline (privacy/cost/egress).
 * Run visibility follows the P3 privacy rules: rows with sensitive labels are
 * visible only to MPs / privacy-scoped users (SQL-enforced).
 *
 * Output quarantine: external-provider outputs stay quarantined until a HUMAN
 * accept step (acceptQuarantinedOutput). Quarantined text never auto-enters
 * any other table.
 */

const runSchema = z.object({
  purpose: z.string().trim().min(1),
  inputs: z.array(z.string()).min(1),
  sensitivity: privacyLabelSchema,
  capability_requirement: z.string().trim().min(1).optional(),
  budget_context: z
    .object({
      critical: z.boolean().optional(),
      expected_input_tokens: z.number().int().positive().optional(),
      expected_output_tokens: z.number().int().positive().optional(),
      preferred_model: z.string().trim().min(1).optional(),
      provider_key: z.string().trim().min(1).optional(),
      /** A caller who knows this particular call is machinery can say so and get the cheap tier. */
      mechanical: z.boolean().optional(),
    })
    .optional(),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function runAiForActor(
  env: Env,
  actor: Actor,
  body: z.infer<typeof runSchema>,
  deps: RunAiDeps = {},
): Promise<AIRunRow> {
  const authz = await authorize(env, actor, "ai.run", { objectType: "ai_run", firmScope: actor.firmScopes[0] });
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);
  const { run } = await runAi(
    env,
    {
      purpose: body.purpose,
      actor,
      inputs: body.inputs,
      sensitivity: body.sensitivity,
      capabilityRequirement: body.capability_requirement,
      /*
       * THE DOOR A PARTNER COMES THROUGH HERSELF, so it defaults to judgement.
       *
       * This is POST /api/ai/runs: whatever somebody typed, for whatever reason, and the answer
       * comes back to the person who asked. There is no way to know from here whether a given call
       * is machinery, and the cost of being wrong is asymmetric — a mechanical call marked
       * judgement costs a fraction of a cent, a partner's question routed to the cheap tier comes
       * back confidently wrong. A caller who knows better can still pass `mechanical` explicitly
       * and it wins, because an explicit value overrides the default below.
       */
      budgetContext: body.budget_context
        ? {
            judgement: true,
            critical: body.budget_context.critical,
            expectedInputTokens: body.budget_context.expected_input_tokens,
            expectedOutputTokens: body.budget_context.expected_output_tokens,
            preferredModel: body.budget_context.preferred_model,
            providerKey: body.budget_context.provider_key,
            // Explicit wins: a caller who declared machinery gets machinery.
            ...(body.budget_context.mechanical ? { judgement: false, mechanical: true } : {}),
          }
        : { judgement: true },
    },
    deps,
  );
  return run;
}

export class AiRouteError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof AiRouteError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleRunAi(ctx: RouteContext): Promise<Response> {
  const body = await parseJsonBody(ctx.request);
  const parsed = runSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const run = await runAiForActor(ctx.env, actorFromIdentity(ctx.identity!), parsed.data);
    return json(run, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleListAiRuns(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const visibility = privacyVisibilityClause(ctx.identity!, "sensitivity");
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM ai_run WHERE status = ?1 AND ${visibility} ORDER BY created_at DESC, id LIMIT 200`,
      )
        .bind(status)
        .all<AIRunRow>()
    : await ctx.env.WP_OS_DB.prepare(`SELECT * FROM ai_run WHERE ${visibility} ORDER BY created_at DESC, id LIMIT 200`).all<AIRunRow>();
  return json({ runs: rows.results ?? [] });
}

export async function handleGetAiRun(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "sensitivity");
  const row = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM ai_run WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<AIRunRow>();
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json({ ...row, trace_id: row.trace_id });
}

/**
 * The quarantine, and the two ways out of it.
 *
 * WHAT WAS WRONG. 51 completed outputs sat quarantined in production and there was no way to accept
 * one, because the accept route had no button anywhere in the client — and no way to refuse one,
 * because a reject path did not exist at all. A quarantine with no exit is a queue that only grows,
 * and every run in it is charged to the firm as rework cost forever.
 *
 * ACCEPT flips `output_quarantine` to 0 — the existing, and still the only, promotion path.
 * DISCARD deliberately does NOT: the whole point of refusing an output is that its text never
 * becomes usable, so the run stays quarantined and a DISCARDED decision row takes it out of the
 * queue instead. Both decisions land in `ai_output_decision` with who, when and why.
 */

/** A quarantined output, with enough context to decide about it without opening anything else. */
interface QuarantinedRow {
  id: string;
  purpose: string;
  model: string | null;
  provider_key: string | null;
  employee_name: string | null;
  created_at: string;
  cost_estimate_json: string;
  actual_usage_json: string | null;
  output_text: string | null;
  sensitivity: string;
}

/**
 * What is waiting for a person to look at it.
 *
 * Ordered oldest first on purpose: the queue's problem is that things sit in it, and a newest-first
 * list hides exactly the rows that have been ignored longest.
 */
export async function handleListQuarantinedOutputs(ctx: RouteContext): Promise<Response> {
  const visibility = privacyVisibilityClause(ctx.identity!, "r.sensitivity");
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT r.id, r.purpose, r.model, r.created_at, r.cost_estimate_json, r.actual_usage_json,
            r.output_text, r.sensitivity, p.provider_key, e.name AS employee_name
       FROM ai_run r
       LEFT JOIN provider_registry p ON p.id = r.provider_id
       LEFT JOIN ai_employee e ON e.id = r.ai_employee_id
       LEFT JOIN ai_output_decision d ON d.ai_run_id = r.id
      WHERE r.status = 'COMPLETED' AND r.output_quarantine = 1 AND d.id IS NULL AND ${visibility}
      ORDER BY r.created_at ASC
      LIMIT 100`,
  ).all<QuarantinedRow>();

  const waiting = rows.results ?? [];
  const total = await ctx.env.WP_OS_DB.prepare(
    `SELECT COUNT(*) AS n FROM ai_run r
       LEFT JOIN ai_output_decision d ON d.ai_run_id = r.id
      WHERE r.status = 'COMPLETED' AND r.output_quarantine = 1 AND d.id IS NULL`,
  ).first<{ n: number }>();

  return json({
    waiting: waiting.map((r) => ({
      id: r.id,
      what_it_was_for: r.purpose,
      who: r.employee_name,
      model: r.model,
      provider: r.provider_key,
      created_at: r.created_at,
      cost_usd: committedCostOf({ status: "COMPLETED", cost_estimate_json: r.cost_estimate_json, actual_usage_json: r.actual_usage_json }),
      // A preview, not the document. Enough to recognise the thing; the run page has all of it.
      preview: r.output_text ? r.output_text.slice(0, 600) : null,
      truncated: (r.output_text?.length ?? 0) > 600,
    })),
    // Counted separately from the list, which is capped: a partner facing 51 of these needs to know
    // it is 51 rather than "at least 100".
    waiting_count: Number(total?.n ?? 0),
    // Some rows may be invisible to this reader under the privacy rules. Said, not silently hidden.
    listed_count: waiting.length,
    what_this_is:
      "Work a model finished that nobody has looked at yet. Nothing here has been used anywhere in the system, and until somebody decides, the firm is charged for it as work done twice.",
  });
}

/**
 * Human accept of a quarantined external output. The ONLY promotion path:
 * flips output_quarantine to 0 and appends ai_output.accepted. AI/SYSTEM
 * actors can never accept (service-level check, not just route auth).
 */
export async function acceptQuarantinedOutput(env: Env, actor: Actor, runId: string, reason?: string): Promise<AIRunRow> {
  if (actor.type !== "HUMAN") {
    throw new AiRouteError(403, "forbidden", "quarantined output accept is human-reserved");
  }
  const authz = await authorize(env, actor, "ai_output.accept", { objectType: "ai_run", objectId: runId });
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);

  const run = await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(runId).first<AIRunRow>();
  if (!run) throw new AiRouteError(404, "not_found");
  if (run.status !== "COMPLETED") throw new AiRouteError(409, "not_completed", "only completed runs have acceptable output");
  if (run.output_quarantine !== 1) throw new AiRouteError(409, "not_quarantined", "run output is not quarantined");
  /*
   * CHECKED BEFORE THE FLAG IS TOUCHED, and the order is the whole point.
   *
   * A discarded run stays quarantined on purpose, so without this check accept would find
   * output_quarantine = 1, release the text, and only then fail on the duplicate decision row —
   * having already promoted the exact output somebody refused. The check goes first so a refusal
   * cannot be undone by pressing the other button.
   */
  const decided = await env.WP_OS_DB.prepare("SELECT decision FROM ai_output_decision WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ decision: string }>();
  if (decided) {
    throw new AiRouteError(409, "already_decided", `this output was already ${decided.decision.toLowerCase()} and cannot be decided again`);
  }

  await env.WP_OS_DB.prepare("UPDATE ai_run SET output_quarantine = 0 WHERE id = ?1").bind(runId).run();
  await recordOutputDecision(env, run, actor, "ACCEPTED", reason ?? null);
  await appendEvent(env, {
    eventType: "ai_output.accepted",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_run",
    objectId: runId,
    firmScope: run.firm_scope,
    payload: { trace_id: run.trace_id },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(runId).first<AIRunRow>())!;
}

/**
 * Refuse a quarantined output, permanently, with a stated reason.
 *
 * The output_quarantine flag is deliberately left at 1. Clearing it is what ACCEPT means, and a
 * discard that cleared it would make refused text available to every reader that checks the flag —
 * the exact opposite of the decision the person just took.
 *
 * The text is kept. Same reasoning the firm applied to document delete on 21 Aug 2026: removal is a
 * tombstone, the thing leaves view and the trail survives, because "why did we throw that away" has
 * to stay answerable.
 */
export async function discardQuarantinedOutput(env: Env, actor: Actor, runId: string, reason: string): Promise<AIRunRow> {
  if (actor.type !== "HUMAN") {
    throw new AiRouteError(403, "forbidden", "throwing away an AI output is a person's decision, never an employee's");
  }
  const authz = await authorize(env, actor, "ai_output.discard", { objectType: "ai_run", objectId: runId });
  if (authz.decision === "DENY") throw new AiRouteError(403, "forbidden", authz.reason);
  // Required, and it is the point of the control: a queue emptied without reasons teaches nobody
  // why the work was wrong, and the same run gets commissioned again next week.
  if (reason.trim().length === 0) throw new AiRouteError(400, "reason_required", "say why this is being thrown away");

  const run = await env.WP_OS_DB.prepare("SELECT * FROM ai_run WHERE id = ?1").bind(runId).first<AIRunRow>();
  if (!run) throw new AiRouteError(404, "not_found");
  if (run.status !== "COMPLETED") throw new AiRouteError(409, "not_completed", "only a completed run has output to throw away");
  if (run.output_quarantine !== 1) {
    throw new AiRouteError(409, "already_accepted", "this output was already accepted, so it is in use and cannot be thrown away here");
  }
  const decided = await env.WP_OS_DB.prepare("SELECT decision FROM ai_output_decision WHERE ai_run_id = ?1")
    .bind(runId)
    .first<{ decision: string }>();
  if (decided) {
    throw new AiRouteError(409, "already_decided", `this output was already ${decided.decision.toLowerCase()} and cannot be decided again`);
  }

  await recordOutputDecision(env, run, actor, "DISCARDED", reason.trim());
  await appendEvent(env, {
    eventType: "ai_output.discarded",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "ai_run",
    objectId: runId,
    firmScope: run.firm_scope,
    payload: { trace_id: run.trace_id, reason: reason.trim() },
  });
  return run;
}

/**
 * Throwing away everything currently waiting.
 *
 * Operator, 22 Aug 2026, of the Cockpit's "What is waiting for somebody to look at it?": *"we need a
 * throw all away option."* Fifty-one items nobody is going to review one at a time is a queue that
 * simply sits there, and a queue that sits there teaches a partner to stop looking at queues.
 *
 * BUILT ON THE SINGLE-ITEM PATH RATHER THAN BESIDE IT, which is the whole design. Every guard —
 * human-only, authorized, a required reason, refusing an already-decided or already-accepted run,
 * never clearing the quarantine flag — comes for free and cannot drift, because there is no second
 * implementation to drift from. A bulk operation that reimplements its own checks is how a control
 * ends up stricter one at a time than fifty at a time.
 *
 * ONE REASON COVERS THE BATCH, and each item still gets its own decision row and its own event. The
 * reason is what stops a queue being emptied thoughtlessly, and a per-item prompt for fifty-one items
 * would guarantee it was answered thoughtlessly.
 *
 * IT NEVER RELEASES ANY TEXT. Discarding is a tombstone, exactly as for one: refused output stays
 * refused, the item leaves the queue, and "why did we throw that away" stays answerable.
 */
export async function discardAllQuarantined(
  env: Env,
  actor: Actor,
  reason: string,
): Promise<{ discarded: number; failed: Array<{ id: string; detail: string }> }> {
  const waiting = await env.WP_OS_DB.prepare(
    `SELECT r.id FROM ai_run r
      WHERE r.status = 'COMPLETED' AND r.output_quarantine = 1
        AND NOT EXISTS (SELECT 1 FROM ai_output_decision d WHERE d.ai_run_id = r.id)
      ORDER BY r.created_at ASC`,
  ).all<{ id: string }>();

  let discarded = 0;
  const failed: Array<{ id: string; detail: string }> = [];
  for (const row of waiting.results ?? []) {
    try {
      await discardQuarantinedOutput(env, actor, row.id, reason);
      discarded += 1;
    } catch (err) {
      // One item failing must not silently stop the rest, and must not be silently swallowed either:
      // a partner who pressed "throw all away" and got 49 of 51 needs to know which two remain.
      failed.push({ id: row.id, detail: err instanceof AiRouteError ? err.message : String(err) });
    }
  }
  return { discarded, failed };
}

/** One decision per run, enforced by a UNIQUE index. A second attempt is a conflict, not a no-op. */
async function recordOutputDecision(
  env: Env,
  run: AIRunRow,
  actor: Actor,
  decision: "ACCEPTED" | "DISCARDED",
  reason: string | null,
): Promise<void> {
  try {
    await env.WP_OS_DB.prepare(
      `INSERT INTO ai_output_decision (id, ai_run_id, decision, reason, decided_by, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(`aod_${crypto.randomUUID()}`, run.id, decision, reason, actor.firmUserId!, run.firm_scope)
      .run();
  } catch (err) {
    // Nothing may fail silently: a duplicate here means two people decided the same run at once, and
    // the second one needs to be told that rather than shown a success.
    throw new AiRouteError(409, "already_decided", `somebody has already decided about this output (${String(err).slice(0, 120)})`);
  }
}

const outputDecisionSchema = z.object({ reason: z.string().trim().default("") });

export async function handleAcceptAiOutput(ctx: RouteContext): Promise<Response> {
  try {
    const parsed = outputDecisionSchema.safeParse((await parseJsonBody(ctx.request)) ?? {});
    const run = await acceptQuarantinedOutput(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.success ? parsed.data.reason || undefined : undefined,
    );
    return json(run);
  } catch (err) {
    return errorResponse(err);
  }
}

/** Throwing away everything waiting, in one press, with one reason on the whole batch. */
export async function handleDiscardAllQuarantined(ctx: RouteContext): Promise<Response> {
  try {
    const parsed = outputDecisionSchema.safeParse((await parseJsonBody(ctx.request)) ?? {});
    const out = await discardAllQuarantined(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      parsed.success ? parsed.data.reason : "",
    );
    return json(out);
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleDiscardAiOutput(ctx: RouteContext): Promise<Response> {
  try {
    const parsed = outputDecisionSchema.safeParse((await parseJsonBody(ctx.request)) ?? {});
    const run = await discardQuarantinedOutput(
      ctx.env,
      actorFromIdentity(ctx.identity!),
      ctx.params.id!,
      parsed.success ? parsed.data.reason : "",
    );
    return json({ run, discarded: true });
  } catch (err) {
    return errorResponse(err);
  }
}

// ── Whether an employee may email anybody ──

/**
 * The two outbound switches, read back for the partner who has to decide about them.
 *
 * They are ENVIRONMENT settings and not database rows on purpose. A switch that lets an AI email
 * the outside world should require a deploy to flip — something with a diff, a review and a
 * timestamp — rather than a click that any session with an MP cookie can make. The page shows their
 * state and says how to change them; it deliberately cannot change them itself.
 */
export async function handleAiOutboundPolicy(ctx: RouteContext): Promise<Response> {
  const s = aiOutboundSwitches(ctx.env);
  return json({
    to_partners: {
      on: s.toPartners,
      what: "An AI employee may email Scooter and Sequoia.",
      risk: "Low. The worst case is a partner reads something wrong, in their own inbox, and says so.",
      variable: "WP_OS_AI_EMAIL_PARTNERS",
    },
    to_external: {
      on: s.toExternal,
      what: "An AI employee may email founders, LPs, co-investors — anybody outside the firm.",
      risk: "This is the firm speaking, and there is no undo.",
      variable: "WP_OS_AI_EMAIL_EXTERNAL",
    },
    // Said plainly, because "both off" is the fact a partner most needs and the shape of the
    // response should not be the only thing conveying it.
    summary:
      !s.toPartners && !s.toExternal
        ? "No AI employee can email anyone. Both switches are off."
        : s.toExternal
          ? "AI employees can email outside the firm. This is the setting with no undo."
          : "AI employees can email the partners, and nobody else.",
    how_to_change:
      "These are deployment settings rather than buttons: set the variable to exactly \"enabled\" in wrangler.toml and deploy. A switch this consequential should leave a diff.",
  });
}
