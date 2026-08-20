import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { browsePage, browserConfigured } from "../effects/browserClient";
import { checkExecutable, checkRequest, searchStartUrl, type PaymentMode } from "../../shared/browser/taskPolicy";

/**
 * Browser task lifecycle (P50) — the runner the scaffold was missing.
 *
 * REQUEST → APPROVE → RUN → RECORD. Four steps and three of them are gates, because a browser task
 * is the only capability here that egresses to a runtime-chosen URL AND returns untrusted content
 * as model input.
 *
 * WHY REQUESTING AND RUNNING ARE SEPARATE CALLS. An employee may raise a task; only an approved task
 * executes. If creating a task also ran it, the approval would be advisory — and an advisory
 * approval on "fetch this arbitrary URL and feed it back to an AI employee" is no approval at all.
 *
 * WHAT COMES BACK IS FENCED, NOT TRUSTED. browsePage() wraps page text before it can reach a model.
 * The fence and the SSRF re-check after redirect are the two things standing between "read a page"
 * and "an attacker chose our prompt".
 */

export class BrowserTaskError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

interface TaskRow {
  id: string;
  objective: string;
  start_url: string;
  status: string;
  approval_card_id: string | null;
  payment_mode: PaymentMode;
  max_price_usd: number;
  spent_usd: number;
  ai_employee_id: string | null;
  refusal_reason: string | null;
  result_text: string | null;
  result_url: string | null;
  firm_scope: string;
}

async function requireTask(env: Env, id: string): Promise<TaskRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM browser_task WHERE id = ?1").bind(id).first<TaskRow>();
  if (!row) throw new BrowserTaskError(404, "not_found", "no such browser task");
  return row;
}

const requestSchema = z.object({
  objective: z.string().min(8).max(500),
  /**
   * Optional. NAMING THE PAGE WAS THE WRONG ASK. "Find out whether Psyflo still has a VP of Sales"
   * is the job; knowing which URL answers it is the job too, and demanding it up front made the
   * operator do the looking before asking anybody to look. Absent, the task starts from a search
   * for the objective — which is what a person would do.
   */
  start_url: z.string().max(2000).optional(),
  ai_employee_id: z.string().max(80).nullish(),
  /** The card this look is for. Carries the standing permission, and receives the result. */
  work_card_id: z.string().max(80).nullish(),
  payment_mode: z.enum(["NONE", "X402_AUTO"]).default("NONE"),
  max_price_usd: z.number().min(0).max(500).default(0),
});

