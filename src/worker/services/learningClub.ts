import { z } from "zod";
import type { Env } from "../env";
import { appendEvent } from "../events";
import { json, type RouteContext } from "../router";
import { runAi } from "../ai/runAi";
import { actorFromIdentity, authorize, type Actor } from "./authorize";
import { SEARCH_MODEL, servedBySearchLane } from "./liveSearch";
import { blockCard } from "./blocks";
import { cannotDetail, steerFor, type Interpreter } from "./instruction";
import { pageTextOf, urlIsLive } from "../effects/urlLiveness";
import { createWorkCardInternal } from "./workCards";
import { sweepIdentity, type SweepCard } from "./workSweep";
import { sendOrPreview } from "./previewApproval";
import { isoWeekOf } from "./jobs";
import { PARTNERS } from "../../shared/registry/partners";
import { personaPrompt } from "../../shared/registry/aiEmployeePersonas";
import { isProviderOutage } from "../../shared/ai/providerFailure";
import type { EmailAttachment } from "../effects/emailTransport";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import {
  BOOKING_PACK_SHAPE,
  BRAND_SEND_SETTING,
  ONEPAGER_APPROVAL_SETTING,
  PLAYBOOK_APPROVAL_SETTING,
  TLC_BOOKING_HOURS,
  TLC_BOOKING_PACK_DAYS,
  TLC_CITY,
  TLC_COST_CAP_USD,
  TLC_DRIP_DAYS,
  TLC_NET_FLOOR_USD,
  TLC_NET_TARGET_USD,
  TLC_PLAYBOOK,
  TLC_PRE_LAUNCH_PROOF,
  TLC_SEATS,
  TLC_SPONSOR_CATEGORIES,
  TLC_TICKET_PRICE_USD,
  TLC_ALTERNATIVES,
  TLC_TOPIC_CRITERIA,
  TLC_TOPIC_SEEDS,
  TLC_VETO_DAYS,
  bookingPackProblems,
  bookingPackTotals,
  brandSendGate,
  classifyBrandMail,
  daysUntil,
  decisionEmail,
  defaultEventDate,
  dripEmail,
  eventEconomics,
  goAheadCheck,
  invoiceNote,
  isTlcKind,
  monthWords,
  needsSwap,
  nextDripAt,
  parseDecisionReply,
  quarterOf,
  renderOnePager,
  rollingTopicMonths,
  runOfShowLines,
  sponsorshipAgreement,
  stageMoveProblem,
  topicsEmail,
  type TopicsEmailAlternative,
  ticketPriceProblem,
  ticketVerdict,
  vetoUntil,
  vetoedMonths,
  warmupDailyCap,
  type BookingPack,
  type Citation,
  type DealStage,
  type EventEconomics,
} from "../../shared/tlc/learningClub";

/**
 * THE LEARNING CLUB, worker half (owner-approved 22 Oct 2026). The rules are in
 * `shared/tlc/learningClub.ts`; this file opens the cards, works them, and keeps the books.
 *
 * WHO DOES WHAT, ON WHAT CLOCK:
 *   tlc_topics       (1st of the month)  → Parker picks topics for the three months ahead, emails
 *                                          both partners the packets; picks PROCEED after 3 days
 *                                          unless either partner replies no.
 *   tlc_trend_story  (1st, quarterly)    → Wynn's trend story, every claim on a live, stored page.
 *   tlc_brand_batch  (Mondays)           → Wynn finds brands for the open clubs; each is a deal.
 *   tlc_daily        (every day)         → booking packs at 6 weeks, swap flags, the go-ahead at
 *                                          21 and 14 days, and the drip (held while the switch is off).
 *
 * WHAT NEVER HAPPENS HERE: a booking, a purchase, a payment out. A brand email that has not passed
 * `brandSendGate` AND an approved `effect.email.send` receipt. A sponsor name or amount written
 * anywhere but these tables.
 */

const PARKER = "aie_parker";
const WYNN = "aie_wynn";
const actorFor = (id: string, firmScope: string): Actor => ({ type: "AI", aiEmployeeId: id, roles: [], firmScopes: [firmScope] });

// ── Rows ────────────────────────────────────────────────────────────────────────────────────────

export interface TlcEventRow {
  id: string;
  month: string;
  event_date: string;
  slot: string;
  topic: string | null;
  angle: string | null;
  status: string;
  veto_until: string | null;
  topic_card_id: string | null;
  vetoed_topics_json: string | null;
  packet_json: string | null;
  sponsor_categories_json: string | null;
  booking_pack_json: string | null;
  booking_pack_at: string | null;
  ticket_url: string | null;
  sponsor_payment_url: string | null;
  committed_costs_usd: number;
  swap_flagged_at: string | null;
  go_checks_json: string | null;
  recap: string | null;
  firm_scope: string;
}

export interface TlcDealRow {
  id: string;
  event_id: string;
  brand: string;
  category: string | null;
  contact_name: string | null;
  contact_email: string;
  contact_source_url: string;
  why_fit: string | null;
  stage: DealStage;
  cash_offer_usd: number | null;
  in_kind_offer: string | null;
  in_kind_value_usd: number | null;
  wants: string | null;
  decision: string | null;
  counter_usd: number | null;
  drip_step: number;
  next_send_at: string | null;
  first_sent_at: string | null;
  replied_at: string | null;
  stop_reason: string | null;
  decision_card_id: string | null;
  firm_scope: string;
}

