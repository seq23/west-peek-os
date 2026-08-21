import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { findVenues } from "./liveSearch";
import {
  buildPacketPrompt,
  computeEconomics,
  monthKey,
  parsePacket,
  verifyPacket,
  type PacketFlag,
  type RoomPacket,
} from "../../shared/events/roomPacket";
import { guidanceBlock } from "../../shared/skills/library";
import { writtenGuidance } from "./firmSkills";

/**
 * Room proposals — Parker's monthly job (P51, docs/COMMUNITY.md).
 *
 * SHAPE: search → propose → verify → store → a human decides → it becomes a Room.
 *
 * WHY A PROPOSAL AND NOT A ROOM. Parker suggests at least one Room a month; West Peek runs far
 * fewer. That is the intended ratio, not a failure of the job — the value is a standing shelf of
 * ready proposals to choose from, and a monthly proposal that auto-created a monthly event would
 * commit the firm to twelve Rooms a year nobody agreed to.
 *
 * WHY THE SEARCH RUNS FIRST. The model is only allowed to cite venues the search actually returned,
 * and verifyPacket() drops anything else. Generating first and checking after would mean discarding
 * most of the packet; giving it the real list up front means the good answer is also the easy one.
 */

export class RoomPacketError extends Error {
  constructor(public status: number, public code: string, detail?: string) {
    super(detail ?? code);
  }
}

export interface PacketRow {
  id: string;
  title: string;
  theme: string;
  central_question: string | null;
  status: string;
  proposed_for_month: string;
  format: string;
  live_url: string | null;
  target_min: number;
  target_max: number;
  audience: string | null;
  agenda_md: string | null;
  seed_questions_json: string;
  guest_ideas_json: string;
  economics_json: string;
  sponsor_thesis: string | null;
  ai_run_id: string | null;
  event_id: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  firm_scope: string;
}

async function requirePacket(env: Env, id: string): Promise<PacketRow> {
  const row = await env.WP_OS_DB.prepare("SELECT * FROM evt_room_packet WHERE id = ?1").bind(id).first<PacketRow>();
  if (!row) throw new RoomPacketError(404, "not_found", "no such Room packet");
  return row;
}

/** Injectable so the whole pipeline is testable without a model or a network. */
export type VenueSearch = typeof findVenues;
export type Synthesise = (prompt: string) => Promise<{ text: string; aiRunId: string | null }>;

