import type { RouteContext } from "../router";
import { json } from "../router";

/**
 * Reference-data reads (P3): the machine/domain registry as seeded from the single
 * TypeScript source (D14). Read-only; any authenticated firm user may read.
 */

export async function handleListMachines(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM machine ORDER BY id").all();
  return json({ machines: rows.results ?? [] });
}

export async function handleListDomains(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare("SELECT * FROM domain ORDER BY id").all();
  return json({ domains: rows.results ?? [] });
}