const list = <T>(raw: string | null | undefined): T[] => {
  try {
    const v = JSON.parse(raw ?? "[]");
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
};

export async function tlcSettings(env: Env): Promise<Record<string, string | null>> {
  const rows = (await env.WP_OS_DB.prepare("SELECT key, value FROM tlc_setting").all<{ key: string; value: string | null }>()).results ?? [];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

async function eventsFrom(env: Env, sql: string, ...binds: unknown[]): Promise<TlcEventRow[]> {
  return (await env.WP_OS_DB.prepare(sql).bind(...binds).all<TlcEventRow>()).results ?? [];
}

async function dealsFor(env: Env, eventId: string): Promise<TlcDealRow[]> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE event_id = ?1").bind(eventId).all<TlcDealRow>()).results ?? [];
}

/** The club's money, from the books: sponsor cash agreed or better, booked costs, paid tickets. */
export async function economicsFor(env: Env, ev: TlcEventRow): Promise<EventEconomics> {
  const deals = await dealsFor(env, ev.id);
  const cash = deals.filter((d) => ["AGREED", "PAID", "DELIVERED"].includes(d.stage)).reduce((s, d) => s + (d.cash_offer_usd ?? 0), 0);
  const inKind = deals.filter((d) => ["AGREED", "PAID", "DELIVERED"].includes(d.stage)).reduce((s, d) => s + (d.in_kind_value_usd ?? 0), 0);
  const tickets = (await env.WP_OS_DB.prepare("SELECT amount_usd, fee_usd FROM tlc_ticket WHERE event_id = ?1 AND refunded_at IS NULL").bind(ev.id).all<{ amount_usd: number; fee_usd: number | null }>()).results ?? [];
  return eventEconomics({ sponsorCashUsd: cash, committedCostsUsd: ev.committed_costs_usd ?? 0, tickets, inKindValueUsd: inKind });
}

// ── Email to both partners ──────────────────────────────────────────────────────────────────────

async function emailBoth(
  env: Env,
  input: { employee: "Parker" | "Wynn"; email: Omit<ExecEmailInput, "employee">; objectType: string; objectId: string; cardId: string | null; cardKind: string | null; firmScope: string; attachments?: readonly EmailAttachment[] },
): Promise<string[]> {
  const sent: string[] = [];
  for (const p of PARTNERS) {
    const out = await sendOrPreview(env, {
      to: p.email,
      email: { employee: input.employee, ...input.email },
      objectType: input.objectType,
      objectId: input.objectId,
      workCardId: input.cardId,
      cardKind: input.cardKind,
      firmScope: input.firmScope,
      actorId: input.employee === "Parker" ? PARKER : WYNN,
      // A scheduled duty: nobody ticked "show me first" on it, and saying so is the honest answer.
      cardAsked: null,
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    });
    if (out.sent || out.previewed) sent.push(p.email);
  }
  return sent;
}

// ── Cards the jobs open ─────────────────────────────────────────────────────────────────────────

async function openCard(
  env: Env,
  input: { title: string; kind: string; owner: string; description: string; nextAction: string; firmScope: string },
): Promise<{ opened: boolean; cardId: string; title: string }> {
  const existing = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE title = ?1 AND firm_scope = ?2 AND state != 'CANCELLED' LIMIT 1")
    .bind(input.title, input.firmScope)
    .first<{ id: string }>();
  if (existing) return { opened: false, cardId: existing.id, title: input.title };
  const card = await createWorkCardInternal(env, sweepIdentity(input.firmScope), {
    title: input.title,
    description: input.description,
    owner_type: "AI",
    owner_id: input.owner,
    priority: "NORMAL",
    firm_scope: input.firmScope,
    next_action: input.nextAction,
  });
  await env.WP_OS_DB.prepare("UPDATE work_card SET kind = ?2 WHERE id = ?1").bind(card.id, input.kind).run();
  await appendEvent(env, {
    eventType: "tlc.card_opened",
    actorType: "system",
    actorId: "scheduled_job",
    objectType: "work_card",
    objectId: card.id,
    firmScope: input.firmScope,
    payload: { kind: input.kind, title: input.title },
  });
  return { opened: true, cardId: card.id, title: input.title };
}

/** The clubs Parker holds a topic for: three months ahead, created on first sight. */
export async function ensureRollingEvents(env: Env, now: Date, firmScope = "west-peek"): Promise<string[]> {
  const months = rollingTopicMonths(now);
  for (const m of months) {
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_event (id, month, event_date, firm_scope) VALUES (?1, ?2, ?3, ?4)")
      .bind(`tlc_${m}`, m, defaultEventDate(m), firmScope)
      .run();
  }
  return months;
}

/**
 * Months that need Parker: no topic yet, flagged for swap, or a topic already CHOSEN (status PLANNING
 * with a topic but no packet yet — e.g. picks a partner or Parker made outside this card) that still
 * needs its packet, one-sheet and the partners' email. A chosen topic is kept exactly; it is never re-picked.
 */
async function monthsNeedingTopics(env: Env, firmScope: string): Promise<TlcEventRow[]> {
  return eventsFrom(env, "SELECT * FROM tlc_event WHERE firm_scope = ?1 AND (status = 'SWAP_FLAGGED' OR (status = 'PLANNING' AND (topic IS NULL OR packet_json IS NULL))) ORDER BY month", firmScope);
}

/** A topic already chosen for this month, which Parker keeps. Null when the month is his to pick. */
const chosenTopic = (e: TlcEventRow): string | null => (e.status === "PLANNING" && e.topic ? e.topic : null);

export async function openTopicsCard(env: Env, now: Date, firmScope = "west-peek"): Promise<{ opened: boolean; cardId: string | null; title: string; detail: string }> {
  await ensureRollingEvents(env, now, firmScope);
  const need = await monthsNeedingTopics(env, firmScope);
  if (need.length === 0) return { opened: false, cardId: null, title: "", detail: "every club in the next three months already has a topic proposed or agreed" };
  /*
   * ONE TOPICS CARD AT A TIME (22 Oct 2026). Titles name the months, so the title check in `openCard` let a
   * second card open for months a live one already holds. A card that is still open, held, or blocked owns them.
   */
  const live = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = 'TLC_TOPICS' AND firm_scope = ?1 AND state NOT IN ('DONE','CANCELLED') LIMIT 1")
    .bind(firmScope)
    .first<{ id: string }>();
  if (live) return { opened: false, cardId: live.id, title: "", detail: `topics card ${live.id} already holds these months` };
  const months = need.map((e) => e.month);
  const out = await openCard(env, {
    title: `Parker: TLC topics for ${months.map(monthWords).join(", ")}`,
    kind: "TLC_TOPICS",
    owner: PARKER,
    description: [
      "THE LEARNING CLUB (TLC). Parker CHOOSES the topic for each month below, writes the Rooms packet for it, names 5–10 sponsor categories, and emails both partners.",
      "His picks PROCEED unless either partner replies no within 3 days. Nothing waits on the owners.",
      `Months: ${months.join(", ")}.`,
    ].join("\n"),
    nextAction: "Pick against the four criteria, check every source page, write the packets, email both partners, then wait out the 3-day veto window.",
    firmScope,
  });
  return { ...out, detail: out.opened ? `opened "${out.title}"` : `"${out.title}" is already open` };
}

export async function openBrandBatchCard(env: Env, now: Date, firmScope = "west-peek"): Promise<{ opened: boolean; cardId: string | null; title: string; detail: string }> {
  const open = await openEvents(env, now, firmScope);
  if (open.length === 0) {
    return { opened: false, cardId: null, title: "", detail: "no club has an agreed topic yet, so there is nothing to sell this week (named stop: waits for Parker's picks to clear their veto window)" };
  }
  const out = await openCard(env, {
    title: `Wynn: TLC brand batch ${isoWeekOf(now)}`,
    kind: "TLC_BRAND_BATCH",
    owner: WYNN,
    description: `This week's new brands for the open clubs: ${open.map((e) => `${monthWords(e.month)} (${e.topic})`).join("; ")}. A named person and an address read off a live page for each, or the brand is left out.`,
    nextAction: "Search, keep only brands with a live source page carrying the address, queue each for the four-email sequence.",
    firmScope,
  });
  return { ...out, detail: out.opened ? `opened "${out.title}"` : `"${out.title}" is already open` };
}

export async function openTrendStoryCard(env: Env, now: Date, firmScope = "west-peek"): Promise<{ opened: boolean; cardId: string | null; title: string; detail: string }> {
  const quarter = quarterOf(now);
  const have = await env.WP_OS_DB.prepare("SELECT id FROM tlc_story WHERE quarter = ?1").bind(quarter).first<{ id: string }>();
  if (have) return { opened: false, cardId: null, title: "", detail: `the ${quarter} trend story is already written; it refreshes next quarter` };
  const out = await openCard(env, {
    title: `Wynn: TLC trend story ${quarter}`,
    kind: "TLC_TREND_STORY",
    owner: WYNN,
    description: "The story of in-person learning clubs in coastal cities, built ONLY from real, live sources stored with the claim each one supports. No invented fact. Refreshed every quarter.",
    nextAction: "Search, keep only claims whose page answers, store the sources, write the story, email both partners.",
    firmScope,
  });
  return { ...out, detail: out.opened ? `opened "${out.title}"` : `"${out.title}" is already open` };
}

/** Clubs that can be sold: a topic past its veto window (or further along) and still in the future. */
export async function openEvents(env: Env, now: Date, firmScope: string): Promise<TlcEventRow[]> {
  const rows = await eventsFrom(env, "SELECT * FROM tlc_event WHERE firm_scope = ?1 AND status IN ('TOPIC_READY','GO','ESCALATED') ORDER BY month", firmScope);
  return rows.filter((e) => daysUntil(e.event_date, now) > 0).slice(0, 3);
}

// ── The daily pass ──────────────────────────────────────────────────────────────────────────────

export interface DailyResult {
  bookingPacksOpened: string[];
  swapFlagged: string[];
  goChecks: Array<{ month: string; checkpoint: number; verdict: string }>;
  drip: DripResult;
  failures: string[];
}

export async function runTlcDaily(env: Env, now: Date, firmScope = "west-peek"): Promise<DailyResult> {
  const out: DailyResult = { bookingPacksOpened: [], swapFlagged: [], goChecks: [], drip: emptyDrip(), failures: [] };
  const events = await eventsFrom(env, "SELECT * FROM tlc_event WHERE firm_scope = ?1 AND status NOT IN ('DONE','CANCELLED') ORDER BY month", firmScope);
  for (const ev of events) {
    try {
      const days = daysUntil(ev.event_date, now);
      if (days <= 0) continue;
      const hasTopic = Boolean(ev.topic) && ["TOPIC_READY", "GO", "ESCALATED"].includes(ev.status);
      // SIX WEEKS OUT: the booking pack, options only.
      if (hasTopic && !ev.booking_pack_at && days <= TLC_BOOKING_PACK_DAYS) {
        const c = await openCard(env, {
          title: `Parker: TLC booking pack ${monthWords(ev.month)}`,
          kind: "TLC_BOOKING_PACK",
          owner: PARKER,
          description: `Options for the partners to book and pay for the ${ev.topic} club on ${ev.event_date}. Parker never books anything.`,
          nextAction: "Search NYC hosts, venues, teachers, food, materials and photographers for a 4-hour club; price each, give a book-by date, total it against the sponsor cash.",
          firmScope,
        });
        if (c.opened) out.bookingPacksOpened.push(ev.month);
      }
      // SIX WEEKS OUT WITH NOBODY INTERESTED: swap the topic.
      if (hasTopic && !ev.swap_flagged_at && needsSwap(days, await dealsFor(env, ev.id))) {
        const vetoed = [...list<string>(ev.vetoed_topics_json), ev.topic!];
        await env.WP_OS_DB.prepare(
          "UPDATE tlc_event SET status = 'SWAP_FLAGGED', swap_flagged_at = ?2, vetoed_topics_json = ?3, updated_at = ?2 WHERE id = ?1",
        ).bind(ev.id, now.toISOString(), JSON.stringify(vetoed)).run();
        out.swapFlagged.push(ev.month);
      }
      // 21 AND 14 DAYS OUT: go, or escalate to both partners.
      if (hasTopic) {
        const check = goAheadCheck({ daysOut: days, economics: await economicsFor(env, ev) });
        const done = list<{ checkpoint: number }>(ev.go_checks_json);
        if (check.checkpoint !== null && !done.some((d) => d.checkpoint === check.checkpoint)) {
          const econ = await economicsFor(env, ev);
          await env.WP_OS_DB.prepare("UPDATE tlc_event SET status = ?2, go_checks_json = ?3, updated_at = ?4 WHERE id = ?1")
            .bind(ev.id, check.verdict === "GO" ? "GO" : "ESCALATED", JSON.stringify([...done, { checkpoint: check.checkpoint, verdict: check.verdict, at: now.toISOString(), reasons: check.reasons }]), now.toISOString())
            .run();
          await emailBoth(env, {
            employee: "Wynn",
            email: {
              what: `TLC ${monthWords(ev.month)}: ${check.verdict === "GO" ? "go-ahead" : "short of the go-ahead"}, ${check.checkpoint} days out`,
              tldr:
                check.verdict === "GO"
                  ? `The ${ev.topic} club clears the go-ahead ${check.checkpoint} days out: ${econ.paidTickets} paid tickets, sponsor net $${econ.sponsorNetUsd.toLocaleString("en-US")}.`
                  : `The ${ev.topic} club is short ${check.checkpoint} days out. ${check.reasons.join(" ")}`,
              tldrBullets: check.verdict === "GO" ? undefined : ['Reply "add sponsor", "cut cost" or "move date"'],
              sections: [
                { label: "Where it stands", bullets: [`Paid tickets: ${econ.paidTickets} of ${TLC_SEATS.max} (${TLC_SEATS.min} needed two weeks out)`, `Sponsor net: $${econ.sponsorNetUsd.toLocaleString("en-US")} (floor $${TLC_NET_FLOOR_USD.toLocaleString("en-US")}, target $${TLC_NET_TARGET_USD.toLocaleString("en-US")})`, `Net with tickets after fees: $${econ.netUsd.toLocaleString("en-US")}`, `Booked costs: $${(ev.committed_costs_usd ?? 0).toLocaleString("en-US")} (cap $${TLC_COST_CAP_USD.toLocaleString("en-US")})`] },
                check.options.length ? { label: "The three ways out", bullets: check.options } : { label: "What happens next", bullets: ["Nothing needed from you. Wynn keeps selling and the tickets stay open until the seats are gone."] },
              ],
            },
            objectType: "tlc_event",
            objectId: ev.id,
            cardId: null,
            cardKind: null,
            firmScope,
          });
          out.goChecks.push({ month: ev.month, checkpoint: check.checkpoint, verdict: check.verdict });
        }
      }
    } catch (err) {
      out.failures.push(`${ev.month}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // A SWAPPED MONTH GOES STRAIGHT BACK TO PARKER.
  if (out.swapFlagged.length) await openTopicsCard(env, now, firmScope);
  try {
    out.drip = await runDrip(env, now, firmScope);
  } catch (err) {
    out.failures.push(`drip: ${err instanceof Error ? err.message : String(err)}`);
  }
  return out;
}

// ── The drip ────────────────────────────────────────────────────────────────────────────────────

export interface DripResult {
  due: number;
  held: number;
  awaitingApproval: number;
  sent: number;
  gate: { open: boolean; reasons: string[] };
}
const emptyDrip = (): DripResult => ({ due: 0, held: 0, awaitingApproval: 0, sent: 0, gate: { open: false, reasons: [] } });

/**
 * One pass of the brand sequence.
 *
 * GATE CLOSED (the default): each due email is composed and stored HELD with the reasons, and the
 * deal does not advance. That is the named stop — the drip page and the job summary say exactly
 * what is held and why. Nothing is sent.
 *
 * GATE OPEN: each due email (up to the warm-up cap) becomes an `email.send` external-effect request
 * from Wynn plus an approval card. A partner's approval is the receipt; the next pass executes it
 * through the executor, which applies the firm's external-email switch once more.
 */
export async function runDrip(env: Env, now: Date, firmScope = "west-peek"): Promise<DripResult> {
  const settings = await tlcSettings(env);
  const gate = brandSendGate(settings, env);
  const result: DripResult = { ...emptyDrip(), gate };
  const wynn = actorFor(WYNN, firmScope);

  // 1 · Execute what a partner has approved (gate re-checked: a switch turned off stops it here).
  if (gate.open) {
    const approved = (await env.WP_OS_DB.prepare(
      `SELECT m.id, m.deal_id, m.step, m.effect_request_id, m.approval_card_id FROM tlc_drip_message m
         JOIN approval_card a ON a.id = m.approval_card_id
        WHERE m.state = 'AWAITING_APPROVAL' AND a.state = 'approved'`,
    ).all<{ id: string; deal_id: string; step: number; effect_request_id: string; approval_card_id: string }>()).results ?? [];
    const { executeExternalEffect } = await import("../effects/executor");
    for (const m of approved) {
      const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(m.deal_id).first<TlcDealRow>();
      if (!deal || deal.stop_reason) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = 'the brand answered or was stopped before it went' WHERE id = ?1").bind(m.id).run();
        continue;
      }
      try {
        await executeExternalEffect(env, wynn, m.effect_request_id, m.approval_card_id);
        const first = deal.first_sent_at ?? now.toISOString();
        const step = m.step + 1;
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'SENT', sent_at = ?2 WHERE id = ?1").bind(m.id, now.toISOString()).run();
        await env.WP_OS_DB.prepare(
          "UPDATE tlc_deal SET stage = CASE WHEN stage = 'PROSPECT' THEN 'PITCHED' ELSE stage END, drip_step = ?2, first_sent_at = ?3, last_sent_at = ?4, next_send_at = ?5, updated_at = ?4 WHERE id = ?1",
        ).bind(deal.id, step, first, now.toISOString(), nextDripAt(step, first, now, null)).run();
        result.sent += 1;
      } catch (err) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'FAILED', held_reason = ?2 WHERE id = ?1").bind(m.id, err instanceof Error ? err.message.slice(0, 300) : "failed").run();
      }
    }
  }

  // 2 · Compose what is due.
  const due = (await env.WP_OS_DB.prepare(
    `SELECT d.* FROM tlc_deal d JOIN tlc_event e ON e.id = d.event_id
      WHERE d.firm_scope = ?1 AND d.stop_reason IS NULL AND d.stage IN ('PROSPECT','PITCHED')
        AND d.drip_step < ?2 AND d.next_send_at IS NOT NULL AND d.next_send_at <= ?3
        AND e.status IN ('TOPIC_READY','GO','ESCALATED')
        AND NOT EXISTS (SELECT 1 FROM tlc_drip_message m WHERE m.deal_id = d.id AND m.step = d.drip_step AND m.state = 'AWAITING_APPROVAL')
      ORDER BY d.next_send_at`,
  ).bind(firmScope, TLC_DRIP_DAYS.length, now.toISOString()).all<TlcDealRow>()).results ?? [];
  result.due = due.length;

  const firstEver = (await env.WP_OS_DB.prepare("SELECT MIN(sent_at) AS at FROM tlc_drip_message WHERE state = 'SENT'").first<{ at: string | null }>())?.at ?? null;
  const today = now.toISOString().slice(0, 10);
  const usedToday = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE state IN ('SENT','AWAITING_APPROVAL') AND substr(created_at, 1, 10) = ?1").bind(today).first<{ n: number }>())?.n ?? 0;
  let room = Math.max(0, warmupDailyCap(firstEver, now) - usedToday);

  for (const deal of due) {
    const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
    if (!ev?.topic) continue;
    const mail = dripEmail({ step: deal.drip_step, brand: deal.brand, contactName: deal.contact_name, topic: ev.topic, month: ev.month, eventDate: ev.event_date, why: deal.why_fit });
    if (!gate.open || room <= 0) {
      const why = gate.open ? "today's warm-up allowance is used" : gate.reasons.join("; ");
      await env.WP_OS_DB.prepare(
        `INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, held_reason) VALUES (?1, ?2, ?3, ?4, ?5, 'HELD', ?6)
         ON CONFLICT (deal_id, step) DO UPDATE SET subject = excluded.subject, body = excluded.body, held_reason = excluded.held_reason
         WHERE tlc_drip_message.state IN ('HELD','FAILED')`,
      ).bind(`tdm_${crypto.randomUUID()}`, deal.id, deal.drip_step, mail.subject, mail.text, why).run();
      result.held += 1;
      continue;
    }
    const requestId = `eer_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4)",
    ).bind(requestId, deal.contact_email, JSON.stringify({ subject: mail.subject, text: mail.text }), WYNN).run();
    const { requestApproval } = await import("./approvals");
    const card = await requestApproval(env, wynn, {
      action_key: "effect.email.send",
      object_type: "external_effect_request",
      object_id: requestId,
      title: `Wynn: TLC email ${deal.drip_step + 1} of 4 to ${deal.brand}`,
      summary: `${mail.subject}\n\n${mail.text}`.slice(0, 1800),
      payload: { deal_id: deal.id, step: deal.drip_step },
      submit: true,
    });
    await env.WP_OS_DB.prepare(
      `INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, effect_request_id, approval_card_id) VALUES (?1, ?2, ?3, ?4, ?5, 'AWAITING_APPROVAL', ?6, ?7)
       ON CONFLICT (deal_id, step) DO UPDATE SET state = 'AWAITING_APPROVAL', held_reason = NULL, effect_request_id = excluded.effect_request_id, approval_card_id = excluded.approval_card_id, subject = excluded.subject, body = excluded.body`,
    ).bind(`tdm_${crypto.randomUUID()}`, deal.id, deal.drip_step, mail.subject, mail.text, requestId, card.id).run();
    result.awaitingApproval += 1;
    room -= 1;
  }
  return result;
}

