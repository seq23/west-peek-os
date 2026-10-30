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
import { APPROVED_SEND_ENV_KEY, type ApprovedSendMarker, type EmailAttachment } from "../effects/emailTransport";
import { renderHtmlPdf, type PdfRenderer } from "../effects/htmlPdf";
import { renderedPdfProblem } from "../../shared/pdf/renderedPdf";
import { renderBrandPitch, renderInternalOnePager, type TlcClubView, type TlcInternalView } from "../../shared/tlc/pitch";
import { INTAKE_MAILBOX } from "../../shared/intake/emailTriggers";
import { TLC_BRAND_SALES_JOB } from "../../shared/policy/outsideEmail";
import { outsideEmailAllowed } from "./outsideEmail";
import { addressReadOffPage, approvedDayZeroFor, handleMustPitch, liveMustPitch, ownerContactedBrands, mustPitchToSearch, queueDeal, type MustPitchFinding } from "./tlcMustPitch";
import { brandKey } from "../../shared/tlc/mustPitch";
import { TLC_BENCH_LOW, TLC_NEW_BRANDS_PER_EVENT_WEEK } from "../../shared/tlc/volume";
import type { ExecEmailInput } from "../../shared/email/execEmail";
import {
  BOOKING_PACK_SHAPE,
  BRAND_SEND_SETTING,
  PITCH_APPROVAL_HASH_SETTING,
  PLAYBOOK_APPROVAL_HASH_SETTING,
  TLC_DECIDER_IDS,
  TLC_OWNER,
  TLC_RECIPIENTS,
  TLC_SIGNATURE,
  TLC_SPONSOR_CASH_TARGET_USD,
  TLC_TIERS,
  approvalState,
  brandDisplayName,
  competingCategories,
  creditForQuote,
  goalOf,
  isTlcTier,
  paceCheck,
  seatsOf,
  seatsWords,
  titleConflict,
  ideaEligibility,
  TLC_SPONSOR_GOAL_USD,
  aiRuleProblems,
  frontierConflict,
  isAiTopic,
  doNotRun,
  switchVerdict,
  TLC_SWITCH_MIN_CASH_YES,
  isBettingCategory,
  sponsorMixProblems,
  TLC_NO_BETTING_THROUGH,
  type TlcBackup,
  replyLooksLikeNo,
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
  BRAND_ROOM_WORDS,
  TLC_SPONSOR_CATEGORIES,
  TLC_TICKET_PRICE_USD,
  PLAYBOOK_DOCUMENT_SETTING,
  TLC_ALTERNATIVES,
  TLC_IDEA_ORIGIN_LABEL,
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
  approvedDayZeroEmail,
  eventEconomics,
  goAheadCheck,
  invoiceNote,
  isTlcKind,
  monthWords,
  needsSwap,
  nextDripAt,
  TLC_BRANDS_PER_CLUB,
  TLC_BRANDS_PER_SEARCH,
  parseDecisionReply,
  quarterOf,
  rollingTopicMonths,
  runOfShowLines,
  sponsorshipAgreement,
  stageMoveProblem,
  isIdeaOrigin,
  sameTopic,
  topicName,
  topicKey,
  topicsEmail,
  type TlcIdeaOrigin,
  type TlcIdeaStatus,
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
 *   tlc_drip         (every 30 minutes)  → the drip alone, plus the first batch for a club with no brand.
 *
 * WHAT NEVER HAPPENS HERE: a booking, a purchase, a payment out. A brand email that has not passed
 * `brandSendGate` AND an approved `effect.email.send` receipt. A sponsor name or amount written
 * anywhere but these tables.
 */

/**
 * WHERE A BRAND'S REPLY GOES: to Sequoia, who signs every brand email, and to the intake mailbox so
 * the OS still sees it and stops the sequence (a reply that only reached her inbox would let the
 * next email go). The send path cannot send AS her for an employee-filed email (employee mail never
 * uses westpeek.ventures; see shared/registry/employeeMail.ts), so Reply-To carries her instead.
 */
export const BRAND_REPLY_TO: readonly string[] = [TLC_OWNER.email, INTAKE_MAILBOX];

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
  pitch_token?: string | null;
  seats_min?: number | null;
  seats_max?: number | null;
  sponsor_goal_usd?: number | null;
  backup_json?: string | null;
  switch_deadline?: string | null;
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
  tier?: string | null;
  yes_at?: string | null;
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
  // A product partner's value is cost relief, never cash toward the goal (owner, 22 Oct 2026).
  const cash = deals.filter((d) => ["AGREED", "PAID", "DELIVERED"].includes(d.stage) && d.tier !== "PRODUCT").reduce((s, d) => s + (d.cash_offer_usd ?? 0), 0);
  const inKind = deals.filter((d) => ["AGREED", "PAID", "DELIVERED"].includes(d.stage)).reduce((s, d) => s + (d.in_kind_value_usd ?? 0), 0);
  const tickets = (await env.WP_OS_DB.prepare("SELECT amount_usd, fee_usd FROM tlc_ticket WHERE event_id = ?1 AND refunded_at IS NULL").bind(ev.id).all<{ amount_usd: number; fee_usd: number | null }>()).results ?? [];
  return eventEconomics({ sponsorCashUsd: cash, committedCostsUsd: ev.committed_costs_usd ?? 0, tickets, inKindValueUsd: inKind, costBudgetUsd: goalOf(ev).costBudgetUsd });
}

/** The month as it would be if its backup took over (for the backup's own documents). */
export function backupRow(ev: TlcEventRow, b: TlcBackup): TlcEventRow {
  return { ...ev, topic: b.topic, angle: b.angle, packet_json: JSON.stringify(b.packet), sponsor_categories_json: JSON.stringify(b.categories), seats_min: b.seats_min ?? ev.seats_min, seats_max: b.seats_max ?? ev.seats_max, backup_json: null };
}

/** The backup club stored on a month, or null. */
export function backupOf(ev: Pick<TlcEventRow, "backup_json">): TlcBackup | null {
  if (!ev.backup_json) return null;
  try { return JSON.parse(ev.backup_json) as TlcBackup; } catch { return null; }
}

/**
 * THE ONE SWITCH (owner, 22 Oct 2026), for every month. Returns what it did, or null when nothing
 * was due. Counts cash yeses (any tier but Product) and whether a Title partner said yes.
 */
export async function applyBackupSwitch(env: Env, ev: TlcEventRow, now: Date, firmScope = "west-peek"): Promise<"SWITCHED" | "KEPT" | null> {
  const backup = backupOf(ev);
  const yes = (await dealsFor(env, ev.id)).filter((d) => !["DECLINED", "STOPPED"].includes(d.stage) && (d.yes_at || ["CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"].includes(d.stage)));
  const said = { cashYes: yes.filter((d) => d.tier !== "PRODUCT").length, titleYes: yes.some((d) => d.tier === "TITLE") };
  const verdict = switchVerdict(backup, ev.switch_deadline ?? null, now, said);
  if (!backup || verdict === "NO_BACKUP" || verdict === "NOT_DUE" || verdict === "DONE") return null;
  if (verdict === "KEEP") {
    await env.WP_OS_DB.prepare("UPDATE tlc_event SET backup_json = ?2, updated_at = ?3 WHERE id = ?1").bind(ev.id, JSON.stringify({ ...backup, kept_at: now.toISOString(), said }), now.toISOString()).run();
    return "KEPT";
  }
  const was = ev.topic ?? "";
  await env.WP_OS_DB.prepare(
    "UPDATE tlc_event SET topic = ?2, angle = ?3, packet_json = ?4, sponsor_categories_json = ?5, seats_min = COALESCE(?6, seats_min), seats_max = COALESCE(?7, seats_max), backup_json = ?8, updated_at = ?9 WHERE id = ?1",
  ).bind(ev.id, backup.topic, backup.angle, JSON.stringify(backup.packet), JSON.stringify(backup.categories), backup.seats_min ?? null, backup.seats_max ?? null, JSON.stringify({ ...backup, applied_at: now.toISOString(), switched_from: was, said }), now.toISOString()).run();
  await env.WP_OS_DB.prepare("UPDATE tlc_idea SET status = 'ALTERNATIVE', status_month = NULL, updated_at = ?2 WHERE topic_key = ?1 AND status = 'PICKED'").bind(topicKey(was), now.toISOString()).run();
  await upsertIdea(env, { topic: backup.topic, origin: "BRANDS_SPENDING", suggestedBy: "Backup topic", suggestedAt: now.toISOString(), status: "PICKED", month: ev.month, firmScope });
  const deadline = (ev.switch_deadline ?? "").slice(0, 10);
  await emailOwner(env, {
    employee: "Wynn",
    email: {
      what: `TLC ${monthWords(ev.month)}: switched to the backup`,
      tldr: `${monthWords(ev.month)} switched from ${was} to ${backup.topic}: by ${deadline}, ${said.cashYes} cash sponsor${said.cashYes === 1 ? "" : "s"} had said yes and no Title partner; it needed ${TLC_SWITCH_MIN_CASH_YES} or a Title partner.`,
      sections: [
        { label: "What switched", bullets: [`From: ${was}`, `To: ${backup.topic}`, `Same date: ${ev.event_date}`] },
        { label: "Why", bullets: [`Your rule: fewer than ${TLC_SWITCH_MIN_CASH_YES} cash sponsors and no Title partner by the deadline (${deadline}) switches the month to its backup.`, `Cash yeses by then: ${said.cashYes}. Title partner: none.`] },
        { label: "What happens next", bullets: ["Wynn starts on the backup slate this week. Its brand pitch needs your approval before any brand sees it."] },
      ],
    },
    objectType: "tlc_event",
    objectId: ev.id,
    cardId: null,
    cardKind: null,
    firmScope,
  });
  return "SWITCHED";
}

// ── Email to the owner (Sequoia only: TLC_RECIPIENTS) ──────────────────────────────────────────

/**
 * Every TLC email to a partner leaves through here, to `TLC_RECIPIENTS` (Sequoia, owner's ruling
 * 22 Oct 2026) and nobody else; the partner-mail door enforces the same list again.
 */