/** Raise a task. Policy is checked here so an impossible task is refused before it is recorded. */
export async function requestTask(
  env: Env,
  actor: Actor,
  input: z.infer<typeof requestSchema>,
): Promise<TaskRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "ai.run", { objectType: "browser_task", firmScope });
  if (authz.decision !== "ALLOW") throw new BrowserTaskError(403, "forbidden", authz.reason);

  // No page named? Start from a search for the objective, which is what a person would do.
  const startUrl = input.start_url && input.start_url.trim().length >= 8
    ? input.start_url.trim()
    : searchStartUrl(input.objective);

  const refusal = checkRequest({
    objective: input.objective,
    start_url: startUrl,
    payment_mode: input.payment_mode,
    max_price_usd: input.max_price_usd,
    requested_by_type: actor.type === "HUMAN" ? "HUMAN" : "AI",
  });
  if (refusal) throw new BrowserTaskError(400, refusal.code, refusal.detail);

  // DOES A CARD ALREADY PERMIT THIS? A human granted that card standing permission to involve
  // reading web pages, which is the approval — made once, deliberately, and scoped to one piece of
  // work — rather than the same yes repeated for every careers page on a card whose whole job is
  // checking careers pages. Without a card, or without permission on it, the task waits for a human
  // exactly as before.
  let preApproved = false;
  if (input.work_card_id) {
    const card = await env.WP_OS_DB.prepare(
      "SELECT allows_browser FROM work_card WHERE id = ?1 AND firm_scope = ?2",
    )
      .bind(input.work_card_id, firmScope)
      .first<{ allows_browser: number }>();
    preApproved = card?.allows_browser === 1;
  }

  const id = `bwt_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO browser_task (id, objective, start_url, requested_by_type, requested_by_id,
                               ai_employee_id, work_card_id, status, approval_card_id,
                               payment_mode, max_price_usd, firm_scope)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`,
  )
    .bind(id, input.objective, startUrl, actor.type === "HUMAN" ? "HUMAN" : "AI",
          actor.firmUserId ?? actor.aiEmployeeId ?? "system", input.ai_employee_id ?? null,
          input.work_card_id ?? null,
          preApproved ? "APPROVED" : "REQUESTED",
          // NULL, deliberately. approval_card_id is a foreign key to a real approval card, and a
          // pre-approved look has none — the authority is the card's standing grant, which is
          // recorded by work_card_id being set plus allows_browser on that card, and stated
          // explicitly in the event below. Writing a synthetic id here failed the constraint, and
          // rightly: inventing a receipt that points at nothing is exactly what that key prevents.
          null,
          input.payment_mode, input.max_price_usd, firmScope)
    .run();

  await appendEvent(env, {
    eventType: "browser_task.requested",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "browser_task", objectId: id, firmScope,
    payload: {
      start_url: startUrl,
      payment_mode: input.payment_mode,
      work_card_id: input.work_card_id ?? null,
      // Recorded because "nobody pressed approve" is a thing an auditor must be able to explain.
      pre_approved_by_card: preApproved,
    },
  });

  return await requireTask(env, id);
}

/**
 * Approve a task. HUMAN ONLY.
 *
 * An AI employee approving another employee's browser task would let the workforce authorise its
 * own egress, which is the loop canon §22A.7 exists to break.
 */