/**
 * A MESSAGE FROM SOMEBODY WE WROTE TO (called from the inbound door before anything else reads it).
 * Any reply, bounce or unsubscribe stops that brand's sequence at once; the reply is put on the
 * club's sales card so it is read. Matched on the sender's address, or — for a bounce, which comes
 * from a mail server — on the subject we sent.
 */
export async function recordBrandMail(env: Env, input: { from: string; subject: string; now?: Date }): Promise<{ matched: number; stop: string | null }> {
  const now = (input.now ?? new Date()).toISOString();
  const kind = classifyBrandMail(input);
  const address = (/<([^>]+)>/.exec(input.from)?.[1] ?? input.from).trim().toLowerCase();
  let deals = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE lower(contact_email) = ?1 AND stop_reason IS NULL").bind(address).all<TlcDealRow>()).results ?? [];
  if (deals.length === 0 && kind === "BOUNCED") {
    const sent = (await env.WP_OS_DB.prepare("SELECT DISTINCT deal_id, subject FROM tlc_drip_message WHERE state = 'SENT'").all<{ deal_id: string; subject: string }>()).results ?? [];
    const ids = sent.filter((s) => input.subject.toLowerCase().includes(s.subject.toLowerCase())).map((s) => s.deal_id);
    for (const id of ids) {
      const d = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1 AND stop_reason IS NULL").bind(id).first<TlcDealRow>();
      if (d) deals.push(d);
    }
  }
  if (deals.length === 0) return { matched: 0, stop: null };
  deals = [...new Map(deals.map((d) => [d.id, d])).values()];
  for (const d of deals) {
    await env.WP_OS_DB.prepare(
      "UPDATE tlc_deal SET stop_reason = ?2, replied_at = CASE WHEN ?2 = 'REPLIED' THEN ?3 ELSE replied_at END, next_send_at = NULL, stage = CASE WHEN ?2 = 'UNSUBSCRIBED' THEN 'STOPPED' ELSE stage END, updated_at = ?3 WHERE id = ?1",
    ).bind(d.id, kind, now).run();
    const ev = await env.WP_OS_DB.prepare("SELECT month, topic FROM tlc_event WHERE id = ?1").bind(d.event_id).first<{ month: string; topic: string | null }>();
    const card = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE kind = 'TLC_BRAND_BATCH' AND firm_scope = ?1 ORDER BY created_at DESC LIMIT 1").bind(d.firm_scope).first<{ id: string }>();
    if (card) {
      await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000), updated_at = ?3 WHERE id = ?1")
        .bind(card.id, `• ${now.slice(0, 16)}Z ${d.brand} (${ev ? monthWords(ev.month) : d.event_id}): ${kind === "REPLIED" ? `replied — "${input.subject.slice(0, 120)}". Sequence stopped; take it to a call and record the offer.` : kind === "BOUNCED" ? "the address bounced. Sequence stopped." : "asked us to stop. Sequence stopped for good."}`, now)
        .run();
    }
  }
  await appendEvent(env, { eventType: "tlc.brand_mail", actorType: "system", actorId: "inbound_email", objectType: "tlc_deal", objectId: deals[0]!.id, payload: { kind, deals: deals.length } });
  return { matched: deals.length, stop: kind };
}

