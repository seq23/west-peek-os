import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { actorFromIdentity, authorize, type Actor } from "./authorize";

/**
 * Event OS — scaffolding (P33, V1 #20).
 *
 * SCOPE, stated up front so the next person does not mistake thin for unfinished-by-accident:
 * this is deliberately the bare bones the operator asked for on 17 Aug 2026. Create an event, list
 * events, add attendees, mark them attended. No run-of-show, no sponsorship, no ticketing, no AI
 * Event Planner. Those are canon (§15) and are NOT here.
 *
 * WEST PEEK LIVE RUNS THE ROOM, NOT THIS. The virtual conference app already exists at
 * westpeek.live (the agency-event-os repo). West Peek OS owns the event as a firm record and holds
 * a link; it does not hold sessions, streams or participants-in-the-room. Reimplementing any of
 * that here would put the same fact in two databases, which canon §0E.4 forbids outright.
 *
 * Nothing in this module sends anything. Invitations are an outbound effect and would go through
 * external_effect_request and an approval card — which is why `rsvp` starts at INVITED as a record
 * of intent rather than as evidence a message went out.
 */

export class EventOsError extends Error {
  constructor(
    public status: number,
    public code: string,
    detail?: string,
  ) {
    super(detail ?? code);
  }
}

export interface EventRow {
  id: string;
  title: string;
  event_type: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  location: string | null;
  live_url: string | null;
  summary: string | null;
  firm_scope: string;
  created_at: string;
}

const createSchema = z.object({
  title: z.string().min(2).max(200),
  event_type: z.enum(["DINNER", "SUMMIT", "WORKSHOP", "OFFICE_HOURS", "MASTERMIND", "WEBINAR", "OTHER"]).default("OTHER"),
  starts_at: z.string().max(40).nullish(),
  ends_at: z.string().max(40).nullish(),
  location: z.string().max(200).nullish(),
  live_url: z.string().url().max(500).nullish(),
  summary: z.string().max(2000).nullish(),
});

const attendeeSchema = z.object({
  display_name: z.string().min(1).max(160),
  person_id: z.string().max(80).nullish(),
  attendee_role: z.enum(["HOST", "SPEAKER", "GUEST", "FOUNDER", "LP", "PORTFOLIO"]).default("GUEST"),
  rsvp: z.enum(["INVITED", "ACCEPTED", "DECLINED", "ATTENDED", "NO_SHOW"]).default("INVITED"),
});

const STATUSES = ["DRAFT", "PLANNED", "LIVE", "COMPLETE", "CANCELLED"] as const;

async function mustAuthorize(env: Env, actor: Actor, actionKey: string, objectId?: string): Promise<void> {
  const authz = await authorize(env, actor, actionKey, {
    objectType: "evt_event",
    objectId,
    firmScope: actor.firmScopes[0],
  });
  if (authz.decision !== "ALLOW") throw new EventOsError(403, "forbidden", authz.reason);
}

