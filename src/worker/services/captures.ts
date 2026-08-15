import { z } from "zod";
import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { isMachinePaused } from "./machines";
import { privacyLabelSchema, DEFAULT_PRIVACY_LABEL } from "../../shared/privacy";
import { actorFromIdentity, authorize, canAccessPrivacyLabel, privacyVisibilityClause } from "./authorize";
import { createWorkCardInternal } from "./workCards";

/**
 * Capture intake (+Capture): unstructured input enters here, then routes to a
 * machine. Privacy labels gate visibility server-side (never by UI hiding);
 * firm_scope isolation is enforced through authorize() on every mutation.
 */

export interface CaptureRow {
  id: string;
  capture_type: string;
  raw_text: string;
  source_channel: string;
  privacy_label: string;
  firm_scope: string;
  captured_by: string;
  status: string;
  routed_machine_id: number | null;
  created_at: string;
}

const createCaptureSchema = z.object({
  capture_type: z.string().trim().min(1),
  raw_text: z.string().min(1),
  source_channel: z.string().trim().min(1),
  privacy_label: privacyLabelSchema.optional(),
});

const routeCaptureSchema = z.object({
  machine_id: z.number().int().positive(),
  /** When true, also create a work card for the routed capture. */
  create_work_card: z.boolean().optional(),
  title: z.string().trim().min(1).optional(),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function firmScopesOf(identity: FirmUserIdentity): string[] {
  const scopes = identity.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  return scopes.length > 0 ? scopes : ["west-peek"];
}

function scopeClause(identity: FirmUserIdentity): string {
  const scopes = firmScopesOf(identity);
  return `firm_scope IN (${scopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ")})`;
}

/** Fetch a capture the identity may see (firm scope + privacy label), else null. */
export async function getVisibleCapture(env: Env, identity: FirmUserIdentity, id: string): Promise<CaptureRow | null> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(id).first<CaptureRow>();
  if (!row) return null;
  if (!firmScopesOf(identity).includes(row.firm_scope)) return null;
  if (!canAccessPrivacyLabel(identity, row.privacy_label)) return null;
  return row;
}

export async function handleCreateCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const body = await parseJsonBody(ctx.request);
  const parsed = createCaptureSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.create", { objectType: "capture", firmScope: "west-peek" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  const id = `cap_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO capture (id, capture_type, raw_text, source_channel, privacy_label, firm_scope, captured_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
  )
    .bind(id, input.capture_type, input.raw_text, input.source_channel, input.privacy_label ?? DEFAULT_PRIVACY_LABEL, "west-peek", identity!.id)
    .run();

  await appendEvent(env, {
    eventType: "capture.created",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: id,
    payload: { capture_type: input.capture_type, source_channel: input.source_channel, privacy_label: input.privacy_label ?? DEFAULT_PRIVACY_LABEL },
  });

  const row = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(id).first<CaptureRow>();
  return json(row, { status: 201 });
}

export async function handleListCaptures(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const status = url.searchParams.get("status");
  const visibility = privacyVisibilityClause(ctx.identity!);
  const scope = scopeClause(ctx.identity!);
  const rows = status
    ? await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM capture WHERE status = ?1 AND ${scope} AND ${visibility} ORDER BY created_at DESC, id`,
      )
        .bind(status)
        .all<CaptureRow>()
    : await ctx.env.WP_OS_DB.prepare(
        `SELECT * FROM capture WHERE ${scope} AND ${visibility} ORDER BY created_at DESC, id`,
      ).all<CaptureRow>();
  return json({ captures: rows.results ?? [] });
}

export async function handleGetCapture(ctx: RouteContext): Promise<Response> {
  const row = await getVisibleCapture(ctx.env, ctx.identity!, ctx.params.id!);
  if (!row) return json({ error: "not_found" }, { status: 404 });
  return json(row);
}

/** Route a capture to a machine; optionally create the work card in one step. */
export async function handleRouteCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const capture = await getVisibleCapture(env, identity!, ctx.params.id!);
  if (!capture) return json({ error: "not_found" }, { status: 404 });

  const body = await parseJsonBody(ctx.request);
  const parsed = routeCaptureSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  if (capture.status === "ARCHIVED") {
    return json({ error: "conflict", detail: "archived captures cannot be routed" }, { status: 409 });
  }

  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.route", { objectType: "capture", objectId: capture.id, firmScope: capture.firm_scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  const machine = await env.WP_OS_DB.prepare("SELECT id, domain_id, name FROM machine WHERE id = ?1")
    .bind(input.machine_id)
    .first<{ id: number; domain_id: string; name: string }>();
  if (!machine) return json({ error: "invalid_input", detail: "unknown machine_id" }, { status: 400 });

  // P17: a paused machine may not be given new work. Enforced here, in the service, so it holds
  // for any caller — not only for a UI that chose to grey the option out.
  const paused = await isMachinePaused(env, machine.id);
  if (paused.paused) {
    return json(
      { error: "machine_paused", detail: `machine ${machine.id} (${machine.name}) is PAUSED: ${paused.reason ?? "no reason recorded"}` },
      { status: 409 },
    );
  }

  await env.WP_OS_DB.prepare("UPDATE capture SET status = 'ROUTED', routed_machine_id = ?2 WHERE id = ?1")
    .bind(capture.id, machine.id)
    .run();

  await appendEvent(env, {
    eventType: "capture.routed",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
    payload: { machine_id: machine.id, machine_name: machine.name },
  });

  let workCard: unknown = null;
  if (input.create_work_card) {
    workCard = await createWorkCardInternal(env, identity!, {
      capture_id: capture.id,
      title: input.title ?? capture.raw_text.slice(0, 120),
      domain_id: machine.domain_id,
      machine_id: machine.id,
      privacy_label: capture.privacy_label,
      firm_scope: capture.firm_scope,
    });
  }

  const updated = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(capture.id).first<CaptureRow>();
  return json({ capture: updated, routed_to: machine, work_card: workCard });
}

export async function handleArchiveCapture(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  const capture = await getVisibleCapture(env, identity!, ctx.params.id!);
  if (!capture) return json({ error: "not_found" }, { status: 404 });
  if (capture.status !== "NEW") {
    return json({ error: "conflict", detail: `capture is ${capture.status}; only NEW captures can be archived` }, { status: 409 });
  }
  const actor = actorFromIdentity(identity!);
  const authz = await authorize(env, actor, "capture.archive", { objectType: "capture", objectId: capture.id, firmScope: capture.firm_scope });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", reason: authz.reason }, { status: 403 });

  await env.WP_OS_DB.prepare("UPDATE capture SET status = 'ARCHIVED' WHERE id = ?1").bind(capture.id).run();
  await appendEvent(env, {
    eventType: "capture.archived",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "capture",
    objectId: capture.id,
    firmScope: capture.firm_scope,
  });
  const updated = await env.WP_OS_DB.prepare("SELECT * FROM capture WHERE id = ?1").bind(capture.id).first<CaptureRow>();
  return json(updated);
}