// ── The runner: one card, one bounded unit of work ─────────────────────────────────────────────

export type TlcSearch = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;
export interface TlcDeps {
  search?: TlcSearch;
  urlCheck?: (url: string) => Promise<boolean>;
  pageText?: (url: string) => Promise<string | null>;
  now?: Date;
  interpret?: Interpreter;
}
export interface TlcRunResult {
  finished: boolean;
  blocked: boolean;
  progressed: boolean;
  held?: boolean;
  waitUntil?: string;
  detail: string;
}

const defaultSearch: TlcSearch = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "The Learning Club: live research",
    actor,
    inputs: [prompt],
    // Public web research about public topics, brands and venues. No sponsor deal term goes in.
    sensitivity: "PUBLIC" as never,
    budgetContext: { requiresSearch: true, expectedOutputTokens: 3500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
    routing: { category: "INTELLIGENCE" },
  });
  if (run.status !== "COMPLETED" || !run.output_text) return { ok: false, text: "", detail: run.failure_reason ?? `run ${run.status}` };
  if (!servedBySearchLane(run.model)) return { ok: false, text: "", detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web` };
  return { ok: true, text: run.output_text, detail: "ok" };
};

/** The first JSON object in a model's answer. */
export function jsonIn(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number => (typeof v === "number" ? v : Number(String(v ?? "").replace(/[$,]/g, "")));
const isUrl = (u: string): boolean => /^https?:\/\/[^\s]+$/.test(u);

function playbookBlock(): string {
  return ["THE PLAYBOOK (the owner approves this text; follow it exactly):", ...TLC_PLAYBOOK.map((l) => `- ${l}`)].join("\n");
}

export function buildTopicsPrompt(months: readonly string[], exclude: readonly string[], chosen: Readonly<Record<string, string>> = {}): string {
  const kept = months.filter((m) => chosen[m]);
  return [
    personaPrompt("Parker", "Event Marketing Coordinator"),
    "",
    `You are choosing topics for The Learning Club: in-person, ${TLC_CITY} only, ${TLC_SEATS.min}–${TLC_SEATS.max} people, one topic, a 3–4 hour deep dive on one afternoon (Sat 1–5 pm) or one evening (Thu 6–10 pm). Every attendee pays a $${TLC_TICKET_PRICE_USD} ticket. Everyone leaves with something they made or learned.`,
    `Run of show: ${runOfShowLines().join("; ")}.`,
    `Pick ONE topic for each of these months: ${months.map(monthWords).join(", ")}. No two months the same topic. Every month must have a pick.`,
    kept.length ? `These months' topics are ALREADY CHOSEN — keep exactly that topic and write its packet: ${kept.map((m) => `${monthWords(m)} = "${chosen[m]}"`).join("; ")}.` : "",
    "",
    "Seed list (you may pick from it or propose a better topic):",
    ...TLC_TOPIC_SEEDS.map((s) => `- ${s}`),
    exclude.length ? `Never pick these (already used or turned down): ${exclude.join("; ")}.` : "",
    "",
    "Pick criteria — argue every pick against all four:",
    ...TLC_TOPIC_CRITERIA.map((c) => `- ${c}`),
    "",
    "For each pick give the usual Rooms packet: the angle, why now (with sources), what happens in the hands-on hour, what people take home, the kind of expert who teaches it, and 5–10 sponsor categories that fit (non-competing within the club, each with why and two or three example brands).",
    `Then give exactly ${TLC_ALTERNATIVES} ALTERNATIVE topics the partners could swap in: each different from the picks and from each other, with a one-line reason it would work and two or three real brands that would pay to sponsor it.`,
    "This goes to the partners as it is: write only what each topic IS. Never mention a topic you turned down, rejected or ruled out, or why.",
    "Use ONLY real, live web pages as sources. Do not invent statistics, quotes or events.",
    "",
    'Return ONLY JSON: {"picks":[{"month":"YYYY-MM","topic":"","angle":"","why_now":"","criteria":{"product_used":"","irl_spend":"","sponsors_fit":"","pays_10":""},"hands_on":"","take_home":"","teacher_profile":"","sponsor_categories":[{"category":"","why":"","example_brands":[""]}],"sources":[{"title":"","url":""}]}],"alternatives":[{"topic":"","reason":"","brands":[""]}]}',
  ].filter(Boolean).join("\n");
}

export function buildBookingPackPrompt(ev: Pick<TlcEventRow, "topic" | "event_date" | "slot">): string {
  return [
    personaPrompt("Parker", "Event Marketing Coordinator"),
    "",
    `Build the booking pack for The Learning Club: "${ev.topic}", ${TLC_CITY}, on ${ev.event_date} (${ev.slot === "AFTERNOON" ? "Saturday 1–5 pm" : "Thursday 6–10 pm"}), ${TLC_SEATS.min}–${TLC_SEATS.max} people, ${TLC_BOOKING_HOURS} hours.`,
    `Run of show: ${runOfShowLines().join("; ")}.`,
    "These are OPTIONS for the partners, who book and pay. You never book, reserve or pay for anything.",
    `Everything together must fit inside $${TLC_COST_CAP_USD.toLocaleString("en-US")}.`,
    "",
    `Give: ${Object.values(BOOKING_PACK_SHAPE).map((s) => `${s.min === s.max ? s.min : `${s.min}–${s.max}`} ${s.label}`).join("; ")}; a materials list with links, quantities and unit prices for ${TLC_SEATS.max} people.`,
    "Donated-venue leads first (law firms, coworking spaces like WeWork, brand showrooms that host community events), then paid venues. A real meal, not snacks. Host and venue priced for 4 hours; the expert paid for the whole session.",
    "Every option needs: a real live URL for it, a price in USD (an estimate is fine if marked in the note), and a book_by date (YYYY-MM-DD).",
    "",
    'Return ONLY JSON: {"hosts":[{"name":"","price_usd":0,"book_by":"YYYY-MM-DD","url":"","note":""}],"donated_venue_leads":[…],"paid_venues":[…],"teachers":[…],"food":[…],"photographers":[…],"materials":[{"item":"","url":"","qty":0,"unit_usd":0}]}',
  ].join("\n");
}

export function buildBrandBatchPrompt(events: ReadonlyArray<Pick<TlcEventRow, "month" | "topic" | "sponsor_categories_json">>, exclude: readonly string[]): string {
  return [
    personaPrompt("Wynn", "TLC Sales & Partnerships"),
    "",
    playbookBlock(),
    "",
    "Find brands to sponsor these clubs:",
    ...events.map((e) => `- ${monthWords(e.month)}: "${e.topic}". Categories: ${list<{ category: string }>(e.sponsor_categories_json).map((c) => c.category).join(", ")}`),
    exclude.length ? `Already contacted for that club (do not repeat): ${exclude.join("; ")}.` : "",
    "",
    "Up to 5 brands per club. For each: a NAMED person whose job is partnerships, events, community or brand marketing, their email address exactly as it appears on a live public page, and that page's URL. No guessed addresses. If you cannot find an address on a page, leave the brand out.",
    'Return ONLY JSON: {"brands":[{"month":"YYYY-MM","brand":"","category":"","contact_name":"","contact_email":"","contact_source_url":"","why_fit":""}]}',
  ].filter(Boolean).join("\n");
}

export function buildTrendPrompt(): string {
  return [
    personaPrompt("Wynn", "TLC Sales & Partnerships"),
    "",
    "Research the trend of in-person learning clubs in coastal US cities: people gathering in person to go deep on one topic (sewing, matcha, day trading, and the like). What is happening, who is doing it, why now.",
    "Use ONLY real, live web pages (news, research, company announcements). Every sentence in the story must rest on a source you list, and each source carries the one claim it supports. No invented numbers, quotes or names.",
    "Story: 120–220 words, plain and warm, written as \"we\" would tell a brand partner. Cite as [1], [2] matching the sources list.",
    'Return ONLY JSON: {"story":"","sources":[{"title":"","publisher":"","url":"","published_on":"YYYY-MM-DD or empty","claim":""}]}',
  ].join("\n");
}

const TLC_STEPS: Record<string, string[]> = {
  TLC_TOPICS: ["read the owner's seed list and the four criteria", "search live pages for each month's topic", "check every source page", "write the packet and the sponsor categories", "email both partners", "wait 3 days for a no"],
  TLC_BOOKING_PACK: ["search NYC hosts, venues, teachers, food, materials and photographers", "check every page", "price each with a book-by date", "total it against the cap and the sponsor cash", "email both partners"],
  TLC_BRAND_BATCH: ["search brands in the club's categories", "check each contact page carries the address", "queue each for the four emails"],
  TLC_TREND_STORY: ["search live sources on in-person learning clubs", "keep only claims whose page answers", "store the sources", "write the story", "email both partners"],
};

/**
 * WHAT A PARTNER SAID ON THE CARD, READ FIRST (services/instruction.ts). Every chain prepends the
 * steer to its prompt; a request this work cannot do blocks with the reason. Called just before the
 * search — never before Parker's veto reading, which must see the notes itself.
 */
async function steeredSearch(env: Env, card: SweepCard, employee: "Parker" | "Wynn", search: TlcSearch, interpret?: Interpreter): Promise<{ search: TlcSearch } | { blocked: TlcRunResult }> {
  const steer = await steerFor(env, actorFor(employee === "Parker" ? PARKER : WYNN, card.firm_scope), {
    cardId: card.id,
    cardKind: card.kind,
    title: card.title,
    employee,
    chain: "The Learning Club",
    steps: TLC_STEPS[card.kind ?? ""] ?? [],
    firmScope: card.firm_scope,
  }, interpret);
  if (steer.cannot.length > 0) {
    const why = await blockCard(env, card, {
      reason: steer.failure ? "the_brief_is_missing" : "asked_for_something_this_work_cannot_do",
      trying: card.title,
      employee,
      detail: steer.failure ? undefined : cannotDetail(employee, steer.cannot),
    });
    return { blocked: { finished: false, blocked: true, progressed: false, detail: why } };
  }
  return { search: (e, a, prompt) => search(e, a, steer.text ? `${steer.text}\n\n${prompt}` : prompt) };
}

