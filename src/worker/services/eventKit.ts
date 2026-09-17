import type { Env } from "../env";
import type { Actor } from "./authorize";
import { appendEvent } from "../events";
import { deliver } from "./deliverables";
import { recordSwallowed } from "./swallowed";
import type { RoomConcept, RunOfShowLine } from "../../shared/events/roomPacket";
import type { WorkshopView } from "../../shared/events/workshopPacket";
import { packetKindOf } from "../../shared/events/workshopPacket";
import {
  EVENT_KIT_PLATFORM,
  buildEventKitPrompt,
  eventKitLink,
  eventKitTldr,
  openItemsFor,
  parseEventKit,
  proposedSlotFor,
  renderEventKitMarkdown,
  verifyEventKit,
  type EventKit,
  type EventKitSource,
} from "../../shared/events/eventKit";

/**
 * THE KIT STAGE — one draft proposed event kit with every monthly proposal (17 Sep 2026).
 *
 * ─── Why this is a stage and not a paragraph in the packet prompt ──────────────────────────────
 *
 * The packet answers "what should we run and what does it cost". The kit answers "what does the
 * broadcast look like, minute by minute, and what do we post" — a different question, a different
 * model call, and a different artifact with its own life: it is FILED and LINKED, and it is
 * rewritten when a date moves. Folding it into the packet prompt would have made one call answer
 * two questions and one JSON blob carry two documents, and the first thing to be dropped when the
 * model ran long would have been the half nothing verified.
 *
 * It sits between PACKET and PDF, which is the only place it can: it reads the packet's own run of
 * show and chosen angle, and the PDF stage sends the email that must carry its link.
 *
 * ─── A LINK, NOT AN ATTACHMENT, AND THE OWNER'S OWN PRODUCT SETTLED IT ─────────────────────────
 *
 * West Peek Live's instruction pages: "The email never carries the text, so correcting a page
 * corrects it for everyone who already has the link." A kit is a DRAFT. The date is proposed, the
 * co-host may be open, the questions will be edited. An attachment freezes all of that at the
 * moment it was sent; a deliverable is rewritten in place, and `deliver()` already upserts on
 * (source_type, source_id) — so a rebuild corrects the page the partners already have a link to
 * rather than sending a second, contradictory copy.
 *
 * ─── Rule 0 ────────────────────────────────────────────────────────────────────────────────────
 *
 * The stage cannot exit having done nothing: a kit that does not parse FAILS the stage (the sweep
 * retries it with the reason on Parker's card) rather than storing an empty one, and a kit with no
 * run-of-show rows does not parse at all.
 */

export class EventKitError extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = "EventKitError";
  }
}

/** The packet columns the kit stage reads. Kept structural so the chain can pass its own row. */
export interface KitPacketRow {
  id: string;
  title: string;
  theme: string;
  central_question: string | null;
  audience: string | null;
  proposed_for_month: string;
  firm_scope: string;
  requested_by: string | null;
  concepts_json: string;
  concept_choice_md: string | null;
  run_of_show_json: string;
  target_min: number;
  target_max: number;
  kind?: string | null;
  workshop_json?: string | null;
  event_kit_json?: string | null;
  event_kit_deliverable_id?: string | null;
}

/** Her Home by default; whoever asked for it, when a partner asked. Both partners see either. */
export const DEFAULT_KIT_RECIPIENT = "fu_sequoia_taylor";

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** The stored kit, or null for a packet whose kit stage has not run. */
export function eventKitOf(packet: Pick<KitPacketRow, "event_kit_json">): EventKit | null {
  return parseJson<EventKit | null>(packet.event_kit_json, null);
}

/**
 * EVERYTHING THE KIT IS BUILT FROM COMES OFF THE PACKET, which is why the kit cannot disagree with
 * it: the angle, the promise, the audience, the hosts and the run of show are read, not re-asked.
 */