async function defaultSynthesise(env: Env, actor: Actor, prompt: string): Promise<{ text: string; aiRunId: string | null }> {
  const { run } = await runAi(env, {
    purpose: "Room packet proposal",
    actor,
    inputs: [prompt],
    // The prompt carries only a city, a theme and public venue listings.
    sensitivity: "PUBLIC" as never,
    budgetContext: { expectedOutputTokens: 2500, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) {
    throw new RoomPacketError(502, "synthesis_failed", run.failure_reason ?? `run ${run.status}`);
  }
  return { text: run.output_text, aiRunId: run.id };
}

export interface GenerateResult {
  packet: PacketRow;
  flags: PacketFlag[];
  venuesKept: number;
  searchDetail: string;
}

/**
 * Generate one Room proposal for a month.
 *
 * Idempotent by (firm_scope, month, title) via a unique index, so the daily job can call this and a
 * retry after a partial failure cannot produce two proposals for March.
 */
export async function generatePacket(
  env: Env,
  actor: Actor,
  input: { month: string; city?: string; brief?: string },
  deps: { search?: VenueSearch; synthesise?: Synthesise } = {},
): Promise<GenerateResult> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "room_packet.manage", { objectType: "room_packet", firmScope });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);

  const city = input.city ?? "New York";
  const brief = input.brief ?? "a seated working dinner for 25-35 operators and first-time founders";

  // Themes already used, so Parker proposes something new rather than the same Room each month.
  const recent = await env.WP_OS_DB.prepare(
    "SELECT theme FROM evt_room_packet WHERE firm_scope = ?1 ORDER BY created_at DESC LIMIT 8",
  ).bind(firmScope).all<{ theme: string }>();

  const search = deps.search ?? findVenues;
  const found = await search(env, actor, city, brief);

  const prompt = buildPacketPrompt({
    month: input.month,
    recentThemes: (recent.results ?? []).map((r) => r.theme),
    venueCandidates: found.hits.map((h) => ({ name: h.name, url: h.url ?? "", description: h.description })),
    city,
    // Both sources: the reviewed library and whatever the partners have adopted for this machine.
    guidance: [
      guidanceBlock(["west_peek_live_events"]),
      await writtenGuidance(env, ["west_peek_live_events"], actor.firmScopes[0] ?? "west-peek"),
    ]
      .filter((block) => block.length > 0)
      .join("\n"),
  });

  const synth = deps.synthesise ?? ((p: string) => defaultSynthesise(env, actor, p));
  const { text, aiRunId } = await synth(prompt);

  const parsed = parsePacket(text);
  if (!parsed) throw new RoomPacketError(502, "unparseable", "the proposal did not come back as a usable packet");

  // The allow-list is every URL the search stood behind — both the structured hits and any URL the
  // search model cited in prose.
  const allowed = [...found.hits.map((h) => h.url ?? ""), ...found.citations].filter(Boolean);
  const { packet, flags } = verifyPacket(parsed, allowed);

  const economics = computeEconomics({
    venues: packet.venues,
    targetAttendees: Math.round((packet.targetMin + packet.targetMax) / 2),
  });

  const id = `rpk_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_room_packet
       (id, title, theme, central_question, status, proposed_for_month, format, target_min,
        target_max, audience, agenda_md, seed_questions_json, guest_ideas_json, economics_json,
        sponsor_thesis, ai_run_id, firm_scope, created_by)
     VALUES (?1,?2,?3,?4,'PROPOSED',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17)`,
  )
    .bind(
      id, packet.title, packet.theme, packet.centralQuestion, input.month, packet.format,
      packet.targetMin, packet.targetMax, packet.audience, packet.agendaMd,
      JSON.stringify(packet.seedQuestions), JSON.stringify(packet.guestIdeas),
      JSON.stringify(economics), packet.sponsorThesis, aiRunId, firmScope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    )
    .run();

  for (const venue of packet.venues) {
    await env.WP_OS_DB.prepare(
      `INSERT INTO evt_packet_venue
         (id, packet_id, name, city, address, capacity, price_low_usd, price_high_usd, price_note,
          booking_phone, booking_email, booking_url, source_url)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
    )
      .bind(
        `rpv_${crypto.randomUUID()}`, id, venue.name, venue.city, venue.address, venue.capacity,
        venue.priceLowUsd, venue.priceHighUsd, venue.priceNote, venue.bookingPhone,
        venue.bookingEmail, venue.bookingUrl, venue.sourceUrl,
      )
      .run();
  }

  await appendEvent(env, {
    eventType: "room_packet.proposed",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    objectType: "room_packet", objectId: id, firmScope,
    payload: { month: input.month, venues: packet.venues.length, flags: flags.map((f) => f.code) },
  });

  return { packet: await requirePacket(env, id), flags, venuesKept: packet.venues.length, searchDetail: found.detail };
}

/**
 * Approve or decline a proposal. HUMAN ONLY.
 *
 * A Room commits the firm to spend, to a guest list, and to approaching sponsors in West Peek's
 * name. An AI employee approving its own proposal would make the proposal the decision.
 */
export async function decidePacket(
  env: Env,
  actor: Actor,
  id: string,
  decision: "APPROVED" | "DECLINED",
  note?: string,
): Promise<PacketRow> {
  const packet = await requirePacket(env, id);
  if (actor.type !== "HUMAN") {
    throw new RoomPacketError(403, "human_required", "A Room is approved by a person, not by the employee who proposed it.");
  }
  const authz = await authorize(env, actor, "room_packet.decide", {
    objectType: "room_packet", objectId: id, firmScope: packet.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);
  if (packet.status !== "PROPOSED" && packet.status !== "DRAFT") {
    throw new RoomPacketError(409, "illegal_state", `packet is ${packet.status}`);
  }

  await env.WP_OS_DB.prepare(
    `UPDATE evt_room_packet SET status = ?2, decided_by = ?3, decision_note = ?4,
            decided_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?1`,
  ).bind(id, decision, actor.firmUserId ?? "system", note ?? null).run();

  await appendEvent(env, {
    eventType: decision === "APPROVED" ? "room_packet.approved" : "room_packet.declined",
    actorType: "firm_user", actorId: actor.firmUserId ?? "system",
    objectType: "room_packet", objectId: id, firmScope: packet.firm_scope,
    payload: { note: note ?? null },
  });
  return await requirePacket(env, id);
}

/** Turn an approved packet into a real Room on the calendar. */
export async function scheduleRoom(
  env: Env,
  actor: Actor,
  id: string,
  input: { startsAt: string; endsAt?: string | null; location?: string | null; liveUrl?: string | null },
): Promise<{ packet: PacketRow; eventId: string }> {
  const packet = await requirePacket(env, id);
  if (packet.status !== "APPROVED") throw new RoomPacketError(409, "illegal_state", "only an approved packet becomes a Room");
  const authz = await authorize(env, actor, "event.manage", {
    objectType: "event", firmScope: packet.firm_scope,
  });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);

  const eventId = `evt_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_event (id, title, event_type, event_class, cadence, theme, status, starts_at,
                            ends_at, location, live_url, summary, packet_id, target_min, target_max,
                            firm_scope, created_by)
     VALUES (?1,?2,?3,'ROOM','MONTHLY',?4,'PLANNED',?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)`,
  )
    .bind(
      eventId, packet.title,
      // The packet's format is the Room's flavour; DINNER and WORKSHOP already exist in the
      // event_type vocabulary, and anything else lands on OTHER rather than failing the CHECK.
      ["DINNER", "WORKSHOP"].includes(packet.format) ? packet.format : "OTHER",
      packet.theme, input.startsAt, input.endsAt ?? null, input.location ?? null,
      input.liveUrl ?? packet.live_url, packet.central_question, packet.id,
      packet.target_min, packet.target_max, packet.firm_scope,
      actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    )
    .run();

  await env.WP_OS_DB.prepare(
    "UPDATE evt_room_packet SET status = 'SCHEDULED', event_id = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(id, eventId).run();

  await appendEvent(env, {
    eventType: "room_packet.scheduled",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "system",
    objectType: "event", objectId: eventId, firmScope: packet.firm_scope,
    payload: { packet_id: id },
  });

  return { packet: await requirePacket(env, id), eventId };
}

/** A person confirms or corrects a venue's details after actually calling. */
export async function verifyVenue(
  env: Env,
  actor: Actor,
  venueId: string,
  verification: "CONFIRMED" | "WRONG" | "UNREACHABLE",
  note?: string,
): Promise<void> {
  if (actor.type !== "HUMAN") {
    throw new RoomPacketError(403, "human_required", "Only a person who called can mark a venue verified.");
  }
  const result = await env.WP_OS_DB.prepare(
    `UPDATE evt_packet_venue SET verification = ?2, note = ?3, verified_by = ?4,
            verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE id = ?1`,
  ).bind(venueId, verification, note ?? null, actor.firmUserId ?? "system").run();
  if (!result.meta.changes) throw new RoomPacketError(404, "not_found", "no such venue");
}

/**
 * The monthly job (job_key `monthly_room_proposal`).
 *
 * Runs daily and generates only if this month has no proposal yet, matching weekly_mp_review. A
 * monthly schedule_kind does not exist and adding one to the CHECK would mean rebuilding
 * scheduled_job; checking the month here is a line of SQL instead.
 */
export async function runMonthlyRoomProposal(
  env: Env,
  actor: Actor,
  now: string,
  deps: { search?: VenueSearch; synthesise?: Synthesise } = {},
): Promise<{ generated: boolean; detail: string; packetId?: string }> {
  const month = monthKey(now);
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const existing = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2",
  ).bind(firmScope, month).first<{ n: number }>();

  if ((existing?.n ?? 0) > 0) {
    return { generated: false, detail: `${month} already has a proposal` };
  }

  const result = await generatePacket(env, actor, { month }, deps);
  return { generated: true, detail: `proposed ${result.packet.title}`, packetId: result.packet.id };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof RoomPacketError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const generateSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  city: z.string().max(80).optional(),
  brief: z.string().max(400).optional(),
});

export async function handleGeneratePacket(ctx: RouteContext): Promise<Response> {
  const parsed = generateSchema.safeParse((await ctx.request.json().catch(() => ({}))) ?? {});
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  try {
    const month = parsed.data.month ?? monthKey(new Date().toISOString());
    const out = await generatePacket(ctx.env, actorFromIdentity(ctx.identity!), { ...parsed.data, month });
    return json(out, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleListPackets(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, title, theme, central_question, status, proposed_for_month, format, target_min,
            target_max, sponsor_thesis, economics_json, event_id, decided_by, decided_at, created_at
     FROM evt_room_packet ORDER BY proposed_for_month DESC, created_at DESC LIMIT 60`,
  ).all();
  return json({ packets: rows.results ?? [] });
}