export async function runTlcCard(env: Env, card: SweepCard, deps: TlcDeps = {}): Promise<TlcRunResult> {
  const now = deps.now ?? new Date();
  const raw = deps.search ?? defaultSearch;
  const interpret = deps.interpret;
  const search: TlcSearch = async (e, a, prompt) => {
    const who = card.kind === "TLC_TOPICS" || card.kind === "TLC_BOOKING_PACK" ? "Parker" : "Wynn";
    const s = await steeredSearch(env, card, who, raw, interpret);
    if ("blocked" in s) throw new SteerBlocked(s.blocked);
    return s.search(e, a, prompt);
  };
  const check = deps.urlCheck ?? ((u: string) => urlIsLive(u));
  const pageText = deps.pageText ?? ((u: string) => pageTextOf(u));
  if (!isTlcKind(card.kind)) return { finished: false, blocked: false, progressed: false, detail: `not a Learning Club card (${card.kind})` };
  try {
    return await runKind(env, card, now, search, check, pageText);
  } catch (err) {
    if (err instanceof SteerBlocked) return err.result;
    throw err;
  }
}

class SteerBlocked extends Error {
  constructor(public result: TlcRunResult) {
    super(result.detail);
  }
}

async function runKind(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>, pageText: (u: string) => Promise<string | null>): Promise<TlcRunResult> {
  switch (card.kind) {
    case "TLC_TOPICS":
      return runTopics(env, card, now, search, check);
    case "TLC_BOOKING_PACK":
      return runBookingPack(env, card, now, search, check);
    case "TLC_BRAND_BATCH":
      return runBrandBatch(env, card, now, search, check, pageText);
    case "TLC_TREND_STORY":
      return runTrendStory(env, card, now, search, check);
    case "TLC_SPONSOR_DECISION":
      return runDecision(env, card, now);
    default:
      return { finished: false, blocked: false, progressed: false, detail: `not a Learning Club card (${card.kind})` };
  }
}

async function finish(env: Env, cardId: string, finding: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'DONE', description = substr(COALESCE(description, '') || char(10) || char(10) || ?2, 1, 16000), next_action = NULL, lease_until = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
  ).bind(cardId, finding).run();
}

async function nothingGood(env: Env, card: SweepCard, employee: "Parker" | "Wynn", detail: string): Promise<TlcRunResult> {
  const why = await blockCard(env, card, { reason: "nothing_good_enough_to_send", trying: card.title, employee, detail });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

// ── Parker: topics, with the 3-day veto window ─────────────────────────────────────────────────

async function runTopics(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>): Promise<TlcRunResult> {
  // STAGE 2 — the veto window has run out (or the card was woken by a reply): read the partners' notes.
  const proposed = await eventsFrom(env, "SELECT * FROM tlc_event WHERE topic_card_id = ?1 AND status = 'TOPIC_PROPOSED' ORDER BY month", card.id);
  if (proposed.length) {
    const notes = (await env.WP_OS_DB.prepare("SELECT id, body FROM work_card_note WHERE work_card_id = ?1 AND acknowledged_at IS NULL").bind(card.id).all<{ id: string; body: string }>()).results ?? [];
    const vetoed = new Set<string>();
    for (const n of notes) for (const m of vetoedMonths(n.body, proposed.map((e) => ({ month: e.month, topic: e.topic ?? "" })))) vetoed.add(m);
    const heard = vetoed.size ? `Parker read this as a no to ${[...vetoed].map(monthWords).join(", ")} and picks again.` : "Parker read this as no veto; the picks proceed when the window closes.";
    if (notes.length) await env.WP_OS_DB.prepare("UPDATE work_card_note SET acknowledged_at = ?2, response = ?3 WHERE work_card_id = ?1 AND acknowledged_at IS NULL").bind(card.id, now.toISOString(), heard).run();
    const windowOver = proposed.every((e) => (e.veto_until ?? "") <= now.toISOString());
    for (const e of proposed.filter((x) => vetoed.has(x.month))) {
      await env.WP_OS_DB.prepare("UPDATE tlc_event SET status = 'PLANNING', topic = NULL, angle = NULL, veto_until = NULL, vetoed_topics_json = ?2, updated_at = ?3 WHERE id = ?1")
        .bind(e.id, JSON.stringify([...list<string>(e.vetoed_topics_json), e.topic]), now.toISOString()).run();
    }
    // A "no" sends those months straight back to the pick below; the rest keep their window.
    if (vetoed.size === 0 && !windowOver) {
      const until = proposed.map((e) => e.veto_until ?? now.toISOString()).sort().pop()!;
      return { finished: false, blocked: false, progressed: true, held: true, waitUntil: until, detail: `waiting out the ${TLC_VETO_DAYS}-day veto window (until ${until})` };
    }
    if (vetoed.size === 0) {
      for (const e of proposed) await env.WP_OS_DB.prepare("UPDATE tlc_event SET status = 'TOPIC_READY', veto_until = NULL, updated_at = ?2 WHERE id = ?1").bind(e.id, now.toISOString()).run();
      await finish(env, card.id, `• No partner said no within ${TLC_VETO_DAYS} days: ${proposed.map((e) => `${monthWords(e.month)} — ${e.topic}`).join("; ")} proceed. Wynn sells them from Monday.`);
      await appendEvent(env, { eventType: "tlc.topics_proceed", actorType: "ai_employee", actorId: PARKER, objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { months: proposed.map((e) => e.month) } });
      return { finished: true, blocked: false, progressed: false, detail: `${proposed.length} topic(s) proceed after the veto window` };
    }
  }

  // STAGE 1 — pick.
  const need = await monthsNeedingTopics(env, card.firm_scope);
  if (need.length === 0) {
    await finish(env, card.id, "• Every club in the next three months already has a topic.");
    return { finished: true, blocked: false, progressed: false, detail: "nothing to pick" };
  }
  const chosen: Record<string, string> = {};
  for (const e of need) { const c = chosenTopic(e); if (c) chosen[e.month] = c; }
  const needIds = new Set(need.map((e) => e.id));
  const used = ((await env.WP_OS_DB.prepare("SELECT id, topic, vetoed_topics_json FROM tlc_event WHERE firm_scope = ?1").bind(card.firm_scope).all<{ id: string; topic: string | null; vetoed_topics_json: string | null }>()).results ?? [])
    // A month's own chosen topic is kept, not excluded.
    .flatMap((r) => [needIds.has(r.id) && chosen[need.find((e) => e.id === r.id)!.month] ? null : r.topic, ...list<string>(r.vetoed_topics_json)])
    .filter((t): t is string => Boolean(t));
  const found = await search(env, actorFor(PARKER, card.firm_scope), buildTopicsPrompt(need.map((e) => e.month), used, chosen));
  if (!found.ok) return searchFailed(env, card, "Parker", found, now);
  const answer = jsonIn(found.text) ?? {};
  const picks = (answer.picks as Array<Record<string, unknown>> | undefined) ?? [];
  const kept: Array<{ ev: TlcEventRow; topic: string; pick: Record<string, unknown>; sources: Array<{ title: string; url: string }>; categories: Array<{ category: string; why: string; example_brands: string[] }> }> = [];
  const dropped: string[] = [];
  const taken = new Set(used.map((u) => u.toLowerCase()));
  for (const ev of need) {
    const pick = picks.find((p) => str(p.month) === ev.month);
    const topic = chosen[ev.month] ?? str(pick?.topic);
    if (!pick || !topic || taken.has(topic.toLowerCase())) { dropped.push(`${ev.month}: no usable pick`); continue; }
    const sources = ((pick.sources as Array<{ title?: string; url?: string }>) ?? []).map((s) => ({ title: str(s.title), url: str(s.url) })).filter((s) => isUrl(s.url));
    const live: typeof sources = [];
    for (const s of sources) if (await check(s.url)) live.push(s);
    const categories = ((pick.sponsor_categories as Array<{ category?: string; why?: string; example_brands?: string[] }>) ?? [])
      .map((c) => ({ category: str(c.category), why: str(c.why), example_brands: (c.example_brands ?? []).map(str).filter(Boolean) }))
      .filter((c) => c.category);
    if (live.length === 0) { dropped.push(`${ev.month} (${topic}): no source page answered`); continue; }
    if (categories.length < TLC_SPONSOR_CATEGORIES.min) { dropped.push(`${ev.month} (${topic}): ${categories.length} sponsor categories, ${TLC_SPONSOR_CATEGORIES.min} needed`); continue; }
    taken.add(topic.toLowerCase());
    kept.push({ ev, topic, pick, sources: live, categories: categories.slice(0, TLC_SPONSOR_CATEGORIES.max) });
  }
  const alternatives: TopicsEmailAlternative[] = [];
  for (const a of (answer.alternatives as Array<Record<string, unknown>> | undefined) ?? []) {
    const topic = str(a.topic);
    const reason = str(a.reason);
    const brands = (Array.isArray(a.brands) ? a.brands : []).map(str).filter(Boolean).slice(0, 3);
    if (!topic || !reason || brands.length === 0 || taken.has(topic.toLowerCase()) || alternatives.some((x) => x.topic.toLowerCase() === topic.toLowerCase())) continue;
    alternatives.push({ topic, reason: /[.!?]$/.test(reason) ? reason : `${reason}.`, brands });
  }
  /*
   * EVERY MONTH, OR NO EMAIL (owner, 22 Oct 2026: "only gave 2 picks Jan and Feb — what happened to 3 picks").
   * A partial set is never written or sent: the attempt fails, the card's record says which month fell out,
   * and the next attempt picks again. The same for fewer than nine alternatives.
   */
  if (kept.length < need.length || alternatives.length < TLC_ALTERNATIVES) {
    const short = [kept.length < need.length ? `${kept.length} of ${need.length} months had a usable pick (${dropped.join("; ")})` : "", alternatives.length < TLC_ALTERNATIVES ? `${alternatives.length} of ${TLC_ALTERNATIVES} alternatives were usable` : ""].filter(Boolean).join("; ");
    await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000) WHERE id = ?1")
      .bind(card.id, `• ${now.toISOString().slice(0, 16)}Z nothing sent: ${short}. Parker picks again.`).run();
    return { finished: false, blocked: false, progressed: false, detail: `nothing sent: ${short}` };
  }

  const until = vetoUntil(now);
  for (const k of kept) {
    const packet = {
      topic: k.topic, angle: str(k.pick.angle), why_now: str(k.pick.why_now), criteria: k.pick.criteria ?? null,
      hands_on: str(k.pick.hands_on), take_home: str(k.pick.take_home), teacher_profile: str(k.pick.teacher_profile),
      run_of_show: runOfShowLines(), sources: k.sources,
    };
    await env.WP_OS_DB.prepare(
      "UPDATE tlc_event SET topic = ?2, angle = ?3, packet_json = ?4, sponsor_categories_json = ?5, status = 'TOPIC_PROPOSED', veto_until = ?6, topic_card_id = ?7, swap_flagged_at = NULL, updated_at = ?8 WHERE id = ?1",
    ).bind(k.ev.id, packet.topic, packet.angle, JSON.stringify(packet), JSON.stringify(k.categories), until, card.id, now.toISOString()).run();
  }
  // THE GLOSSY ONE-SHEET PER PICK, as a brand would see it: linked, and attached so it opens from the inbox.
  const attachments: EmailAttachment[] = [];
  for (const k of kept) {
    const ev = (await eventsFrom(env, "SELECT * FROM tlc_event WHERE id = ?1", k.ev.id))[0]!;
    const html = await onePagerFor(env, ev);
    attachments.push({ filename: `TLC ${monthWords(ev.month)} - ${k.topic.replace(/[^\w &-]+/g, "").trim()}.html`, content: base64Utf8(html), contentType: "text/html" });
  }
  const email = topicsEmail({
    months: need.map((e) => e.month),
    picks: kept.map((k) => ({ month: k.ev.month, topic: k.topic, angle: str(k.pick.angle), categories: k.categories.map((c) => c.category), onePagerUrl: onePagerUrl(k.ev.id) })),
    alternatives: alternatives.slice(0, TLC_ALTERNATIVES),
    goAheadOn: until.slice(0, 10),
  });
  await emailBoth(env, { employee: "Parker", email, objectType: "work_card", objectId: card.id, cardId: card.id, cardKind: card.kind, firmScope: card.firm_scope, attachments });
  // The record keeps everything, including the alternatives; the partners' email carries only the picks and the list.
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000) WHERE id = ?1")
    .bind(card.id, [
      `• Proposed ${kept.map((k) => `${k.ev.month} ${k.topic}`).join("; ")}. Proceeds ${until} unless a partner says no.`,
      `• Alternatives: ${alternatives.slice(0, TLC_ALTERNATIVES).map((a) => a.topic).join("; ")}.`,
      dropped.length ? `• Parker's notes (not emailed): ${dropped.join("; ")}.` : "",
    ].filter(Boolean).join("\n")).run();
  // HELD UNTIL THE WINDOW CLOSES. A partner's reply lands on this card as a note and is read then.
  return { finished: false, blocked: false, progressed: true, held: true, waitUntil: until, detail: `proposed ${kept.length} topic(s) and ${TLC_ALTERNATIVES} alternatives; ${TLC_VETO_DAYS}-day veto window until ${until}` };
}

