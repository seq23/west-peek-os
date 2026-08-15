import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";

/**
 * Private personal intelligence (P14, task §8 GAP-04 "private personal intelligence boundary").
 *
 * THIS IS NOT INSTITUTIONAL TRUTH, and the module is built so it cannot become it:
 *
 * - Owner-scoped by construction. Every read and write is filtered by
 *   `owner_firm_user_id = <the authenticated user>`. There is no route, parameter, or
 *   query flag that reads another person's layer, so the second Managing Partner cannot
 *   read the first's — and the MANAGING_PARTNER role grants no bypass here. This is the
 *   one place in West Peek OS where MP is deliberately NOT a master key, because the data
 *   is personal rather than firm data.
 * - Physically separate from the evidence substrate. Nothing here can be linked to a
 *   diligence_claim, knowledge_record, lp_claim, or ic_packet: no foreign key exists and
 *   no service reads across.
 * - Honest about calculation. `calculation_state` is `UNPROVEN_NO_SOURCE` until something
 *   real computes an entry. No ephemeris, transit table, or astronomy library is present
 *   in this repo and none is fabricated: operator-entered content is labelled
 *   MANUAL_ENTRY, and the governed interface for a future calculation source is here
 *   without a pretend implementation behind it.
 */

export class PersonalIntelligenceError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

function errorResponse(err: unknown): Response {
  if (err instanceof PersonalIntelligenceError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

async function parseJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export const PERSONAL_INTELLIGENCE_DISCLAIMER =
  "Private to you. Not institutional truth, not firm evidence, and never usable to justify an investment, LP, or compliance decision.";

const profileSchema = z.object({
  enabled: z.boolean(),
  config: z
    .object({
      birth_date: z.string().trim().min(1).optional(),
      birth_time: z.string().trim().min(1).optional(),
      birth_place: z.string().trim().min(1).optional(),
      overlays: z.array(z.enum(["TRANSIT", "LUNAR", "TIMING_WINDOW"])).optional(),
    })
    .default({}),
  calculation_source: z.string().trim().min(1).default("NONE"),
});

export async function handleGetPersonalProfile(ctx: RouteContext): Promise<Response> {
  const row = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM personal_intelligence_profile WHERE owner_firm_user_id = ?1",
  )
    .bind(ctx.identity!.id)
    .first();
  return json({
    profile: row ?? null,
    disclaimer: PERSONAL_INTELLIGENCE_DISCLAIMER,
    calculation_note:
      "No ephemeris or transit-calculation source is configured or bundled. Entries you record are MANUAL_ENTRY. West Peek OS does not compute planetary positions and does not pretend to.",
  });
}

export async function handleSetPersonalProfile(ctx: RouteContext): Promise<Response> {
  const parsed = profileSchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "personal_intelligence.configure", {
    objectType: "personal_intelligence_profile",
    objectId: ctx.identity!.id,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const body = parsed.data;
  // A configured source name does not prove a working source: state stays UNPROVEN unless
  // the operator explicitly records entries by hand.
  const state = body.calculation_source === "NONE" ? "UNPROVEN_NO_SOURCE" : "MANUAL_ENTRY";
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO personal_intelligence_profile (id, owner_firm_user_id, config_json, calculation_source, calculation_state, enabled, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
     ON CONFLICT (owner_firm_user_id) DO UPDATE SET
       config_json = excluded.config_json,
       calculation_source = excluded.calculation_source,
       calculation_state = excluded.calculation_state,
       enabled = excluded.enabled,
       updated_at = excluded.updated_at`,
  )
    .bind(`pip_${crypto.randomUUID()}`, ctx.identity!.id, JSON.stringify(body.config), body.calculation_source, state, body.enabled ? 1 : 0, now)
    .run();

  // The event records THAT a private layer was configured, never its contents.
  await appendEvent(ctx.env, {
    eventType: "personal_intelligence.configured",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "personal_intelligence_profile",
    objectId: ctx.identity!.id,
    payload: { enabled: body.enabled, calculation_state: state },
  });

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM personal_intelligence_profile WHERE owner_firm_user_id = ?1")
    .bind(ctx.identity!.id)
    .first();
  return json({ profile: row, disclaimer: PERSONAL_INTELLIGENCE_DISCLAIMER }, { status: 201 });
}

const entrySchema = z.object({
  entry_date: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "entry_date must be YYYY-MM-DD"),
  kind: z.enum(["TRANSIT", "LUNAR", "TIMING_WINDOW", "NOTE"]),
  headline: z.string().trim().min(1),
  body: z.string().trim().default(""),
  source_note: z.string().trim().min(1).optional(),
});

export async function handleCreatePersonalEntry(ctx: RouteContext): Promise<Response> {
  const parsed = entrySchema.safeParse(await parseJsonBody(ctx.request));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "personal_intelligence.record", {
    objectType: "personal_intelligence_entry",
    objectId: ctx.identity!.id,
  });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const profile = await ctx.env.WP_OS_DB.prepare(
    "SELECT enabled FROM personal_intelligence_profile WHERE owner_firm_user_id = ?1",
  )
    .bind(ctx.identity!.id)
    .first<{ enabled: number }>();
  if (!profile || profile.enabled !== 1) {
    return json(
      { error: "layer_disabled", detail: "enable your private personal-intelligence layer before recording entries" },
      { status: 409 },
    );
  }

  const id = `pie_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO personal_intelligence_entry (id, owner_firm_user_id, entry_date, kind, headline, body, calculation_state, source_note)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'MANUAL_ENTRY', ?7)`,
  )
    .bind(
      id,
      ctx.identity!.id,
      parsed.data.entry_date,
      parsed.data.kind,
      parsed.data.headline,
      parsed.data.body,
      parsed.data.source_note ?? "operator-entered; no ephemeris source is configured",
    )
    .run();

  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM personal_intelligence_entry WHERE id = ?1").bind(id).first();
  return json({ entry: row, disclaimer: PERSONAL_INTELLIGENCE_DISCLAIMER }, { status: 201 });
}

/**
 * List the ACTING USER's entries. There is deliberately no owner parameter: the only
 * readable layer is your own, whatever role you hold.
 */
export async function handleListPersonalEntries(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const date = url.searchParams.get("date");
  const rows = date
    ? await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM personal_intelligence_entry WHERE owner_firm_user_id = ?1 AND entry_date = ?2 ORDER BY created_at DESC",
      )
        .bind(ctx.identity!.id, date)
        .all()
    : await ctx.env.WP_OS_DB.prepare(
        "SELECT * FROM personal_intelligence_entry WHERE owner_firm_user_id = ?1 ORDER BY entry_date DESC, created_at DESC LIMIT 100",
      )
        .bind(ctx.identity!.id)
        .all();
  return json({
    entries: rows.results ?? [],
    disclaimer: PERSONAL_INTELLIGENCE_DISCLAIMER,
    visibility: "owner-only; the Managing Partner role does not grant access to another user's layer",
  });
}

export { errorResponse as personalIntelligenceErrorResponse };