export async function emailOwner(
  env: Env,
  input: { employee: "Parker" | "Wynn"; email: Omit<ExecEmailInput, "employee">; objectType: string; objectId: string; cardId: string | null; cardKind: string | null; firmScope: string; attachments?: readonly EmailAttachment[]; replyOnThread?: string | null },
): Promise<string[]> {
  const sent: string[] = [];
  for (const address of TLC_RECIPIENTS) {
    const out = await sendOrPreview(env, {
      to: address,
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
      ...(input.replyOnThread ? { replyOnThread: input.replyOnThread } : {}),
    });
    if (out.sent || out.previewed) sent.push(address);
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
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO tlc_event (id, month, event_date, firm_scope, pitch_token) VALUES (?1, ?2, ?3, ?4, lower(hex(randomblob(16))))")
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
      "THE LEARNING CLUB (TLC). Parker CHOOSES the topic for each month below, writes the Rooms packet for it, names 5–10 sponsor categories, and emails Sequoia.",
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

// ── The drip pass, every half hour ──────────────────────────────────────────────────────────────

/**
 * THE DRIP DOES NOT WAIT FOR TOMORROW (owner, 24 Oct 2026: "get them going now today"). Before this the
 * brand emails moved only on the 13:30 UTC daily pass, so a brand queued on Monday got its draft the next
 * day and an email she approved waited up to a day more; and a club ready to sell waited for the next
 * Monday before Wynn looked for a single brand. Every 30 minutes now:
 *   1 · a club that is open for selling and has NO brand at all gets this week's batch card at once
 *       (the first batch never waits for Monday; the Monday batch still adds new brands weekly);
 *   2 · the drip runs: approved emails go, due ones are drafted for her approval, and she is emailed the list.
 */
export async function runDripPass(env: Env, now: Date, firmScope = "west-peek"): Promise<{ batch: string | null; drip: DripResult; notice: string; prospects: import("./tlcVolume").PromoteResult }> {
  const open = await openEvents(env, now, firmScope);
  let batch: string | null = null;
  if (open.length > 0) {
    const deals = await env.WP_OS_DB.prepare(`SELECT COUNT(*) AS n FROM tlc_deal WHERE event_id IN (${open.map(() => "?").join(",")})`).bind(...open.map((e) => e.id)).first<{ n: number }>();
    const batchOpen = await env.WP_OS_DB.prepare("SELECT 1 FROM work_card WHERE kind = 'TLC_BRAND_BATCH' AND firm_scope = ?1 AND state NOT IN ('DONE','CANCELLED') LIMIT 1").bind(firmScope).first();
    if ((deals?.n ?? 0) === 0 && !batchOpen) batch = (await openBrandBatchCard(env, now, firmScope)).detail;
  }
  const { recomposeBrandNames, recomposeGuestCounts, recomposeSecondEmails, repairLeakedDrafts, sendDraftNotice } = await import("./tlcDraftNotice");
  // Before the drip, so an approved draft waiting for its allowance goes with the brand's clean name.
  await recomposeBrandNames(env, firmScope);
  // And a queued email 2 offers the three samples, never a call (owner, 26 Oct 2026).
  await recomposeSecondEmails(env, firmScope);
  // And every queued draft tells the brand 25 to 100+ guests per event, flexible (owner, 30 Oct 2026).
  await recomposeGuestCounts(env, firmScope);
  // Samples planned ahead of time are rendered, so the PDF is ready the moment the brand says yes (sends nothing).
  const { renderPlannedSamples } = await import("./tlcSamples");
  await renderPlannedSamples(env, firmScope).catch(() => []);
  // WYNN'S TEN A WEEK (owner, 26 Oct 2026): up to 10 new brands per open club from Parker's list, nearest club
  // first, none for a club that reached its goal. They join the drip here and are drafted on this same pass.
  const { promoteProspects } = await import("./tlcVolume");
  const prospects = await promoteProspects(env, now, firmScope);
  const drip = await runDrip(env, now, firmScope);
  const repaired = await repairLeakedDrafts(env, now, firmScope);
  const notice = await sendDraftNotice(env, now, firmScope);
  return { batch, drip, prospects, notice: repaired.startsWith("no draft") ? notice : `${notice}; ${repaired}` };
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
      // PRIMARY OR BACKUP: on the month's switch deadline, too few yeses hand the month to its backup, and Sequoia is told.
      if (hasTopic) {
        const r = await applyBackupSwitch(env, ev, now, firmScope);
        if (r) out.goChecks.push({ month: ev.month, checkpoint: 0, verdict: r });
      }
      // 21 AND 14 DAYS OUT: go, or escalate to Sequoia.
      if (hasTopic) {
        // PACE (60 and 42 days out): behind pace, Sequoia is told; nothing else moves.
        const econNow = await economicsFor(env, ev);
        const pace = paceCheck(days, econNow.sponsorNetUsd + (ev.committed_costs_usd ?? 0), goalOf(ev).goalUsd);
        const paceDone = list<{ checkpoint: number }>(ev.go_checks_json);
        if (pace && !paceDone.some((d) => d.checkpoint === pace.checkpoint)) {
          await env.WP_OS_DB.prepare("UPDATE tlc_event SET go_checks_json = ?2, updated_at = ?3 WHERE id = ?1")
            .bind(ev.id, JSON.stringify([...paceDone, { checkpoint: pace.checkpoint, verdict: pace.behind ? "BEHIND_PACE" : "ON_PACE", at: now.toISOString() }]), now.toISOString()).run();
          ev.go_checks_json = JSON.stringify([...paceDone, { checkpoint: pace.checkpoint }]);
          if (pace.behind) {
            const committed = econNow.sponsorNetUsd + (ev.committed_costs_usd ?? 0);
            await emailOwner(env, {
              employee: "Wynn",
              email: {
                what: `TLC ${monthWords(ev.month)}: behind pace, ${pace.checkpoint} days out`,
                tldr: `The ${ev.topic} club has $${committed.toLocaleString("en-US")} agreed ${pace.checkpoint} days out; the pace is $${pace.neededUsd.toLocaleString("en-US")} of the $${goalOf(ev).goalUsd.toLocaleString("en-US")} goal.`,
                sections: [
                  { label: "Where it stands", bullets: [`Agreed sponsor cash: $${committed.toLocaleString("en-US")}`, `Pace for today: $${pace.neededUsd.toLocaleString("en-US")}`, `Goal: $${goalOf(ev).goalUsd.toLocaleString("en-US")}; the go-checks come at 21 and 14 days out`] },
                  { label: "What I am doing", bullets: ["Taking the next brands in the queue to a call this week.", "Nothing is needed from you unless you want to add a sponsor yourself."] },
                ],
              },
              objectType: "tlc_event",
              objectId: ev.id,
              cardId: null,
              cardKind: null,
              firmScope,
            });
          }
          out.goChecks.push({ month: ev.month, checkpoint: pace.checkpoint, verdict: pace.behind ? "BEHIND_PACE" : "ON_PACE" });
        }
        const check = goAheadCheck({ daysOut: days, economics: econNow, seats: seatsOf(ev), costBudgetUsd: goalOf(ev).costBudgetUsd });
        const done = list<{ checkpoint: number }>(ev.go_checks_json);
        if (check.checkpoint !== null && !done.some((d) => d.checkpoint === check.checkpoint)) {
          const econ = await economicsFor(env, ev);
          await env.WP_OS_DB.prepare("UPDATE tlc_event SET status = ?2, go_checks_json = ?3, updated_at = ?4 WHERE id = ?1")
            .bind(ev.id, check.verdict === "GO" ? "GO" : "ESCALATED", JSON.stringify([...done, { checkpoint: check.checkpoint, verdict: check.verdict, at: now.toISOString(), reasons: check.reasons }]), now.toISOString())
            .run();
          await emailOwner(env, {
            employee: "Wynn",
            email: {
              what: `TLC ${monthWords(ev.month)}: ${check.verdict === "GO" ? "go-ahead" : "short of the go-ahead"}, ${check.checkpoint} days out`,
              tldr:
                check.verdict === "GO"
                  ? `The ${ev.topic} club clears the go-ahead ${check.checkpoint} days out: ${econ.paidTickets} paid tickets, sponsor net $${econ.sponsorNetUsd.toLocaleString("en-US")}.`
                  : `The ${ev.topic} club is short ${check.checkpoint} days out. ${check.reasons.join(" ")}`,
              tldrBullets: check.verdict === "GO" ? undefined : ['Reply "add sponsor", "cut cost" or "move date"'],
              sections: [
                { label: "Where it stands", bullets: [`Paid tickets: ${econ.paidTickets} of ${seatsOf(ev).max} (${seatsOf(ev).min} needed two weeks out)`, `Sponsor net: $${econ.sponsorNetUsd.toLocaleString("en-US")} (floor $${TLC_NET_FLOOR_USD.toLocaleString("en-US")}, target $${TLC_NET_TARGET_USD.toLocaleString("en-US")})`, `Net with tickets after fees: $${econ.netUsd.toLocaleString("en-US")}`, `Booked costs: $${(ev.committed_costs_usd ?? 0).toLocaleString("en-US")} (cap $${TLC_COST_CAP_USD.toLocaleString("en-US")})`] },
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
  /** The approval cards this pass opened (brand, club, card id) — the list she is emailed. */
  newDrafts: Array<{ brand: string; month: string; step: number; cardId: string }>;
  /** Brands whose approved email went on this pass. */
  sentBrands: string[];
  /** Approved emails over today's warm-up allowance: they go on the next pass with room. */
  waitingForAllowance: number;
  /** First pitches held because another brand in the same category for the same club is live (owner, 26 Oct 2026). */
  heldForCategory?: string[];
  /** What Wynn did with brand replies this pass (tlcBrandReply), in words. */
  replies?: string;
  /** Clubs whose agreed sponsor cash reached the goal: no first pitch and no follow-up went for them (26 Oct 2026). */
  goalStopped?: string[];
  /** Brands whose address failed NeverBounce (or bounced before): never written to. */
  addressRefused?: string[];
  /** First emails waiting because NeverBounce could not be asked yet; the next pass asks again. */
  addressWaiting?: number;
}
const emptyDrip = (): DripResult => ({ due: 0, held: 0, awaitingApproval: 0, sent: 0, gate: { open: false, reasons: [] }, newDrafts: [], sentBrands: [], waitingForAllowance: 0 });

/** Where she approves each brand email. */
export const TLC_APPROVALS_URL = "https://os.joinwestpeek.com/#/approvals";

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
/**
 * FILE ONE DRAFT FOR HER APPROVAL: an `email.send` request from Wynn and its approval card, with the draft
 * stored against the deal's current step. Used by the drip and by a "change N: …" redraft. Returns the card id.
 * The draft joins the next batched notice email (notice_ref is cleared).
 */
/** The brand-send gate's answer, for a path outside the drip that files a draft (a "change N: …" redraft). */
export async function brandGateFor(env: Env): Promise<{ open: boolean; reasons: string[] }> {
  return brandSendGate(await tlcSettings(env), await tlcOutside(env), await contentHashes(env));
}

export async function fileDraft(env: Env, deal: Pick<TlcDealRow, "id" | "brand" | "contact_email" | "drip_step">, mail: { subject: string; text: string }, firmScope = "west-peek", redraftNote: string | null = null): Promise<string> {
  const wynn = actorFor(WYNN, firmScope);
  let threading: { gmail_thread_id: string; in_reply_to: string } | undefined;
  if (deal.drip_step > 0) {
    // A deal is the sequence boundary. Match the actual destination too: a changed contact must
    // never inherit another person's conversation. Old sends have no metadata and still go out.
    const previous = await env.WP_OS_DB.prepare(
      `SELECT r.gmail_thread_id, r.rfc_message_id,
              (SELECT subject FROM tlc_drip_message WHERE deal_id = m.deal_id AND step = 0 AND state = 'SENT') AS original_subject
         FROM tlc_drip_message m
         JOIN tlc_deal d ON d.id = m.deal_id
         LEFT JOIN external_effect_request r ON r.id = m.effect_request_id
        WHERE m.deal_id = ?1 AND m.step < ?2 AND m.state = 'SENT' AND d.firm_scope = ?3
          AND (r.id IS NULL OR lower(trim(r.destination)) = lower(trim(?4)))
        ORDER BY m.step DESC LIMIT 1`,
    ).bind(deal.id, deal.drip_step, firmScope, deal.contact_email).first<{ gmail_thread_id: string | null; rfc_message_id: string | null; original_subject: string | null }>();
    if (previous?.gmail_thread_id && previous.rfc_message_id && previous.original_subject) {
      threading = { gmail_thread_id: previous.gmail_thread_id, in_reply_to: previous.rfc_message_id.replace(/^<|>$/g, "") };
      mail = { ...mail, subject: `Re: ${previous.original_subject.replace(/^(?:Re:\s*)+/i, "")}` };
    } else {
      await appendEvent(env, {
        eventType: "tlc.drip_thread_fallback", actorType: "ai_employee", actorId: WYNN,
        objectType: "tlc_deal", objectId: deal.id, firmScope,
        payload: { step: deal.drip_step, reason: "previous_send_missing_thread_metadata" },
      });
    }
  }
  const requestId = `eer_${crypto.randomUUID()}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id, outside_job) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4, ?5)",
  ).bind(requestId, deal.contact_email, JSON.stringify({ subject: mail.subject, text: mail.text, reply_to: BRAND_REPLY_TO, ...threading }), WYNN, TLC_BRAND_SALES_JOB).run();
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
    `INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, effect_request_id, approval_card_id, redraft_note) VALUES (?1, ?2, ?3, ?4, ?5, 'AWAITING_APPROVAL', ?6, ?7, ?8)
     ON CONFLICT (deal_id, step) DO UPDATE SET state = 'AWAITING_APPROVAL', held_reason = NULL, effect_request_id = excluded.effect_request_id, approval_card_id = excluded.approval_card_id, subject = excluded.subject, body = excluded.body, notice_ref = NULL, redraft_note = excluded.redraft_note`,
  ).bind(`tdm_${crypto.randomUUID()}`, deal.id, deal.drip_step, mail.subject, mail.text, requestId, card.id, redraftNote).run();
  return card.id;
}

/*
 * HER APPROVAL IS WHAT LETS A BRAND EMAIL THROUGH THE OUTSIDE-EMAIL BOUNDARY (24 Oct 2026). The transport refuses
 * any non-partner recipient unless the send carries a marker naming that exact address (`assertPreviewLane`).
 * The drip executed her approved cards WITHOUT one, so every approved brand email would have been refused at the
 * wire, marked FAILED, and silently re-drafted for approval again — found on the first reply-approval test.
 * The marker is her approval card for this one email and this one recipient; nothing else carries it.
 */
export function approvedFor(env: Env, approvalCardId: string, recipient: string): Env {
  const marker: ApprovedSendMarker = { approvalId: approvalCardId, recipient: recipient.trim().toLowerCase() };
  return { ...env, [APPROVED_SEND_ENV_KEY]: marker } as Env;
}

/** How long a pitched brand that never answered its one follow-up counts as live before its category opens again. */
export const CATEGORY_QUIET_DAYS = 7;

/**
 * THE BRAND THAT HOLDS THIS ONE'S CATEGORY, if any (owner, 26 Oct 2026: two brands in the same category for the same
 * club are never pitched at the same time). Another deal for the same club and category is live while it has not
 * declined or been stopped and has not gone quiet: a reply keeps it live; a brand that got its one follow-up and
 * said nothing for CATEGORY_QUIET_DAYS has gone quiet. A first pitch already queued for approval also holds the
 * category (`sentOnly` counts only brands already written to, for the send step).
 */
export async function categoryRival(env: Env, deal: TlcDealRow, now: Date, sentOnly = false): Promise<string | null> {
  if (!deal.category?.trim()) return null;
  const quietBefore = new Date(now.getTime() - CATEGORY_QUIET_DAYS * 86_400_000).toISOString();
  const row = await env.WP_OS_DB.prepare(
    `SELECT d.brand FROM tlc_deal d
      WHERE d.event_id = ?1 AND d.id != ?2 AND lower(trim(d.category)) = lower(trim(?3)) AND d.firm_scope = ?4
        AND d.stage NOT IN ('DECLINED','STOPPED') AND (d.stop_reason IS NULL OR d.stop_reason = 'REPLIED')
        AND (
          d.stop_reason = 'REPLIED' OR d.stage IN ('CALL','WAITING_ON_OWNERS','AGREED','PAID','DELIVERED')
          OR (d.first_sent_at IS NOT NULL AND NOT (d.drip_step >= ?5 AND d.last_sent_at < ?6))
          OR (?7 = 0 AND EXISTS (SELECT 1 FROM tlc_drip_message m WHERE m.deal_id = d.id AND m.step = 0 AND m.state = 'AWAITING_APPROVAL' AND d.created_at <= ?8))
        )
      ORDER BY d.first_sent_at IS NULL, d.first_sent_at, d.created_at LIMIT 1`,
  ).bind(deal.event_id, deal.id, deal.category, deal.firm_scope, TLC_DRIP_DAYS.length, quietBefore, sentOnly ? 1 : 0, (deal as TlcDealRow & { created_at?: string }).created_at ?? now.toISOString()).first<{ brand: string }>();
  return row?.brand ?? null;
}

export async function runDrip(env: Env, now: Date, firmScope = "west-peek", replyDeps: import("./tlcBrandReply").BrandReplyDeps = {}): Promise<DripResult> {
  const settings = await tlcSettings(env);
  const gate = brandSendGate(settings, await tlcOutside(env), await contentHashes(env));
  const result: DripResult = { ...emptyDrip(), gate };
  const wynn = actorFor(WYNN, firmScope);

  // 1 · Execute what a partner has approved (gate re-checked: a switch turned off stops it here).
  if (gate.open) {
    const approved = (await env.WP_OS_DB.prepare(
      `SELECT m.id, m.deal_id, m.step, m.effect_request_id, m.approval_card_id FROM tlc_drip_message m
         JOIN approval_card a ON a.id = m.approval_card_id
         LEFT JOIN tlc_deal d ON d.id = m.deal_id LEFT JOIN tlc_event e ON e.id = d.event_id
        WHERE m.state = 'AWAITING_APPROVAL' AND a.state = 'approved'
        ORDER BY e.month, m.created_at`,
    ).all<{ id: string; deal_id: string; step: number; effect_request_id: string; approval_card_id: string }>()).results ?? [];
    const { executeExternalEffect } = await import("../effects/executor");
    /*
     * THE WARM-UP CAP IS ON WHAT GOES OUT (24 Oct 2026). She approves a whole batch from one email, so the
     * drafts are composed together and the slow warm-up (5 a day in week one, then 10, 20, 30) is applied
     * here, to the sends. An approved email over today's allowance stays approved and goes on the next pass
     * that has room.
     */
    const firstSent = (await env.WP_OS_DB.prepare("SELECT MIN(sent_at) AS at FROM tlc_drip_message WHERE state = 'SENT'").first<{ at: string | null }>())?.at ?? null;
    const sentToday = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE state = 'SENT' AND substr(sent_at, 1, 10) = ?1").bind(now.toISOString().slice(0, 10)).first<{ n: number }>())?.n ?? 0;
    let sendRoom = Math.max(0, warmupDailyCap(firstSent, now) - sentToday);
    const { dripAddressCheck, outreachStopped, refuseAddress } = await import("./tlcVolume");
    // The nearest club's approved emails go first, so the day's allowance is spent where the date is closest.
    for (const m of approved) {
      if (sendRoom <= 0) { result.waitingForAllowance += 1; continue; }
      const deal = await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(m.deal_id).first<TlcDealRow>();
      if (deal && !deal.stop_reason && (await ownerContactedBrands(env, firmScope)).has(brandKey(deal.brand))) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = 'Sequoia contacted this brand directly; replies go to her, no drip' WHERE id = ?1").bind(m.id).run();
        continue;
      }
      if (!deal || deal.stop_reason) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = 'the brand answered or was stopped before it went' WHERE id = ?1").bind(m.id).run();
        continue;
      }
      // Approved together with a rival in its category: the first pitch waits (still approved) until that one is done.
      if (m.step === 0 && (await categoryRival(env, deal, now, true))) continue;
      // THE CLUB REACHED ITS GOAL (26 Oct 2026): its outreach stops; the approved email is held, never sent.
      const club = await env.WP_OS_DB.prepare("SELECT id, month, sponsor_goal_usd FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<{ id: string; month: string; sponsor_goal_usd: number | null }>();
      if (club && (await outreachStopped(env, club))) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = 'the club reached its sponsor goal, so its outreach stopped' WHERE id = ?1").bind(m.id).run();
        result.goalStopped = [...new Set([...(result.goalStopped ?? []), monthWords(club.month)])];
        continue;
      }
      // NEVERBOUNCE BEFORE THE FIRST EMAIL, AND NEVER A FOLLOW-UP TO AN ADDRESS THAT BOUNCED.
      const addr = await dripAddressCheck(env, deal.contact_email, m.step, now);
      if (!addr.ok && "refused" in addr) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'HELD', held_reason = ?2 WHERE id = ?1").bind(m.id, await refuseAddress(env, deal, addr.refused, now)).run();
        result.addressRefused = [...(result.addressRefused ?? []), brandDisplayName(deal.brand)];
        continue;
      }
      if (!addr.ok && m.step === 0) { result.addressWaiting = (result.addressWaiting ?? 0) + 1; continue; }
      try {
        await executeExternalEffect(approvedFor(env, m.approval_card_id, deal.contact_email), wynn, m.effect_request_id, m.approval_card_id);
        const first = deal.first_sent_at ?? now.toISOString();
        const step = m.step + 1;
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'SENT', sent_at = ?2 WHERE id = ?1").bind(m.id, now.toISOString()).run();
        sendRoom -= 1;
        result.sentBrands.push(deal.brand);
        await env.WP_OS_DB.prepare(
          "UPDATE tlc_deal SET stage = CASE WHEN stage = 'PROSPECT' THEN 'PITCHED' ELSE stage END, drip_step = ?2, first_sent_at = ?3, last_sent_at = ?4, next_send_at = ?5, updated_at = ?4 WHERE id = ?1",
        ).bind(deal.id, step, first, now.toISOString(), nextDripAt(step, first, now, null)).run();
        result.sent += 1;
      } catch (err) {
        await env.WP_OS_DB.prepare("UPDATE tlc_drip_message SET state = 'FAILED', held_reason = ?2 WHERE id = ?1").bind(m.id, err instanceof Error ? err.message.slice(0, 300) : "failed").run();
      }
    }
  }

  // 1b · A reply whose body the door never read (an oversize message, an early door): after 15 minutes it is a yes.
  // (26 Oct 2026: never "a yes" by default any more. Wynn reads the stored words, or her inbox, and drafts her answer.)
  {
    const { processBrandReplies } = await import("./tlcBrandReply");
    result.replies = await processBrandReplies(env, now, firmScope, replyDeps).catch((err) => `brand replies not read: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 2 · Compose what is due.
  const due = (await env.WP_OS_DB.prepare(
    `SELECT d.* FROM tlc_deal d JOIN tlc_event e ON e.id = d.event_id
      WHERE d.firm_scope = ?1 AND d.stop_reason IS NULL AND d.stage IN ('PROSPECT','PITCHED')
        AND d.drip_step < ?2 AND d.next_send_at IS NOT NULL AND d.next_send_at <= ?3
        AND e.status IN ('TOPIC_READY','GO','ESCALATED')
        AND NOT EXISTS (SELECT 1 FROM tlc_drip_message m WHERE m.deal_id = d.id AND m.step = d.drip_step AND m.state = 'AWAITING_APPROVAL')
      ORDER BY e.month, d.next_send_at`,
  ).bind(firmScope, TLC_DRIP_DAYS.length, now.toISOString()).all<TlcDealRow>()).results ?? [];
  result.due = due.length;


  const volume = await import("./tlcVolume");
  for (const deal of due) {
    const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<TlcEventRow>();
    if (!ev?.topic) continue;
    // THE CLUB REACHED ITS GOAL (26 Oct 2026): no new pitch and no follow-up for it; a brand already talking to us goes on by reply.
    if (await volume.outreachStopped(env, ev)) {
      result.goalStopped = [...new Set([...(result.goalStopped ?? []), monthWords(ev.month)])];
      continue;
    }
    // SHE CONTACTED THIS BRAND HERSELF: never a drip email from Wynn, at any step, gate open or not.
    if ((await ownerContactedBrands(env, firmScope)).has(brandKey(deal.brand))) {
      await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = NULL, updated_at = ?2 WHERE id = ?1").bind(deal.id, now.toISOString()).run();
      continue;
    }
    // ONE BRAND PER CATEGORY AT A TIME (owner, 26 Oct 2026): a second brand in the same category for the same club
    // is not pitched while the first is live; it waits until the first declines or goes quiet after its follow-up.
    if (deal.drip_step === 0) {
      const first = await categoryRival(env, deal, now);
      if (first) {
        await env.WP_OS_DB.prepare("UPDATE tlc_deal SET next_send_at = ?2, updated_at = ?3 WHERE id = ?1").bind(deal.id, new Date(now.getTime() + 86_400_000).toISOString(), now.toISOString()).run();
        result.heldForCategory = [...(result.heldForCategory ?? []), `${brandDisplayName(deal.brand)} (after ${brandDisplayName(first)})`];
        continue;
      }
    }
    // Email 1 uses her approved text word for word when she approved one for this brand and club (0266).
    const approvedFirst = deal.drip_step === 0 ? await approvedDayZeroFor(env, deal.brand, ev.month, ev.topic, firmScope) : null;
    const mail = approvedFirst
      ? approvedDayZeroEmail(approvedFirst, deal.contact_name)
      : dripEmail({ step: deal.drip_step, brand: deal.brand, contactName: deal.contact_name, topic: ev.topic, month: ev.month, eventDate: ev.event_date, why: deal.why_fit, seats: seatsOf(ev) });
    if (!gate.open) {
      const why = gate.reasons.join("; ");
      await env.WP_OS_DB.prepare(
        `INSERT INTO tlc_drip_message (id, deal_id, step, subject, body, state, held_reason) VALUES (?1, ?2, ?3, ?4, ?5, 'HELD', ?6)
         ON CONFLICT (deal_id, step) DO UPDATE SET subject = excluded.subject, body = excluded.body, held_reason = excluded.held_reason
         WHERE tlc_drip_message.state IN ('HELD','FAILED')`,
      ).bind(`tdm_${crypto.randomUUID()}`, deal.id, deal.drip_step, mail.subject, mail.text, why).run();
      result.held += 1;
      continue;
    }
    // NEVERBOUNCE BEFORE THE FIRST EMAIL: an address that fails is never drafted to; one not yet checkable waits.
    const addr = await volume.dripAddressCheck(env, deal.contact_email, deal.drip_step, now);
    if (!addr.ok) {
      if ("refused" in addr) {
        await volume.refuseAddress(env, deal, addr.refused, now);
        result.addressRefused = [...(result.addressRefused ?? []), brandDisplayName(deal.brand)];
      } else result.addressWaiting = (result.addressWaiting ?? 0) + 1;
      continue;
    }
    const cardId = await fileDraft(env, deal, mail, firmScope);
    result.awaitingApproval += 1;
    result.newDrafts.push({ brand: deal.brand, month: ev.month, step: deal.drip_step, cardId });
  }

  // 3 · The pitch emails to brands that said yes: execute the approved ones, file the held ones.
  if (gate.open) {
    const { executeExternalEffect } = await import("../effects/executor");
    const approvedPitch = (await env.WP_OS_DB.prepare(
      "SELECT f.deal_id, f.effect_request_id, f.approval_card_id, d.contact_email FROM tlc_pitch_followup f JOIN approval_card a ON a.id = f.approval_card_id JOIN tlc_deal d ON d.id = f.deal_id WHERE f.state = 'AWAITING_APPROVAL' AND a.state = 'approved'",
    ).all<{ deal_id: string; effect_request_id: string; approval_card_id: string; contact_email: string }>()).results ?? [];
    for (const f of approvedPitch) {
      try {
        await executeExternalEffect(approvedFor(env, f.approval_card_id, f.contact_email), wynn, f.effect_request_id, f.approval_card_id);
        await env.WP_OS_DB.prepare("UPDATE tlc_pitch_followup SET state = 'SENT', sent_at = ?2 WHERE deal_id = ?1").bind(f.deal_id, now.toISOString()).run();
        await env.WP_OS_DB.prepare("UPDATE tlc_deal SET yes_at = COALESCE(yes_at, ?2), updated_at = ?2 WHERE id = ?1").bind(f.deal_id, now.toISOString()).run();
        result.sent += 1;
      } catch (err) {
        await env.WP_OS_DB.prepare("UPDATE tlc_pitch_followup SET state = 'FAILED', held_reason = ?2 WHERE deal_id = ?1").bind(f.deal_id, err instanceof Error ? err.message.slice(0, 300) : "failed").run();
      }
    }
    const heldPitch = (await env.WP_OS_DB.prepare("SELECT f.*, d.contact_email, d.brand, d.event_id FROM tlc_pitch_followup f JOIN tlc_deal d ON d.id = f.deal_id WHERE f.state = 'HELD' AND d.stop_reason = 'REPLIED'").all<{ deal_id: string; subject: string; body: string; contact_email: string; brand: string; event_id: string }>()).results ?? [];
    for (const f of heldPitch) {
      const ev = await env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(f.event_id).first<TlcEventRow>();
      if (!ev?.topic) continue;
      const pdf = await renderHtmlPdf(env, renderBrandPitch(clubViewOf(ev)), { onePage: true });
      const attachments = pdf.pdfBase64 ? [{ filename: `The Learning Club - ${ev.topic.replace(/[^\w &-]+/g, "").trim()}.pdf`, content: pdf.pdfBase64, contentType: "application/pdf" }] : [];
      const requestId = `eer_${crypto.randomUUID()}`;
      await env.WP_OS_DB.prepare(
        "INSERT INTO external_effect_request (id, effect_type, destination, payload_json, requested_by_type, requested_by_id, outside_job) VALUES (?1, 'email.send', ?2, ?3, 'AI', ?4, ?5)",
      ).bind(requestId, f.contact_email, JSON.stringify({ subject: f.subject, text: f.body, reply_to: BRAND_REPLY_TO, attachments }), WYNN, TLC_BRAND_SALES_JOB).run();
      const { requestApproval } = await import("./approvals");
      const card = await requestApproval(env, wynn, {
        action_key: "effect.email.send",
        object_type: "external_effect_request",
        object_id: requestId,
        title: `Wynn: TLC pitch to ${f.brand}, who said yes`,
        summary: `${f.subject}\n\n${f.body}${attachments.length ? "\n\n(The brand pitch PDF is attached.)" : "\n\n(The PDF could not be rendered; the link carries the pitch.)"}`.slice(0, 1800),
        payload: { deal_id: f.deal_id, pitch: true },
        submit: true,
      });
      await env.WP_OS_DB.prepare("UPDATE tlc_pitch_followup SET state = 'AWAITING_APPROVAL', held_reason = NULL, effect_request_id = ?2, approval_card_id = ?3 WHERE deal_id = ?1").bind(f.deal_id, requestId, card.id).run();
      result.awaitingApproval += 1;
    }
  }
  return result;
}

/**
 * A MESSAGE FROM SOMEBODY WE WROTE TO (called from the inbound door before anything else reads it).
 * Any reply, bounce or unsubscribe stops that brand's sequence at once; the reply is put on the
 * club's sales card so it is read. Matched on the sender's address, or — for a bounce, which comes
 * from a mail server — on the subject we sent.
 */
export async function recordBrandMail(env: Env, input: { from: string; subject: string; text?: string; messageId?: string | null; now?: Date }): Promise<{ matched: number; stop: string | null }> {
  const now = (input.now ?? new Date()).toISOString();
  // A "not a fit" answer to the P.S. is a stop for good, read off the subject or, when the door has it, the new text.
  const first = classifyBrandMail(input);
  const kind = first === "REPLIED" && (replyLooksLikeNo(input.subject) || (input.text !== undefined && replyLooksLikeNo(input.text))) ? "UNSUBSCRIBED" : first;
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
  if (kind === "BOUNCED") {
    // NEVER A FOLLOW-UP TO A BOUNCE, for any club: the address is marked bounced for good.
    const { recordBounce } = await import("./tlcVolume");
    for (const d of deals) await recordBounce(env, d.contact_email, new Date(now));
  }
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
  // A REPLY THAT IS NOT A NO: the pitch email (PDF + call link) goes behind the gate for her approval. From the
  // header-only call (no text yet) this waits for the body: recordBrandReplyText decides, or the drip after 15 minutes.
  if (kind === "REPLIED" && input.text !== undefined) {
    const { takeBrandReply } = await import("./tlcBrandReply");
    for (const d of deals) {
      const fresh = (await env.WP_OS_DB.prepare("SELECT * FROM tlc_deal WHERE id = ?1").bind(d.id).first<TlcDealRow>())!;
      await takeBrandReply(env, fresh, { messageId: input.messageId ?? "", subject: input.subject, text: input.text, receivedAt: now }, { now: new Date(now) });
    }
  }
  await appendEvent(env, { eventType: "tlc.brand_mail", actorType: "system", actorId: "inbound_email", objectType: "tlc_deal", objectId: deals[0]!.id, payload: { kind, deals: deals.length } });
  return { matched: deals.length, stop: kind };
}

/**
 * THE BLIND COPY OF HER OWN BRAND EMAIL (24 Oct 2026): from her address, addressed to a brand we have a deal with.
 * Returns that deal's id, or null for anything else (her ordinary mail to the OS is never caught by this).
 */
export async function isOwnBrandMailCopy(env: Env, input: { from: string; to: string }): Promise<string | null> {
  const from = (/<([^>]+)>/.exec(input.from)?.[1] ?? input.from).trim().toLowerCase();
  if (from !== TLC_OWNER.email.toLowerCase()) return null;
  const to = [...input.to.matchAll(/[^\s<>,;"]+@[^\s<>,;"]+/g)].map((m) => m[0].toLowerCase()).filter((a) => a !== INTAKE_MAILBOX);
  if (to.length === 0) return null;
  const deal = await env.WP_OS_DB.prepare(`SELECT id FROM tlc_deal WHERE lower(contact_email) IN (${to.map((_, i) => `?${i + 1}`).join(",")}) LIMIT 1`).bind(...to).first<{ id: string }>();
  return deal?.id ?? null;
}

/**
 * THE REPLY'S OWN WORDS (24 Oct 2026). The header-only call stopped the sequence as REPLIED; once the door has read
 * the body, a "not a fit / no thanks / stop" answer turns that into a stop for good, and anything else is a yes
 * whose pitch email is drafted for her approval.
 */
export async function recordBrandReplyText(env: Env, input: { from: string; subject: string; text: string; messageId?: string | null; now?: Date }): Promise<{ matched: number; stop: string | null }> {
  // (26 Oct 2026) The words decide: an auto-reply resumes the drip, a no is DECLINED, anything else is a reply Wynn
  // drafts her answer to (tlcBrandReply). Nothing is "a yes" by default and no pitch PDF goes before one.
  const now = input.now ?? new Date();
  const { dealsForSender, sendReplyApprovals, takeBrandReply } = await import("./tlcBrandReply");
  const deals = await dealsForSender(env, input.from);
  if (deals.length === 0) return { matched: 0, stop: null };
  let stop: string | null = null;
  const drafted = new Set<string>();
  for (const d of deals) {
    const out = await takeBrandReply(env, d, { messageId: input.messageId ?? "", subject: input.subject, text: input.text, receivedAt: now.toISOString() }, { now });
    stop = out === "NO" ? "DECLINED" : out === "AUTO_REPLY" ? "AUTO_REPLY" : "REPLIED";
    if (out === "DRAFTED") drafted.add(d.firm_scope);
  }
  // Her approval email goes AT ONCE (owner, 26 Oct 2026: "Why 4pm?"); a failure here is retried by the next drip pass.
  for (const scope of drafted) await sendReplyApprovals(env, now, scope).catch(() => undefined);
  return { matched: deals.length, stop };
}

/** The email back to a brand that said yes: the pitch (attached and linked) and a call link. Signed by Sequoia. */
export function pitchFollowUp(input: { brand: string; contactName: string | null; topic: string; month: string; pitchUrl: string; callLink: string | null }): { subject: string; text: string } {
  const hi = input.contactName ? `Hi ${input.contactName.split(" ")[0]},` : "Hi,";
  return {
    subject: `${brandDisplayName(input.brand)} + a small room in New York`,
    text: [
      hi,
      "",
      `Thank you for coming back to me. Here is the one-page pitch for The Learning Club: ${input.topic}, in ${monthWords(input.month)}. The PDF is attached, and it is also here: ${input.pitchUrl}`,
      "",
      input.callLink ? `If it is easier to talk it through, pick a time that suits you: ${input.callLink}` : "If it is easier to talk it through, reply with two times that suit you and I will send an invitation.",
      "",
      ...TLC_SIGNATURE,
    ].join("\n"),
  };
}

// ── The runner: one card, one bounded unit of work ─────────────────────────────────────────────

export type TlcSearch = (env: Env, actor: Actor, prompt: string) => Promise<{ ok: boolean; text: string; detail: string }>;
export interface TlcDeps {
  search?: TlcSearch;
  urlCheck?: (url: string) => Promise<boolean>;
  pageText?: (url: string) => Promise<string | null>;
  now?: Date;
  interpret?: Interpreter;
  /** HTML → PDF for the one-sheets; Browser Rendering by default. */
  renderPdf?: PdfRenderer;
}
export interface TlcRunResult {
  finished: boolean;
  blocked: boolean;
  progressed: boolean;
  held?: boolean;
  waitUntil?: string;
  detail: string;
}

export const defaultSearch: TlcSearch = async (env, actor, prompt) => {
  const { run } = await runAi(env, {
    purpose: "The Learning Club: live research",
    actor,
    inputs: [prompt],
    // Public web research about public topics, brands and venues. No sponsor deal term goes in.
    sensitivity: "PUBLIC" as never,
    // TLC work is brand-facing in her name: important (owner, 26 Oct 2026) — Claude seat, then Codex, never a free lane.
    budgetContext: { requiresSearch: true, expectedOutputTokens: 3500, preferredModel: SEARCH_MODEL, providerKey: "openrouter", important: true },
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

/**
 * THE PLAYBOOK EVERY TLC PROMPT CARRIES IS THE STORED ONE (owner, 22 Oct 2026). Her approved playbook lives in
 * Documents (R2, never this public repository); `tlc_setting.playbook_document_id` names it, and the current
 * version's text is read on every run, so a new version she files is what Parker and Wynn follow next.
 * Only when it cannot be read does the built-in summary stand in, and the prompt says so.
 */
export async function storedPlaybook(env: Env): Promise<string | null> {
  try {
    const row = await env.WP_OS_DB.prepare(
      "SELECT v.r2_key FROM tlc_setting s JOIN document d ON d.id = s.value JOIN document_version v ON v.id = d.current_version_id WHERE s.key = ?1",
    ).bind(PLAYBOOK_DOCUMENT_SETTING).first<{ r2_key: string }>();
    if (!row || !env.WP_OS_DOCUMENTS) return null;
    const obj = await env.WP_OS_DOCUMENTS.get(row.r2_key);
    const text = obj ? (await obj.text()).trim() : "";
    return text || null;
  } catch {
    return null;
  }
}

export function playbookBlock(stored: string | null = null): string {
  if (stored) return ["THE PLAYBOOK (the owner's approved copy, read from Documents; follow it):", stored].join("\n");
  return ["THE PLAYBOOK (the stored copy could not be read; this is the built-in summary of it — follow it exactly):", ...TLC_PLAYBOOK.map((l) => `- ${l}`)].join("\n");
}

// ── The ideas list (owner, 22 Oct 2026) ───────────────────────────────────────────────────────

export interface TlcIdeaRow {
  id: string;
  topic: string;
  topic_key: string;
  note: string | null;
  origin: TlcIdeaOrigin;
  suggested_by: string;
  suggested_at: string;
  source_ref: string | null;
  preferred_month: string | null;
  status: TlcIdeaStatus;
  status_month: string | null;
  status_card_id: string | null;
  dropped_by: string | null;
  dropped_at: string | null;
  merged_into?: string | null;
  earliest_month?: string | null;
  packet_json?: string | null;
}

function ideaPacket(i: { packet_json?: string | null }): { ai_angle?: unknown; ai_segment?: unknown } | null {
  try { return i.packet_json ? (JSON.parse(i.packet_json) as { ai_angle?: unknown }) : null; } catch { return null; }
}

/** How many clubs have each raised the full $25,000 (or their own goal) in agreed cash, from tlc_deal. */
export async function fundedEventCount(env: Env): Promise<number> {
  const rows = (await env.WP_OS_DB.prepare(
    "SELECT e.id, COALESCE(e.sponsor_goal_usd, ?1) AS goal, COALESCE(SUM(CASE WHEN d.stage IN ('AGREED','PAID','DELIVERED') AND COALESCE(d.tier,'') != 'PRODUCT' THEN d.cash_offer_usd ELSE 0 END), 0) AS cash FROM tlc_event e LEFT JOIN tlc_deal d ON d.event_id = e.id GROUP BY e.id",
  ).bind(TLC_SPONSOR_GOAL_USD).all<{ id: string; goal: number; cash: number }>()).results ?? [];
  return rows.filter((r) => r.cash >= r.goal).length;
}

export async function ideasFor(env: Env, firmScope = "west-peek"): Promise<TlcIdeaRow[]> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_idea WHERE firm_scope = ?1 ORDER BY CASE origin WHEN 'OWNER_IDEA' THEN 0 ELSE 1 END, suggested_at").bind(firmScope).all<TlcIdeaRow>()).results ?? [];
}

/**
 * Add an idea, or move an existing one's status. Who suggested it, when and where it came from are kept
 * from the FIRST time it was recorded — a partner's idea stays the partner's when research finds it too.
 * A DROPPED idea stays dropped until a partner restores it. Nothing here deletes.
 */
export async function upsertIdea(
  env: Env,
  input: { topic: string; origin: TlcIdeaOrigin; suggestedBy: string; suggestedAt: string; note?: string | null; sourceRef?: string | null; preferredMonth?: string | null; status?: TlcIdeaStatus; month?: string | null; cardId?: string | null; firmScope?: string },
): Promise<void> {
  const key = topicKey(input.topic);
  if (!key || !isIdeaOrigin(input.origin)) return;
  await env.WP_OS_DB.prepare(
    `INSERT INTO tlc_idea (id, topic, topic_key, note, origin, suggested_by, suggested_at, source_ref, preferred_month, status, status_month, status_card_id, firm_scope)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
     ON CONFLICT (firm_scope, topic_key) DO UPDATE SET
       status = CASE WHEN tlc_idea.status IN ('DROPPED','MERGED') OR ?14 = 0 THEN tlc_idea.status ELSE excluded.status END,
       status_month = CASE WHEN tlc_idea.status IN ('DROPPED','MERGED') OR ?14 = 0 THEN tlc_idea.status_month ELSE excluded.status_month END,
       status_card_id = CASE WHEN tlc_idea.status IN ('DROPPED','MERGED') OR ?14 = 0 THEN tlc_idea.status_card_id ELSE excluded.status_card_id END,
       note = COALESCE(tlc_idea.note, excluded.note),
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  ).bind(
    `tli_${crypto.randomUUID()}`, input.topic.trim().slice(0, 160), key, input.note ?? null, input.origin, input.suggestedBy, input.suggestedAt,
    input.sourceRef ?? null, input.preferredMonth ?? null, input.status ?? "LATER", input.month ?? null, input.cardId ?? null, input.firmScope ?? "west-peek",
    input.status ? 1 : 0,
  ).run();
}

/**
 * What the partners have said about topics, word for word, since the last pick: their notes on any TLC card, and
 * the text of every card they asked for that mentions the Learning Club or Rooms. Parker reads it and names any
 * topic idea in it; an idea is kept only when the quote he gives is really in this text.
 */
async function partnerWords(env: Env, firmScope: string, now: Date): Promise<Array<{ who: string; at: string; ref: string; text: string }>> {
  const since = new Date(now.getTime() - 90 * 86_400_000).toISOString();
  const byEmail = new Map(PARTNERS.map((p) => [p.email, p.firstName]));
  const byId = new Map(PARTNERS.map((p) => [p.firmUserId, p.firstName]));
  const out: Array<{ who: string; at: string; ref: string; text: string }> = [];
  const cards = (await env.WP_OS_DB.prepare(
    "SELECT id, requested_by_email, created_at, description FROM work_card WHERE firm_scope = ?1 AND created_at >= ?2 AND requested_by_email IS NOT NULL AND (title LIKE '%Learning Club%' OR title LIKE '%TLC%' OR title LIKE '%Room%' OR description LIKE '%Learning Club%' OR description LIKE '%learning club%') ORDER BY created_at",
  ).bind(firmScope, since).all<{ id: string; requested_by_email: string; created_at: string; description: string | null }>()).results ?? [];
  for (const c of cards) {
    const who = byEmail.get(c.requested_by_email.toLowerCase());
    if (who && c.description) {
      const own = theirOwnWords(c.description);
      if (own) out.push({ who, at: c.created_at, ref: c.id, text: own.slice(0, 2500) });
    }
  }
  const notes = (await env.WP_OS_DB.prepare(
    "SELECT n.id, n.author_id, n.body, n.created_at FROM work_card_note n JOIN work_card w ON w.id = n.work_card_id WHERE w.firm_scope = ?1 AND w.kind LIKE 'TLC_%' AND n.created_at >= ?2 ORDER BY n.created_at",
  ).bind(firmScope, since).all<{ id: string; author_id: string; body: string; created_at: string }>()).results ?? [];
  for (const n of notes) {
    const who = byId.get(n.author_id);
    if (who) out.push({ who, at: n.created_at, ref: n.id, text: n.body.slice(0, 1500) });
  }
  return out;
}

/**
 * ONLY WHAT THE PARTNER WROTE (22 Oct 2026). A card's description also carries the brief Wren wrote and every
 * employee's notes ("• …"), and Parker captured "The Record Room" from his own November packet as her idea.
 * Here: the quoted request after "in their own words:" up to the grant boilerplate, or else the text before the
 * first employee note.
 */
export function theirOwnWords(description: string): string {
  const m = /in their own words:\s*\n([\s\S]*?)(?:\n\s*WHAT THIS DOES NOT GRANT|\n\s*Stored message:|\n• |$)/i.exec(description);
  if (m) return m[1]!.trim();
  return description.split(/\n• /)[0]!.trim();
}

/** The ideas Parker found in the partners' own words. Kept only when the quote really appears in what they wrote. */
// ── The research library (owner, 22 Oct 2026) ─────────────────────────────────────────────────

export const TLC_RESEARCH_KINDS = ["TREND_STORY", "BRAND_SPEND", "TREND", "REGULATORY"] as const;
export type TlcResearchKind = (typeof TLC_RESEARCH_KINDS)[number];
export const TLC_RESEARCH_LABEL: Record<TlcResearchKind, string> = { TREND_STORY: "Trend story", BRAND_SPEND: "Brands spending now", TREND: "Trend and curiosity", REGULATORY: "Regulatory check" };
export interface TlcResearchRow {
  id: string;
  kind: TlcResearchKind;
  title: string;
  body: string | null;
  topic: string | null;
  source_title: string | null;
  source_url: string | null;
  published_on: string | null;
  found_at: string;
  found_by: string;
  card_id: string | null;
}

export async function researchLibrary(env: Env, firmScope = "west-peek", limit = 200): Promise<TlcResearchRow[]> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM tlc_research WHERE firm_scope = ?1 ORDER BY found_at DESC LIMIT ?2").bind(firmScope, limit).all<TlcResearchRow>()).results ?? [];
}

export async function addResearch(env: Env, r: { kind: TlcResearchKind; title: string; body?: string | null; topic?: string | null; sourceTitle?: string | null; sourceUrl?: string | null; publishedOn?: string | null; foundAt: string; foundBy: string; cardId?: string | null; firmScope?: string }): Promise<void> {
  if (!r.title.trim()) return;
  await env.WP_OS_DB.prepare(
    "INSERT INTO tlc_research (id, kind, title, body, topic, source_title, source_url, published_on, found_at, found_by, card_id, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
  ).bind(`tlr_${crypto.randomUUID()}`, r.kind, r.title.slice(0, 400), r.body ?? null, r.topic ?? null, r.sourceTitle ?? null, r.sourceUrl ?? null, r.publishedOn ?? null, r.foundAt, r.foundBy, r.cardId ?? null, r.firmScope ?? "west-peek").run();
}

/** The library as a prompt block: newest first, every entry dated, labelled and sourced. Read by every TLC prompt that builds a room or sells one. */
export function libraryBlock(rows: ReadonlyArray<Pick<TlcResearchRow, "kind" | "title" | "body" | "topic" | "source_url" | "published_on" | "found_at">>, max = 40): string {
  if (rows.length === 0) return "THE RESEARCH LIBRARY (Rooms page): empty so far.";
  return [
    "THE RESEARCH LIBRARY (Rooms page) — draw on it; cite only what has a source:",
    ...rows.slice(0, max).map((r) => `- [${TLC_RESEARCH_LABEL[r.kind]}, ${(r.published_on || r.found_at).slice(0, 10)}]${r.topic ? ` ${r.topic}:` : ""} ${r.title}${r.body && r.kind !== "TREND_STORY" ? ` — ${r.body.slice(0, 300)}` : r.body ? ` — ${r.body.slice(0, 1500)}` : ""}${r.source_url ? ` (${r.source_url})` : ""}`),
  ].join("\n");
}

export function ideasFoundIn(raw: unknown, words: ReadonlyArray<{ who: string; at: string; ref: string; text: string }>): Array<{ topic: string; who: string; at: string; ref: string; quote: string }> {
  const out: Array<{ topic: string; who: string; at: string; ref: string; quote: string }> = [];
  const norm = (x: string) => x.toLowerCase().replace(/\s+/g, " ").trim();
  for (const f of Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []) {
    const topic = str(f.topic);
    const quote = str(f.quote);
    if (!topic || quote.length < 4) continue;
    const src = words.find((w) => norm(w.text).includes(norm(quote)));
    if (src) out.push({ topic, who: src.who, at: src.at, ref: src.ref, quote });
  }
  return out;
}

export function buildTopicsPrompt(
  months: readonly string[],
  exclude: readonly string[],
  chosen: Readonly<Record<string, string>> = {},
  opts: { ideas?: ReadonlyArray<Pick<TlcIdeaRow, "topic" | "origin" | "suggested_by" | "suggested_at" | "note" | "preferred_month" | "status"> & { earliest_month?: string | null; packet_json?: string | null }>; fundedEvents?: number; partnerWords?: ReadonlyArray<{ who: string; at: string; text: string }>; playbook?: string | null; library?: Parameters<typeof libraryBlock>[0]; part?: "all" | "picks" | "alternatives"; picked?: readonly string[] } = {},
): string {
  const kept = months.filter((m) => chosen[m]);
  const part = opts.part ?? "all";
  const picksPart = part !== "alternatives";
  const altsPart = part !== "picks";
  const ideas = (opts.ideas ?? []).filter((i) => i.status !== "DROPPED" && i.status !== "MERGED");
  return [
    personaPrompt("Parker", "Event Marketing Coordinator"),
    "",
    playbookBlock(opts.playbook ?? null),
    "",
    libraryBlock(opts.library ?? []),
    "",
    "THE IDEAS LIST — read this FIRST. Weigh every idea on its merits next to what you find; you decide.",
    ...(ideas.length ? ideas.map((i) => {
      const e = ideaEligibility({ topic: i.topic, earliest_month: i.earliest_month ?? null, packet: ideaPacket(i) }, months[0] ?? "", opts.fundedEvents ?? 0);
      const angle = ideaPacket(i)?.ai_angle;
      return `- ${i.topic} [${TLC_IDEA_ORIGIN_LABEL[i.origin]}; ${i.suggested_by}, ${i.suggested_at.slice(0, 10)}]${i.preferred_month ? ` (preferred: ${monthWords(i.preferred_month)})` : ""}${typeof angle === "string" ? ` AI angle: ${angle}` : ""}${e.eligible ? "" : ` [NOT a primary yet: ${e.why}]`}${i.note ? ` — ${i.note}` : ""}`;
    }) : ["- (no ideas on the list yet)"]),
    ...(altsPart && opts.partnerWords?.length ? ["", "WHAT THE PARTNERS WROTE (under found_ideas, name each concrete club topic they suggested — one topic per entry, not a format or a list of examples — with a short quote copied exactly):", ...opts.partnerWords.map((w) => `--- ${w.who}, ${w.at.slice(0, 10)}:\n${w.text}`)] : []),
    "",
    "WHERE IDEAS COME FROM — draw on all three, and label each pick and alternative with its origin:",
    "- OWNER_IDEA: an idea on the list above that a partner sent in their own words.",
    "- SUGGESTED_LIST: an idea on the list above from a suggested list (not a partner's own idea).",
    "- BRANDS_SPENDING: research which brands are spending right now (recent sponsorships, campaigns, launches, funding rounds, NYC event sponsorships), and sometimes reverse-engineer a club from a brand that is clearly buying.",
    "- TREND: what people are searching for and curious about right now.",
    "Favour topics where meeting in person is the point — the connection in the room is part of what people pay for.",
    "",
    `You are choosing topics for The Learning Club: in-person, ${TLC_CITY} only, ${BRAND_ROOM_WORDS} people (the partners size each room to its sponsors), one topic, a 3–4 hour deep dive on one afternoon (Sat 1–5 pm) or one evening (Thu 6–10 pm). Every attendee pays a $${TLC_TICKET_PRICE_USD} ticket. Everyone leaves with something they made or learned.`,
    `Run of show: ${runOfShowLines().join("; ")}.`,
    picksPart ? `Pick ONE topic for each of these months: ${months.map(monthWords).join(", ")}. No two months the same topic. Every month must have a pick.` : "",
    !picksPart && opts.picked?.length ? `The picks are already made: ${opts.picked.join("; ")}. Do not repeat them.` : "",
    picksPart && kept.length ? `These months' topics are ALREADY CHOSEN — keep exactly that topic and write its packet: ${kept.map((m) => `${monthWords(m)} = "${chosen[m]}"`).join("; ")}.` : "",
    "",
    "Seed list (you may pick from it or propose a better topic):",
    ...TLC_TOPIC_SEEDS.map((s) => `- ${s}`),
    exclude.length ? `Never pick these (already used or turned down): ${exclude.join("; ")}.` : "",
    "",
    "Pick criteria — argue every pick against all four (and IRL connection):",
    ...TLC_TOPIC_CRITERIA.map((c) => `- ${c}`),
    "",
    "For a topic with a legal or health angle (for example peptides and biohacking, supplements, money), add a short regulatory_note: which sponsor types can legally sponsor it in New York and what they may not claim. It stays on the card; it never goes in the email.",
    picksPart ? "For each pick give the usual Rooms packet: the angle, why now (with sources), what happens in the hands-on hour, what people take home, the kind of expert who teaches it, and 5–10 sponsor categories that fit (each with why and two or three example brands). The categories are COMPLEMENTARY, never competitors: one drink base, then mixers, glassware, wellness, food; never two kinds of the same product." : "",
    "Write each topic as its name only — no day, time, month or format in brackets.",
    "Never pick a standalone peptides topic (FDA warning letters to research-use sellers). No sportsbook or casino sponsors before April 2027, and never one beside trading. Prediction markets (Kalshi, Polymarket) and Robinhood may sponsor any month, Q1 included, for investing or money topics.",
    "EVERY CLUB HAS AN AI ANGLE: a topic not explicitly about AI gives ai_segment (one AI segment inside the Go deeper block, e.g. guests use an AI assistant on their own material) and includes one category marked ai_partner true (\"AI partner\": cash at any tier, or credits for every guest or an expert who runs the segment). Mark any frontier-model company's category frontier_model true; only one is seated per club.",
    "Brand-safe words (a brand reads these): never a trademarked campaign name such as Dry January, never a promised result (\"they leave with three automations running\"), never a date (the club's date is set elsewhere), and never a label like (lead), (supporting) or category-exclusive. Several brands partner on a club; nobody gets a category to itself.",
    altsPart ? `Give exactly ${TLC_ALTERNATIVES} ALTERNATIVE topics (partner ideas, brands spending now and trends alike; each with its origin) the partners could swap in: each different from the picks and from each other, with a one-line reason it would work and two or three real brands that would pay to sponsor it.` : "",
    "This goes to the partners as it is: write only what each topic IS. Never mention a topic you turned down, rejected or ruled out, or why.",
    "Use ONLY real, live web pages as sources. Do not invent statistics, quotes or events.",
    "",
    `Return ONLY JSON: {${[
      picksPart ? '"picks":[{"month":"YYYY-MM","topic":"","angle":"","why_now":"","criteria":{"product_used":"","irl_spend":"","sponsors_fit":"","pays_10":""},"hands_on":"","take_home":"","teacher_profile":"","ai_segment":"","origin":"OWNER_IDEA|BRANDS_SPENDING|TREND","regulatory_note":"","sponsor_categories":[{"category":"","why":"","example_brands":[""],"tier":"","ai_partner":false,"frontier_model":false}],"sources":[{"title":"","url":""}]}]' : "",
      altsPart ? '"alternatives":[{"topic":"","origin":"OWNER_IDEA|BRANDS_SPENDING|TREND","reason":"","brands":[""],"regulatory_note":""}],"found_ideas":[{"topic":"","quote":""}]' : "",
    ].filter(Boolean).join(",")}}`,
  ].filter(Boolean).join("\n");
}

export function buildBookingPackPrompt(ev: Pick<TlcEventRow, "topic" | "event_date" | "slot" | "seats_min" | "seats_max" | "sponsor_goal_usd">, playbook: string | null = null, library: Parameters<typeof libraryBlock>[0] = []): string {
  return [
    personaPrompt("Parker", "Event Marketing Coordinator"),
    "",
    playbookBlock(playbook),
    "",
    libraryBlock(library),
    "",
    `Build the booking pack for The Learning Club: "${ev.topic}", ${TLC_CITY}, on ${ev.event_date} (${ev.slot === "AFTERNOON" ? "Saturday 1–5 pm" : "Thursday 6–10 pm"}), ${seatsWords(seatsOf(ev))} people, ${TLC_BOOKING_HOURS} hours.`,
    `Run of show: ${runOfShowLines().join("; ")}.`,
    "These are OPTIONS for the partners, who book and pay. You never book, reserve or pay for anything.",
    `Everything together must fit inside $${goalOf(ev).costBudgetUsd.toLocaleString("en-US")}. An in-kind venue or product is preferred: it lowers cost.`,
    "",
    `Give: ${Object.values(BOOKING_PACK_SHAPE).map((s) => `${s.min === s.max ? s.min : `${s.min}–${s.max}`} ${s.label}`).join("; ")}; a materials list with links, quantities and unit prices for ${seatsOf(ev).max} people.`,
    "Donated-venue leads first (law firms, coworking spaces like WeWork, brand showrooms that host community events), then paid venues. A real meal, not snacks. Host and venue priced for 4 hours; the expert paid for the whole session.",
    "Every option needs: a real live URL for it, a price in USD (an estimate is fine if marked in the note), and a book_by date (YYYY-MM-DD).",
    "",
    'Return ONLY JSON: {"hosts":[{"name":"","price_usd":0,"book_by":"YYYY-MM-DD","url":"","note":""}],"donated_venue_leads":[…],"paid_venues":[…],"teachers":[…],"food":[…],"photographers":[…],"materials":[{"item":"","url":"","qty":0,"unit_usd":0}]}',
  ].join("\n");
}

export function buildBrandBatchPrompt(
  events: ReadonlyArray<Pick<TlcEventRow, "month" | "topic" | "sponsor_categories_json">>,
  exclude: readonly string[],
  playbook: string | null = null,
  library: Parameters<typeof libraryBlock>[0] = [],
  mustPitch: ReadonlyArray<{ brand: string; months: readonly string[]; reasons: readonly string[] }> = [],
  /** How many of Wynn's own brands this one search asks for; 0 means the must-pitch brands alone. */
  picks: number = TLC_BRANDS_PER_CLUB,
): string {
  if (picks <= 0 && mustPitch.length) {
    return [
      personaPrompt("Wynn", "TLC Sales & Partnerships"),
      "",
      playbookBlock(playbook),
      "",
      "The owner says these brands MUST be pitched for The Learning Club:",
      ...mustPitch.map((m) => `- ${m.brand}, for ${m.months.map(monthWords).join(" and ")}. Why: ${m.reasons.join(" ")}`),
      "For each, find a NAMED person whose job is partnerships, events, community, a startup program or developer relations, and their email address exactly as it appears on a live public page, with that page's URL. No guessed addresses. If no address is printed on any page, still return the brand with an empty contact_email, and list every page you checked in pages_checked.",
      'Return ONLY JSON: {"must_pitch":[{"brand":"","contact_name":"","contact_email":"","contact_source_url":"","pages_checked":[""]}],"brands":[]}',
    ].join("\n");
  }
  return [
    personaPrompt("Wynn", "TLC Sales & Partnerships"),
    "",
    playbookBlock(playbook),
    "",
    libraryBlock(library),
    "",
    // BRANDS WE MUST PITCH (owner, 23 Oct 2026) come first, outside the five-per-club limit.
    ...(mustPitch.length
      ? [
          "FIRST, before choosing any brand of your own: the owner says these brands MUST be pitched. They do not count toward the 5 per club.",
          ...mustPitch.map((m) => `- ${m.brand}, for ${m.months.map(monthWords).join(" and ")}. Why: ${m.reasons.join(" ")}`),
          "For each, find a NAMED person whose job is partnerships, events, community, a startup program or developer relations, and their email address exactly as it appears on a live public page, with that page's URL. No guessed addresses. If no address is printed on any page, still return the brand with an empty contact_email, and list every page you checked in pages_checked.",
          "",
        ]
      : []),
    "Find brands to sponsor these clubs:",
    ...events.map((e) => {
      const cats = list<{ category: string; bench?: boolean; excluded_brands?: string[]; featured?: string | null; tier?: string }>(e.sponsor_categories_json);
      const live = cats.filter((c) => !c.bench).map((c) => `${c.category}${c.featured ? ` (filled: ${c.featured})` : ""}${c.tier && isTlcTier(c.tier) ? ` [${TLC_TIERS[c.tier].label}]` : ""}`);
      const never = cats.flatMap((c) => c.excluded_brands ?? []);
      return `- ${monthWords(e.month)}: "${e.topic}". Categories: ${live.join(", ")}${never.length ? `. NEVER approach (they compete with a featured partner): ${never.join(", ")}` : ""}`;
    }),
    "Sponsors in a club are complementary, never competitors: never offer a brand that competes with a featured or agreed partner, and skip any category already filled.",
    "Never a peptide seller. No betting brands (sportsbooks such as DraftKings or FanDuel, casinos) before April 2027, and never a betting brand beside a trading or investing brand. Prediction markets (Kalshi, Polymarket) and Robinhood are not betting brands: pitch them in any month, Q1 included, for investing or money topics such as Money Reset.",
    exclude.length ? `Already contacted for that club (do not repeat): ${exclude.join("; ")}.` : "",
    "",
    `Up to ${Math.min(picks, TLC_BRANDS_PER_CLUB)} brands per club (the must-pitch brands above are extra). For each: a NAMED person whose job is partnerships, events, community or brand marketing, their email address exactly as it appears on a live public page, and that page's URL. No guessed addresses. If you cannot find an address on a page, leave the brand out.`,
    mustPitch.length
      ? 'Return ONLY JSON: {"must_pitch":[{"brand":"","contact_name":"","contact_email":"","contact_source_url":"","pages_checked":[""]}],"brands":[{"month":"YYYY-MM","brand":"","category":"","contact_name":"","contact_email":"","contact_source_url":"","why_fit":""}]}'
      : 'Return ONLY JSON: {"brands":[{"month":"YYYY-MM","brand":"","category":"","contact_name":"","contact_email":"","contact_source_url":"","why_fit":""}]}',
  ].filter(Boolean).join("\n");
}

export function buildTrendPrompt(playbook: string | null = null, library: Parameters<typeof libraryBlock>[0] = []): string {
  return [
    personaPrompt("Wynn", "TLC Sales & Partnerships"),
    "",
    playbookBlock(playbook),
    "",
    libraryBlock(library),
    "Refresh the library: add what is new since these entries; do not repeat them.",
    "",
    "Research the trend of in-person learning clubs in coastal US cities: people gathering in person to go deep on one topic (sewing, matcha, day trading, and the like). What is happening, who is doing it, why now.",
    "Use ONLY real, live web pages (news, research, company announcements). Every sentence in the story must rest on a source you list, and each source carries the one claim it supports. No invented numbers, quotes or names.",
    "Story: 120–220 words, plain and warm, written as \"we\" would tell a brand partner. Cite as [1], [2] matching the sources list.",
    "Also name up to 5 TOPIC IDEAS for future clubs from this research: brands clearly spending right now (recent sponsorships, campaigns, launches, funding rounds, NYC event sponsorships) — origin BRANDS_SPENDING — or what people are searching for and curious about — origin TREND. Favour topics where meeting in person is the point.",
    'Return ONLY JSON: {"story":"","sources":[{"title":"","publisher":"","url":"","published_on":"YYYY-MM-DD or empty","claim":""}],"topic_ideas":[{"topic":"","origin":"BRANDS_SPENDING|TREND","reason":"","source_url":"","source_title":""}]}',
  ].join("\n");
}

const TLC_STEPS: Record<string, string[]> = {
  TLC_TOPICS: ["read the owner's seed list and the four criteria", "search live pages for each month's topic", "check every source page", "write the packet and the sponsor categories", "email both partners", "wait 3 days for a no"],
  TLC_BOOKING_PACK: ["search NYC hosts, venues, teachers, food, materials and photographers", "check every page", "price each with a book-by date", "total it against the cap and the sponsor cash", "email both partners"],
  TLC_BRAND_BATCH: ["pitch the brands we must pitch first", "search brands in the club's categories", "check each contact page carries the address", "queue each for the four emails"],
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
    return await runKind(env, card, now, search, check, pageText, deps.renderPdf ?? ((html) => renderHtmlPdf(env, html, { onePage: true })));
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

async function runKind(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>, pageText: (u: string) => Promise<string | null>, renderPdf: PdfRenderer): Promise<TlcRunResult> {
  switch (card.kind) {
    case "TLC_TOPICS":
      return runTopics(env, card, now, search, check, renderPdf);
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

async function runTopics(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>, renderPdf: PdfRenderer): Promise<TlcRunResult> {
  // STAGE 2 — the veto window has run out (or the card was woken by a reply): read the partners' notes.
  const proposed = await eventsFrom(env, "SELECT * FROM tlc_event WHERE topic_card_id = ?1 AND status = 'TOPIC_PROPOSED' ORDER BY month", card.id);
  if (proposed.length) {
    const unread = (await env.WP_OS_DB.prepare("SELECT id, body, author_id FROM work_card_note WHERE work_card_id = ?1 AND acknowledged_at IS NULL").bind(card.id).all<{ id: string; body: string; author_id: string | null }>()).results ?? [];
    // ONLY HER REPLY IS A VETO (owner, 22 Oct 2026). Anyone else's note is acknowledged, not obeyed.
    const notes = unread.filter((n) => TLC_DECIDER_IDS.includes(n.author_id ?? ""));
    const vetoed = new Set<string>();
    for (const n of notes) for (const m of vetoedMonths(n.body, proposed.map((e) => ({ month: e.month, topic: e.topic ?? "" })))) vetoed.add(m);
    const heard = vetoed.size ? `Parker read this as a no to ${[...vetoed].map(monthWords).join(", ")} and picks again.` : "Parker read this as no veto; the picks proceed when the window closes.";
    if (unread.length) await env.WP_OS_DB.prepare("UPDATE work_card_note SET acknowledged_at = ?2, response = ?3 WHERE work_card_id = ?1 AND acknowledged_at IS NULL").bind(card.id, now.toISOString(), heard).run();
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

  // STAGE 1 — pick, ONE SEARCH AT A TIME (22 Oct 2026). One search for all three packets and nine alternatives
  // ran past the seat's four-minute limit, so each month's pick, then the alternatives, is its own search; what
  // came back is kept on a draft between ticks, and the email is assembled only when every piece is in.
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
  const ideas = await ideasFor(env, card.firm_scope);
  const playbook = await storedPlaybook(env);
  const library = await researchLibrary(env, card.firm_scope);
  const partnerTopics = ideas.filter((i) => i.origin === "OWNER_IDEA").map((i) => i.topic);
  /** A topic a partner sent is labelled theirs, whatever the model called it, and under whatever subtitle. */
  const listedTopics = ideas.filter((i) => i.origin === "SUGGESTED_LIST").map((i) => i.topic);
  const originOf = (topic: string, said: unknown): TlcIdeaOrigin | null =>
    partnerTopics.some((t) => sameTopic(t, topic)) ? "OWNER_IDEA" : listedTopics.some((t) => sameTopic(t, topic)) ? "SUGGESTED_LIST" : isIdeaOrigin(said) && said !== "OWNER_IDEA" && said !== "SUGGESTED_LIST" ? said : null;
  type Kept = { month: string; topic: string; origin: TlcIdeaOrigin; pick: Record<string, unknown>; sources: Array<{ title: string; url: string }>; categories: Array<{ category: string; why: string; example_brands: string[] }> };
  const draftKey = `topics_draft:${card.id}`;
  const stored = await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(draftKey).first<{ value: string }>();
  const draft: { picks: Record<string, Kept>; alternatives?: Array<Record<string, unknown>> } = { picks: {}, ...(stored ? (JSON.parse(stored.value) as object) : {}) };
  const saveDraft = () => env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by) VALUES (?1, ?2, 'parker') ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')").bind(draftKey, JSON.stringify(draft)).run();
  const draftedTopics = () => Object.values(draft.picks).filter((k) => needIds.has(need.find((e) => e.month === k.month)?.id ?? "")).map((k) => k.topic);
  const started = Date.now();
  const failNote = async (why: string): Promise<TlcRunResult> => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000) WHERE id = ?1")
      .bind(card.id, `• ${now.toISOString().slice(0, 16)}Z nothing sent yet: ${why}. Parker tries again.`).run();
    return { finished: false, blocked: false, progressed: false, detail: `nothing sent: ${why}` };
  };
  const dropped: string[] = [];
  // Keep going while the searches come back quickly; a slow one hands the rest to the next tick.
  for (;;) {
    const pending = need.find((e) => !draft.picks[e.month]);
    if (pending) {
      const taken = new Set([...used, ...draftedTopics()].map((u) => u.toLowerCase()));
      const funded = await fundedEventCount(env);
      const found = await search(env, actorFor(PARKER, card.firm_scope), buildTopicsPrompt([pending.month], [...used, ...draftedTopics()], chosen, { ideas, fundedEvents: funded, playbook, library, part: "picks" }));
      if (!found.ok) return searchFailed(env, card, "Parker", found, now);
      const pick = (((jsonIn(found.text) ?? {}).picks as Array<Record<string, unknown>> | undefined) ?? []).find((p) => str(p.month) === pending.month);
      const topic = chosen[pending.month] ?? partnerTopics.find((t) => sameTopic(t, str(pick?.topic))) ?? topicName(str(pick?.topic));
      if (!pick || !topic || taken.has(topic.toLowerCase())) return failNote(`${monthWords(pending.month)} had no usable pick`);
      if (doNotRun(topic)) return failNote(`${monthWords(pending.month)} (${topic}): ${doNotRun(topic)}`);
      if (!isAiTopic(topic) && !str(pick.ai_segment)) return failNote(`${monthWords(pending.month)} (${topic}): not an AI topic and no AI segment`);
      const listed = ideas.find((i) => sameTopic(i.topic, topic));
      const gate = ideaEligibility({ topic, earliest_month: listed?.earliest_month ?? null, packet: listed ? ideaPacket(listed) ?? { ai_segment: str(pick.ai_segment) } : { ai_segment: str(pick.ai_segment) } }, pending.month, funded);
      if (!chosen[pending.month] && !gate.eligible) return failNote(`${monthWords(pending.month)} (${topic}) is not a primary yet: ${gate.why}`);
      const origin = originOf(topic, pick.origin);
      if (!origin) return failNote(`${monthWords(pending.month)} (${topic}) had no origin label`);
      const sources = ((pick.sources as Array<{ title?: string; url?: string }>) ?? []).map((x) => ({ title: str(x.title), url: str(x.url) })).filter((x) => isUrl(x.url));
      const live: typeof sources = [];
      for (const x of sources) if (await check(x.url)) live.push(x);
      const categories = ((pick.sponsor_categories as Array<{ category?: string; why?: string; example_brands?: string[]; tier?: unknown; bench?: unknown }>) ?? [])
        .map((c) => ({ category: str(c.category), why: str(c.why), example_brands: (c.example_brands ?? []).map(str).filter(Boolean), ...(isTlcTier(c.tier) ? { tier: c.tier } : {}), ...(c.bench === true ? { bench: true } : {}), ...((c as { ai_partner?: unknown }).ai_partner === true ? { ai_partner: true } : {}), ...((c as { frontier_model?: unknown }).frontier_model === true ? { frontier_model: true } : {}) }))
        .filter((c) => c.category);
      if (live.length === 0) return failNote(`${monthWords(pending.month)} (${topic}): no source page answered`);
      if (categories.length < TLC_SPONSOR_CATEGORIES.min) return failNote(`${monthWords(pending.month)} (${topic}): ${categories.length} sponsor categories, ${TLC_SPONSOR_CATEGORIES.min} needed`);
      const kept = categories.slice(0, TLC_SPONSOR_CATEGORIES.max);
      // The AI partner slot every non-AI club carries; added when the pick left it out.
      if (!isAiTopic(topic) && !kept.some((c) => (c as { ai_partner?: boolean }).ai_partner)) kept.push({ category: "AI partner", why: "Every club has an AI angle: cash at any tier, or credits for every guest or an expert who runs the AI segment.", example_brands: [], ai_partner: true } as (typeof kept)[number]);
      draft.picks[pending.month] = { month: pending.month, topic, origin, pick, sources: live, categories: kept };
      await saveDraft();
    } else if (!draft.alternatives) {
      const words = await partnerWords(env, card.firm_scope, now);
      const found = await search(env, actorFor(PARKER, card.firm_scope), buildTopicsPrompt(need.map((e) => e.month), used, chosen, { ideas, partnerWords: words, playbook, library, part: "alternatives", picked: draftedTopics() }));
      if (!found.ok) return searchFailed(env, card, "Parker", found, now);
      const answer = jsonIn(found.text) ?? {};
      // EVERY IDEA A PARTNER WROTE DOWN IS CAPTURED, picked or not, the moment Parker reads it (owner, 22 Oct 2026).
      for (const f of ideasFoundIn(answer.found_ideas, words).filter((x) => !ideas.some((i) => sameTopic(i.topic, x.topic)))) {
        // CREDITED BY WHAT THE EMAIL ITSELF SAYS (22 Oct 2026): a list item with no claim of authorship is a suggested list.
        const origin = creditForQuote(words.find((w) => w.ref === f.ref)?.text ?? "", f.quote);
        await upsertIdea(env, { topic: f.topic, origin, suggestedBy: origin === "OWNER_IDEA" ? f.who : `Suggested list (in ${f.who}'s email)`, suggestedAt: f.at, note: `"${f.quote.slice(0, 200)}"`, sourceRef: f.ref, firmScope: card.firm_scope });
        if (origin === "OWNER_IDEA") partnerTopics.push(f.topic);
      }
      const alts = (answer.alternatives as Array<Record<string, unknown>> | undefined) ?? [];
      // A partner's idea goes under the partner's own name, so the list shows it where it stands.
      for (const a of alts) a.topic = partnerTopics.find((t) => sameTopic(t, str(a.topic))) ?? topicName(str(a.topic));
      const usable = alts.filter((a) => str(a.topic) && str(a.reason) && Array.isArray(a.brands) && a.brands.length > 0 && originOf(str(a.topic), a.origin) && !new Set([...used, ...draftedTopics()].map((u) => u.toLowerCase())).has(str(a.topic).toLowerCase()));
      if (new Set(usable.map((a) => str(a.topic).toLowerCase())).size < TLC_ALTERNATIVES) return failNote(`${usable.length} of ${TLC_ALTERNATIVES} alternatives were usable`);
      draft.alternatives = usable;
      await saveDraft();
    } else break;
    if (Date.now() - started > 45_000) {
      return { finished: false, blocked: false, progressed: true, detail: `drafting: ${Object.keys(draft.picks).length} of ${need.length} picks${draft.alternatives ? " and the alternatives" : ""} in; the next tick continues` };
    }
  }
  const kept = need.map((ev) => ({ ...draft.picks[ev.month]!, ev, origin: originOf(draft.picks[ev.month]!.topic, draft.picks[ev.month]!.origin) ?? draft.picks[ev.month]!.origin }));
  const taken = new Set(kept.map((k) => k.topic.toLowerCase()));
  const alternatives: TopicsEmailAlternative[] = [];
  const regulatory: string[] = kept.filter((k) => str(k.pick.regulatory_note)).map((k) => `${k.topic}: ${str(k.pick.regulatory_note)}`);
  for (const a of draft.alternatives ?? []) {
    const topic = str(a.topic);
    const reason = str(a.reason);
    const brands = (Array.isArray(a.brands) ? a.brands : []).map(str).filter(Boolean).slice(0, 3);
    const origin = originOf(topic, a.origin);
    if (!origin || !topic || !reason || brands.length === 0 || doNotRun(topic) || taken.has(topic.toLowerCase()) || alternatives.some((x) => x.topic.toLowerCase() === topic.toLowerCase())) continue;
    alternatives.push({ topic, origin, reason: /[.!?]$/.test(reason) ? reason : `${reason}.`, brands });
    if (str(a.regulatory_note)) regulatory.push(`${topic}: ${str(a.regulatory_note)}`);
  }
  /*
   * EVERY MONTH, OR NO EMAIL (owner, 22 Oct 2026: "only gave 2 picks Jan and Feb — what happened to 3 picks").
   * A partial set is never written or sent; the draft is cleared so the next attempt starts clean.
   */
  if (kept.length < need.length || alternatives.length < TLC_ALTERNATIVES) {
    await env.WP_OS_DB.prepare("DELETE FROM tlc_setting WHERE key = ?1").bind(draftKey).run();
    return failNote(`${kept.length} of ${need.length} picks and ${alternatives.length} of ${TLC_ALTERNATIVES} alternatives were usable`);
  }

  const until = vetoUntil(now);
  for (const k of kept) {
    const packet = {
      topic: k.topic, angle: str(k.pick.angle), why_now: str(k.pick.why_now), criteria: k.pick.criteria ?? null,
      hands_on: str(k.pick.hands_on), take_home: str(k.pick.take_home), teacher_profile: str(k.pick.teacher_profile),
      ...(str(k.pick.ai_segment) ? { ai_segment: str(k.pick.ai_segment) } : {}),
      run_of_show: runOfShowLines(str(k.pick.ai_segment) || null), sources: k.sources,
    };
    await env.WP_OS_DB.prepare(
      "UPDATE tlc_event SET topic = ?2, angle = ?3, packet_json = ?4, sponsor_categories_json = ?5, status = 'TOPIC_PROPOSED', veto_until = ?6, topic_card_id = ?7, swap_flagged_at = NULL, updated_at = ?8 WHERE id = ?1",
    ).bind(k.ev.id, packet.topic, packet.angle, JSON.stringify(packet), JSON.stringify(k.categories), until, card.id, now.toISOString()).run();
  }
  // THE GLOSSY ONE-SHEET PER PICK, as a brand would see it: linked, and attached so it opens from the inbox.
  const { attachments, problems: pdfProblems } = await onePagerAttachments(env, kept.map((k) => k.ev.id), renderPdf);
  const email = topicsEmail({
    months: need.map((e) => e.month),
    picks: kept.map((k) => ({ month: k.ev.month, topic: k.topic, origin: k.origin, angle: str(k.pick.angle), categories: k.categories.map((c) => c.category), onePagerUrl: onePagerUrl(k.ev.id) })),
    alternatives: alternatives.slice(0, TLC_ALTERNATIVES),
    goAheadOn: until.slice(0, 10),
  });
  await emailOwner(env, { employee: "Parker", email, objectType: "work_card", objectId: card.id, cardId: card.id, cardKind: card.kind, firmScope: card.firm_scope, attachments });
  await env.WP_OS_DB.prepare("DELETE FROM tlc_setting WHERE key = ?1").bind(draftKey).run();
  // The record keeps everything, including the alternatives; the partners' email carries only the picks and the list.
  await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || ?2, 1, 16000) WHERE id = ?1")
    .bind(card.id, [
      `• Proposed ${kept.map((k) => `${k.ev.month} ${k.topic} [${TLC_IDEA_ORIGIN_LABEL[k.origin]}]`).join("; ")}. Proceeds ${until} unless a partner says no.`,
      `• Alternatives: ${alternatives.slice(0, TLC_ALTERNATIVES).map((a) => `${a.topic} [${TLC_IDEA_ORIGIN_LABEL[a.origin]}]`).join("; ")}.`,
      regulatory.length ? `• Regulatory check (card only, never emailed): ${regulatory.join(" | ")}` : "",
      dropped.length ? `• Parker's notes (not emailed): ${dropped.join("; ")}.` : "",
      pdfProblems.length ? `• One-sheet PDFs not attached (linked instead): ${pdfProblems.join("; ")}` : "",
    ].filter(Boolean).join("\n")).run();
  // REGULATORY CHECKS GO TO THE LIBRARY (and the card), never the email.
  for (const r of regulatory) await addResearch(env, { kind: "REGULATORY", title: r.slice(r.indexOf(":") + 1).trim(), topic: r.slice(0, r.indexOf(":")), foundAt: now.toISOString(), foundBy: "Parker", cardId: card.id, firmScope: card.firm_scope });
  // THE IDEAS LIST SAYS WHERE EACH ONE STANDS: picked for a month, in the alternatives, or later.
  for (const k of kept) await upsertIdea(env, { topic: k.topic, origin: k.origin, suggestedBy: "Parker", suggestedAt: now.toISOString(), sourceRef: card.id, status: "PICKED", month: k.ev.month, cardId: card.id, firmScope: card.firm_scope });
  for (const a of alternatives.slice(0, TLC_ALTERNATIVES)) await upsertIdea(env, { topic: a.topic, origin: a.origin, suggestedBy: "Parker", suggestedAt: now.toISOString(), note: a.reason, sourceRef: card.id, status: "ALTERNATIVE", cardId: card.id, firmScope: card.firm_scope });
  // HELD UNTIL THE WINDOW CLOSES. A partner's reply lands on this card as a note and is read then.
  return { finished: false, blocked: false, progressed: true, held: true, waitUntil: until, detail: `proposed ${kept.length} topic(s) and ${TLC_ALTERNATIVES} alternatives; ${TLC_VETO_DAYS}-day veto window until ${until}` };
}

/**
 * THE TWO DOCUMENTS PER MONTH AS RENDERED PDFs (22 Oct 2026). Until today each one-sheet was
 * attached as its raw HTML source (`text/html`), and the owner opened files of code. Each month now
 * gets the brand pitch and the internal one-pager, each printed by the browser onto one letter page
 * and checked by `renderedPdfProblem` before it may leave: a file that is not a rendered PDF naming
 * its topic is never attached. The email still links every month, and a missing PDF's reason goes
 * on the card.
 */
export async function onePagerAttachments(env: Env, eventIds: readonly string[], renderPdf: PdfRenderer): Promise<{ attachments: EmailAttachment[]; problems: string[] }> {
  const attachments: EmailAttachment[] = [];
  const problems: string[] = [];
  for (const id of eventIds) {
    const ev = (await eventsFrom(env, "SELECT * FROM tlc_event WHERE id = ?1", id))[0];
    if (!ev?.topic) continue;
    const base = `TLC ${monthWords(ev.month)} - ${ev.topic.replace(/[^\w &-]+/g, "").trim()}`;
    for (const doc of [
      { name: `${base} - brand pitch.pdf`, html: renderBrandPitch(clubViewOf(ev)) },
      { name: `${base} - internal one-pager.pdf`, html: renderInternalOnePager(await internalViewOf(env, ev)) },
    ]) {
      const out = await renderPdf(doc.html);
      if (out.pdfBase64 === null) { problems.push(`${doc.name}: ${out.reason}`); continue; }
      const bytes = Uint8Array.from(atob(out.pdfBase64), (c) => c.charCodeAt(0));
      const problem = (await renderedPdfProblem(bytes, ev.topic)) ?? (out.pageCount !== 1 ? `it ran to ${out.pageCount} pages` : null);
      if (problem) { problems.push(`${doc.name}: ${problem}`); continue; }
      attachments.push({ filename: doc.name, content: out.pdfBase64, contentType: "application/pdf" });
    }
  }
  return { attachments, problems };
}

const onePagerUrl = (eventId: string): string => `https://os.joinwestpeek.com/api/tlc/events/${eventId}/onepager`;
/** The call link a brand gets with the pitch after a yes (set by a partner on the Rooms page). */
export const CALL_LINK_SETTING = "call_link";
/** The brand pitch's public, read-only address: no login, the unguessable token is the credential. */
export const pitchPublicUrl = (token: string): string => `https://os.joinwestpeek.com/api/tlc-pitch/${token}`;
/** The club's one-page brand pitch as a PDF attachment, or none when it cannot be rendered (the link still carries it). */
export async function renderPdfFor(env: Env, view: TlcClubView, topic: string): Promise<EmailAttachment[]> {
  const pdf = await renderHtmlPdf(env, renderBrandPitch(view), { onePage: true });
  return pdf.pdfBase64 ? [{ filename: `The Learning Club - ${topic.replace(/[^\w &-]+/g, "").trim()}.pdf`, content: pdf.pdfBase64, contentType: "application/pdf" }] : [];
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
  const found = await search(env, actorFor(PARKER, card.firm_scope), buildBookingPackPrompt(ev, await storedPlaybook(env), await researchLibrary(env, card.firm_scope)));
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
  await emailOwner(env, {
    employee: "Parker",
    email: {
      what: `TLC booking pack, ${monthWords(ev.month)}`,
      tldr: `Options for you to book and pay; I have booked nothing. The cheapest full plan costs $${totals.costUsd.toLocaleString("en-US")} (budget $${goalOf(ev).costBudgetUsd.toLocaleString("en-US")}) and nets $${totals.netUsd.toLocaleString("en-US")} against agreed sponsor cash of $${totals.sponsorCashUsd.toLocaleString("en-US")}.`,
      sections: [
        { label: "Totals", bullets: [...totals.lines.map((l) => `${l.what}: ${l.name}, $${l.priceUsd.toLocaleString("en-US")}`), `Cost $${totals.costUsd.toLocaleString("en-US")} (best case with a donated venue $${totals.bestCaseCostUsd.toLocaleString("en-US")}) — ${totals.costUsd <= goalOf(ev).costBudgetUsd ? "inside" : "OVER"} the $${goalOf(ev).costBudgetUsd.toLocaleString("en-US")} budget`, `Net vs $10,000 target: ${totals.vsTarget >= 0 ? "met" : `$${(-totals.vsTarget).toLocaleString("en-US")} short`}; vs $7,500 floor: ${totals.vsFloor >= 0 ? "met" : `$${(-totals.vsFloor).toLocaleString("en-US")} short`}`] },
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

/*
 * ONE CLUB PER TICK (24 Oct 2026). The first live batch searched all three clubs and all nine must-pitch
 * brands in one prompt; on her Mac's Claude Code seat that ran past the router's 230 s search wait twice
 * (subscription_seat_run ccr_ef003b2e…, 16:25Z and 17:01Z, both ABANDONED) while every single-club search
 * on 22 Oct answered in 114–159 s. So the card now works the open clubs one at a time, nearest month first:
 * each tick searches ONE club's brands plus the must-pitch brands whose earliest open month is that club,
 * records what it did on the event spine (`tlc.batch_club_done`), and hands the card back. The last club's
 * tick writes the card's summary from those records.
 */
interface BatchClubRecord { event_id: string; month: string; part?: "must" | "picks" | "picks2"; added: string[]; dropped: string[]; queued: string[]; wayIn: string[]; changed: number }

async function batchRecords(env: Env, cardId: string): Promise<BatchClubRecord[]> {
  const rows = (await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'tlc.batch_club_done' ORDER BY created_at").bind(cardId).all<{ payload_json: string }>()).results ?? [];
  return rows.map((r) => JSON.parse(r.payload_json) as BatchClubRecord);
}

async function runBrandBatch(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>, pageText: (u: string) => Promise<string | null>): Promise<TlcRunResult> {
  const events = await openEvents(env, now, card.firm_scope);
  if (events.length === 0) {
    await finish(env, card.id, "• No club is open for selling this week.");
    return { finished: true, blocked: false, progressed: false, detail: "no open club" };
  }
  const done = await batchRecords(env, card.id);
  const next = await nextBatchStep(env, card, events, done);
  if (next) {
    const rec = await brandBatchForClub(env, card, next.ev, events, next.part, now, search, check, pageText);
    if ("failed" in rec) return rec.failed;
    await appendEvent(env, { eventType: "tlc.batch_club_done", actorType: "ai_employee", actorId: WYNN, objectType: "work_card", objectId: card.id, firmScope: card.firm_scope, payload: rec as unknown as Record<string, unknown> });
    done.push(rec);
    if (await nextBatchStep(env, card, events, done)) {
      return { finished: false, blocked: false, progressed: true, detail: `${monthWords(next.ev.month)} (${next.part === "must" ? "brands we must pitch" : next.part === "picks" ? "Wynn's own picks" : "Wynn's own picks, second search"}): ${rec.added.length + rec.queued.length} brand(s) queued; the next search follows on the next tick` };
    }
  }
  const added = done.flatMap((d) => d.added);
  const dropped = done.flatMap((d) => d.dropped);
  const queued = done.flatMap((d) => d.queued);
  const wayIn = done.flatMap((d) => d.wayIn);
  const changed = done.reduce((n, d) => n + d.changed, 0);
  const mustLines = [queued.length ? `• Brands we must pitch, queued first: ${queued.join("; ")}.` : "", ...wayIn.map((w) => `• Needs a way in: ${w}`)].filter(Boolean);
  // NEVER A NAG: a week whose only news is a new or changed "Needs a way in" item finishes, and the item
  // itself is the stop she sees (TLC panel and Approvals). An unchanged week with nothing queued blocks as before.
  // A week where every club was covered by Parker's list (or its goal) is a finished week, never a nag.
  const coveredLines: string[] = [];
  for (const ev of events) {
    const c = await clubCovered(env, ev);
    if (c) coveredLines.push(c === "goal" ? `• ${monthWords(ev.month)}: its sponsor goal is reached, so its outreach has stopped.` : `• ${monthWords(ev.month)}: Parker's list still has brands ready, so Wynn pitches from it this week (about ${TLC_NEW_BRANDS_PER_EVENT_WEEK} new brands).`);
  }
  if (added.length === 0 && queued.length === 0 && changed === 0 && coveredLines.length === events.length) {
    await finish(env, card.id, [...coveredLines, ...mustLines].join("\n"));
    return { finished: true, blocked: false, progressed: false, detail: `${coveredLines.length} club(s) covered by Parker's list or their goal` };
  }
  if (added.length === 0 && queued.length === 0 && changed === 0) {
    return nothingGood(env, card, "Wynn", [`No brand came with an address that is really on its page (${dropped.slice(0, 6).join("; ") || "nothing returned"}). Name brands or a category to try and Wynn runs it again.`, ...mustLines].join("\n"));
  }
  const gate = brandSendGate(await tlcSettings(env), await tlcOutside(env), await contentHashes(env));
  await finish(env, card.id, [...coveredLines, ...mustLines, added.length ? `• ${added.length} brand(s) queued for the four-email sequence: ${added.join("; ")}.` : "", gate.open ? "• Sending is on: each email waits for a partner's approval on Approvals." : `• NOTHING SENT: ${gate.reasons.join("; ")}. The emails are composed and held.`, dropped.length ? `• Left out: ${dropped.join("; ")}.` : ""].filter(Boolean).join("\n"));
  return { finished: true, blocked: false, progressed: false, detail: `${added.length + queued.length} brand(s) queued${wayIn.length ? `, ${wayIn.length} need a way in` : ""}` };
}

/*
 * TWO SMALLER SEARCHES PER CLUB (24 Oct 2026, measured). One club's search for five brands plus its must-pitch
 * brands took 126 s in a terminal and 272 s in the claimer's own working directory — past the seat's 230 s
 * window, so it was ABANDONED a third time (17:35Z). Each club is now two searches: its must-pitch brands
 * alone (when it has any), then TLC_BRANDS_PER_SEARCH of Wynn's own picks. The weekly batch adds more.
 */
async function mustFor(env: Env, card: SweepCard, ev: TlcEventRow, events: readonly TlcEventRow[], existing: ReadonlyArray<{ brand: string; event_id: string }>) {
  // A brand on her list for several months is handled once, on its earliest open month, for all its months together.
  return (await mustPitchToSearch(env, events, existing, card.firm_scope)).filter((m) => [...m.months].sort()[0] === ev.month);
}

async function batchDeals(env: Env, events: readonly TlcEventRow[]): Promise<Array<{ brand: string; event_id: string }>> {
  return (await env.WP_OS_DB.prepare(`SELECT brand, event_id FROM tlc_deal WHERE event_id IN (${events.map(() => "?").join(",")})`).bind(...events.map((e) => e.id)).all<{ brand: string; event_id: string }>()).results ?? [];
}

/** Wynn's own brands one search asks for: none in the must-pitch search, then 3, then the rest of the club's 5. */
const picksIn = (part: "must" | "picks" | "picks2"): number => (part === "must" ? 0 : part === "picks" ? TLC_BRANDS_PER_SEARCH : TLC_BRANDS_PER_CLUB - TLC_BRANDS_PER_SEARCH);

async function nextBatchStep(env: Env, card: SweepCard, events: readonly TlcEventRow[], done: readonly BatchClubRecord[]): Promise<{ ev: TlcEventRow; part: "must" | "picks" | "picks2" } | null> {
  // A record written before the two-search split (no `part`, 24 Oct 2026 18:10Z) that queued and dropped
  // none of Wynn's own picks was a must-pitch search in effect: the club still gets its picks search.
  const partOf = (d: BatchClubRecord): "must" | "picks" | "picks2" => d.part ?? (d.added.length + d.dropped.length > 0 ? "picks" : "must");
  const has = (ev: TlcEventRow, part: "must" | "picks" | "picks2") => done.some((d) => d.event_id === ev.id && partOf(d) === part);
  const existing = await batchDeals(env, events);
  for (const ev of events) {
    // MORE VOLUME (owner, 26 Oct 2026): a club that reached its goal gets no search; a club whose list from Parker still
    // holds a week's worth of brands needs no search of Wynn's own picks this week.
    const covered = await clubCovered(env, ev);
    if (covered === "goal") continue;
    if (!has(ev, "must") && !has(ev, "picks") && (await mustFor(env, card, ev, events, existing)).length > 0) return { ev, part: "must" };
    if (covered === "list") continue;
    if (!has(ev, "picks")) return { ev, part: "picks" };
    // OWNER, 24 Oct 2026: about five new brands per club per week, in two searches small enough for the seat.
    if (!has(ev, "picks2")) return { ev, part: "picks2" };
  }
  return null;
}

/** Why a club needs no search of Wynn's own this week: its goal is reached, or Parker's list still holds a week's worth. */
async function clubCovered(env: Env, ev: TlcEventRow): Promise<"goal" | "list" | null> {
  const { outreachStopped, readyCount } = await import("./tlcVolume");
  if (await outreachStopped(env, ev)) return "goal";
  return (await readyCount(env, ev.id)) >= TLC_BENCH_LOW ? "list" : null;
}

/** One search for one club: either its must-pitch brands alone, or up to TLC_BRANDS_PER_SEARCH of Wynn's own picks. */
async function brandBatchForClub(
  env: Env, card: SweepCard, ev: TlcEventRow, events: readonly TlcEventRow[], part: "must" | "picks" | "picks2", now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>, pageText: (u: string) => Promise<string | null>,
): Promise<BatchClubRecord | { failed: TlcRunResult }> {
  const existing = await batchDeals(env, events);
  // BRANDS WE MUST PITCH FIRST (owner, 23 Oct 2026), outside the five-per-club cap, in their own search.
  const must = part === "must" ? await mustFor(env, card, ev, events, existing) : [];
  const ownerContacted = await ownerContactedBrands(env, card.firm_scope);
  const mustNames = [...(await liveMustPitch(env, card.firm_scope)).map((r) => r.brand)];
  const found = await search(env, actorFor(WYNN, card.firm_scope), buildBrandBatchPrompt([ev], [...existing.map((d) => d.brand), ...mustNames], await storedPlaybook(env), part === "must" ? [] : await researchLibrary(env, card.firm_scope), must, picksIn(part)));
  if (!found.ok) return { failed: await searchFailed(env, card, "Wynn", found, now) };
  const parsed = jsonIn(found.text);
  const findings: MustPitchFinding[] = ((parsed?.must_pitch as Array<Record<string, unknown>> | undefined) ?? []).map((m) => ({
    brand: str(m.brand),
    contact_name: str(m.contact_name),
    contact_email: str(m.contact_email),
    contact_source_url: str(m.contact_source_url),
    pages_checked: Array.isArray(m.pages_checked) ? m.pages_checked.map(str).filter(Boolean) : [],
  }));
  const mp = await handleMustPitch(env, { events, existing, findings, firmScope: card.firm_scope, now, onlyBrands: new Set(must.map((m) => brandKey(m.brand))) }, check, pageText);
  const brands = part === "must" ? [] : ((parsed?.brands as Array<Record<string, unknown>> | undefined) ?? []);
  const added: string[] = [];
  const dropped: string[] = [];
  let count = 0;
  const mustKeys = new Set((await liveMustPitch(env, card.firm_scope)).map((r) => `${r.month}|${brandKey(r.brand)}`));
  for (const b of brands) {
    if (str(b.month) && str(b.month) !== ev.month) continue;
    const brand = str(b.brand);
    const email = str(b.contact_email).toLowerCase();
    const source = str(b.contact_source_url);
    if (!brand) continue;
    // A must-pitch brand was handled above, first; it is never a second, capped pick.
    if (mustKeys.has(`${ev.month}|${brandKey(brand)}`)) continue;
    // She wrote to this brand herself: Wynn never does, in any month.
    if (ownerContacted.has(brandKey(brand))) { dropped.push(`${brand}: Sequoia contacted them directly`); continue; }
    if (count >= picksIn(part)) { dropped.push(`${brand}: over the ${picksIn(part)}-a-search limit`); continue; }
    const never = list<{ excluded_brands?: string[] }>(ev.sponsor_categories_json).flatMap((c) => c.excluded_brands ?? []);
    if (never.some((n) => brand.toLowerCase().includes(n.toLowerCase()) || n.toLowerCase().includes(brand.toLowerCase()))) { dropped.push(`${brand}: competes with a featured partner`); continue; }
    const cat = str(b.category);
    if (isBettingCategory(`${cat} ${brand}`) && ev.month <= TLC_NO_BETTING_THROUGH) { dropped.push(`${brand}: betting brands stay out of Q1 2027`); continue; }
    const mix = sponsorMixProblems(ev.month, [...list<{ category: string; bench?: boolean }>(ev.sponsor_categories_json), { category: cat }]);
    if (mix.length) { dropped.push(`${brand}: ${mix.join("; ")}`); continue; }
    if (existing.some((d) => d.event_id === ev.id && d.brand.toLowerCase() === brand.toLowerCase())) continue;
    // THE ADDRESS IS READ OFF THE PAGE, not taken on the model's word — the one check, shared with must-pitch.
    const notOnPage = await addressReadOffPage(email, source, check, pageText);
    if (notOnPage) { dropped.push(`${brand}: ${notOnPage}`); continue; }
    if (await queueDeal(env, { eventId: ev.id, brand, category: cat || null, contactName: str(b.contact_name) || null, contactEmail: email, contactSourceUrl: source, whyFit: str(b.why_fit) || null, firmScope: card.firm_scope }, now)) {
      added.push(`${brand} (${monthWords(ev.month)})`);
      count += 1;
    }
  }
  return { event_id: ev.id, month: ev.month, part, added, dropped, queued: mp.queued, wayIn: mp.wayIn, changed: mp.changed };
}

// ── Wynn: the trend story ───────────────────────────────────────────────────────────────────────

async function runTrendStory(env: Env, card: SweepCard, now: Date, search: TlcSearch, check: (u: string) => Promise<boolean>): Promise<TlcRunResult> {
  const found = await search(env, actorFor(WYNN, card.firm_scope), buildTrendPrompt(await storedPlaybook(env), await researchLibrary(env, card.firm_scope)));
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
  /*
   * BACKGROUND, NOT A DECISION (owner, 22 Oct 2026: "what is this TLC trend story? does it need to be emailed?").
   * The story and every fact under it go into the research library on the Rooms page, dated and sourced,
   * and nobody is emailed. Parker and Wynn read the library whenever they build or sell a club.
   */
  await addResearch(env, { kind: "TREND_STORY", title: `Trend story ${quarter}`, body: story, foundAt: now.toISOString(), foundBy: "Wynn", cardId: card.id, firmScope: card.firm_scope });
  for (const s of live) await addResearch(env, { kind: "TREND_STORY", title: s.claim, sourceTitle: `${s.title}${s.publisher ? `, ${s.publisher}` : ""}`, sourceUrl: s.url, publishedOn: s.published_on, foundAt: now.toISOString(), foundBy: "Wynn", cardId: card.id, firmScope: card.firm_scope });
  // Wynn's research feeds the ideas list, each labelled with where it came from.
  const ideaNames: string[] = [];
  for (const i of ((raw.topic_ideas as Array<Record<string, unknown>>) ?? []).slice(0, 5)) {
    const topic = str(i.topic);
    if (!topic || !isIdeaOrigin(i.origin) || i.origin === "OWNER_IDEA" || i.origin === "SUGGESTED_LIST") continue;
    await upsertIdea(env, { topic, origin: i.origin, suggestedBy: "Wynn", suggestedAt: now.toISOString(), note: str(i.reason) || null, sourceRef: card.id, firmScope: card.firm_scope });
    const url = str(i.source_url);
    await addResearch(env, { kind: i.origin === "BRANDS_SPENDING" ? "BRAND_SPEND" : "TREND", title: str(i.reason) || topic, topic, sourceTitle: str(i.source_title) || null, sourceUrl: isUrl(url) && (await check(url)) ? url : null, foundAt: now.toISOString(), foundBy: "Wynn", cardId: card.id, firmScope: card.firm_scope });
    ideaNames.push(`${topic} (${TLC_IDEA_ORIGIN_LABEL[i.origin]})`);
  }
  await finish(env, card.id, `• Trend story ${quarter} stored with ${live.length} live sources.${ideaNames.length ? ` Ideas added to the list: ${ideaNames.join("; ")}.` : ""}`);
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
  await emailOwner(env, { employee: "Wynn", email: mail, objectType: "work_card", objectId: card.id, cardId: card.id, cardKind: card.kind, firmScope: card.firm_scope });
  const why = await blockCard(env, card, { reason: "a_question_for_you", trying: card.title, employee: "Wynn", detail: `${mail.tldr} Reply "yes", "no" or "counter $X".` });
  return { finished: false, blocked: true, progressed: false, detail: why };
}

/** TLC brand sales, asked of the one function that decides outside email. */
async function tlcOutside(env: Env): Promise<{ allowed: boolean; code: string; reason: string }> {
  return outsideEmailAllowed(env, { job: TLC_BRAND_SALES_JOB });
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
    out.push({ ...ev, days_out: daysUntil(ev.event_date, now), economics: econ, tickets: ticketVerdict(econ.paidTickets, seatsOf(ev)), seats: seatsOf(ev), goal: goalOf(ev), deals: await dealsFor(ctx.env, ev.id) });
  }
  const settings = await tlcSettings(ctx.env);
  const held = (await ctx.env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM tlc_drip_message WHERE state = 'HELD'").first<{ n: number }>())?.n ?? 0;
  return json({
    events: out.map((e) => ({ ...e, one_pager_url: e.topic ? onePagerUrl(e.id) : null })),
    send_gate: brandSendGate(settings, await tlcOutside(ctx.env), await contentHashes(ctx.env)),
    approvals: await approvalsView(ctx.env, settings),
    settings,
    held_emails: held,
    ideas: await ideasWithNotes(ctx.env),
    research_links: await researchLinks(ctx.env),
    playbook_document_id: settings[PLAYBOOK_DOCUMENT_SETTING] ?? null,
    research: (await researchLibrary(ctx.env)).map((r) => ({ ...r, kind_label: TLC_RESEARCH_LABEL[r.kind] })),
  });
}

const ideaSchema = z.object({ topic: z.string().trim().min(2).max(160), note: z.string().trim().max(600).optional(), preferred_month: z.string().regex(/^\d{4}-\d{2}$/).optional() });

/** POST /api/tlc/ideas — a partner adds a topic idea to the list. It is labelled theirs and Parker reads it first. */
export async function handleTlcIdeaAdd(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "only a partner adds an idea here" }, { status: 403 });
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = ideaSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "an idea needs a topic (2–160 characters)" }, { status: 400 });
  const who = PARTNERS.find((p) => p.firmUserId === actor.firmUserId)?.firstName ?? ctx.identity!.id;
  await upsertIdea(ctx.env, { topic: parsed.data.topic, origin: "OWNER_IDEA", suggestedBy: who, suggestedAt: new Date().toISOString(), note: parsed.data.note ?? null, preferredMonth: parsed.data.preferred_month ?? null, sourceRef: "rooms_tab" });
  return json({ ok: true, ideas: await ideasFor(ctx.env) });
}

/**
 * POST /api/tlc/ideas/:id/drop and /restore — a partner sets an idea aside or brings it back. A dropped idea
 * stays on the list, marked, with who dropped it and when. Nothing is ever deleted.
 */
export async function handleTlcIdeaStatus(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "only a partner drops or restores an idea" }, { status: 403 });
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const drop = new URL(ctx.request.url).pathname.endsWith("/drop");
  const now = new Date().toISOString();
  const res = drop
    ? await ctx.env.WP_OS_DB.prepare("UPDATE tlc_idea SET status = 'DROPPED', dropped_by = ?2, dropped_at = ?3, updated_at = ?3 WHERE id = ?1").bind(ctx.params.id, ctx.identity!.id, now).run()
    : await ctx.env.WP_OS_DB.prepare("UPDATE tlc_idea SET status = 'LATER', status_month = NULL, dropped_by = NULL, dropped_at = NULL, updated_at = ?2 WHERE id = ?1 AND status = 'DROPPED'").bind(ctx.params.id, now).run();
  if (!res.meta.changes) return json({ error: "not_found", detail: "no idea by that id to change" }, { status: 404 });
  return json({ ok: true, ideas: await ideasFor(ctx.env) });
}

// ── Notes on an idea, and the research pages (owner, 23 Oct 2026) ─────────────────────────────

export interface TlcIdeaNoteRow { id: string; idea_id: string; body: string; author: string; created_at: string }
export interface TlcResearchLinkRow { id: string; title: string; url: string; added_by: string; added_at: string }

/** Every idea with its origin label and its notes, oldest note first. */
export async function ideasWithNotes(env: Env, firmScope = "west-peek"): Promise<Array<TlcIdeaRow & { origin_label: string; notes: TlcIdeaNoteRow[] }>> {
  const notes = (await env.WP_OS_DB.prepare("SELECT id, idea_id, body, author, created_at FROM tlc_idea_note WHERE firm_scope = ?1 ORDER BY created_at, id").bind(firmScope).all<TlcIdeaNoteRow>()).results ?? [];
  return (await ideasFor(env, firmScope)).map((i) => ({ ...i, origin_label: TLC_IDEA_ORIGIN_LABEL[i.origin], notes: notes.filter((n) => n.idea_id === i.id) }));
}

export async function researchLinks(env: Env, firmScope = "west-peek"): Promise<TlcResearchLinkRow[]> {
  return (await env.WP_OS_DB.prepare("SELECT id, title, url, added_by, added_at FROM tlc_research_link WHERE firm_scope = ?1 ORDER BY added_at DESC, id").bind(firmScope).all<TlcResearchLinkRow>()).results ?? [];
}

const ideaNoteSchema = z.object({ body: z.string().trim().min(2).max(600) });

/** POST /api/tlc/ideas/:id/notes — a partner adds a note under an idea. Who and when are kept; nothing is edited or deleted. */
export async function handleTlcIdeaNote(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "only a partner adds a note to an idea" }, { status: 403 });
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = ideaNoteSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "a note needs a few words (2–600 characters)" }, { status: 400 });
  const idea = await ctx.env.WP_OS_DB.prepare("SELECT id, firm_scope FROM tlc_idea WHERE id = ?1").bind(ctx.params.id).first<{ id: string; firm_scope: string }>();
  if (!idea) return json({ error: "not_found", detail: "no idea by that id" }, { status: 404 });
  const who = PARTNERS.find((p) => p.firmUserId === actor.firmUserId)?.firstName ?? ctx.identity!.id;
  await ctx.env.WP_OS_DB.prepare("INSERT INTO tlc_idea_note (id, idea_id, body, author, created_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6)")
    .bind(`tln_${crypto.randomUUID()}`, idea.id, parsed.data.body, who, new Date().toISOString(), idea.firm_scope).run();
  return json({ ok: true, ideas: await ideasWithNotes(ctx.env) });
}

const researchLinkSchema = z.object({ title: z.string().trim().min(2).max(160), url: z.string().trim().url().max(500).refine((u) => /^https:\/\//i.test(u), "https only") });

/** POST /api/tlc/research-links — a partner adds a research page (title + link) to the Research library. */
export async function handleTlcResearchLinkAdd(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return json({ error: "forbidden", detail: "only a partner adds a research link" }, { status: 403 });
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = researchLinkSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "a research link needs a title and an https:// address" }, { status: 400 });
  const who = PARTNERS.find((p) => p.firmUserId === actor.firmUserId)?.firstName ?? ctx.identity!.id;
  await ctx.env.WP_OS_DB.prepare("INSERT INTO tlc_research_link (id, title, url, added_by, added_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, 'west-peek')")
    .bind(`trl_${crypto.randomUUID()}`, parsed.data.title, parsed.data.url, who, new Date().toISOString()).run();
  return json({ ok: true, research_links: await researchLinks(ctx.env) });
}

const settingSchema = z.object({
  what: z.enum(["pitch", "playbook", "brand_send_on", "brand_send_off", "call_link"]),
  /** The hash of the content the partner was shown. An approval of anything else is refused. */
  hash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  call_link: z.string().url().max(400).optional(),
});

/** Partners only: the two people in the partner registry, signed in as themselves. */
function partnerOf(ctx: RouteContext): (typeof PARTNERS)[number] | null {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN") return null;
  return PARTNERS.find((p) => p.firmUserId === actor.firmUserId) ?? null;
}

/**
 * POST /api/tlc/approve — the brand-send screen's buttons. PARTNERS ONLY. An approval is of exact
 * content: the request carries the hash of what the partner was shown, it must equal the hash of
 * what would be sent now, and that hash is what is stored. "Start sending" is refused until both
 * approvals hold for the current content; "Stop sending" always works.
 */
export async function handleTlcApprove(ctx: RouteContext): Promise<Response> {
  const partner = partnerOf(ctx);
  if (!partner) return json({ error: "forbidden", detail: "only a partner approves" }, { status: 403 });
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const parsed = settingSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input" }, { status: 400 });
  const now = new Date().toISOString();
  const set = (key: string, value: string) =>
    ctx.env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value, set_by, set_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(key) DO UPDATE SET value = excluded.value, set_by = excluded.set_by, set_at = excluded.set_at")
      .bind(key, value, ctx.identity!.id, now).run();
  const w = parsed.data.what;
  const hashes = await contentHashes(ctx.env);
  if (w === "pitch" || w === "playbook") {
    const current = w === "pitch" ? hashes.pitch : hashes.playbook;
    if (parsed.data.hash !== current) {
      return json({ error: "changed", detail: `the ${w === "pitch" ? "brand pitch" : "playbook"} changed since this page loaded; look at it again, then approve` }, { status: 409 });
    }
    await set(w === "pitch" ? PITCH_APPROVAL_HASH_SETTING : PLAYBOOK_APPROVAL_HASH_SETTING, current);
  }
  if (w === "call_link") {
    if (!parsed.data.call_link || !/^https:\/\//.test(parsed.data.call_link)) return json({ error: "invalid_input", detail: "a call link starts with https://" }, { status: 400 });
    await set(CALL_LINK_SETTING, parsed.data.call_link);
  }
  if (w === "brand_send_off") await set(BRAND_SEND_SETTING, "off");
  if (w === "brand_send_on") {
    const s = await tlcSettings(ctx.env);
    if (approvalState(s, PITCH_APPROVAL_HASH_SETTING, hashes.pitch) !== "APPROVED" || approvalState(s, PLAYBOOK_APPROVAL_HASH_SETTING, hashes.playbook) !== "APPROVED") {
      return json({ error: "not_approved", detail: "approve the current brand pitch and playbook first" }, { status: 409 });
    }
    await set(BRAND_SEND_SETTING, "on");
  }
  await appendEvent(ctx.env, { eventType: "tlc.setting", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "tlc_setting", objectId: w, payload: { what: w, hash: parsed.data.hash ?? null } });
  const settings = await tlcSettings(ctx.env);
  return json({ ok: true, send_gate: brandSendGate(settings, await tlcOutside(ctx.env), hashes), approvals: await approvalsView(ctx.env, settings) });
}

const dealPatch = z.object({
  stage: z.enum(["PROSPECT", "PITCHED", "CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED", "DECLINED", "STOPPED"]).optional(),
  // Never capped (owner, 22 Oct 2026): any custom amount.
  cash_offer_usd: z.number().min(0).finite().optional(),
  in_kind_offer: z.string().max(500).nullish(),
  in_kind_value_usd: z.number().min(0).max(1_000_000).optional(),
  wants: z.string().max(1000).nullish(),
  tier: z.enum(["TITLE", "PARTNER", "LEAD", "PRESENTING", "PRODUCT"]).optional(),
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
    // ONE FRONTIER-MODEL COMPANY PER CLUB: the first to say yes is seated; the others stop.
    if (["CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"].includes(p.stage)) {
      const ev = await ctx.env.WP_OS_DB.prepare("SELECT sponsor_categories_json FROM tlc_event WHERE id = ?1").bind(deal.event_id).first<{ sponsor_categories_json: string | null }>();
      const frontierCats = list<{ category: string; frontier_model?: boolean }>(ev?.sponsor_categories_json).filter((c) => c.frontier_model).map((c) => c.category.toLowerCase());
      const isFrontier = (cat: string | null) => !!cat && frontierCats.includes(cat.toLowerCase());
      const yes = ((await ctx.env.WP_OS_DB.prepare("SELECT id, category FROM tlc_deal WHERE event_id = ?1 AND (yes_at IS NOT NULL OR stage IN ('CALL','WAITING_ON_OWNERS','AGREED','PAID','DELIVERED')) AND stage NOT IN ('DECLINED','STOPPED')").bind(deal.event_id).all<{ id: string; category: string | null }>()).results ?? []);
      const conflict = frontierConflict(yes.map((d) => ({ id: d.id, frontier: isFrontier(d.category) })), { id: deal.id, frontier: isFrontier(deal.category) });
      if (conflict) return json({ error: "frontier_model", detail: conflict }, { status: 409 });
      if (isFrontier(deal.category)) {
        await ctx.env.WP_OS_DB.prepare("UPDATE tlc_deal SET stage = 'STOPPED', next_send_at = NULL, updated_at = ?3 WHERE event_id = ?1 AND id != ?2 AND lower(category) IN (SELECT value FROM json_each(?4)) AND yes_at IS NULL AND stage IN ('PROSPECT','PITCHED')")
          .bind(deal.event_id, deal.id, new Date().toISOString(), JSON.stringify(frontierCats)).run();
      }
    }
    if (["AGREED", "PAID", "DELIVERED"].includes(p.stage)) {
      const agreed = ((await ctx.env.WP_OS_DB.prepare("SELECT id, tier FROM tlc_deal WHERE event_id = ?1 AND stage IN ('AGREED','PAID','DELIVERED')").bind(deal.event_id).all<{ id: string; tier: string | null }>()).results ?? []);
      const conflict = titleConflict(agreed, { id: deal.id, tier: p.tier ?? deal.tier ?? null });
      if (conflict) return json({ error: "title_partner", detail: conflict }, { status: 409 });
    }
    if (p.stage === "WAITING_ON_OWNERS" && !(p.cash_offer_usd ?? deal.cash_offer_usd) && !(p.in_kind_offer ?? deal.in_kind_offer)) {
      return json({ error: "no_offer", detail: "record what they offer before asking the partners" }, { status: 409 });
    }
  }
  const now = new Date();
  await ctx.env.WP_OS_DB.prepare(
    `UPDATE tlc_deal SET stage = COALESCE(?2, stage), cash_offer_usd = COALESCE(?3, cash_offer_usd), in_kind_offer = COALESCE(?4, in_kind_offer),
       in_kind_value_usd = COALESCE(?5, in_kind_value_usd), wants = COALESCE(?6, wants), next_send_at = CASE WHEN ?2 IS NOT NULL AND ?2 NOT IN ('PROSPECT','PITCHED') THEN NULL ELSE next_send_at END,
       tier = COALESCE(?8, tier), yes_at = CASE WHEN yes_at IS NULL AND ?2 IN ('CALL','WAITING_ON_OWNERS','AGREED','PAID','DELIVERED') THEN ?7 ELSE yes_at END, updated_at = ?7 WHERE id = ?1`,
  ).bind(deal.id, p.stage ?? null, p.cash_offer_usd ?? null, p.in_kind_offer ?? null, p.in_kind_value_usd ?? null, p.wants ?? null, now.toISOString(), p.tier ?? null).run();
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
  if (ticketVerdict(paid, seatsOf(ev)).verdict === "FULL") return json({ error: "full", detail: `all ${seatsOf(ev).max} seats are sold` }, { status: 409 });
  await ctx.env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO tlc_ticket (id, event_id, buyer_name, buyer_email, amount_usd, fee_usd, payment_ref, source, paid_at, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
  ).bind(`tlt_${crypto.randomUUID()}`, ev.id, t.buyer_name ?? null, t.buyer_email.toLowerCase(), t.amount_usd, t.fee_usd ?? null, t.payment_ref, t.source, t.paid_at ?? new Date().toISOString(), ev.firm_scope).run();
  return json({ ok: true, ...ticketVerdict(paid + 1, seatsOf(ev)) });
}

/** The month as a brand would see it: the packet's own why-now and sources, never the quarterly trend story. */
export function clubViewOf(ev: TlcEventRow): TlcClubView {
  const packet = (() => { try { return JSON.parse(ev.packet_json ?? "{}") as Record<string, unknown>; } catch { return {}; } })();
  const s = (k: string): string | null => (typeof packet[k] === "string" && (packet[k] as string).trim() ? (packet[k] as string) : null);
  const sources = (Array.isArray(packet.sources) ? (packet.sources as Array<{ title?: unknown; url?: unknown }>) : [])
    .filter((x) => typeof x.url === "string" && /^https:\/\//.test(x.url as string))
    .map((x) => ({ title: String(x.title ?? x.url), url: String(x.url) }));
  return {
    topic: ev.topic ?? "",
    angle: ev.angle,
    month: ev.month,
    eventDate: ev.event_date,
    slot: ev.slot,
    whyNow: s("why_now"),
    sources,
    categories: list<{ category?: string; why?: string; example_brands?: string[]; tier?: unknown; bench?: unknown; excluded_brands?: string[]; featured?: string | null }>(ev.sponsor_categories_json).map((c) => ({
      category: String(c.category ?? ""), why: String(c.why ?? ""), example_brands: (c.example_brands ?? []).map(String),
      ...(isTlcTier(c.tier) ? { tier: c.tier } : {}), ...(c.bench === true ? { bench: true } : {}),
      ...(c.excluded_brands?.length ? { excluded_brands: c.excluded_brands.map(String) } : {}), ...(c.featured ? { featured: String(c.featured) } : {}),
      ...((c as { ai_partner?: unknown }).ai_partner === true ? { ai_partner: true } : {}), ...((c as { frontier_model?: unknown }).frontier_model === true ? { frontier_model: true } : {}),
    })),
    aiSegment: s("ai_segment"),
    seats: seatsOf(ev),
    handsOn: s("hands_on"),
    takeHome: s("take_home"),
    recap: ev.recap,
  };
}

export async function internalViewOf(env: Env, ev: TlcEventRow): Promise<TlcInternalView> {
  const deals = await dealsFor(env, ev.id);
  const agreed = deals.filter((d) => ["AGREED", "PAID", "DELIVERED"].includes(d.stage) && d.tier !== "PRODUCT");
  const inKind = deals.filter((d) => d.tier === "PRODUCT" && !["DECLINED", "STOPPED"].includes(d.stage) && (d.yes_at || ["CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"].includes(d.stage)));
  const idea = await env.WP_OS_DB.prepare("SELECT origin FROM tlc_idea WHERE status = 'PICKED' AND status_month = ?1 ORDER BY updated_at DESC LIMIT 1").bind(ev.month).first<{ origin: string }>().catch(() => null);
  return {
    ...clubViewOf(ev),
    origin: idea?.origin ?? null,
    status: ev.status,
    vetoUntil: ev.veto_until,
    committedUsd: agreed.reduce((n, d) => n + (d.cash_offer_usd ?? 0), 0),
    committedPartners: agreed.length,
    pitchUrl: ev.pitch_token ? pitchPublicUrl(ev.pitch_token) : null,
    goalUsd: goalOf(ev).goalUsd,
    costBudgetUsd: goalOf(ev).costBudgetUsd,
    inKind: inKind.map((d) => ({ brand: d.brand, what: d.in_kind_offer })),
    backup: (() => { const b = backupOf(ev); return b && ev.switch_deadline && !b.applied_at ? { topic: b.topic, angle: b.angle, deadline: ev.switch_deadline } : null; })(),
    decidedBy: (() => { try { const d = (JSON.parse(ev.packet_json ?? "{}") as { decided_by?: string; decided_on?: string }); return d.decided_by ? `chosen by ${d.decided_by}${d.decided_on ? `, ${d.decided_on}` : ""}` : null; } catch { return null; } })(),
  };
}

const sha256 = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * What an approval is OF: the exact brand pitches that would be sent now (every upcoming month with
 * a topic), and the exact playbook text. Any change to either changes its hash and clears the approval.
 */
export async function contentHashes(env: Env): Promise<{ pitch: string; playbook: string }> {
  const evs = await eventsFrom(env, "SELECT * FROM tlc_event WHERE topic IS NOT NULL AND status NOT IN ('DONE','CANCELLED') ORDER BY month");
  return {
    pitch: await sha256(evs.map((e) => `${e.month}\n${renderBrandPitch(clubViewOf(e))}`).join("\n\n")),
    playbook: await sha256(TLC_PLAYBOOK.join("\n")),
  };
}

const settingMeta = async (env: Env, key: string): Promise<{ set_by: string | null; set_at: string | null } | null> =>
  env.WP_OS_DB.prepare("SELECT set_by, set_at FROM tlc_setting WHERE key = ?1").bind(key).first<{ set_by: string | null; set_at: string | null }>();

/** The switch screen's whole state, in plain words. */
export async function approvalsView(env: Env, settings: Record<string, string | null>) {
  const hashes = await contentHashes(env);
  const pitch = approvalState(settings, PITCH_APPROVAL_HASH_SETTING, hashes.pitch);
  const playbook = approvalState(settings, PLAYBOOK_APPROVAL_HASH_SETTING, hashes.playbook);
  const pm = await settingMeta(env, PITCH_APPROVAL_HASH_SETTING);
  const bm = await settingMeta(env, PLAYBOOK_APPROVAL_HASH_SETTING);
  const evs = await eventsFrom(env, "SELECT * FROM tlc_event WHERE topic IS NOT NULL AND status NOT IN ('DONE','CANCELLED') ORDER BY month");
  return {
    pitch: { state: pitch, hash: hashes.pitch, approved_at: pitch === "NOT_APPROVED" ? null : pm?.set_at ?? null },
    playbook: { state: playbook, hash: hashes.playbook, approved_at: playbook === "NOT_APPROVED" ? null : bm?.set_at ?? null },
    sending: settings[BRAND_SEND_SETTING] === "on",
    pitches: evs.map((e) => ({ month: e.month, topic: e.topic, url: e.pitch_token ? pitchPublicUrl(e.pitch_token) : null, pdf_url: e.pitch_token ? `${pitchPublicUrl(e.pitch_token)}/pdf` : null })),
  };
}

const planSchema = z.object({
  seats_min: z.number().int().min(2).max(2000).optional(),
  seats_max: z.number().int().min(2).max(2000).optional(),
  sponsor_goal_usd: z.number().min(TLC_NET_TARGET_USD + 1).finite().optional(),
});

/**
 * POST /api/tlc/events/:id/plan — the partners size a club's room to its sponsors (60, 100, 150…)
 * and may change its sponsor goal (its cost budget is the goal less the $10,000 net). Partners only.
 */
export async function handleTlcPlan(ctx: RouteContext): Promise<Response> {
  const partner = partnerOf(ctx);
  if (!partner) return json({ error: "forbidden", detail: "only a partner sizes a club" }, { status: 403 });
  const parsed = planSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", detail: "a room size is a whole number of people; a goal is above $10,000" }, { status: 400 });
  const ev = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(ctx.params.id).first<TlcEventRow>();
  if (!ev) return json({ error: "not_found" }, { status: 404 });
  const min = parsed.data.seats_min ?? seatsOf(ev).min;
  const max = parsed.data.seats_max ?? Math.max(min, seatsOf(ev).max);
  if (max < min) return json({ error: "invalid_input", detail: "the most people cannot be fewer than the fewest" }, { status: 400 });
  const now = new Date().toISOString();
  await ctx.env.WP_OS_DB.prepare("UPDATE tlc_event SET seats_min = ?2, seats_max = ?3, sponsor_goal_usd = COALESCE(?4, sponsor_goal_usd), updated_at = ?5 WHERE id = ?1")
    .bind(ev.id, min, max, parsed.data.sponsor_goal_usd ?? null, now).run();
  await appendEvent(ctx.env, { eventType: "tlc.plan", actorType: "firm_user", actorId: ctx.identity!.id, objectType: "tlc_event", objectId: ev.id, payload: { seats_min: min, seats_max: max, sponsor_goal_usd: parsed.data.sponsor_goal_usd ?? null } });
  return json({ ok: true, seats: { min, max }, goal: goalOf({ sponsor_goal_usd: parsed.data.sponsor_goal_usd ?? ev.sponsor_goal_usd }) });
}

/** GET /api/tlc/events/:id/onepager — the internal one-pager; `?doc=pitch` shows the brand pitch. */
export async function handleTlcOnePager(ctx: RouteContext): Promise<Response> {
  const a = await requireManage(ctx);
  if (a instanceof Response) return a;
  const ev = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE id = ?1").bind(ctx.params.id).first<TlcEventRow>();
  if (!ev?.topic) return json({ error: "not_found", detail: "no club with a topic by that id" }, { status: 404 });
  const doc = new URL(ctx.request.url).searchParams.get("doc") ?? "internal";
  // The backup's documents are in the OS (never in the email): ?doc=backup-pitch or ?doc=backup-internal.
  const b = backupOf(ev);
  const target = doc.startsWith("backup") ? (b ? backupRow(ev, b) : null) : ev;
  if (!target) return json({ error: "not_found", detail: "this month has no backup topic" }, { status: 404 });
  const html = doc.endsWith("pitch") ? renderBrandPitch(clubViewOf(target)) : renderInternalOnePager({ ...(await internalViewOf(ctx.env, target)), ...(doc.startsWith("backup") ? { backup: null, decidedBy: `the backup for ${ev.topic}` } : {}) });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

/**
 * GET /api/tlc-pitch/:token and /api/tlc-pitch/:token/pdf — THE PUBLIC BRAND PITCH (review B2: a
 * brand could not open the staff-only link). No login: the 128-bit token is the credential, it names
 * one month, and the page is read-only and carries nothing internal. Unknown token: 404, nothing else.
 */
export async function handleTlcPitchPublic(ctx: RouteContext): Promise<Response> {
  const token = String(ctx.params.token ?? "");
  if (!/^[0-9a-f]{32}$/.test(token)) return new Response("Not found", { status: 404 });
  const ev = await ctx.env.WP_OS_DB.prepare("SELECT * FROM tlc_event WHERE pitch_token = ?1 AND topic IS NOT NULL AND status NOT IN ('CANCELLED')").bind(token).first<TlcEventRow>();
  if (!ev) return new Response("Not found", { status: 404 });
  const html = renderBrandPitch(clubViewOf(ev));
  const headers = { "cache-control": "no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" };
  if (new URL(ctx.request.url).pathname.endsWith("/pdf")) {
    const out = await renderHtmlPdf(ctx.env, html, { onePage: true });
    if (out.pdfBase64 === null) return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
    const bytes = Uint8Array.from(atob(out.pdfBase64), (c) => c.charCodeAt(0));
    return new Response(bytes, { headers: { ...headers, "content-type": "application/pdf", "content-disposition": `inline; filename="The Learning Club - ${ev.topic!.replace(/[^\w &-]+/g, "")}.pdf"` } });
  }
  return new Response(html, { headers: { ...headers, "content-type": "text/html; charset=utf-8" } });
}