const onePagerUrl = (eventId: string): string => `https://os.joinwestpeek.com/api/tlc/events/${eventId}/onepager`;

function base64Utf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * A SEARCH THE MACHINE COULD NOT SERVE IS NOT AN ATTEMPT (22 Oct 2026). When every search lane was down —
 * a seat asleep, a CLI erroring, a vendor out — the employee did nothing wrong and the owner can do nothing
 * about it, so the card is HELD and tried again in half an hour, with no attempt spent and no STUCK email.
 * Only after a full day of a dead lane does it fall through to the ordinary failure, so a lane that never
 * comes back is still seen. Anything else (a refusal, a model that cannot search) is an ordinary attempt.
 */
export const TLC_SEARCH_RETRY_MINUTES = 30;
export const TLC_SEARCH_RETRY_MAX = 48;
async function searchFailed(env: Env, card: SweepCard, employee: "Parker" | "Wynn", found: { detail: string }, now: Date): Promise<TlcRunResult> {
  const reason = found.detail.replace(/^provider_failure:/, "");
  if (isProviderOutage(reason)) {
    const n = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE object_id = ?1 AND event_type = 'tlc.search_retry'").bind(card.id).first<{ n: number }>())?.n ?? 0;
    if (n < TLC_SEARCH_RETRY_MAX) {
      const until = new Date(now.getTime() + TLC_SEARCH_RETRY_MINUTES * 60_000).toISOString();
      await appendEvent(env, { eventType: "tlc.search_retry", actorType: "system", actorId: "work_sweep", objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: { retry: n + 1, reason: reason.slice(0, 240) } });
      return { finished: false, blocked: false, progressed: true, held: true, waitUntil: until, detail: `no search lane could serve this right now (${reason.slice(0, 120)}); ${employee} tries again at ${until.slice(11, 16)}Z — no attempt spent` };
    }
  }
  return { finished: false, blocked: false, progressed: false, detail: `the live search failed: ${found.detail}` };
}
const k0 = <T>(a: readonly T[]): T => a[0]!;

// ── Parker: the booking pack ────────────────────────────────────────────────────────────────────

function options(raw: unknown): BookingPack["hosts"] {
  return ((raw as Array<Record<string, unknown>>) ?? []).map((o) => ({ name: str(o.name), priceUsd: num(o.price_usd), bookBy: str(o.book_by), url: str(o.url), note: str(o.note) || undefined })).filter((o) => o.name && isUrl(o.url) && Number.isFinite(o.priceUsd));
}

async function runBookingPack(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>): Promise<TlcRunResult> {
  const month = /(\w+ \d{4})$/.exec(card.title)?.[1];
  const ev = (await eventsFrom(env, "SELECT * FROM tlc_event WHERE firm_scope = ?1", card.firm_scope)).find((e) => monthWords(e.month) === month);
  if (!ev?.topic) return nothingGood(env, card, "Parker", "The club this pack is for has no agreed topic any more. Drop this card; a new one opens when the topic is set.");
  const found = await search(env, actorFor(PARKER, card.firm_scope), buildBookingPackPrompt(ev));
  if (!found.ok) return searchFailed(env, card, "Parker", found, now);
  const raw = jsonIn(found.text) ?? {};
  const keepLive = async (xs: BookingPack["hosts"]): Promise<BookingPack["hosts"]> => {
    const out: BookingPack["hosts"] = [];
    for (const x of xs) if (await check(x.url)) out.push(x);
    return out;
  };
  const materialsRaw = ((raw.materials as Array<Record<string, unknown>>) ?? []).map((m) => ({ item: str(m.item), url: str(m.url), qty: num(m.qty), unitUsd: num(m.unit_usd) })).filter((m) => m.item && isUrl(m.url) && m.qty > 0 && m.unitUsd >= 0);
  const materials: BookingPack["materials"] = [];
  for (const m of materialsRaw) if (await check(m.url)) materials.push(m);
  const pack: BookingPack = {
    hosts: await keepLive(options(raw.hosts)),
    donatedVenueLeads: await keepLive(options(raw.donated_venue_leads)),
    paidVenues: await keepLive(options(raw.paid_venues)),
    teachers: await keepLive(options(raw.teachers)),
    food: await keepLive(options(raw.food)),
    photographers: await keepLive(options(raw.photographers)),
    materials,
  };
  const problems = bookingPackProblems(pack);
  if (pack.paidVenues.length === 0 || pack.food.length === 0 || pack.teachers.length === 0) {
    return nothingGood(env, card, "Parker", `The pack is missing whole sections (${problems.join("; ")}). Tell Parker where to look, or reply "send what you have".`);
  }
  const econ = await economicsFor(env, ev);
  const totals = bookingPackTotals(pack, econ.sponsorNetUsd + (ev.committed_costs_usd ?? 0));
  await env.WP_OS_DB.prepare("UPDATE tlc_event SET booking_pack_json = ?2, booking_pack_at = ?3, updated_at = ?3 WHERE id = ?1").bind(ev.id, JSON.stringify({ pack, totals, problems }), now.toISOString()).run();
  const line = (label: string, xs: BookingPack["hosts"]): { label: string; bullets: string[] } => ({
    label: label,
    bullets: xs.length ? xs.map((o) => `${o.name}: $${o.priceUsd.toLocaleString("en-US")}, book by ${o.bookBy || "?"} — ${o.url}${o.note ? ` (${o.note})` : ""}`) : ["none found"],
  });
  await emailBoth(env, {
    employee: "Parker",
    email: {
      what: `TLC booking pack, ${monthWords(ev.month)}`,
      tldr: `Options for you to book and pay; I have booked nothing. The cheapest full plan costs $${totals.costUsd.toLocaleString("en-US")} (cap $${TLC_COST_CAP_USD.toLocaleString("en-US")}) and nets $${totals.netUsd.toLocaleString("en-US")} against agreed sponsor cash of $${totals.sponsorCashUsd.toLocaleString("en-US")}.`,
      sections: [
        { label: "Totals", bullets: [...totals.lines.map((l) => `${l.what}: ${l.name}, $${l.priceUsd.toLocaleString("en-US")}`), `Cost $${totals.costUsd.toLocaleString("en-US")} (best case with a donated venue $${totals.bestCaseCostUsd.toLocaleString("en-US")}) — ${totals.underCap ? "inside" : "OVER"} the $${TLC_COST_CAP_USD.toLocaleString("en-US")} cap`, `Net vs $10,000 target: ${totals.vsTarget >= 0 ? "met" : `$${(-totals.vsTarget).toLocaleString("en-US")} short`}; vs $7,500 floor: ${totals.vsFloor >= 0 ? "met" : `$${(-totals.vsFloor).toLocaleString("en-US")} short`}`] },
        line("Donated-venue leads (ask first)", pack.donatedVenueLeads),
        line("Paid venues (4 hours)", pack.paidVenues),
        line("Hosts (4 hours)", pack.hosts),
        line("Teachers (paid for the session)", pack.teachers),
        line("Food: a real meal for 25–40", pack.food),
        line("Photographers", pack.photographers),
        { label: "Materials", bullets: pack.materials.map((m) => `${m.item}: ${m.qty} × $${m.unitUsd} — ${m.url}`) },
        ...(problems.length ? [{ label: "Still short", bullets: problems }] : []),
      ],
    },
    objectType: "tlc_event",
    objectId: ev.id,
    cardId: card.id,
    cardKind: card.kind,
    firmScope: card.firm_scope,
  });
  await finish(env, card.id, `• Booking pack sent to both partners: cost $${totals.costUsd}, net $${totals.netUsd}. Nothing booked.`);
  return { finished: true, blocked: false, progressed: false, detail: `booking pack for ${ev.month} emailed` };
}