export function eventKitSourceFor(packet: KitPacketRow): EventKitSource {
  const workshop = packetKindOf(packet.kind) === "WORKSHOP" ? parseJson<WorkshopView | null>(packet.workshop_json, null) : null;
  const concepts = parseJson<RoomConcept[]>(packet.concepts_json, []);
  const chosen = concepts.find((c) => c.chosen) ?? concepts[0] ?? null;
  const runOfShow = parseJson<RunOfShowLine[]>(packet.run_of_show_json, []);
  const totalMinutes = runOfShow.reduce((n, l) => n + (l.minutes || 0), 0);
  const hostName = workshop?.facilitator.name ?? "Scooter Taylor";
  const coHostName = workshop ? (workshop.coHost?.name ?? null) : null;
  return {
    stream: workshop ? "WORKSHOP" : "ROOM",
    month: packet.proposed_for_month,
    topic: workshop?.topic ?? chosen?.angleOn ?? packet.theme,
    angleTitle: chosen?.title ?? packet.title.replace(/^Workshop: /, ""),
    whyThisAngle: packet.concept_choice_md ?? "",
    promise: workshop?.promise ?? packet.central_question ?? packet.theme,
    whoItsFor: workshop?.whoItsFor ?? packet.audience ?? "the firm's network",
    hostName,
    coHostName,
    /*
     * A GUEST IS WANTED WHENEVER THE HOSTS DO NOT ALREADY FILL THE SEATS. For a Workshop that is
     * when the chosen angle asked for one; for a Room it is always, because a Room is one real
     * question put to people who are not the partners. Wanted-and-unnamed is what makes it OPEN
     * rather than absent — see `openItemsFor`.
     */
    guestWanted: workshop ? workshop.facilitator.kind === "GUEST" || workshop.coHost?.kind === "GUEST" || false : true,
    guestName: workshop?.facilitator.kind === "GUEST" ? workshop.facilitator.name : workshop?.coHost?.kind === "GUEST" ? workshop.coHost.name : null,
    runOfShow: runOfShow.map((l) => ({ time: l.time, minutes: l.minutes, what: l.what, who: l.who })),
    totalMinutes: totalMinutes > 0 ? totalMinutes : Math.max(45, packet.target_min),
  };
}

export type KitSynthesise = (prompt: string) => Promise<{ text: string; aiRunId: string | null }>;

/**
 * Build the kit, verify it, store it, file it on a partner's Home — and return the link the email
 * has to carry.
 *
 * A KIT THAT DOES NOT PARSE IS A FAILED STAGE, never a stored empty one. The sweep puts the reason
 * on Parker's card and retries the stage, which is the same contract every other stage in this
 * chain keeps.
 */
export async function buildAndFileEventKit(
  env: Env,
  actor: Actor,
  packet: KitPacketRow,
  synth: KitSynthesise,
): Promise<{ kit: EventKit; deliverableId: string | null; link: string | null }> {
  const src = eventKitSourceFor(packet);
  const slot = proposedSlotFor(src.month, src.stream);
  const open = openItemsFor({ coHostName: src.coHostName, guestWanted: src.guestWanted, guestName: src.guestName });

  const answer = await synth(buildEventKitPrompt(src, slot, open));
  const parsed = parseEventKit(answer.text, src, slot, open);
  if (!parsed) throw new EventKitError("the event kit did not come back as usable JSON with a run of show");
  const kit = verifyEventKit(parsed, src);

  const title = `Draft event kit — ${kit.header.eventTitle} (${slot.label})`;
  const body = renderEventKitMarkdown(kit);

  /*
   * FILED FIRST, LINKED SECOND. If filing fails the kit is still stored on the packet and still
   * rendered into the PDF — losing the proposal because the archive is down would be the wrong
   * trade — but the email then says the kit is on the packet rather than offering a link that
   * opens nothing, and the failure goes in the swallowed ledger rather than nowhere.
   */
  let deliverableId: string | null = null;
  try {
    const delivered = await deliver(env, actor, {
      kind: "event_kit",
      title,
      body,
      preparedBy: "Parker",
      preparedFor: packet.requested_by ?? DEFAULT_KIT_RECIPIENT,
      sourceType: "room_packet_kit",
      sourceId: packet.id,
    });
    deliverableId = delivered.id;
  } catch (err) {
    await recordSwallowed(env, "eventKit.file", err, { packet_id: packet.id });
  }

  await env.WP_OS_DB.prepare(
    "UPDATE evt_room_packet SET event_kit_json = ?2, event_kit_deliverable_id = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(packet.id, JSON.stringify(kit), deliverableId).run();

  await appendEvent(env, {
    eventType: "room_packet.kit_drafted",
    actorType: "ai_employee",
    actorId: "aie_parker",
    objectType: "room_packet",
    objectId: packet.id,
    firmScope: packet.firm_scope,
    payload: {
      stream: kit.stream,
      month: kit.month,
      angle: kit.angleTitle,
      proposed_for: slot.date,
      proposed_at_et: slot.startEt,
      platform: EVENT_KIT_PLATFORM,
      open: kit.open.map((o) => o.kind),
      flags: kit.flags.map((f) => f.code),
      deliverable_id: deliverableId,
    },
  });

  return { kit, deliverableId, link: deliverableId ? eventKitLink(deliverableId) : null };
}

/**
 * The kit's place in the partner email: the TL;DR, then the link. Never the kit itself — a draft
 * that has to be corrected in two places is a draft that will disagree with itself.
 */
export function eventKitEmailBullets(kit: EventKit, deliverableId: string | null): string[] {
  return [
    eventKitTldr(kit),
    ...(kit.open.length ? [`Still open, said rather than invented: ${kit.open.map((o) => o.label).join("; ")}.`] : []),
    deliverableId
      ? `The whole kit — run of show, who is on screen, the questions, the posts: ${eventKitLink(deliverableId)}`
      : "The kit is on the packet; filing it for the link failed this run, and that is in the ledger.",
  ];
}