export async function handleGetPacket(ctx: RouteContext): Promise<Response> {
  if (!ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    const packet = await requirePacket(ctx.env, ctx.params.id);
    const venues = await ctx.env.WP_OS_DB.prepare(
      "SELECT * FROM evt_packet_venue WHERE packet_id = ?1 ORDER BY price_low_usd",
    ).bind(packet.id).all();
    const sponsors = await ctx.env.WP_OS_DB.prepare(
      "SELECT id, org_name, tier, category, stage, ask_low_usd, ask_high_usd, committed_usd FROM evt_sponsor_prospect WHERE packet_id = ?1",
    ).bind(packet.id).all();
    return json({ packet, venues: venues.results ?? [], sponsors: sponsors.results ?? [] });
  } catch (err) {
    return fail(err);
  }
}

const decideSchema = z.object({
  decision: z.enum(["APPROVED", "DECLINED"]),
  note: z.string().max(1000).optional(),
});

export async function handleDecidePacket(ctx: RouteContext): Promise<Response> {
  const parsed = decideSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(await decidePacket(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data.decision, parsed.data.note));
  } catch (err) {
    return fail(err);
  }
}

const scheduleSchema = z.object({
  starts_at: z.string().min(10),
  ends_at: z.string().nullish(),
  location: z.string().max(300).nullish(),
  live_url: z.string().max(500).nullish(),
});

export async function handleScheduleRoom(ctx: RouteContext): Promise<Response> {
  const parsed = scheduleSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    return json(
      await scheduleRoom(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, {
        startsAt: parsed.data.starts_at,
        endsAt: parsed.data.ends_at,
        location: parsed.data.location,
        liveUrl: parsed.data.live_url,
      }),
      { status: 201 },
    );
  } catch (err) {
    return fail(err);
  }
}

const verifyVenueSchema = z.object({
  verification: z.enum(["CONFIRMED", "WRONG", "UNREACHABLE"]),
  note: z.string().max(500).optional(),
});

export async function handleVerifyVenue(ctx: RouteContext): Promise<Response> {
  const parsed = verifyVenueSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success || !ctx.params.id) return json({ error: "invalid_input" }, { status: 400 });
  try {
    await verifyVenue(ctx.env, actorFromIdentity(ctx.identity!), ctx.params.id, parsed.data.verification, parsed.data.note);
    return json({ ok: true });
  } catch (err) {
    return fail(err);
  }
}