// ── Wynn: the Monday brand batch ────────────────────────────────────────────────────────────────

async function runBrandBatch(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>, pageText: (u: string) => Promise<string | null>): Promise<TlcRunResult> {
  const events = await openEvents(env, now, card.firm_scope);
  if (events.length === 0) {
    await finish(env, card.id, "• No club is open for selling this week.");
    return { finished: true, blocked: false, progressed: false, detail: "no open club" };
  }
  const existing = ((await env.WP_OS_DB.prepare(`SELECT brand, event_id FROM tlc_deal WHERE event_id IN (${events.map(() => "?").join(",")})`).bind(...events.map((e) => e.id)).all<{ brand: string; event_id: string }>()).results ?? []);
  const found = await search(env, actorFor(WYNN, card.firm_scope), buildBrandBatchPrompt(events, existing.map((d) => d.brand)));
  if (!found.ok) return searchFailed(env, card, "Wynn", found, now);
  const brands = (jsonIn(found.text)?.brands as Array<Record<string, unknown>> | undefined) ?? [];
  const added: string[] = [];
  const dropped: string[] = [];
  for (const b of brands) {
    const ev = events.find((e) => e.month === str(b.month));
    const brand = str(b.brand);
    const email = str(b.contact_email).toLowerCase();
    const source = str(b.contact_source_url);
    if (!ev || !brand) continue;
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email) || !isUrl(source)) { dropped.push(`${brand}: no address on a page`); continue; }
    if (existing.some((d) => d.event_id === ev.id && d.brand.toLowerCase() === brand.toLowerCase())) continue;
    // THE ADDRESS IS READ OFF THE PAGE, not taken on the model's word.
    if (!(await check(source))) { dropped.push(`${brand}: the source page did not answer`); continue; }
    const text = (await pageText(source)) ?? "";
    if (!text.toLowerCase().includes(email)) { dropped.push(`${brand}: ${email} is not on ${source}`); continue; }
    const id = `tld_${crypto.randomUUID()}`;
    const res = await env.WP_OS_DB.prepare(
      "INSERT OR IGNORE INTO tlc_deal (id, event_id, brand, category, contact_name, contact_email, contact_source_url, why_fit, next_send_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
    ).bind(id, ev.id, brand, str(b.category) || null, str(b.contact_name) || null, email, source, str(b.why_fit) || null, nextDripAt(0, null, now, null), card.firm_scope).run();
    if ((res.meta?.changes ?? 0) > 0) added.push(`${brand} (${monthWords(ev.month)})`);
  }
  if (added.length === 0) return nothingGood(env, card, "Wynn", `No brand came with an address that is really on its page (${dropped.slice(0, 6).join("; ") || "nothing returned"}). Name brands or a category to try and Wynn runs it again.`);
  const gate = brandSendGate(await tlcSettings(env), env);
  await finish(env, card.id, [`• ${added.length} brand(s) queued for the four-email sequence: ${added.join("; ")}.`, gate.open ? "• Sending is on: each email waits for a partner's approval on Approvals." : `• NOTHING SENT: ${gate.reasons.join("; ")}. The emails are composed and held.`, dropped.length ? `• Left out: ${dropped.join("; ")}.` : ""].filter(Boolean).join("\n"));
  return { finished: true, blocked: false, progressed: false, detail: `${added.length} brand(s) queued` };
}

// ── Wynn: the trend story ───────────────────────────────────────────────────────────────────────

async function runTrendStory(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>): Promise<TlcRunResult> {
  const found = await search(env, actorFor(WYNN, card.firm_scope), buildTrendPrompt());
  if (!found.ok) return searchFailed(env, card, "Wynn", found, now);
  const raw = jsonIn(found.text) ?? {};
  const story = str(raw.story);
  const sources = ((raw.sources as Array<Record<string, unknown>>) ?? []).map((s) => ({ title: str(s.title), publisher: str(s.publisher) || null, url: str(s.url), published_on: str(s.published_on) || null, claim: str(s.claim) })).filter((s) => s.title && s.claim && isUrl(s.url));
  const live: typeof sources = [];
  const dead: string[] = [];
  for (const s of sources) ((await check(s.url)) ? live : dead).push(s as never);
  // A citation to a dead page is a claim we cannot show; three live ones is the least a story stands on.
  if (!story || live.length < 3 || dead.length > 0 && citesDead(story, sources, dead)) {
    return nothingGood(env, card, "Wynn", `The story did not stand on live sources (${live.length} live, ${dead.length} dead${story ? "" : ", no story"}). Point Wynn at sources, or reply "try again".`);
  }
  const quarter = quarterOf(now);
  const storyId = `tls_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare("INSERT INTO tlc_story (id, quarter, story, card_id) VALUES (?1, ?2, ?3, ?4)").bind(storyId, quarter, story, card.id).run();
  for (const s of live) {
    await env.WP_OS_DB.prepare("INSERT INTO tlc_source (id, story_id, title, publisher, url, published_on, claim, checked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
      .bind(`tsrc_${crypto.randomUUID()}`, storyId, s.title, s.publisher, s.url, s.published_on, s.claim, now.toISOString()).run();
  }
  await emailBoth(env, {
    employee: "Wynn",
    email: { what: `TLC trend story, ${quarter}`, tldr: `This quarter's story for the one-pagers, on ${live.length} live sources. Reply with any change.`, sections: [{ label: "The story", bullets: [story] }, { label: "Sources", bullets: live.map((s, i) => `[${i + 1}] ${s.title}${s.publisher ? `, ${s.publisher}` : ""} — ${s.url} — supports: ${s.claim}`) }] },
    objectType: "tlc_story",
    objectId: storyId,
    cardId: card.id,
    cardKind: card.kind,
    firmScope: card.firm_scope,
  });
  await finish(env, card.id, `• Trend story ${quarter} stored with ${live.length} live sources.`);
  return { finished: true, blocked: false, progressed: false, detail: `trend story ${quarter} written` };
}

/** True when the story cites, by number, a source whose page was dead. */
function citesDead(story: string, all: ReadonlyArray<{ url: string }>, dead: readonly unknown[]): boolean {
  const deadUrls = new Set((dead as Array<{ url: string }>).map((d) => d.url));
  return all.some((s, i) => deadUrls.has(s.url) && story.includes(`[${i + 1}]`));
}

// ── Wynn: the partners' decision on one brand ──────────────────────────────────────────────────

export async function openDecisionCard(env: Env, deal: TlcDealRow, now: Date): Promise<string> {
  const ev = await env.WP_OS_DB.prepare("SELECT month, topic FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<{ month: string; topic: string }>();
  const out = await openCard(env, {
    title: `Wynn: ${deal.brand} for the ${ev?.topic ?? "TLC"} club (${ev ? monthWords(ev.month) : ""}) — yes, no or counter?`,
    kind: "TLC_SPONSOR_DECISION",
    owner: WYNN,
    description: `Deal ${deal.id}. Both partners get one email; the first reply decides.`,
    nextAction: "Email both partners the offer, the recommendation and the net if we say yes; wait for yes, no or counter.",
    firmScope: deal.firm_scope,
  });
  await env.WP_OS_DB.prepare("UPDATE tlc_deal SET decision_card_id = ?2, updated_at = ?3 WHERE id = ?1").bind(deal.id, out.cardId, now.toISOString()).run();
  return out.cardId;
}

async function runDecision(env: Env, card: SweepCard, now: Date): Promise<TlcRunResult> {
  const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE decision_card_id = ?1").bind(card.id).first<TlcDealRow>();
  if (!deal) return nothingGood(env, card, "Wynn", "The deal this decision was for is gone. Drop the card.");
  const ev = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>())!;
  const row = await env.WP_OS_DB.prepare("SELECT block_answer, block_answered_by, blocked_at FROM work_card WHERE id = ?1").bind(card.id).first<{ block_answer: string | null; block_answered_by: string | null; blocked_at: string | null }>();
  const offer = { brand: deal.brand, topic: ev.topic ?? "", month: ev.month, cashUsd: deal.cash_offer_usd ?? 0, inKind: deal.in_kind_offer, inKindValueUsd: deal.in_kind_value_usd ?? 0, wants: deal.wants };

  if (row?.block_answer) {
    const d = parseDecisionReply(row.block_answer);
    if (d.kind === "UNCLEAR") {
      const why = await blockCard(env, card, { reason: "a_question_for_you", trying: card.title, employee: "Wynn", detail: `I could not read "${row.block_answer.slice(0, 120)}" as a decision. Reply "yes", "no" or "counter $X".` });
      return { finished: false, blocked: true, progressed: false, detail: why };
    }
    const by = row.block_answered_by ?? "a partner";
    if (d.kind === "YES") {
      const due = new Date(Math.min(Date.parse(`${ev.event_date}T00:00:00Z`) - 14 * 86_400_000, now.getTime() + 14 * 86_400_000)).toISOString().slice(0, 10);
      const agreement = sponsorshipAgreement({ brand: deal.brand, topic: ev.topic ?? "", eventDate: ev.event_date, cashUsd: offer.cashUsd, inKind: deal.in_kind_offer, deliverables: deal.wants, dueDate: due });
      const invoice = invoiceNote({ brand: deal.brand, topic: ev.topic ?? "", month: ev.month, cashUsd: offer.cashUsd, dueDate: due, paymentUrl: ev.sponsor_payment_url });
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'AGREED', decision = 'YES', decision_by = ?2, updated_at = ?3 WHERE id = ?1").bind(deal.id, by, now.toISOString()).run();
      await finish(env, card.id, `• ${by} said yes. Deal AGREED.\n\n${invoice}\n\n${agreement}`);
    } else if (d.kind === "NO") {
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'DECLINED', decision = 'NO', decision_by = ?2, stop_reason = COALESCE(stop_reason, 'DECLINED'), updated_at = ?3 WHERE id = ?1").bind(deal.id, by, now.toISOString()).run();
      await finish(env, card.id, `• ${by} said no. Deal DECLINED; Wynn thanks the brand when sending is on.`);
    } else {
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'CALL', decision = 'COUNTER', decision_by = ?2, counter_usd = ?3, updated_at = ?4 WHERE id = ?1").bind(deal.id, by, d.amountUsd, now.toISOString()).run();
      await finish(env, card.id, `• ${by} countered at $${d.amountUsd.toLocaleString("en-US")}. Deal back to CALL to take the counter to the brand.`);
    }
    await appendEvent(env, { eventType: "tlc.decision", actorType: "firm_user", actorId: by, objectType: "tlc_deal", objectId: deal.id, firmScope: deal.firm_scope, payload: { decision: d.kind } });
    return { finished: true, blocked: false, progressed: false, detail: `decision: ${d.kind}` };
  }

  // First pass: one email to each partner, then wait for the reply (which answers this card's block).
  const econ = await economicsFor(env, ev);
  const mail = decisionEmail(offer, econ);
  await emailBoth(env, { employee: "Wynn", email: mail, objectType: "work_card", objectId: card.id, cardId: card.id, cardKind: card.kind, firmScope: card.firm_scope });
  const why = await blockCard(env, card, { reason: "a_question_for_you", trying: card.title, employee: "Wynn", detail: `${mail.tldr} Reply "yes", "no" or "counter $X".` });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

// ── Routes (partners) ───────────────────────────────────────────────────────────────────────────

async function requireManage(ctx: RouteContext): Promise<Actor | Response> {
  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "sponsor.manage", { objectType: "sponsor_prospect", firmScope: "west-peek" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });
  return actor;
}

