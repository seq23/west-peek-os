import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";

/**
 * Governance updates (P3): MP-issued rules, bulletins, and broadcasts.
 * Creation is Managing-Partner-only (governance authority); reads are firm-wide.
 */

export interface GovernanceUpdateRow {
  id: string;
  update_type: string;
  title: string;
  body: string;
  issued_by: string;
  firm_scope: string;
  created_at: string;
}

const createGovernanceUpdateSchema = z.object({
  update_type: z.enum(["RULE", "BULLETIN", "BROADCAST", "CONTEXT_NOTE", "VENDOR_UPDATE"]),
  title: z.string().trim().min(1),
  body: z.string().min(1),
});

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export async function handleCreateGovernanceUpdate(ctx: RouteContext): Promise<Response> {
  const { env, identity } = ctx;
  if (!identity!.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "forbidden", detail: "governance updates are issued by Managing Partners only" }, { status: 403 });
  }

  const body = await parseJsonBody(ctx.request);
  const parsed = createGovernanceUpdateSchema.safeParse(body);
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const input = parsed.data;

  const id = `gu_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO governance_update (id, update_type, title, body, issued_by) VALUES (?1, ?2, ?3, ?4, ?5)",
  )
    .bind(id, input.update_type, input.title, input.body, identity!.id)
    .run();

  await appendEvent(env, {
    eventType: "governance_update.issued",
    actorType: "firm_user",
    actorId: identity!.id,
    objectType: "governance_update",
    objectId: id,
    payload: { update_type: input.update_type, title: input.title },
  });

  const row = await env.WP_OS_DB.prepare("SELECT * FROM governance_update WHERE id = ?1").bind(id).first<GovernanceUpdateRow>();
  return json(row, { status: 201 });
}

export async function handleListGovernanceUpdates(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM governance_update ORDER BY created_at DESC, id",
  ).all<GovernanceUpdateRow>();
  return json({ governance_updates: rows.results ?? [] });
}
