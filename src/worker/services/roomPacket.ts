import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json } from "../router";
import type { RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { findVenues } from "./liveSearch";
import {
  SPONSORSHIP_RULE,
  buildPacketPrompt,
  computeEconomics,
  followingMonth,
  mergeBriefSponsors,
  monthKey,
  parsePacket,
  verifyPacket,
  type PacketFlag,
  type PacketOrigin,
  type RoomBrief,
  type RoomPacket,
} from "../../shared/events/roomPacket";
import { guidanceBlock } from "../../shared/skills/library";
import { writtenGuidance } from "./firmSkills";
import { emailPartnerDeliverable } from "./requestReply";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { notifyPartners } from "./notifications";

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
  origin: PacketOrigin;
  brief_json: string | null;
  requested_by: string | null;
  sponsor_count: number;
  sponsor_total_usd: number;
  risks_json: string;
  commitment_md: string | null;
  build_error: string | null;
  build_attempts: number;
  parent_packet_id: string | null;
  emailed_at: string | null;
}

/** The brief as stored. A malformed one is null, never a crash on the page. */
export function parseBrief(raw: string | null): RoomBrief | null {
  if (!raw) return null;
  try {
    const b = JSON.parse(raw) as Partial<RoomBrief>;
    if (!b || typeof b.audience !== "string" || typeof b.month !== "string") return null;
    return {
      audience: b.audience,
      month: b.month,
      city: typeof b.city === "string" ? b.city : null,
      sponsorProspects: Array.isArray(b.sponsorProspects) ? b.sponsorProspects.filter((x): x is string => typeof x === "string") : [],
      notes: typeof b.notes === "string" ? b.notes : null,
    };
  } catch {
    return null;
  }
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

/** How many times a draft is built before it is left for a person, with the last error on it. */
export const MAX_BUILD_ATTEMPTS = 3;

/**
 * Put a Room on the queue as a DRAFT — the brief is on the record before any model is called.
 *
 * ONE QUEUE, TWO DOORS. A partner's brief and Parker's own monthly idea both land here; `origin`
 * says which. A failed build leaves this row with `build_error` on it, visible on the page as
 * "Parker could not build it: …", and the job tries again (up to MAX_BUILD_ATTEMPTS) rather than
 * the request vanishing into a 502.
 */
export async function queueDraft(
  env: Env,
  actor: Actor,
  input: { month: string; origin: PacketOrigin; brief?: RoomBrief | null; parentPacketId?: string | null },
): Promise<PacketRow> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";
  const authz = await authorize(env, actor, "room_packet.manage", { objectType: "room_packet", firmScope });
  if (authz.decision !== "ALLOW") throw new RoomPacketError(403, "forbidden", authz.reason);

  const id = `rpk_${crypto.randomUUID()}`;
  const theme = input.brief?.audience ?? "Parker's proposal for the month";
  // The title is unique per month; a draft's title says what was asked so two requests in one month
  // for different audiences do not collide, and a second identical request joins the first below.
  const title = input.brief ? `Room requested: ${input.brief.audience.slice(0, 70)}` : `Parker's Room for ${input.month}`;
  const existing = await env.WP_OS_DB.prepare(
    "SELECT * FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND title = ?3",
  ).bind(firmScope, input.month, title).first<PacketRow>();
  if (existing) return existing;

  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_room_packet
       (id, title, theme, status, proposed_for_month, origin, brief_json, requested_by, parent_packet_id,
        firm_scope, created_by)
     VALUES (?1,?2,?3,'DRAFT',?4,?5,?6,?7,?8,?9,?10)`,
  )
    .bind(
      id, title, theme, input.month, input.origin,
      input.brief ? JSON.stringify(input.brief) : null,
      input.origin === "PARTNER_BRIEF" ? (actor.firmUserId ?? null) : null,
      input.parentPacketId ?? null,
      firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    )
    .run();

  await appendEvent(env, {
    eventType: "room_packet.requested",
    actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
    actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
    objectType: "room_packet", objectId: id, firmScope,
    payload: { month: input.month, origin: input.origin, sponsors_named: input.brief?.sponsorProspects.length ?? 0, parent: input.parentPacketId ?? null },
  });
  return await requirePacket(env, id);
}

/**
 * Build a DRAFT into a PROPOSED packet, in place.
 *
 * Search → propose → verify → store, as before, but the row already exists: the build UPDATES it,
 * writes its venues and sponsor prospects in ONE batch (each statement is its own round trip on
 * the Free plan; a batch is one), and on any failure records the reason on the row.
 */
export async function buildDraft(
  env: Env,
  actor: Actor,
  draft: PacketRow,
  deps: { search?: VenueSearch; synthesise?: Synthesise } = {},
): Promise<GenerateResult> {
  const firmScope = draft.firm_scope;
  const brief = parseBrief(draft.brief_json);
  const city = brief?.city ?? "New York";
  const searchBrief = brief
    ? `a seated working dinner or salon for 25-35 people: ${brief.audience.slice(0, 200)}`
    : "a seated working dinner for 25-35 operators and first-time founders";

  await env.WP_OS_DB.prepare(
    "UPDATE evt_room_packet SET build_attempts = build_attempts + 1, build_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(draft.id).run();

  const failBuild = async (code: string, detail: string): Promise<never> => {
    await env.WP_OS_DB.prepare(
      "UPDATE evt_room_packet SET build_error = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
    ).bind(draft.id, detail.slice(0, 500)).run();
    throw new RoomPacketError(502, code, detail);
  };

  try {
    // Themes already used, so Parker proposes something new rather than the same Room each month.
    const recent = await env.WP_OS_DB.prepare(
      "SELECT theme FROM evt_room_packet WHERE firm_scope = ?1 AND id != ?2 AND status != 'DRAFT' ORDER BY created_at DESC LIMIT 8",
    ).bind(firmScope, draft.id).all<{ theme: string }>();

    const search = deps.search ?? findVenues;
    const found = await search(env, actor, city, searchBrief);

    const prompt = buildPacketPrompt({
      month: draft.proposed_for_month,
      recentThemes: (recent.results ?? []).map((r) => r.theme),
      venueCandidates: found.hits.map((h) => ({ name: h.name, url: h.url ?? "", description: h.description })),
      city,
      brief,
      // Both sources: the reviewed library and whatever the partners have adopted for this machine.
      guidance: [
        guidanceBlock(["west_peek_live_events", "brand_sponsorship_revenue"]),
        await writtenGuidance(env, ["west_peek_live_events", "brand_sponsorship_revenue"], firmScope),
      ]
        .filter((block) => block.length > 0)
        .join("\n"),
    });

    const synth = deps.synthesise ?? ((p: string) => defaultSynthesise(env, actor, p));
    const { text, aiRunId } = await synth(prompt);

    const parsed = parsePacket(text);
    if (!parsed) return await failBuild("unparseable", "the proposal did not come back as a usable packet");

    // The allow-list is every URL the search stood behind — both the structured hits and any URL the
    // search model cited in prose.
    const allowed = [...found.hits.map((h) => h.url ?? ""), ...found.citations].filter(Boolean);
    const verified = verifyPacket(parsed, allowed);
    const packet = mergeBriefSponsors(verified.packet, brief);
    const flags = verified.flags;

    const economics = computeEconomics({
      venues: packet.venues,
      targetAttendees: Math.round((packet.targetMin + packet.targetMax) / 2),
      sponsorCount: packet.sponsorCount,
    });

    // A title Parker reuses within the month would trip the unique index; suffix rather than fail.
    const clash = await env.WP_OS_DB.prepare(
      "SELECT id FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2 AND title = ?3 AND id != ?4",
    ).bind(firmScope, draft.proposed_for_month, packet.title, draft.id).first<{ id: string }>();
    const title = clash ? `${packet.title} (${draft.proposed_for_month})` : packet.title;

    const statements = [
      env.WP_OS_DB.prepare(
        `UPDATE evt_room_packet
            SET title = ?2, theme = ?3, central_question = ?4, status = 'PROPOSED', format = ?5,
                target_min = ?6, target_max = ?7, audience = ?8, agenda_md = ?9, seed_questions_json = ?10,
                guest_ideas_json = ?11, economics_json = ?12, sponsor_thesis = ?13, ai_run_id = ?14,
                sponsor_count = ?15, sponsor_total_usd = ?16, risks_json = ?17, commitment_md = ?18,
                build_error = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE id = ?1`,
      ).bind(
        draft.id, title, packet.theme, packet.centralQuestion, packet.format,
        packet.targetMin, packet.targetMax, packet.audience, packet.agendaMd,
        JSON.stringify(packet.seedQuestions), JSON.stringify(packet.guestIdeas),
        JSON.stringify(economics), packet.sponsorThesis, aiRunId,
        packet.sponsorCount, economics.sponsorTargetHighUsd, JSON.stringify(packet.risks), packet.commitmentMd,
      ),
      // A rebuild replaces what an earlier attempt wrote; a packet is one packet.
      env.WP_OS_DB.prepare("DELETE FROM evt_packet_venue WHERE packet_id = ?1").bind(draft.id),
      env.WP_OS_DB.prepare("DELETE FROM evt_sponsor_prospect WHERE packet_id = ?1 AND stage = 'IDENTIFIED'").bind(draft.id),
      ...packet.venues.map((venue) =>
        env.WP_OS_DB.prepare(
          `INSERT INTO evt_packet_venue
             (id, packet_id, name, city, address, capacity, price_low_usd, price_high_usd, price_note,
              booking_phone, booking_email, booking_url, source_url)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)`,
        ).bind(
          `rpv_${crypto.randomUUID()}`, draft.id, venue.name, venue.city, venue.address, venue.capacity,
          venue.priceLowUsd, venue.priceHighUsd, venue.priceNote, venue.bookingPhone,
          venue.bookingEmail, venue.bookingUrl, venue.sourceUrl,
        ),
      ),
      // Every named prospect becomes a pipeline row on this packet, Parker's to work. Hers first.
      ...packet.sponsorProspects.slice(0, 8).map((sp, i) =>
        env.WP_OS_DB.prepare(
          `INSERT INTO evt_sponsor_prospect
             (id, org_name, tier, category, ask_low_usd, ask_high_usd, pitch, ask_detail, stage,
              packet_id, source_url, note, owner_employee, firm_scope, created_by)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,'IDENTIFIED',?9,?10,?11,'Parker',?12,?13)`,
        ).bind(
          `spp_${crypto.randomUUID()}`, sp.orgName, i === 0 ? "PRESENTING" : "SUPPORTING", sp.category,
          sp.askUsd, sp.askUsd, sp.pitch, sp.whyFit, draft.id, sp.sourceUrl,
          sp.fromBrief ? "Named by the partner in her brief." : "Proposed by Parker.",
          firmScope, actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
        ),
      ),
    ];
    await env.WP_OS_DB.batch(statements);

    await appendEvent(env, {
      eventType: "room_packet.proposed",
      actorType: actor.type === "HUMAN" ? "firm_user" : "ai_employee",
      actorId: actor.firmUserId ?? actor.aiEmployeeId ?? "Parker",
      objectType: "room_packet", objectId: draft.id, firmScope,
      payload: {
        month: draft.proposed_for_month, origin: draft.origin, venues: packet.venues.length,
        sponsors: packet.sponsorProspects.length, sponsor_count: packet.sponsorCount, flags: flags.map((f) => f.code),
      },
    });

    const built = await requirePacket(env, draft.id);
    await emailPacket(env, built).catch(() => undefined);
    return { packet: built, flags, venuesKept: packet.venues.length, searchDetail: found.detail };
  } catch (err) {
    if (err instanceof RoomPacketError) throw err;
    return await failBuild("build_failed", err instanceof Error ? err.message : String(err));
  }
}

/**
 * Generate one Room proposal for a month: queue a draft, build it. The one-call form both the
 * request door and the tests use.
 */
export async function generatePacket(
  env: Env,
  actor: Actor,
  input: { month: string; city?: string; brief?: RoomBrief | null; origin?: PacketOrigin; parentPacketId?: string | null },
  deps: { search?: VenueSearch; synthesise?: Synthesise } = {},
): Promise<GenerateResult> {
  const brief = input.brief ?? null;
  const draft = await queueDraft(env, actor, {
    month: input.month,
    origin: input.origin ?? (brief ? "PARTNER_BRIEF" : "PARKER"),
    brief: brief ? { ...brief, city: brief.city ?? input.city ?? null } : null,
    parentPacketId: input.parentPacketId ?? null,
  });
  if (draft.status !== "DRAFT") {
    return { packet: draft, flags: [], venuesKept: 0, searchDetail: "already built" };
  }
  return buildDraft(env, actor, draft, deps);
}

/**
 * The finished packet, to both partners, by email.
 *
 * Operator: "when i request a room they should email me and scooter with the deliverable as well.
 * b/c we requested the room we should get an email with the finished deliverable." Parker's own
 * monthly proposal is emailed the same way, so a packet never lands only on a page nobody opened.
 * Destination-restricted to the two partner addresses in `emailPartnerDeliverable`.
 */
export async function emailPacket(env: Env, packet: PacketRow): Promise<{ sent: string[]; failed: string[] }> {
  if (packet.status !== "PROPOSED") return { sent: [], failed: [] };
  const [venues, sponsors] = await env.WP_OS_DB.batch([
    env.WP_OS_DB.prepare("SELECT name, city, capacity, price_low_usd, price_high_usd, price_note, booking_phone, booking_email, source_url FROM evt_packet_venue WHERE packet_id = ?1 ORDER BY price_low_usd").bind(packet.id),
    env.WP_OS_DB.prepare("SELECT org_name, category, ask_low_usd, pitch, ask_detail, source_url, note FROM evt_sponsor_prospect WHERE packet_id = ?1").bind(packet.id),
  ]);
  const text = renderPacketText(packet, (venues?.results ?? []) as VenueLine[], (sponsors?.results ?? []) as SponsorLine[]);
  const monthName = monthWord(packet.proposed_for_month);
  const subject = `Parker: your ${monthName} Room — ${packet.title}`.slice(0, 180);
  const sent: string[] = [];
  const failed: string[] = [];
  for (const to of ASSIGNING_PARTNERS) {
    const out = await emailPartnerDeliverable(env, {
      to, subject, text, objectType: "room_packet", objectId: packet.id, firmScope: packet.firm_scope, actorId: "aie_parker",
    });
    (out.sent ? sent : failed).push(to);
  }
  if (sent.length > 0) {
    await env.WP_OS_DB.prepare("UPDATE evt_room_packet SET emailed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(packet.id).run();
  }
  // Inside the OS too, so the packet is findable from Home whether or not the mail was read.
  await notifyPartners(env, {
    kind: "MEETING",
    severity: "INFO",
    title: `Parker proposed a Room for ${monthName}: ${packet.title.slice(0, 70)}`,
    body: `${packet.central_question ?? packet.theme} · ${packet.sponsor_count} sponsor(s), $${Math.round(packet.sponsor_total_usd).toLocaleString("en-US")} proposed. Keep it or dismiss it on Events & Rooms.`,
    objectType: "room_packet",
    objectId: packet.id,
    dedupeKey: `room_packet:${packet.id}:proposed`,
    firmScope: packet.firm_scope,
  }).catch(() => undefined);
  return { sent, failed };
}

interface VenueLine { name: string; city: string | null; capacity: number | null; price_low_usd: number | null; price_high_usd: number | null; price_note: string | null; booking_phone: string | null; booking_email: string | null; source_url: string }
interface SponsorLine { org_name: string; category: string; ask_low_usd: number | null; pitch: string | null; ask_detail: string | null; source_url: string | null; note: string | null }

function monthWord(yyyyMm: string): string {
  const names = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const m = Number(yyyyMm.slice(5, 7));
  return `${names[m - 1] ?? yyyyMm} ${yyyyMm.slice(0, 4)}`;
}

const usdText = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

/** The packet as plain text — the email body, and what a partner can forward. */
export function renderPacketText(packet: PacketRow, venues: VenueLine[], sponsors: SponsorLine[]): string {
  const brief = parseBrief(packet.brief_json);
  const list = (raw: string): unknown[] => { try { const v: unknown = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; } };
  const guests = list(packet.guest_ideas_json) as Array<{ description: string; why: string | null }>;
  const seeds = list(packet.seed_questions_json) as string[];
  const risks = list(packet.risks_json) as string[];
  let eco: { estimatedCostLowUsd: number; estimatedCostHighUsd: number; sponsorTargetLowUsd: number; sponsorTargetHighUsd: number; netLowUsd: number; netHighUsd: number; targetAttendees: number } | null = null;
  try { eco = JSON.parse(packet.economics_json); } catch { eco = null; }
  const lines: string[] = [
    `${packet.title} — proposed for ${monthWord(packet.proposed_for_month)}`,
    packet.origin === "PARTNER_BRIEF" ? "Asked for by a partner." : "Parker's own idea for the month.",
    "",
    brief ? `WHAT WAS ASKED FOR\n${brief.audience}${brief.city ? ` · ${brief.city}` : ""}${brief.sponsorProspects.length ? `\nSponsor prospects named: ${brief.sponsorProspects.join(", ")}` : ""}${brief.notes ? `\nNotes: ${brief.notes}` : ""}\n` : "",
    `THEME\n${packet.theme}`,
    packet.central_question ? `\nCENTRAL QUESTION\n${packet.central_question}` : "",
    "",
    `WHO IS IN THE ROOM (${packet.target_min}–${packet.target_max} people)`,
    packet.audience ?? "Parker did not say.",
    ...guests.map((g) => `- ${g.description}${g.why ? ` — ${g.why}` : ""}`),
    "",
    `FORMAT AND RUN OF SHOW — ${packet.format.replace(/_/g, " ").toLowerCase()}`,
    packet.agenda_md ?? "No run-of-show written.",
    "",
    "QUESTIONS TO SEED IT WITH",
    ...(seeds.length ? seeds.map((q) => `- ${q}`) : ["- none suggested"]),
    "",
    "VENUE SHORTLIST (nothing verified until a person has called)",
    ...(venues.length
      ? venues.map((v) => `- ${v.name}${v.city ? `, ${v.city}` : ""}${v.capacity ? ` (holds ${v.capacity})` : ""}: ${v.price_low_usd === null && v.price_high_usd === null ? "price not published" : `${usdText(v.price_low_usd ?? v.price_high_usd)}–${usdText(v.price_high_usd ?? v.price_low_usd)}`}${v.price_note ? ` — ${v.price_note}` : ""}${v.booking_phone ? ` · ${v.booking_phone}` : ""}${v.booking_email ? ` · ${v.booking_email}` : ""} · ${v.source_url}`)
      : ["- no venue survived sourcing; a person finds the space"]),
    "",
    "BUDGET VS SPONSORSHIP",
    eco
      ? `Estimated cost ${usdText(eco.estimatedCostLowUsd)}–${usdText(eco.estimatedCostHighUsd)} at ${eco.targetAttendees} people. Sponsorship ${usdText(eco.sponsorTargetLowUsd)}–${usdText(eco.sponsorTargetHighUsd)} (${packet.sponsor_count} sponsor(s) at ${usdText(SPONSORSHIP_RULE.perSponsorUsd)} each). Left over ${usdText(eco.netLowUsd)}–${usdText(eco.netHighUsd)}.`
      : "Not costed.",
    packet.sponsor_thesis ? `Why a sponsor underwrites this: ${packet.sponsor_thesis}` : "",
    "",
    `SPONSOR PROSPECTS (${sponsors.length})`,
    ...(sponsors.length
      ? sponsors.map((sp) => `- ${sp.org_name} (${sp.category.replace(/_/g, " ").toLowerCase()}) — ask ${usdText(sp.ask_low_usd)}.${sp.ask_detail ? ` Fit: ${sp.ask_detail}` : " Fit: Parker did not say."}${sp.pitch ? ` Pitch: ${sp.pitch}` : ""}${sp.source_url ? ` ${sp.source_url}` : ""}${sp.note ? ` [${sp.note}]` : ""}`)
      : ["- none named"]),
    "",
    "RISKS",
    ...(risks.length ? risks.map((r) => `- ${r}`) : ["- none stated"]),
    "",
    "WHAT SAYING KEEP COMMITS THE FIRM TO",
    packet.commitment_md ?? "Parker did not say — decide before you keep it.",
    "",
    "Keep it or dismiss it: https://os.joinwestpeek.com/#/rooms",
    "— Parker, via West Peek OS. Nothing is booked and nobody outside the firm has been contacted.",
  ];
  return lines.filter((l) => l !== "").join("\n").replace(/\n{3,}/g, "\n\n");
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
  if (packet.status === "DRAFT" && decision === "APPROVED") {
    throw new RoomPacketError(409, "not_built", "This Room has not been built yet; there is nothing to keep.");
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
 * The Rooms job (job_key `monthly_room_proposal`), every half hour, ONE unit of work per run:
 *
 *   1. a DRAFT waiting to be built (a partner's request whose synchronous build failed, or a
 *      "propose again") — build it; else
 *   2. the FOLLOWING month has no packet — propose one (lead time to sell sponsors: both packets
 *      proposed for the month they ran in were declined); else
 *   3. nothing, and say so.
 *
 * One search and one synthesis at most per run, which is what the Free plan's tick can carry.
 */
export async function runMonthlyRoomProposal(
  env: Env,
  actor: Actor,
  now: string,
  deps: { search?: VenueSearch; synthesise?: Synthesise } = {},
): Promise<{ generated: boolean; detail: string; packetId?: string }> {
  const firmScope = actor.firmScopes[0] ?? "west-peek";

  const draft = await env.WP_OS_DB.prepare(
    `SELECT * FROM evt_room_packet
      WHERE firm_scope = ?1 AND status = 'DRAFT' AND build_attempts < ?2
      ORDER BY created_at ASC LIMIT 1`,
  ).bind(firmScope, MAX_BUILD_ATTEMPTS).first<PacketRow>();
  if (draft) {
    const result = await buildDraft(env, actor, draft, deps);
    return { generated: true, detail: `built the Room that was asked for: ${result.packet.title}`, packetId: result.packet.id };
  }

  const month = followingMonth(now);
  const existing = await env.WP_OS_DB.prepare(
    "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND proposed_for_month = ?2",
  ).bind(firmScope, month).first<{ n: number }>();
  if ((existing?.n ?? 0) > 0) {
    const stuck = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM evt_room_packet WHERE firm_scope = ?1 AND status = 'DRAFT'",
    ).bind(firmScope).first<{ n: number }>();
    return {
      generated: false,
      detail: `${month} already has a proposal${(stuck?.n ?? 0) > 0 ? `; ${stuck!.n} request(s) could not be built after ${MAX_BUILD_ATTEMPTS} attempts and wait for a person` : ""}`,
    };
  }

  const result = await generatePacket(env, actor, { month, origin: "PARKER" }, deps);
  return { generated: true, detail: `proposed ${result.packet.title} for ${month}`, packetId: result.packet.id };
}

// ── Routes ───────────────────────────────────────────────────────────────────

function fail(err: unknown): Response {
  if (err instanceof RoomPacketError) return json({ error: err.code, detail: err.message }, { status: err.status });
  throw err;
}

const briefSchema = z.object({
  audience: z.string().trim().min(3).max(400),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  city: z.string().trim().max(80).optional(),
  sponsor_prospects: z.array(z.string().trim().min(1).max(120)).max(12).optional(),
  notes: z.string().trim().max(1500).optional(),
  /** A declined packet this one is a rework of. */
  again_from: z.string().max(80).optional(),
});

/**
 * POST /api/rooms/packets — the two doors.
 *
 * An empty body is "Parker, think of one" (his own idea for the FOLLOWING month, or the month
 * given). A body with `audience` is her brief, and the packet records that it came from her.
 * Either way the draft is on the record before the model runs, and the build is synchronous —
 * measured at ~25 s in production on 15 Sep 2026 — so she sees the packet when the button
 * returns; if the build fails the row stays as a draft the job retries.
 */
export async function handleGeneratePacket(ctx: RouteContext): Promise<Response> {
  const body = ((await ctx.request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
  const actor = actorFromIdentity(ctx.identity!);
  try {
    if (typeof body.audience === "string" && body.audience.trim().length > 0) {
      const parsed = briefSchema.safeParse(body);
      if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
      const b = parsed.data;
      const brief: RoomBrief = {
        audience: b.audience,
        month: b.month,
        city: b.city && b.city.length > 0 ? b.city : null,
        sponsorProspects: (b.sponsor_prospects ?? []).filter((x) => x.length > 0),
        notes: b.notes && b.notes.length > 0 ? b.notes : null,
      };
      const out = await generatePacket(ctx.env, actor, { month: b.month, brief, origin: "PARTNER_BRIEF", parentPacketId: b.again_from ?? null });
      return json(out, { status: 201 });
    }
    const month = typeof body.month === "string" && /^\d{4}-\d{2}$/.test(body.month) ? body.month : followingMonth(new Date().toISOString());
    const city = typeof body.city === "string" && body.city.trim() ? body.city.trim().slice(0, 80) : undefined;
    const out = await generatePacket(ctx.env, actor, { month, city, origin: "PARKER" });
    return json(out, { status: 201 });
  } catch (err) {
    return fail(err);
  }
}

export async function handleListPackets(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT id, title, theme, central_question, status, proposed_for_month, format, target_min,
            target_max, audience, sponsor_thesis, economics_json, event_id, decided_by, decided_at,
            decision_note, created_at, origin, brief_json, requested_by, sponsor_count,
            sponsor_total_usd, build_error, build_attempts, parent_packet_id, emailed_at
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
      "SELECT id, org_name, tier, category, stage, ask_low_usd, ask_high_usd, committed_usd, pitch, ask_detail, source_url, note, decline_reason FROM evt_sponsor_prospect WHERE packet_id = ?1 ORDER BY created_at",
    ).bind(packet.id).all();
    return json({ packet, brief: parseBrief(packet.brief_json), venues: venues.results ?? [], sponsors: sponsors.results ?? [] });
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