export async function createEvent(env: Env, actor: Actor, input: z.infer<typeof createSchema>): Promise<EventRow> {
  await mustAuthorize(env, actor, "event.manage");
  const id = `evt_${crypto.randomUUID()}`;
  const scope = actor.firmScopes[0] ?? "west-peek";
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_event (id, title, event_type, starts_at, ends_at, location, live_url, summary, firm_scope, created_by)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
  )
    .bind(
      id, input.title, input.event_type, input.starts_at ?? null, input.ends_at ?? null,
      input.location ?? null, input.live_url ?? null, input.summary ?? null, scope,
      actor.firmUserId ?? "system",
    )
    .run();
  await appendEvent(env, {
    eventType: "event.created",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "evt_event",
    objectId: id,
    firmScope: scope,
    payload: { title: input.title, event_type: input.event_type },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM evt_event WHERE id = ?1").bind(id).first<EventRow>())!;
}

export async function setEventStatus(env: Env, actor: Actor, eventId: string, status: string): Promise<EventRow> {
  if (!(STATUSES as readonly string[]).includes(status)) throw new EventOsError(400, "invalid_status", status);
  const existing = await env.WP_OS_DB.prepare("SELECT * FROM evt_event WHERE id = ?1").bind(eventId).first<EventRow>();
  if (!existing) throw new EventOsError(404, "not_found");
  await mustAuthorize(env, actor, "event.manage", eventId);
  await env.WP_OS_DB.prepare(
    "UPDATE evt_event SET status = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  )
    .bind(eventId, status)
    .run();
  await appendEvent(env, {
    eventType: "event.status_changed",
    actorType: actor.type === "HUMAN" ? "firm_user" : "system",
    actorId: actor.firmUserId ?? "system",
    objectType: "evt_event",
    objectId: eventId,
    firmScope: existing.firm_scope,
    payload: { from: existing.status, to: status },
  });
  return (await env.WP_OS_DB.prepare("SELECT * FROM evt_event WHERE id = ?1").bind(eventId).first<EventRow>())!;
}

// ── Route handlers ───────────────────────────────────────────────────────────

function errorResponse(err: unknown): Response {
  if (err instanceof EventOsError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

export async function handleListEvents(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM evt_event ORDER BY COALESCE(starts_at, created_at) DESC, id DESC LIMIT 200",
  ).all<EventRow>();
  return json({ events: rows.results ?? [] });
}

export async function handleCreateEvent(ctx: RouteContext): Promise<Response> {
  const parsed = createSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    return json(await createEvent(ctx.env, actorFromIdentity(ctx.identity!), parsed.data), { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleGetEvent(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  if (!id) return json({ error: "invalid_input" }, { status: 400 });
  const event = await ctx.env.WP_OS_DB.prepare("SELECT * FROM evt_event WHERE id = ?1").bind(id).first<EventRow>();
  if (!event) return json({ error: "not_found" }, { status: 404 });
  const attendees = await ctx.env.WP_OS_DB.prepare(
    "SELECT * FROM evt_attendee WHERE event_id = ?1 ORDER BY display_name",
  )
    .bind(id)
    .all();
  return json({ event, attendees: attendees.results ?? [] });
}

export async function handleSetEventStatus(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  const body = (await ctx.request.json().catch(() => null)) as { status?: string } | null;
  if (!id || !body?.status) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await setEventStatus(ctx.env, actorFromIdentity(ctx.identity!), id, body.status));
  } catch (err) {
    return errorResponse(err);
  }
}

export async function handleAddAttendee(ctx: RouteContext): Promise<Response> {
  const eventId = ctx.params.id;
  const parsed = attendeeSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!eventId || !parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const event = await ctx.env.WP_OS_DB.prepare("SELECT firm_scope FROM evt_event WHERE id = ?1")
    .bind(eventId)
    .first<{ firm_scope: string }>();
  if (!event) return json({ error: "not_found" }, { status: 404 });
  try {
    const actor = actorFromIdentity(ctx.identity!);
    await mustAuthorize(ctx.env, actor, "event.manage", eventId);
    const id = `eva_${crypto.randomUUID()}`;
    await ctx.env.WP_OS_DB.prepare(
      `INSERT INTO evt_attendee (id, event_id, person_id, display_name, attendee_role, rsvp, firm_scope)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (event_id, display_name) DO UPDATE SET attendee_role = excluded.attendee_role, rsvp = excluded.rsvp`,
    )
      .bind(id, eventId, parsed.data.person_id ?? null, parsed.data.display_name, parsed.data.attendee_role, parsed.data.rsvp, event.firm_scope)
      .run();
    const attendees = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM evt_attendee WHERE event_id = ?1 ORDER BY display_name",
    )
      .bind(eventId)
      .all();
    return json({ attendees: attendees.results ?? [] }, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
}
