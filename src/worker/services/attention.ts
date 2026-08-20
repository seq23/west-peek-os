import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { attentionSignature } from "../../shared/setup/attentionKey";

/**
 * Answering something on "Needs your attention".
 *
 * THE PROBLEM WITH DISMISSING A DERIVED ITEM. Nothing on that list is a row. Each item is
 * recomputed from system state every time Home loads, so there is no record to tick off — and the
 * naive fix, remembering the item's key forever, is worse than the complaint. Silence
 * "no AI provider is configured" once and you have silenced it for the next outage too.
 *
 * WHAT IS REMEMBERED INSTEAD is the key together with the words the operator was reading when they
 * dismissed it. Same problem, same words, stays quiet. Different words — the failing job changed, a
 * second employee went dark, the count moved — and it is a different thing to be told about, so it
 * speaks up. Everything ages out after a week regardless, because an operator who said "I know"
 * last Tuesday has not said it about today.
 *
 * ACKNOWLEDGE AND DISMISS ARE BOTH RECORDED, and both hide the item. The distinction is kept
 * because they mean different things to a reader of the ledger later: acknowledged is "seen, still
 * true, I am living with it"; dismissed is "stop telling me". Collapsing them would lose the only
 * signal that separates alerts worth having from noise.
 */
export const DISMISSAL_LIFETIME_DAYS = 7;

/*
 * The cutoff is computed here rather than in SQL, and that is not a style choice.
 * `strftime('%Y-%m-%dT%H:%M:%fZ','now', ?1)` with the modifier BOUND returns NULL — SQLite will not
 * take a modifier from a parameter — so `created_at >= NULL` is NULL, no row ever matches, and
 * every dismissal appears to do nothing. It fails silently and looks exactly like a write that did
 * not happen, which is where twenty minutes went.
 */
function cutoffIso(now: Date = new Date()): string {
  return new Date(now.getTime() - DISMISSAL_LIFETIME_DAYS * 86_400_000).toISOString();
}

const dismissSchema = z.object({
  /** The exact headline the operator was looking at. */
  signature: z.string().trim().min(1).max(400),
  kind: z.enum(["ACKNOWLEDGED", "DISMISSED"]).default("DISMISSED"),
});

/** Signatures currently silenced, as `key::signature` strings. */
export async function silencedAttention(env: Env, firmScope = "west-peek"): Promise<Set<string>> {
  const rows = await env.WP_OS_DB.prepare(
    "SELECT item_key, signature FROM attention_dismissal WHERE firm_scope = ?1 AND created_at >= ?2",
  )
    .bind(firmScope, cutoffIso())
    .all<{ item_key: string; signature: string }>();
  return new Set((rows.results ?? []).map((r) => attentionSignature(r.item_key, r.signature)));
}

export async function handleDismissAttention(ctx: RouteContext): Promise<Response> {
  const parsed = dismissSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const key = ctx.params.key!;

  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO attention_dismissal (id, item_key, signature, kind, dismissed_by, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  )
    .bind(`atd_${crypto.randomUUID()}`, key, parsed.data.signature, parsed.data.kind, ctx.identity!.id, "west-peek")
    .run();

  await appendEvent(ctx.env, {
    eventType: parsed.data.kind === "ACKNOWLEDGED" ? "attention.acknowledged" : "attention.dismissed",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "attention_item",
    objectId: key,
    firmScope: "west-peek",
    payload: { signature: parsed.data.signature },
  });

  return json({ ok: true, silenced_for_days: DISMISSAL_LIFETIME_DAYS });
}

/** GET — what is currently silenced, so the page can say so and offer it back. */
export async function handleListSilencedAttention(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT item_key, signature, kind, created_at FROM attention_dismissal
      WHERE firm_scope = 'west-peek' AND created_at >= ?1
      ORDER BY created_at DESC`,
  )
    .bind(cutoffIso())
    .all();
  return json({ silenced: rows.results ?? [] });
}

/** DELETE — bring them all back. The way out of having silenced something by mistake. */
export async function handleClearSilencedAttention(ctx: RouteContext): Promise<Response> {
  await ctx.env.WP_OS_DB.prepare("DELETE FROM attention_dismissal WHERE firm_scope = 'west-peek'").run();
  await appendEvent(ctx.env, {
    eventType: "attention.unsilenced",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "attention_item",
    objectId: "all",
    firmScope: "west-peek",
    payload: {},
  });
  return json({ ok: true });
}
