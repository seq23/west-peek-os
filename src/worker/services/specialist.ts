import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize, privacyVisibilityClause } from "./authorize";
import { runAi } from "../ai/runAi";
import { privacyLabelSchema } from "../../shared/privacy";

/**
 * Specialist AI provider lane — Harvey (legal) and Norm (compliance) (P23, GAP-15).
 *
 * An engagement is a bounded question put to a specialist vendor THROUGH `run_ai()`. There is no
 * second call path: the same egress policy, budget preflight, kill switch, and output quarantine
 * apply, and the run lands in the same `ai_run` ledger as everything else.
 *
 * Three refusals are structural, not advisory:
 * 1. Nothing egresses to a specialist vendor until an operator explicitly allows a data class for
 *    it. Neither vendor has an allowing row, so `run_ai` blocks with `data_policy_denies_label`.
 * 2. Accepting specialist output records it as an INPUT to a human decision. There is no
 *    `conclusion` column, and `legal.final_conclusion` / `compliance.act_as_officer` remain
 *    human-reserved in the canon register.
 * 3. Neither vendor has an endpoint or a credential in this environment, so even with an egress
 *    allowance the adapter fails closed with a named reason.
 */

const engagementSchema = z.object({
  provider_key: z.enum(["harvey", "norm"]),
  matter_type: z.enum(["LEGAL_RESEARCH", "CONTRACT_REVIEW", "COMPLIANCE_REVIEW", "POLICY_QUESTION"]),
  question: z.string().trim().min(1),
  data_class: privacyLabelSchema.default("INTERNAL"),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleOpenEngagement(ctx: RouteContext): Promise<Response> {
  const parsed = engagementSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "specialist_engagement.open", { objectType: "specialist_engagement" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const b = parsed.data;
  const id = `seng_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO specialist_engagement (id, provider_key, matter_type, question, data_class, status, opened_by, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, 'OPENED', ?6, ?7)",
  )
    .bind(id, b.provider_key, b.matter_type, b.question, b.data_class, ctx.identity!.id, actor.firmScopes[0] ?? "west-peek")
    .run();

  // Through the governed boundary, pinned to the specialist vendor. Everything that can refuse
  // this — privacy mode, egress policy, kill switch, budget, missing credential — does so here.
  const { run } = await runAi(ctx.env, {
    purpose: `specialist ${b.provider_key}: ${b.matter_type}`,
    actor,
    inputs: [b.question],
    sensitivity: b.data_class,
    capabilityRequirement: b.provider_key === "harvey" ? "legal-research" : "compliance-review",
    budgetContext: { judgement: true, confidential: true, providerKey: b.provider_key },
    routing: { taskClass: `specialist-${b.provider_key}`, category: b.provider_key === "harvey" ? "LEGAL" : "COMPLIANCE" },
  });

  const completed = run.status === "COMPLETED";
  const status = completed ? (run.output_quarantine === 1 ? "RETURNED_QUARANTINED" : "RETURNED_QUARANTINED") : "BLOCKED";
  await ctx.env.WP_OS_DB.prepare("UPDATE specialist_engagement SET status = ?2, block_reason = ?3, ai_run_id = ?4 WHERE id = ?1")
    .bind(id, status, completed ? null : run.failure_reason, run.id)
    .run();

  await appendEvent(ctx.env, {
    eventType: "specialist_engagement.opened",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "specialist_engagement",
    objectId: id,
    payload: { provider_key: b.provider_key, matter_type: b.matter_type, run_status: run.status },
  });

  return json(
    {
      engagement: await ctx.env.WP_OS_DB.prepare("SELECT * FROM specialist_engagement WHERE id = ?1").bind(id).first(),
      run,
      boundary:
        "The specialist vendor was called through run_ai() like any other provider. Whatever it returns is an INPUT to a human decision: West Peek OS never issues a legal or compliance conclusion (legal.final_conclusion and compliance.act_as_officer are human-reserved).",
    },
    { status: 201 },
  );
}

export async function handleListEngagements(ctx: RouteContext): Promise<Response> {
  // An engagement carries the question itself, at the data class it was opened under: gate it.
  const visibility = privacyVisibilityClause(ctx.identity!, "data_class");
  const engagements = (
    await ctx.env.WP_OS_DB.prepare(`SELECT * FROM specialist_engagement WHERE ${visibility} ORDER BY created_at DESC LIMIT 100`).all()
  ).results ?? [];
  const providers = (
    await ctx.env.WP_OS_DB.prepare(
      `SELECT p.provider_key, p.display_name, p.enabled, p.kill_switched, p.base_url,
              (SELECT COUNT(*) FROM provider_data_policy d WHERE d.provider_id = p.id AND d.allowed = 1) AS allowed_labels
         FROM provider_registry p WHERE p.provider_key IN ('harvey','norm')`,
    ).all<{ provider_key: string; display_name: string; enabled: number; kill_switched: number; base_url: string | null; allowed_labels: number }>()
  ).results ?? [];

  return json({
    engagements,
    providers: providers.map((p) => ({
      ...p,
      credential_configured:
        typeof (ctx.env as unknown as Record<string, unknown>)[p.provider_key === "harvey" ? "HARVEY_API_KEY" : "NORM_API_KEY"] === "string",
      endpoint_known: p.base_url !== null,
    })),
    status: "UNPROVEN — VENDOR ACCESS GATE",
    gate_detail:
      "No account, contract, credential, endpoint, or published API contract exists for Harvey or Norm in this environment. Both are registered as configuration (D9), disabled, with no data class allowed to egress. The lane, quarantine, cost, and privacy architecture are implemented and tested; the vendors have never been called.",
  });
}

/**
 * Accept a specialist's returned output as an INPUT. This deliberately does not, and cannot,
 * record a conclusion: it promotes a quarantined `ai_run` output through the existing P4 accept
 * path and notes the human's own disposition beside it.
 */
export async function handleAcceptEngagement(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "accepting specialist output is a human act" }, { status: 403 });
  const parsed = z.object({ disposition_note: z.string().trim().min(1) }).safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  const authz = await authorize(ctx.env, actor, "specialist_engagement.accept", { objectType: "specialist_engagement", objectId: ctx.params.id! });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const visibility = privacyVisibilityClause(ctx.identity!, "data_class");
  const engagement = await ctx.env.WP_OS_DB.prepare(`SELECT * FROM specialist_engagement WHERE id = ?1 AND ${visibility}`)
    .bind(ctx.params.id!)
    .first<{ id: string; status: string; ai_run_id: string | null }>();
  if (!engagement) return json({ error: "not_found" }, { status: 404 });
  if (engagement.status !== "RETURNED_QUARANTINED") {
    return json(
      { error: "nothing_to_accept", detail: `engagement is ${engagement.status}: there is no returned output to accept` },
      { status: 409 },
    );
  }

  await ctx.env.WP_OS_DB.prepare(
    "UPDATE specialist_engagement SET status = 'ACCEPTED_AS_INPUT', accepted_by = ?2, accepted_at = ?3, disposition_note = ?4 WHERE id = ?1",
  )
    .bind(engagement.id, actor.firmUserId!, new Date().toISOString(), parsed.data.disposition_note)
    .run();

  await appendEvent(ctx.env, {
    eventType: "specialist_engagement.accepted_as_input",
    actorType: "firm_user",
    actorId: actor.firmUserId!,
    objectType: "specialist_engagement",
    objectId: engagement.id,
    payload: { ai_run_id: engagement.ai_run_id },
  });

  return json({
    engagement: await ctx.env.WP_OS_DB.prepare("SELECT * FROM specialist_engagement WHERE id = ?1").bind(engagement.id).first(),
    note: "Recorded as an input to a human decision. West Peek OS has not issued a legal or compliance conclusion and cannot: those actions are human-reserved.",
  });
}