/** GET /api/tlc — every club, its money, its deals, and the send gate (with its reasons). */
export async function handleTlcOverview(ctx: RouteContext): Promise<Response> {
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const now = new Date();
  const events = await eventsFrom(ctx.env, "SELECT * FROM tlc_event ORDER BY month");
  const out = [];
  for (const ev of events) {
    const econ = await economicsFor(ctx.env, ev);
    out.push({ ...ev, days_out: daysUntil(ev.event_date, now), economics: econ, tickets: ticketVerdict(econ.paidTickets), deals: await dealsFor(ctx.env, ev.id) });
  }
  const settings = await tlcSettings(ctx.env);
  const held = (await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE state = 'HELD'").first<{ n: number }>())?.n ?? 0;
  return json({ events: out, send_gate: brandSendGate(settings, ctx.env), settings, held_emails: held });
}

const settingSchema = z.object({ what: z.enum(["onepager_mock", "playbook", "brand_send_on", "brand_send_off"]) });

/**
 * POST /api/tlc/approve — the owner's approvals and the switch. HUMAN only. Turning sending on is
 * refused until both approvals are on record.
 */
export async function handleTlcApprove(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "only a partner approves" }, { status: 403 });
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = settingSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const now = new Date().toISOString();
  const set = (key: string, value: string) =>
    ctx.env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by, set_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at")
      .bind(key, value, ctx.identity!.id, now).run();
  const w = parsed.data.what;
  if (w === "onepager_mock") await set(ONEPAGER_APPROVAL_SETTING, now);
  if (w === "playbook") await set(PLAYBOOK_APPROVAL_SETTING, now);
  if (w === "brand_send_off") await set(BRAND_SEND_SETTING, "off");
  if (w === "brand_send_on") {
    const s = await tlcSettings(ctx.env);
    if (!s[ONEPAGER_APPROVAL_SETTING] || !s[PLAYBOOK_APPROVAL_SETTING]) {
      return json({ error: "not_approved", detail: "approve the one-pager mock and the playbook first" }, { status: 409 });
    }
    await set(BRAND_SEND_SETTING, "on");
  }
  await appendEvent(ctx.env, { eventType: "tlc.setting", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "tlc_setting", objectId: w, payload: { what: w } });
  return json({ ok: true, send_gate: brandSendGate(await tlcSettings(ctx.env), ctx.env) });
}

const dealPatch = z.object({
  stage: z.enum(["PROSPECT", "PITCHED", "CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED", "DECLINED", "STOPPED"]).optional(),
  cash_offer_usd: z.number().min(0).max(1_000_000).optional(),
  in_kind_offer: z.string().max(500).nullish(),
  in_kind_value_usd: z.number().min(0).max(1_000_000).optional(),
  wants: z.string().max(1000).nullish(),
});

/** POST /api/tlc/deals/:id — record the offer after a call; WAITING_ON_OWNERS opens the decision. */
export async function handleTlcDeal(ctx: RouteContext): Promise<Response> {
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = dealPatch.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const deal = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(ctx.params.id).first<TlcDealRow>();
  if (!deal) return json({ error: "not_found" }, { status: 404 });
  const p = parsed.data;
  if (p.stage) {
    const problem = stageMoveProblem(deal.stage, p.stage);
    if (problem) return json({ error: "bad_stage", detail: problem }, { status: 409 });
    if (p.stage === "WAITING_ON_OWNERS" && !(p.cash_offer_usd ?? deal.cash_offer_usd) && !(p.in_kind_offer ?? deal.in_kind_offer)) {
      return json({ error: "no_offer", detail: "record what they offer before asking the partners" }, { status: 409 });
    }
  }
  const now = new Date();
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE tlc_deal SET stage = COALESCE(?2, stage), cash_offer_usd = COALESCE(?3, cash_offer_usd), in_kind_offer = COALESCE(?4, in_kind_offer),
       in_kind_value_usd = COALESCE(?5, in_kind_value_usd), wants = COALESCE(?6, wants), next_send_at = CASE WHEN ?2 IS NOT NULL AND ?2 NOT IN ('PROSPECT','PITCHED') THEN NULL ELSE next_send_at END, updated_at = ?7 WHERE id = ?1`,
  ).bind(deal.id, p.stage ?? null, p.cash_offer_usd ?? null, p.in_kind_offer ?? null, p.in_kind_value_usd ?? null, p.wants ?? null, now.toISOString()).run();
  let decisionCard: string | null = null;
  if (p.stage === "WAITING_ON_OWNERS") decisionCard = await openDecisionCard(ctx.env, (await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(deal.id).first<TlcDealRow>())!, now);
  return json({ ok: true, decision_card_id: decisionCard });
}

const ticketSchema = z.object({
  buyer_email: z.string().email().max(200),
  buyer_name: z.string().max(160).nullish(),
  amount_usd: z.number(),
  fee_usd: z.number().min(0).max(10).nullish(),
  payment_ref: z.string().min(3).max(200),
  source: z.string().min(2).max(60),
  paid_at: z.string().max(40).optional(),
});

/**
 * POST /api/tlc/events/:id/tickets — record a PAID ticket from West Peek's payment tool (money in).
 * Refused past 40 seats, above $10, or as a free seat; idempotent on the payment reference.
 */
export async function handleTlcTicket(ctx: RouteContext): Promise<Response> {
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = ticketSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });
  const t = parsed.data;
  const priceProblem = ticketPriceProblem(t.amount_usd);
  if (priceProblem) return json({ error: "bad_price", detail: priceProblem }, { status: 409 });
  const ev = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(ctx.params.id).first<TlcEventRow>();
  if (!ev) return json({ error: "not_found" }, { status: 404 });
  const paid = (await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_ticket WHERE event_id = ?1 AND refunded_at IS NULL").bind(ev.id).first<{ n: number }>())?.n ?? 0;
  if (ticketVerdict(paid).verdict === "FULL") return json({ error: "full", detail: `all ${TLC_SEATS.max} seats are sold` }, { status: 409 });
  await ctx.env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_ticket (id, event_id, buyer_name, buyer_email, amount_usd, fee_usd, payment_ref, source, paid_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  ).bind(`tlt_${crypto.randomUUID()}`, ev.id, t.buyer_name ?? null, t.buyer_email.toLowerCase(), t.amount_usd, t.fee_usd ?? null, t.payment_ref, t.source, t.paid_at ?? new Date().toISOString(), ev.firm_scope).run();
  return json({ ok: true, ...ticketVerdict(paid + 1) });
}

/** GET /api/tlc/events/:id/onepager — the glossy one-pager, built from the packet and the stored story. */
export async function handleTlcOnePager(ctx: RouteContext): Promise<Response> {
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const ev = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(ctx.params.id).first<TlcEventRow>();
  if (!ev?.topic) return json({ error: "not_found", detail: "no club with a topic by that id" }, { status: 404 });
  return new Response(await onePagerFor(ctx.env, ev), { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function onePagerFor(env: Env, ev: TlcEventRow): Promise<string> {
  const story = await env.WP_OS_DB.prepare("SELECT id, story FROM tlc_story ORDER BY created_at DESC LIMIT 1").first<{ id: string; story: string }>();
  const citations: Citation[] = story
    ? ((await env.WP_OS_DB.prepare("SELECT title, publisher, url, claim FROM tlc_source WHERE story_id = ?1").bind(story.id).all<Citation>()).results ?? [])
    : [];
  const packet = (() => { try { return JSON.parse(ev.packet_json ?? "{}") as { why_now?: string }; } catch { return {}; } })();
  return renderOnePager({
    topic: ev.topic ?? "",
    angle: ev.angle,
    month: ev.month,
    eventDate: ev.event_date,
    whyNow: packet.why_now ?? null,
    categories: list<{ category: string }>(ev.sponsor_categories_json).map((c) => c.category),
    story: story?.story ?? null,
    citations,
    proof: TLC_PRE_LAUNCH_PROOF,
    recap: ev.recap,
  });
}