export async function approveTask(env: Env, actor: Actor, id: string): Promise<TaskRow> {
  const task = await requireTask(env, id);
  if (actor.type !== "HUMAN") throw new BrowserTaskError(403, "human_required", "A browser task is approved by a person.");
  const authz = await authorize(env, actor, "approval.decide", {
    objectType: "browser_task", objectId: id, firmScope: task.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new BrowserTaskError(403, "forbidden", authz.reason);
  if (task.status !== "REQUESTED") throw new BrowserTaskError(409, "illegal_state", `task is ${task.status}`);

  await env.WP_OS_DB.prepare("UPDATE browser_task SET status = 'APPROVED' WHERE id = ?1").bind(id).run();
  await appendEvent(env, {
    eventType: "browser_task.approved",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "browser_task", objectId: id, firmScope: task.firm_scope,
    payload: {},
  });
  return await requireTask(env, id);
}

export interface RunResult {
  task: TaskRow;
  ok: boolean;
  detail: string;
}

/** Execute an approved task. Every refusal is recorded on the row rather than thrown away. */
export async function runTask(
  env: Env,
  id: string,
  browse: typeof browsePage = browsePage,
  opts?: { shots?: boolean },
): Promise<RunResult> {
  const task = await requireTask(env, id);

  const provider = await env.WP_OS_DB.prepare(
    "SELECT enabled, kill_switched FROM provider_registry WHERE provider_key = 'cloudflare_browser'",
  ).first<{ enabled: number; kill_switched: number }>();

  const refusal = checkExecutable({
    status: task.status,
    // The approval is the status transition; a task APPROVED by approveTask() carries the authority
    // even when no separate approval_card was minted for it.
    approvalCardId: task.status === "APPROVED" ? (task.approval_card_id ?? "approved") : task.approval_card_id,
    providerEnabled: Number(provider?.enabled ?? 0) === 1,
    providerKillSwitched: Number(provider?.kill_switched ?? 0) === 1,
    transportConfigured: browserConfigured(env),
  });
  if (refusal) {
    await env.WP_OS_DB.prepare(
      "UPDATE browser_task SET status = 'REFUSED', refusal_reason = ?2, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    ).bind(id, refusal.detail).run();
    await appendEvent(env, {
      eventType: "browser_task.refused",
      actorType: "system", actorId: "system",
      objectType: "browser_task", objectId: id, firmScope: task.firm_scope,
      payload: { code: refusal.code },
    });
    return { task: await requireTask(env, id), ok: false, detail: refusal.detail };
  }

  await env.WP_OS_DB.prepare("UPDATE browser_task SET status = 'RUNNING' WHERE id = ?1").bind(id).run();
  const result = await browse(env, task.start_url, undefined, { shots: opts?.shots === true });

  if (!result.ok) {
    await env.WP_OS_DB.prepare(
      "UPDATE browser_task SET status = 'FAILED', refusal_reason = ?2, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    ).bind(id, result.detail).run();
    return { task: await requireTask(env, id), ok: false, detail: result.detail };
  }

  await env.WP_OS_DB.prepare(
    `UPDATE browser_task SET status = 'SUCCEEDED', result_text = ?2, result_url = ?3,
            completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1`,
  )
    // Already fenced by browsePage. Stored fenced so anything reading it later inherits the warning
    // rather than having to remember to add one.
    .bind(id, result.text, result.finalUrl)
    .run();

  /*
   * KEEP THE PICTURES.
   *
   * Bytes to R2, metadata to D1 — the same split documents already use, because a few hundred
   * kilobytes per shot is not something D1 should be holding.
   *
   * BEST EFFORT AND LAST. The reading has already been recorded as SUCCEEDED above; a storage
   * failure must not turn a page that was read perfectly well into a failed task. What is lost in
   * that case is the evidence, not the answer, and the interface shows which shots exist rather
   * than assuming both.
   */
  for (const shot of result.shots ?? []) {
    try {
      const bucket = env.WP_OS_DOCUMENTS;
      if (!bucket) break;
      const digest = await crypto.subtle.digest("SHA-256", shot.bytes as unknown as ArrayBuffer);
      const sha = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const key = `${task.firm_scope}/browser-shots/${id}/${shot.key}-${sha.slice(0, 16)}.jpg`;
      await bucket.put(key, shot.bytes as unknown as ArrayBuffer, {
        httpMetadata: { contentType: "image/jpeg" },
      });
      await env.WP_OS_DB.prepare(
        `INSERT INTO browser_task_shot (id, task_id, viewport, width, height, r2_key, sha256, size_bytes, firm_scope)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
      )
        .bind(`bts_${crypto.randomUUID()}`, id, shot.key, shot.width, shot.height, key, sha, shot.bytes.byteLength, task.firm_scope)
        .run();
    } catch {
      // This shot is not kept. The reading stands.
    }
  }

  await appendEvent(env, {
    eventType: "browser_task.succeeded",
    actorType: "system", actorId: "system",
    objectType: "browser_task", objectId: id, firmScope: task.firm_scope,
    payload: { final_url: result.finalUrl, chars: result.text?.length ?? 0, shots: result.shots?.length ?? 0 },
  });

  return { task: await requireTask(env, id), ok: true, detail: "ok" };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof BrowserTaskError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleRequestBrowserTask(ctx: RouteContext): Promise<Response> {
  const parsed = requestSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await requestTask(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleApproveBrowserTask(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await approveTask(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id));
  } catch (err) {
    return fail(err);
  }
}

export async function handleRunBrowserTask(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const out = await runTask(ctx.env, ctx.params.id);
    return json(out, { status: out.ok ? 200 : 409 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleListBrowserTasks(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, objective, start_url, status, refusal_reason, result_url, created_at FROM browser_task ORDER BY created_at DESC LIMIT 100",
  ).all();
  return json({ tasks: rows.results ?? [] });
}

const grantSchema = z.object({ allows_browser: z.boolean() });

/**
 * POST /api/work-cards/:id/browser-permission — let this card's work involve reading web pages.
 *
 * HUMAN ONLY, and that is the whole point. This is the approval, moved from "yes to this URL" to
 * "yes, this piece of work may involve looking things up" — a decision worth making once, about a
 * scope somebody understands, rather than the same yes repeated for every careers page on a card
 * whose entire purpose is checking careers pages.
 *
 * Scoped to one card. Granting it for "Diligence Psyflo" says nothing about any other work, and
 * withdrawing it is the same click. Who granted it and when are recorded, because a standing
 * permission with no record of who gave it is a setting rather than a permission.
 */
export async function handleSetCardBrowserPermission(ctx: RouteContext): Promise<Response> {
  const cardId = ctx.params.id;
  const parsed = grantSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!cardId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });

  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") {
    return json({ error: "human_required", detail: "Only a person can let work reach the web." }, { status: 403 });
  }
  const authz = await authorize(ctx.env, actor, "approval.decide", {
    objectType: "work_card",
    objectId: cardId,
    firmScope: actor.firmScopes[0] ?? "west-peek",
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE work_card
        SET allows_browser = ?2,
            browser_granted_by = ?3,
            browser_granted_at = ?4
      WHERE id = ?1`,
  )
    .bind(cardId, parsed.data.allows_browser ? 1 : 0, parsed.data.allows_browser ? ctx.identity!.id : null, parsed.data.allows_browser ? now : null)
    .run();

  await appendEvent(ctx.env, {
    eventType: parsed.data.allows_browser ? "work_card.browser_granted" : "work_card.browser_withdrawn",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "work_card",
    objectId: cardId,
    firmScope: actor.firmScopes[0] ?? "west-peek",
    payload: {},
  });

  return json({
    allows_browser: parsed.data.allows_browser,
    granted_at: parsed.data.allows_browser ? now : null,
    detail: parsed.data.allows_browser
      ? "Whoever carries this card can now look at pages for it without asking each time. Every look is still recorded, and read-only."
      : "Withdrawn. Looks for this card need a person to approve each one again.",
  });
}

/**
 * POST /api/work-cards/:id/look — ask for a page to be read, for this card.
 *
 * Runs IMMEDIATELY when the card carries permission, which is the operator's explicit instruction:
 * work that is allowed to involve the web should not stop to ask on every page. Without permission
 * it lands as a request and waits for a person, exactly as before.
 */
export async function handleCardLook(ctx: RouteContext): Promise<Response> {
  const cardId = ctx.params.id;
  const body = (await ctx.request.json().catch(() => null)) as { objective?: string; start_url?: string } | null;
  // Only the objective is required. Without a page it starts from a search, which is what a person
  // would do — and is the difference between asking for what you want to know and being made to
  // find it yourself first.
  if (!cardId || !body?.objective) {
    return json({ error: "invalid_input", detail: "say what they should find out" }, { status: 400 });
  }

  const actor = actorFromIdentity(ctx.identity!);
  let task: TaskRow;
  try {
    task = await requestTask(ctx.env, actor, {
      objective: body.objective,
      ...(body.start_url ? { start_url: body.start_url } : {}),
      work_card_id: cardId,
      payment_mode: "NONE",
      max_price_usd: 0,
    } as never);
  } catch (err) {
    const e = err as BrowserTaskError;
    return json({ error: e.code ?? "refused", detail: e.message }, { status: e.status ?? 400 });
  }

  // Pre-approved by the card's standing grant: go and look now.
  if (task.status === "APPROVED") {
    const result = await runTask(ctx.env, task.id);
    return json({ task: result.task, ran: true, ok: result.ok, detail: result.detail }, { status: 201 });
  }

  return json(
    {
      task,
      ran: false,
      detail: "Raised. This card does not allow looking without asking, so it is waiting for a person to approve it.",
    },
    { status: 201 },
  );
}
