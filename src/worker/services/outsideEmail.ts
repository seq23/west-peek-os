import { z } from "zod";
import type { Env } from "../env";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import {
  OUTSIDE_EMAIL_JOBS,
  breakGlassPulled,
  decideOutsideEmail,
  outsideEmailJob,
  readMode,
  type OutsideEmailAsk,
  type OutsideEmailDecision,
  type OutsideEmailMode,
  type OutsideEmailState,
} from "../../shared/policy/outsideEmail";

/**
 * OUTSIDE EMAIL: WHAT MAY SEND — the one door (owner ruling, 23 Oct 2026).
 *
 * `outsideEmailAllowed` is the ONLY function that answers "may this employee email somebody outside
 * the firm?". The executor asks it for every employee `email.send` to a non-partner; the Learning
 * Club's brand-send gate asks it for its job. No other code reads the break-glass variable or the
 * list tables — `scripts/validate/outside-email-one-door.mjs` fails one that does, and fails any
 * transport call site that is not registered with its reason.
 *
 * The rest of this file is her screen: read the list, Allow or Stop one item, set the master
 * switch. Owner-only (a Managing Partner, signed in as a person). Every change writes an audit row.
 */

export async function outsideEmailState(env: Env): Promise<OutsideEmailState & { modeChangedBy: string | null; modeChangedAt: string | null }> {
  const modeRow = await env.WP_OS_DB.prepare("SELECT mode, changed_by, changed_at FROM outside_email_mode WHERE id = 1")
    .first<{ mode: string; changed_by: string; changed_at: string }>()
    .catch(() => null);
  const rows = (await env.WP_OS_DB.prepare("SELECT item_type, item_id FROM outside_email_allow WHERE allowed = 1")
    .all<{ item_type: string; item_id: string }>()
    .catch(() => ({ results: [] as Array<{ item_type: string; item_id: string }> }))).results ?? [];
  return {
    breakGlass: breakGlassPulled(env as unknown as Record<string, unknown>),
    mode: readMode(modeRow?.mode),
    allowedJobs: new Set(rows.filter((r) => r.item_type === "JOB").map((r) => r.item_id)),
    allowedCards: new Set(rows.filter((r) => r.item_type === "CARD").map((r) => r.item_id)),
    modeChangedBy: modeRow?.changed_by ?? null,
    modeChangedAt: modeRow?.changed_at ?? null,
  };
}

/** THE ONE FUNCTION. True only if the item is on her list, the master switch is not off, and break-glass is not pulled. */
export async function outsideEmailAllowed(env: Env, ask: OutsideEmailAsk): Promise<OutsideEmailDecision> {
  return decideOutsideEmail(await outsideEmailState(env), ask);
}

// ── Her screen ──────────────────────────────────────────────────────────────────────────────────

function ownerOf(ctx: RouteContext): { name: string } | Response {
  const id = ctx.identity;
  if (!id || !id.roles.includes("MANAGING_PARTNER")) {
    return json({ error: "forbidden", detail: "Only a Managing Partner changes what may email outside the firm." }, { status: 403 });
  }
  return { name: id.fullName || id.email };
}

interface AllowRow {
  item_type: "JOB" | "CARD";
  item_id: string;
  allowed: number;
  changed_by: string;
  changed_at: string;
}

async function screen(env: Env): Promise<Record<string, unknown>> {
  const state = await outsideEmailState(env);
  const rows = (await env.WP_OS_DB.prepare("SELECT item_type, item_id, allowed, changed_by, changed_at FROM outside_email_allow").all<AllowRow>()).results ?? [];
  const jobRow = (id: string) => rows.find((r) => r.item_type === "JOB" && r.item_id === id) ?? null;
  const cardRows = rows.filter((r) => r.item_type === "CARD");
  const cards = [];
  for (const r of cardRows) {
    const c = await env.WP_OS_DB.prepare("SELECT title FROM work_card WHERE id = ?1").bind(r.item_id).first<{ title: string }>();
    cards.push({ id: r.item_id, title: c?.title ?? "(a card that no longer exists)", allowed: r.allowed === 1, changed_by: r.changed_by, changed_at: r.changed_at });
  }
  const audit = (await env.WP_OS_DB.prepare("SELECT item_type, item_id, action, changed_by, changed_at FROM outside_email_audit ORDER BY changed_at DESC, id DESC LIMIT 20")
    .all<{ item_type: string; item_id: string; action: string; changed_by: string; changed_at: string }>()).results ?? [];
  return {
    break_glass: state.breakGlass,
    mode: state.mode,
    mode_changed_by: state.modeChangedBy,
    mode_changed_at: state.modeChangedAt,
    jobs: OUTSIDE_EMAIL_JOBS.map((j) => {
      const r = jobRow(j.id);
      return { ...j, allowed: r?.allowed === 1, changed_by: r?.changed_by ?? null, changed_at: r?.changed_at ?? null, sending_now: decideOutsideEmail(state, { job: j.id }).allowed };
    }),
    cards,
    audit,
  };
}

