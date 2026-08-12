import type { RouteContext } from "../router";
import { json } from "../router";

/**
 * Activity feed (P3): a read view over the ONE append-only typed event spine (D15).
 * Newest first; scoped to the identity's firm scopes. No second event system exists.
 */

export interface EventRecordRow {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id: string;
  object_type: string;
  object_id: string;
  firm_scope: string;
  payload_json: string;
  created_at: string;
}

export async function handleListActivity(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(limitParam) ? Math.min(Math.max(limitParam, 1), 200) : 50;

  const scopes = ctx.identity!.authorityScopes.filter((s) => s.scopeKey === "firm_scope").map((s) => s.scopeValue);
  const firmScopes = scopes.length > 0 ? scopes : ["west-peek"];
  const scopeClause = `firm_scope IN (${firmScopes.map((s) => `'${s.replaceAll("'", "''")}'`).join(", ")})`;

  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT * FROM event_record WHERE ${scopeClause} ORDER BY created_at DESC, id DESC LIMIT ?1`,
  )
    .bind(limit)
    .all<EventRecordRow>();

  return json({
    events: (rows.results ?? []).map((r) => ({ ...r, payload: JSON.parse(r.payload_json) as unknown })),
  });
}