/** GET /api/outside-email — the whole list, with who changed each item and when. */
export async function handleOutsideEmailScreen(ctx: RouteContext): Promise<Response> {
  const who = ownerOf(ctx);
  if (who instanceof Response) return who;
  return json(await screen(ctx.env));
}

const allowSchema = z.object({
  item_type: z.enum(["JOB", "CARD"]),
  item_id: z.string().trim().min(1).max(200),
  allowed: z.boolean(),
});

/** POST /api/outside-email/allow — Allow or Stop one job or card. Allowing sends nothing by itself. */
export async function handleOutsideEmailAllow(ctx: RouteContext): Promise<Response> {
  const who = ownerOf(ctx);
  if (who instanceof Response) return who;
  const parsed = allowSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "Say which job or card, and Allow or Stop." }, { status: 400 });
  const { item_type, item_id, allowed } = parsed.data;
  if (item_type === "JOB" && !outsideEmailJob(item_id)) {
    return json({ error: "unknown_job", detail: "That is not a job that can email outside the firm." }, { status: 400 });
  }
  if (item_type === "CARD") {
    const card = await ctx.env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE id = ?1").bind(item_id).first<{ id: string }>();
    if (!card) return json({ error: "not_found", detail: "No card by that id." }, { status: 404 });
  }
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5)
     ON CONFLICT(item_type, item_id) DO UPDATE SET allowed = excluded.allowed, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
  ).bind(item_type, item_id, allowed ? 1 : 0, who.name, now).run();
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO outside_email_audit (id, item_type, item_id, action, changed_by, changed_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
  ).bind(`oea_${crypto.randomUUID()}`, item_type, item_id, allowed ? "ALLOW" : "STOP", who.name, now).run();
  await appendEvent(ctx.env, { eventType: "outside_email.changed", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "outside_email_allow", objectId: `${item_type}:${item_id}`, payload: { allowed } });
  return json(await screen(ctx.env));
}

const modeSchema = z.object({ mode: z.enum(["OFF", "ONLY_ALLOWED"]) });

/** POST /api/outside-email/mode — the master switch: Off, or Only what I allow. Never "everything". */
export async function handleOutsideEmailMode(ctx: RouteContext): Promise<Response> {
  const who = ownerOf(ctx);
  if (who instanceof Response) return who;
  const parsed = modeSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "Off, or Only what I allow. There is no third choice." }, { status: 400 });
  const mode: OutsideEmailMode = parsed.data.mode;
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO outside_email_mode (id, mode, changed_by, changed_at) VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(id) DO UPDATE SET mode = excluded.mode, changed_by = excluded.changed_by, changed_at = excluded.changed_at`,
  ).bind(mode, who.name, now).run();
  await ctx.env.WP_OS_DB.prepare(
    "INSERT INTO outside_email_audit (id, item_type, item_id, action, changed_by, changed_at) VALUES (?1, 'MODE', 'mode', ?2, ?3, ?4)",
  ).bind(`oea_${crypto.randomUUID()}`, mode === "OFF" ? "MODE_OFF" : "MODE_ONLY_ALLOWED", who.name, now).run();
  await appendEvent(ctx.env, { eventType: "outside_email.mode", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "outside_email_mode", objectId: "1", payload: { mode } });
  return json(await screen(ctx.env));
}

/** GET /api/outside-email/cards/:id — one card's line, for the card's own page. */
export async function handleOutsideEmailCard(ctx: RouteContext): Promise<Response> {
  const who = ownerOf(ctx);
  if (who instanceof Response) return who;
  const id = ctx.params.id!;
  const r = await ctx.env.WP_OS_DB.prepare("SELECT allowed, changed_by, changed_at FROM outside_email_allow WHERE item_type = 'CARD' AND item_id = ?1")
    .bind(id).first<{ allowed: number; changed_by: string; changed_at: string }>();
  const decision = await outsideEmailAllowed(ctx.env, { cardId: id });
  return json({ card_id: id, allowed: r?.allowed === 1, changed_by: r?.changed_by ?? null, changed_at: r?.changed_at ?? null, sending_now: decision.allowed, reason: decision.reason });
}
