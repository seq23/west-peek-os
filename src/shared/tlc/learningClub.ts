/**
 * WEST PEEK ROOMS — THE LEARNING CLUB (TLC) EDITION. Owner-approved 22 Oct 2026.
 *
 * In-person learning clubs: 25–40 people deep-diving ONE topic, in New York City only, one event a
 * month, the first in January 2027, selling from early November 2026. Paid for by brand sponsors;
 * every attendee buys a $10 ticket (owner, 22 Oct 2026: "proof to sponsors of real intent and
 * spending"). This file is the whole rulebook as code — the money rule, the go-ahead rule, the
 * drip, the deal stages, the booking pack, the escalation email, the one-pager — so a test can read
 * every rule and no prose document governs anything on its own.
 *
 * PURE. No database, no network. `services/learningClub.ts` is the worker half.
 *
 * TWO PEOPLE CARRY IT:
 *   Parker (Event Marketing Coordinator) — the topics, rolling three ahead, and the booking pack.
 *   Wynn (TLC Sales & Partnerships, un-retired 22 Oct 2026) — the trend story, the brand drip,
 *   the deals, the decision emails, the agreement and the invoice note.
 *
 * THE HARD RULES (each one is enforced below or in the worker, and `validate:tlc` reads them):
 *   1. AGENTS NEVER SPEND MONEY. Hosts, venues, food, materials and photographers are OPTIONS sent
 *      to the partners, who book and pay. Money IN (tickets, sponsor invoices) is fine.
 *   2. NOTHING SENDS TO A BRAND until the owner has approved the one-pager mock AND the sales
 *      playbook, and the brand-send switch (`tlc_setting.brand_send`, default 'off') is on, and the
 *      platform's external-email switch is on. Every send is still an approved external effect.
 *   3. SPONSOR NAMES AND AMOUNTS LIVE ONLY IN THE DATABASE, never in this public repository.
 *   4. VOICE: "we"; no inflated claims; no invented facts; no fake case studies.
 */

// ── The numbers ─────────────────────────────────────────────────────────────────────────────────

export const TLC_CITY = "New York City";
export const TLC_SEATS = { min: 25, max: 40 } as const;
/** Every attendee pays to be there. $10, never more (owner, 22 Oct 2026). */
export const TLC_TICKET_PRICE_USD = 10;
export const TLC_TICKET_PRICE_MAX_USD = 10;
/**
 * The processing fee assumed on each ticket until the payment tool reports the real one: the
 * common card rate (2.9% + $0.30). A ticket row carries its own fee when the payment tool gives
 * one, and that number wins.
 */
export const TLC_TICKET_FEE = { percent: 0.029, fixedUsd: 0.3 } as const;
export const TLC_NET_TARGET_USD = 10_000;
/** The floor: $7,500 net (a 25% margin under the target). */
export const TLC_NET_FLOOR_USD = 7_500;
export const TLC_COST_CAP_USD = 5_000;
export const TLC_FIRST_MONTH = "2027-01";
export const TLC_TOPICS_AHEAD = 3;
/** Days before the event the go-ahead is checked. */
export const TLC_GO_CHECK_DAYS = [21, 14] as const;
/** The paid-ticket gate is checked at the 2-weeks-out point. */
export const TLC_TICKET_GATE_DAYS = 14;
/** The booking pack goes to the partners ~6 weeks out; a topic with no interested brand is flagged then. */
export const TLC_BOOKING_PACK_DAYS = 42;
/** Brand emails: day 0, 4, 10 and 18 after the first. */
export const TLC_DRIP_DAYS = [0, 4, 10, 18] as const;
export const TLC_SPONSOR_CATEGORIES = { min: 5, max: 10 } as const;

/**
 * THE SHAPE OF ONE CLUB (owner, 22 Oct 2026): a 3–4 hour deep dive on one topic, one afternoon
 * (e.g. Saturday 1–5 pm) or one evening (e.g. Thursday 6–10 pm). Everyone leaves with something
 * they made or learned. Parker's packet and booking pack are priced for this length: a real meal
 * for 25–40, the host and venue for four hours, the expert paid for the afternoon — all inside the
 * $5,000 cap.
 */
export const TLC_SLOTS = [
  { key: "AFTERNOON", label: "Saturday afternoon, 1–5 pm", weekday: 6, start: "13:00", end: "17:00" },
  { key: "EVENING", label: "Thursday evening, 6–10 pm", weekday: 4, start: "18:00", end: "22:00" },
] as const;
export const TLC_HOURS = { min: 3, max: 4 } as const;
export const TLC_BOOKING_HOURS = 4;
export const TLC_RUN_OF_SHOW: ReadonlyArray<{ part: string; minutes: readonly [number, number] }> = [
  { part: "Arrive", minutes: [20, 20] },
  { part: "Learn", minutes: [45, 45] },
  { part: "Hands-on", minutes: [60, 60] },
  { part: "Break with food, and the sponsor's 5 minutes", minutes: [20, 30] },
  { part: "Go deeper", minutes: [45, 45] },
  { part: "Share", minutes: [20, 20] },
  { part: "Close", minutes: [10, 10] },
];
/** 220–230 minutes: inside the 3–4 hours, never outside it. */
export function runOfShowMinutes(): { min: number; max: number } {
  return TLC_RUN_OF_SHOW.reduce((a, r) => ({ min: a.min + r.minutes[0], max: a.max + r.minutes[1] }), { min: 0, max: 0 });
}
export function runOfShowLines(): string[] {
  return TLC_RUN_OF_SHOW.map((r) => `${r.part}: ${r.minutes[0] === r.minutes[1] ? r.minutes[0] : `${r.minutes[0]}–${r.minutes[1]}`} min`);
}

// ── Months ──────────────────────────────────────────────────────────────────────────────────────

export function addMonths(yyyyMm: string, n: number): string {
  const [y, m] = yyyyMm.split("-").map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

export function monthOf(at: Date): string {
  return at.toISOString().slice(0, 7);
}

/**
 * The three months Parker holds a topic for. Two to four months out, never before January 2027:
 * on 1 Nov 2026 that is Jan, Feb, Mar; on 1 Dec it adds Apr. A month already held keeps its topic.
 */
export function rollingTopicMonths(now: Date): string[] {
  let start = addMonths(monthOf(now), 2);
  if (start < TLC_FIRST_MONTH) start = TLC_FIRST_MONTH;
  return Array.from({ length: TLC_TOPICS_AHEAD }, (_, i) => addMonths(start, i));
}

/** Whole days from `now` to the event date (an ISO date). Negative once it has passed. */
export function daysUntil(eventDate: string, now: Date): number {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const ev = Date.parse(`${eventDate.slice(0, 10)}T00:00:00Z`);
  return Math.round((ev - day) / 86_400_000);
}

/**
 * The default date for a month's club: its third Thursday. A partner moves it by editing the row;
 * "move the date" is one of the three escalation answers, so it must be a field, not a constant.
 */
export function defaultEventDate(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const firstThursday = 1 + ((4 - first.getUTCDay() + 7) % 7);
  return `${yyyyMm}-${String(firstThursday + 14).padStart(2, "0")}`;
}

// ── Money ───────────────────────────────────────────────────────────────────────────────────────

export function ticketFeeUsd(priceUsd: number = TLC_TICKET_PRICE_USD): number {
  return Math.round((priceUsd * TLC_TICKET_FEE.percent + TLC_TICKET_FEE.fixedUsd) * 100) / 100;
}

export interface TicketLine {
  amount_usd: number;
  fee_usd: number | null;
}

export interface EventMoney {
  /** Sponsor cash that is AGREED, PAID or DELIVERED. In-kind is never cash. */
  sponsorCashUsd: number;
  /** Costs the partners have committed (booked). Options not yet booked are not costs. */
  committedCostsUsd: number;
  tickets: readonly TicketLine[];
  /** What donated space and product would have cost. Lowers cost; never counted as net. */
  inKindValueUsd?: number;
}

export interface EventEconomics {
  sponsorNetUsd: number;
  paidTickets: number;
  ticketNetUsd: number;
  /** Sponsor cash − committed costs + ticket revenue after fees. */
  netUsd: number;
  /** The target and the floor are judged on SPONSOR net alone: the $10K never depends on tickets. */
  hitsTarget: boolean;
  hitsFloor: boolean;
  overCostCap: boolean;
  inKindValueUsd: number;
}

export function eventEconomics(m: EventMoney): EventEconomics {
  const sponsorNetUsd = m.sponsorCashUsd - m.committedCostsUsd;
  const paid = m.tickets.filter((t) => t.amount_usd > 0);
  const ticketNetUsd = Math.round(paid.reduce((s, t) => s + t.amount_usd - (t.fee_usd ?? ticketFeeUsd(t.amount_usd)), 0) * 100) / 100;
  return {
    sponsorNetUsd,
    paidTickets: paid.length,
    ticketNetUsd,
    netUsd: Math.round((sponsorNetUsd + ticketNetUsd) * 100) / 100,
    hitsTarget: sponsorNetUsd >= TLC_NET_TARGET_USD,
    hitsFloor: sponsorNetUsd >= TLC_NET_FLOOR_USD,
    overCostCap: m.committedCostsUsd > TLC_COST_CAP_USD,
    inKindValueUsd: m.inKindValueUsd ?? 0,
  };
}

// ── The go-ahead rule ───────────────────────────────────────────────────────────────────────────

export type GoVerdict = "NOT_YET" | "GO" | "ESCALATE";

export interface GoCheck {
  verdict: GoVerdict;
  /** Which checkpoint this is (21 or 14), or null when today is not one. */
  checkpoint: number | null;
  reasons: string[];
  /** The three answers to a shortfall, always offered together. */
  options: string[];
}

export const ESCALATION_OPTIONS = [
  "Add a sponsor: Wynn takes the next brand in the queue to a call this week.",
  "Cut cost: drop the most expensive booking-pack option for the next one down.",
  "Move the date: push the club a month and keep every agreed sponsor on it.",
] as const;

/**
 * GO when sponsor cash minus committed costs is at least $7,500 AND (at two weeks out) at least 25
 * tickets are PAID. Checked at 21 and 14 days out; anything short escalates to both partners with
 * the three ways out. Between checkpoints the verdict is NOT_YET.
 */
export function goAheadCheck(input: { daysOut: number; economics: EventEconomics }): GoCheck {
  const checkpoint = (TLC_GO_CHECK_DAYS as readonly number[]).includes(input.daysOut) ? input.daysOut : null;
  if (checkpoint === null) return { verdict: "NOT_YET", checkpoint, reasons: [], options: [] };
  const e = input.economics;
  const reasons: string[] = [];
  if (!e.hitsFloor) {
    reasons.push(`Sponsor cash minus committed costs is $${e.sponsorNetUsd.toLocaleString("en-US")}, under the $${TLC_NET_FLOOR_USD.toLocaleString("en-US")} floor.`);
  }
  if (checkpoint <= TLC_TICKET_GATE_DAYS && e.paidTickets < TLC_SEATS.min) {
    reasons.push(`${e.paidTickets} paid ticket(s), under the ${TLC_SEATS.min} needed two weeks out.`);
  }
  if (e.overCostCap) reasons.push(`Committed costs are over the $${TLC_COST_CAP_USD.toLocaleString("en-US")} cap.`);
  return reasons.length
    ? { verdict: "ESCALATE", checkpoint, reasons, options: [...ESCALATION_OPTIONS] }
    : { verdict: "GO", checkpoint, reasons: [], options: [] };
}

// ── Tickets ─────────────────────────────────────────────────────────────────────────────────────

export type TicketVerdict = "OPEN" | "FULL";

/** 40 seats. A ticket past 40 is refused before payment is taken; 25 paid is the go-ahead floor. */
export function ticketVerdict(paid: number): { verdict: TicketVerdict; seatsLeft: number; meetsFloor: boolean } {
  return { verdict: paid >= TLC_SEATS.max ? "FULL" : "OPEN", seatsLeft: Math.max(0, TLC_SEATS.max - paid), meetsFloor: paid >= TLC_SEATS.min };
}

export function ticketPriceProblem(amountUsd: number): string | null {
  if (!(amountUsd > 0)) return "a ticket is paid; a free seat is not a ticket";
  if (amountUsd > TLC_TICKET_PRICE_MAX_USD) return `a ticket is at most $${TLC_TICKET_PRICE_MAX_USD}`;
  return null;
}

// ── Deal stages ─────────────────────────────────────────────────────────────────────────────────

/** PROSPECT is found but not yet written to. The six stages the owner named follow it. */
export const DEAL_STAGES = ["PROSPECT", "PITCHED", "CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"] as const;
export const DEAL_END_STATES = ["DECLINED", "STOPPED"] as const;
export type DealStage = (typeof DEAL_STAGES)[number] | (typeof DEAL_END_STATES)[number];

/** Forward one or more stages, or out to DECLINED / STOPPED. Never backwards, except a counter (to CALL). */
export function stageMoveProblem(from: DealStage, to: DealStage, opts: { counter?: boolean } = {}): string | null {
  if (from === to) return null;
  if ((DEAL_END_STATES as readonly string[]).includes(from)) return `the deal is ${from}`;
  if ((DEAL_END_STATES as readonly string[]).includes(to)) return null;
  const a = DEAL_STAGES.indexOf(from as (typeof DEAL_STAGES)[number]);
  const b = DEAL_STAGES.indexOf(to as (typeof DEAL_STAGES)[number]);
  if (b > a) return null;
  if (opts.counter && from === "WAITING_ON_OWNERS" && to === "CALL") return null;
  return `a deal moves forward: ${from} cannot go back to ${to}`;
}

/** A brand that has answered, or got further, is "interested" for the swap rule. */
export function isInterested(deal: { stage: string; replied_at?: string | null }): boolean {
  return Boolean(deal.replied_at) || ["CALL", "WAITING_ON_OWNERS", "AGREED", "PAID", "DELIVERED"].includes(deal.stage);
}

/** Six weeks out with no interested brand: Parker is told to swap the topic. */
export function needsSwap(daysOut: number, deals: ReadonlyArray<{ stage: string; replied_at?: string | null }>): boolean {
  return daysOut <= TLC_BOOKING_PACK_DAYS && daysOut > 0 && !deals.some(isInterested);
}

// ── The drip ────────────────────────────────────────────────────────────────────────────────────

export type DripStop = "REPLIED" | "BOUNCED" | "UNSUBSCRIBED" | "DECLINED";

/**
 * When the next email in the sequence is due. `step` is how many have gone; null means the drip is
 * over (all four sent) or stopped. Day N counts from the first send, so a held day-0 does not
 * squeeze the rest together.
 */
export function nextDripAt(step: number, firstSentAt: string | null, now: Date, stopped: DripStop | null): string | null {
  if (stopped) return null;
  if (step >= TLC_DRIP_DAYS.length) return null;
  if (step === 0 || !firstSentAt) return now.toISOString();
  return new Date(Date.parse(firstSentAt) + TLC_DRIP_DAYS[step]! * 86_400_000).toISOString();
}

/**
 * SLOW WARM-UP. A new sending address that starts at full volume is filed as spam. Week one of
 * sending allows 5 a day, week two 10, week three 20, then 30. Counted from the first brand email
 * the firm ever sent for TLC.
 */
export function warmupDailyCap(firstEverSentAt: string | null, now: Date): number {
  if (!firstEverSentAt) return 5;
  const weeks = Math.floor((now.getTime() - Date.parse(firstEverSentAt)) / (7 * 86_400_000));
  return weeks <= 0 ? 5 : weeks === 1 ? 10 : weeks === 2 ? 20 : 30;
}

/** What an arriving message means for a deal's drip, from its From and Subject alone. */
export function classifyBrandMail(input: { from: string; subject: string }): DripStop {
  const from = input.from.toLowerCase();
  const subject = input.subject.toLowerCase();
  if (/mailer-daemon|postmaster|mail delivery|bounce/.test(from) || /undeliverable|delivery status notification|returned mail|delivery failure/.test(subject)) return "BOUNCED";
  if (/\bunsubscribe\b|\bremove me\b|\bstop\b/.test(subject)) return "UNSUBSCRIBED";
  return "REPLIED";
}

export interface DripEmailInput {
  step: number;
  brand: string;
  contactName: string | null;
  topic: string;
  month: string;
  eventDate: string;
  why: string | null;
}

/**
 * The four emails. Short, plain, "we", one ask, no inflated claim, no number we cannot prove.
 * Every one says how to stop hearing from us.
 */
export function dripEmail(input: DripEmailInput): { subject: string; text: string } {
  const hi = input.contactName ? `Hi ${input.contactName.split(" ")[0]},` : "Hi,";
  const when = monthWords(input.month);
  // One subject for all four, so the sequence threads in the brand's inbox.
  const subject = `${input.brand} x a ${input.topic} learning club in New York, ${when}`;
  const bodies = [
    [
      hi,
      "",
      `We run West Peek Rooms, small in-person gatherings in New York. In ${when} we are hosting The Learning Club: ${TLC_SEATS.min} to ${TLC_SEATS.max} people spending four hours going deep on one topic, ${input.topic}, with an hour of hands-on work. Every attendee buys a ticket to be there.`,
      input.why ? `We thought of ${input.brand} because ${input.why}` : `We thought ${input.brand} would be a natural fit for the room.`,
      "",
      "Would you be open to a short call about sponsoring it? I can send the one-pager first if that is easier.",
    ],
    [hi, "", `Following up on The Learning Club, ${input.topic}, in New York in ${when}. Happy to send the one-pager or find 15 minutes, whichever suits you.`],
    [hi, "", `One more note on the ${input.topic} club in ${when}. We keep sponsors to one per category so each brand has the room to itself. If ${input.brand} is interested, a reply is all it takes.`],
    [hi, "", `Last note from us on the ${input.topic} club. If the timing is wrong this round, we run one every month in New York and would be glad to keep you in mind.`],
  ];
  const text = [...bodies[Math.min(input.step, 3)]!, "", "West Peek Rooms", "", "If you would rather not hear from us, reply \"unsubscribe\" and we will not write again."].join("\n");
  return { subject, text };
}

export function monthWords(yyyyMm: string): string {
  const [y, m] = yyyyMm.split("-").map(Number) as [number, number];
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}`;
}

// ── The send gate ───────────────────────────────────────────────────────────────────────────────

/** THE SWITCH. `tlc_setting.brand_send`; anything but exactly 'on' is off, and no row is off. */
export const BRAND_SEND_SETTING = "brand_send";
export const ONEPAGER_APPROVAL_SETTING = "onepager_mock_approved_at";
export const PLAYBOOK_APPROVAL_SETTING = "playbook_approved_at";

export function brandSendGate(settings: Record<string, string | null | undefined>, env: { WP_OS_AI_EMAIL_EXTERNAL?: string }): { open: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (!settings[ONEPAGER_APPROVAL_SETTING]) reasons.push("the owner has not approved the one-pager mock");
  if (!settings[PLAYBOOK_APPROVAL_SETTING]) reasons.push("the owner has not approved the sales playbook");
  if (settings[BRAND_SEND_SETTING] !== "on") reasons.push("the TLC brand-send switch is off");
  if (env.WP_OS_AI_EMAIL_EXTERNAL !== "enabled") reasons.push("employees may not email outside the firm (WP_OS_AI_EMAIL_EXTERNAL)");
  return { open: reasons.length === 0, reasons };
}

// ── The partners' decision ──────────────────────────────────────────────────────────────────────

export type Decision = { kind: "YES" } | { kind: "NO" } | { kind: "COUNTER"; amountUsd: number } | { kind: "UNCLEAR" };

/** "yes", "no", or "counter $6,000" (or "counter 6k"). The first word decides; a counter needs a number. */
export function parseDecisionReply(text: string | null | undefined): Decision {
  const t = String(text ?? "").trim().toLowerCase();
  const counter = /\bcounter\b[^0-9$]*\$?\s*([0-9][0-9,]*(?:\.[0-9]+)?)\s*(k)?/.exec(t);
  if (counter) {
    const n = Number(counter[1]!.replace(/,/g, "")) * (counter[2] ? 1000 : 1);
    if (n > 0) return { kind: "COUNTER", amountUsd: Math.round(n) };
  }
  if (/^(yes|yep|yeah|approved|approve|go|do it|agreed|ok|okay)\b/.test(t)) return { kind: "YES" };
  if (/^(no|nope|pass|decline|declined|don't|do not)\b/.test(t)) return { kind: "NO" };
  return { kind: "UNCLEAR" };
}

export interface DealOffer {
  brand: string;
  topic: string;
  month: string;
  cashUsd: number;
  inKind: string | null;
  inKindValueUsd: number;
  wants: string | null;
}

/** What the club nets if the partners say yes to this one, given what is already agreed and booked. */
export function netIfYes(offer: Pick<DealOffer, "cashUsd">, current: EventEconomics): { netUsd: number; sponsorNetUsd: number; vsTarget: number; vsFloor: number } {
  const sponsorNetUsd = current.sponsorNetUsd + offer.cashUsd;
  return {
    sponsorNetUsd,
    netUsd: Math.round((current.netUsd + offer.cashUsd) * 100) / 100,
    vsTarget: sponsorNetUsd - TLC_NET_TARGET_USD,
    vsFloor: sponsorNetUsd - TLC_NET_FLOOR_USD,
  };
}

export function recommendation(offer: DealOffer, current: EventEconomics): string {
  const after = netIfYes(offer, current);
  if (offer.cashUsd <= 0) return "Say no unless the in-kind removes a cost we would otherwise pay: it adds no cash.";
  if (after.vsTarget >= 0) return "Say yes: with this one the club reaches the $10,000 target.";
  if (after.vsFloor >= 0) return "Say yes: with this one the club clears the $7,500 floor.";
  return "Say yes and keep selling: it moves us toward the floor, and the next brand in the queue is already being written to.";
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;

/** The escalation to BOTH partners when a brand is ready. Their reply is the permission. */
export function decisionEmail(offer: DealOffer, current: EventEconomics): { what: string; tldr: string; tldrBullets: string[]; sections: Array<{ label: string; bullets: string[] }> } {
  const after = netIfYes(offer, current);
  return {
    what: `TLC sponsor ${offer.brand.slice(0, 28)}: yes, no or counter?`,
    tldr: `${offer.brand} offers ${usd(offer.cashUsd)} cash${offer.inKind ? ` plus ${offer.inKind}` : ""}. If we say yes the club nets ${usd(after.netUsd)}.`,
    tldrBullets: ['Reply "yes" to agree', 'Reply "no" to pass', 'Reply "counter $X" to ask for a different amount'],
    sections: [
      {
        label: "The offer",
        bullets: [
          `Cash: ${usd(offer.cashUsd)}`,
          `In kind: ${offer.inKind ?? "none"}${offer.inKindValueUsd ? ` (worth about ${usd(offer.inKindValueUsd)}; lowers cost, not counted as net)` : ""}`,
          `What they want: ${offer.wants ?? "nothing beyond the standard sponsor package"}`,
        ],
      },
      {
        label: "Net if we say yes",
        bullets: [
          `Club net: ${usd(after.netUsd)} (sponsor net ${usd(after.sponsorNetUsd)} plus ticket revenue after fees)`,
          `Against the $10,000 target: ${after.vsTarget >= 0 ? "met" : `${usd(-after.vsTarget)} short`}`,
          `Against the $7,500 floor: ${after.vsFloor >= 0 ? "met" : `${usd(-after.vsFloor)} short`}`,
        ],
      },
      { label: "Recommendation", bullets: [recommendation(offer, current)] },
    ],
  };
}

// ── The booking pack (options only — never a booking) ──────────────────────────────────────────

export interface BookingOption {
  name: string;
  priceUsd: number;
  /** The last day it can be booked at that price. */
  bookBy: string;
  url: string;
  note?: string;
}

export interface MaterialLine {
  item: string;
  url: string;
  qty: number;
  unitUsd: number;
}

export interface BookingPack {
  hosts: BookingOption[];
  donatedVenueLeads: BookingOption[];
  paidVenues: BookingOption[];
  teachers: BookingOption[];
  food: BookingOption[];
  materials: MaterialLine[];
  photographers: BookingOption[];
}

export const BOOKING_PACK_SHAPE: Readonly<Record<Exclude<keyof BookingPack, "materials">, { min: number; max: number; label: string }>> = {
  hosts: { min: 3, max: 3, label: "NYC paid host (4 hours)" },
  donatedVenueLeads: { min: 0, max: 5, label: "donated-venue lead" },
  paidVenues: { min: 2, max: 3, label: "paid venue (4 hours)" },
  teachers: { min: 2, max: 3, label: "expert teacher (paid for the afternoon)" },
  food: { min: 2, max: 3, label: "real meal for 25–40" },
  photographers: { min: 2, max: 2, label: "photographer" },
};

/** What is short or malformed. Empty means the pack is complete. */
export function bookingPackProblems(pack: BookingPack): string[] {
  const out: string[] = [];
  for (const [key, shape] of Object.entries(BOOKING_PACK_SHAPE) as Array<[keyof typeof BOOKING_PACK_SHAPE, (typeof BOOKING_PACK_SHAPE)[keyof typeof BOOKING_PACK_SHAPE]]>) {
    const list = pack[key];
    if (list.length < shape.min) out.push(`${list.length} ${shape.label} option(s); ${shape.min} wanted`);
    for (const o of list) {
      if (!(o.priceUsd >= 0)) out.push(`${o.name}: no price`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(o.bookBy)) out.push(`${o.name}: no "book by" date`);
    }
  }
  if (pack.materials.length === 0) out.push("no materials list");
  return out;
}

export function materialsTotalUsd(pack: Pick<BookingPack, "materials">): number {
  return Math.round(pack.materials.reduce((s, m) => s + m.qty * m.unitUsd, 0) * 100) / 100;
}

const cheapest = (list: readonly BookingOption[]): BookingOption | null => (list.length ? [...list].sort((a, b) => a.priceUsd - b.priceUsd)[0]! : null);

/**
 * The cheapest complete plan, against the cap and the sponsor cash. A donated venue, when there is
 * a lead, is assumed at $0 only as the BEST case; the paid venue is the plan the totals use, because
 * a lead is not a yes.
 */
export function bookingPackTotals(pack: BookingPack, sponsorCashUsd: number): {
  lines: Array<{ what: string; name: string; priceUsd: number }>;
  costUsd: number;
  bestCaseCostUsd: number;
  sponsorCashUsd: number;
  netUsd: number;
  vsTarget: number;
  vsFloor: number;
  underCap: boolean;
} {
  const lines: Array<{ what: string; name: string; priceUsd: number }> = [];
  const add = (what: string, o: BookingOption | null): void => {
    if (o) lines.push({ what, name: o.name, priceUsd: o.priceUsd });
  };
  add("Host", cheapest(pack.hosts));
  add("Venue (paid)", cheapest(pack.paidVenues));
  add("Teacher", cheapest(pack.teachers));
  add("Food", cheapest(pack.food));
  add("Photographer", cheapest(pack.photographers));
  const materials = materialsTotalUsd(pack);
  lines.push({ what: "Materials", name: `${pack.materials.length} item(s)`, priceUsd: materials });
  const costUsd = Math.round(lines.reduce((s, l) => s + l.priceUsd, 0) * 100) / 100;
  const venue = cheapest(pack.paidVenues)?.priceUsd ?? 0;
  const bestCaseCostUsd = pack.donatedVenueLeads.length ? Math.round((costUsd - venue) * 100) / 100 : costUsd;
  const netUsd = sponsorCashUsd - costUsd;
  return { lines, costUsd, bestCaseCostUsd, sponsorCashUsd, netUsd, vsTarget: netUsd - TLC_NET_TARGET_USD, vsFloor: netUsd - TLC_NET_FLOOR_USD, underCap: costUsd <= TLC_COST_CAP_USD };
}

// ── The sponsorship agreement (a template; NOT legal advice) ───────────────────────────────────

export const AGREEMENT_DISCLAIMER = "TEMPLATE ONLY. NOT LEGAL ADVICE. Have counsel review before anyone signs.";

export function sponsorshipAgreement(input: { brand: string; topic: string; eventDate: string; cashUsd: number; inKind: string | null; deliverables: string | null; dueDate: string }): string {
  return [
    AGREEMENT_DISCLAIMER,
    "",
    "SPONSORSHIP AGREEMENT — WEST PEEK ROOMS: THE LEARNING CLUB",
    "",
    `1. Parties. West Peek Ventures ("West Peek") and ${input.brand} ("Sponsor").`,
    `2. Event. The Learning Club: ${input.topic}, New York City, on ${input.eventDate} (or a date West Peek gives at least 14 days' notice of).`,
    `3. Sponsorship. Sponsor pays ${usd(input.cashUsd)} in cash${input.inKind ? ` and provides in kind: ${input.inKind}` : ""}.`,
    `4. Payment. Due by ${input.dueDate} against West Peek's invoice. The sponsorship is confirmed when payment is received.`,
    `5. What Sponsor receives. ${input.deliverables ?? "Category exclusivity at the event, its product in attendees' hands during the hands-on session where it fits the topic, five minutes during the food break, a mention in the invitation and on the day, and a short recap afterwards."}`,
    "6. Attendee privacy. West Peek does not share attendee names, emails or any list of attendees with Sponsor.",
    "7. Cancellation. If West Peek cancels and does not offer a new date, West Peek refunds the cash paid. If Sponsor withdraws within 14 days of the event, the payment is not refundable.",
    "8. Brand use. Each party may use the other's name and logo only to describe this sponsorship, and only as the other approves.",
    "9. No other promises. This is the whole agreement. Neither party promises any particular attendance, outcome or result.",
    "",
    "West Peek Ventures: ____________________   Date: ________",
    `${input.brand}: ____________________   Date: ________`,
  ].join("\n");
}

/** The invoice note that goes with a yes. The payment link is West Peek's own; the OS never moves money out. */
export function invoiceNote(input: { brand: string; topic: string; month: string; cashUsd: number; dueDate: string; paymentUrl: string | null }): string {
  return [
    `Invoice: ${input.brand}, sponsorship of The Learning Club, ${input.topic} (${monthWords(input.month)})`,
    `Amount: ${usd(input.cashUsd)}`,
    `Due: ${input.dueDate}`,
    input.paymentUrl ? `Pay here: ${input.paymentUrl}` : "Payment link: not set yet. A partner adds it from West Peek's own payment account (it is the one thing only you hold).",
  ].join("\n");
}

// ── The one-pager ───────────────────────────────────────────────────────────────────────────────

export interface Citation {
  title: string;
  publisher: string | null;
  url: string;
  claim: string;
}

export interface OnePagerInput {
  topic: string;
  angle: string | null;
  month: string;
  eventDate: string | null;
  whyNow: string | null;
  categories: readonly string[];
  /** The trend story, every claim backed by a citation. */
  story: string | null;
  citations: readonly Citation[];
  /** Real history only. Before event #1 this is West Peek Rooms/Workshops history, never an invented case. */
  proof: readonly string[];
  /** Filled after event #1 from the real recap; null until then. */
  recap: string | null;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The glossy one-pager, self-contained HTML. Light and dark, phone width, no external assets. */
export function renderOnePager(p: OnePagerInput): string {
  const cats = p.categories.map((c) => `<li>${esc(c)}</li>`).join("");
  const cites = p.citations.map((c, i) => `<li id="s${i + 1}"><a href="${esc(c.url)}">${esc(c.title)}</a>${c.publisher ? `, ${esc(c.publisher)}` : ""}</li>`).join("");
  const proof = p.proof.map((x) => `<li>${esc(x)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Learning Club</title>
<style>
:root{--bg:#FFFFFF;--ink:#050505;--muted:#5F5B55;--line:#D9D2C6;--accent:#F05A1A;--card:#F7F2EA}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A;--line:#2A2A2A;--card:#171717}}
:root[data-theme="dark"]{--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A;--line:#2A2A2A;--card:#171717}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 64px}
.eyebrow{letter-spacing:.14em;text-transform:uppercase;font-size:12px;color:var(--accent);font-weight:700}
h1{font-size:clamp(34px,6vw,56px);line-height:1.05;margin:10px 0 8px;letter-spacing:-.02em}
h2{font-size:14px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:36px 0 10px;font-weight:700}
.lede{font-size:19px;color:var(--muted);max-width:640px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:28px 0}
.fact{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px}
.fact b{display:block;font-size:24px;letter-spacing:-.01em}.fact span{color:var(--muted);font-size:13px}
ul{padding-left:20px}li{margin:4px 0}.cats{columns:2;column-gap:28px}@media (max-width:560px){.cats{columns:1}}
.note{border-left:3px solid var(--accent);padding:2px 0 2px 14px;color:var(--muted)}
a{color:inherit}small{color:var(--muted)}footer{margin-top:44px;border-top:1px solid var(--line);padding-top:16px;color:var(--muted);font-size:13px}
</style></head><body><main>
<div class="eyebrow">West Peek Rooms · The Learning Club</div>
<h1>${esc(p.topic)}</h1>
<p class="lede">${esc(p.angle ?? "One afternoon, one topic, taught properly.")} ${p.eventDate ? `New York City, ${esc(p.eventDate)}.` : `New York City, ${esc(monthWords(p.month))}.`}</p>
<div class="facts">
<div class="fact"><b>${TLC_SEATS.min}–${TLC_SEATS.max}</b><span>people in the room</span></div>
<div class="fact"><b>Every seat paid</b><span>each attendee bought a ticket to be there</span></div>
<div class="fact"><b>3–4 hours</b><span>a working session, not a panel</span></div>
<div class="fact"><b>One per category</b><span>each sponsor has the room to itself</span></div>
</div>
<h2>Why now</h2>
<p>${esc(p.story ?? p.whyNow ?? "")}</p>
<h2>The format</h2>
<p>A teacher who does this for a living leads the group through ${esc(p.topic)} for one afternoon or evening. A real meal, materials and a photographer are part of it, and everyone leaves with something they made or learned. Attendees pay for their seat, so the people in the room chose to be there.</p>
<ol>${runOfShowLines().map((l) => `<li>${esc(l)}</li>`).join("")}</ol>
<h2>Sponsor categories</h2>
<ul class="cats">${cats}</ul>
<h2>What sponsors receive</h2>
<ul><li>Real hands-on time: your product in attendees' hands during the 60-minute hands-on session, where it fits the topic</li><li>Five minutes to the room during the food break</li><li>Category exclusivity for the day</li><li>Named in the invitation and on the day</li><li>A short recap with photographs afterwards</li></ul>
<p class="note">We never share attendee names, emails or lists with sponsors.</p>
<h2>${p.recap ? "The last club" : "Who is behind it"}</h2>
${p.recap ? `<p>${esc(p.recap)}</p>` : `<ul>${proof}</ul>`}
${cites ? `<h2>Sources</h2><ol>${cites}</ol>` : ""}
<footer>West Peek Rooms · New York City · a reply to the email this came with is the quickest way to reach us.</footer>
</main></body></html>`;
}

// ── The sales playbook (Wynn's), as the prompts read it ────────────────────────────────────────

/**
 * WYNN'S PLAYBOOK. Every TLC prompt carries this text, so the playbook the owner approves IS the
 * instruction the model is given — never a document beside it.
 */
export const TLC_PLAYBOOK: readonly string[] = [
  "Who we sell to: brands whose customers are the people a club on this topic draws, in categories Parker named for it. One sponsor per category per club.",
  "What we sell: real hands-on time with the product, in a room of 25 to 40 people who each paid to be there, for a 3 to 4 hour deep dive on one topic in New York (one afternoon or one evening). Product in hands during the 60-minute hands-on session where it fits, five minutes during the food break, category exclusivity, a mention in the invitation and on the day, a recap with photographs.",
  "Target per club: $10,000 net from sponsors, $7,500 at the least, costs held under $5,000. Tickets add to the net but the target never depends on them.",
  "Who we write to: a named person at the brand whose job is partnerships, events, community or brand marketing, at an address read off a live page. Never a guessed address. Never a contact without an email.",
  "How we write: we, not I. Short, plain, warm. One ask: a short call. No inflated claims, no numbers we cannot show, no invented case studies. Before the first club runs we describe the format and West Peek Rooms' real history; after it, the real recap.",
  "Cadence: four emails at day 0, 4, 10 and 18. Stop the moment they reply, bounce or ask us to stop. Warm up slowly: 5 a day the first week, then 10, 20, 30.",
  "When a brand says yes in principle: write up their cash, their in-kind and what they want, and send both partners one email with a recommendation and the club's net if we say yes. Their reply decides: yes, no, or counter with an amount.",
  "Money: we invoice and send West Peek's own payment link. We never book, buy or pay for anything; hosts, venues, food, materials and photographers go to the partners as options with prices and book-by dates.",
  "Privacy: no attendee name, email or list ever goes to a sponsor.",
];

export function renderPlaybook(): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TLC Sales Playbook</title>
<style>:root{--bg:#FFFFFF;--ink:#050505;--muted:#5F5B55;--accent:#F05A1A}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A}}:root[data-theme="dark"]{--bg:#050505;--ink:#FFFFFF;--muted:#A8A29A}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 16px}h1{margin:0 0 6px}p.s{color:var(--muted)}li{margin:10px 0}.e{color:var(--accent);font-weight:700;letter-spacing:.12em;text-transform:uppercase;font-size:12px}</style></head>
<body><main><div class="e">The Learning Club · for the owner's approval</div><h1>Wynn's sales playbook</h1><p class="s">This exact text is what every TLC prompt carries. Nothing is sent to any brand until you approve this and the one-pager.</p><ol>${TLC_PLAYBOOK.map((l) => `<li>${esc(l)}</li>`).join("")}</ol></main></body></html>`;
}

// ── Parker's topics: he chooses; the partners may veto within 3 days ───────────────────────────

/** Owner's seed list, 22 Oct 2026. Parker may add better ones; these are a start, not a cage. */
export const TLC_TOPIC_SEEDS: readonly string[] = [
  'Trading & Investing ("Money Reset")',
  "Fragrance Lab",
  "Matcha & Tea",
  "Zero-Proof Home Bar",
  "Home Espresso & Coffee",
  "Skincare Science",
  "Knife Skills & Home Cooking",
  "Sleep & Recovery",
  "Film Photography",
  "Sewing & Visible Mending",
  "AI Tools for Your Work",
  "Buying Your First NYC Home",
];

/** How Parker picks. Every pick is argued against all four. */
export const TLC_TOPIC_CRITERIA: readonly string[] = [
  "A sponsor's product is actually used in the session (the hands-on hour runs on it).",
  "The category already spends on in-person events.",
  "Two or three NON-competing sponsors fit the same club.",
  "People would happily pay $10 to spend 3–4 hours on it.",
];

/** Parker's picks proceed unless either partner says no within this window. Nothing waits on the owners. */
export const TLC_VETO_DAYS = 3;

export function vetoUntil(sentAt: Date): string {
  return new Date(sentAt.getTime() + TLC_VETO_DAYS * 86_400_000).toISOString();
}

/**
 * Which proposed months a partner's reply vetoes. No negative word: none. A negative word naming a
 * month ("no to February") or a topic ("not Fragrance Lab"): those. A bare "no": all of them — the
 * cautious reading of an unspecific no.
 */
export function vetoedMonths(text: string, proposed: ReadonlyArray<{ month: string; topic: string }>): string[] {
  const t = ` ${text.toLowerCase()} `;
  if (!/\b(no|not|veto|swap|pass|don't|do not|skip|change)\b/.test(t)) return [];
  const named = proposed.filter((p) => {
    const monthName = monthWords(p.month).split(" ")[0]!.toLowerCase();
    const topicWords = p.topic.toLowerCase().replace(/\(.*?\)|"/g, "").split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    return t.includes(monthName) || t.includes(monthName.slice(0, 3) + " ") || topicWords.some((w) => t.includes(w));
  });
  return (named.length ? named : proposed).map((p) => p.month);
}

// ── Card kinds ──────────────────────────────────────────────────────────────────────────────────

export const TLC_CARD_KINDS = ["TLC_TOPICS", "TLC_BOOKING_PACK", "TLC_BRAND_BATCH", "TLC_TREND_STORY", "TLC_SPONSOR_DECISION"] as const;
export type TlcCardKind = (typeof TLC_CARD_KINDS)[number];
export function isTlcKind(kind: string | null | undefined): kind is TlcCardKind {
  return (TLC_CARD_KINDS as readonly string[]).includes(kind ?? "");
}

export function quarterOf(at: Date): string {
  return `${at.getUTCFullYear()}-Q${Math.floor(at.getUTCMonth() / 3) + 1}`;
}

/** The real history the one-pager leans on before the first club has run. No invented case study. */
export const TLC_PRE_LAUNCH_PROOF: readonly string[] = [
  "West Peek Rooms: the firm's in-person gatherings. The Learning Club is their monthly New York edition.",
  "West Peek Workshops: free, hands-on virtual sessions on West Peek Live (most recently AI in business, September 2026).",
  "The West Peek community: more than 5,000 founders, operators, investors, creatives and builders.",
];

// ── Parker's topics email to both partners (owner, 22 Oct 2026) ─────────────────────────────────

/**
 * WHAT THE PARTNERS GET: the 3 picks (one per month, each with the glossy one-sheet a brand would see)
 * and 9 alternatives as a plain list, each with a one-line reason and the brands that would pay.
 * Her words: "the deliverable should be the glossy 1 sheet to sell a brand the idea for us to see and
 * approve + 9 more alt ideas in a list in the email", and "I don't need to see that he rejected
 * trading for Jan". Parker's working notes — what he turned down and why — stay on the card.
 */
export const TLC_ALTERNATIVES = 9;

// ── Where an idea came from (owner, 22 Oct 2026) ────────────────────────────────────────────────

/**
 * Every topic idea carries its origin, on the card, in the Rooms tab's ideas list and in the email:
 * a partner's own idea; one reverse-engineered from a brand that is clearly spending right now; or
 * what people are searching for and curious about. Parker weighs them all on merit — a partner's
 * idea is considered, never automatically picked (owner's correction, 22 Oct 2026).
 */
export const TLC_IDEA_ORIGINS = ["OWNER_IDEA", "BRANDS_SPENDING", "TREND"] as const;
export type TlcIdeaOrigin = (typeof TLC_IDEA_ORIGINS)[number];
export const TLC_IDEA_ORIGIN_LABEL: Record<TlcIdeaOrigin, string> = {
  OWNER_IDEA: "Partner idea",
  BRANDS_SPENDING: "Brands spending now",
  TREND: "Trend",
};
export function isIdeaOrigin(v: unknown): v is TlcIdeaOrigin {
  return typeof v === "string" && (TLC_IDEA_ORIGINS as readonly string[]).includes(v);
}
/** An idea's status on the ideas list. DROPPED stays listed: an idea is never deleted or hidden. */
export const TLC_IDEA_STATUSES = ["LATER", "PICKED", "ALTERNATIVE", "DROPPED"] as const;
export type TlcIdeaStatus = (typeof TLC_IDEA_STATUSES)[number];
/** One key per topic, so "Trading & Investing" and "trading and investing" are one idea. */
export function topicKey(topic: string): string {
  return topic.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The topic's name alone: a trailing "(Saturday afternoon, 1–5 pm)" or "(November 2026 Room)" is scheduling, not the name.
 * 22 Oct 2026: alternatives came back as "Sewing & Visible Mending (Saturday afternoon, 1–5 pm)".
 */
export function topicName(topic: string): string {
  return topic.replace(/\s*\((?=[^)]*\b(?:am|pm|saturday|thursday|friday|sunday|evening|afternoon|morning|room|20\d\d)\b)[^)]*\)\s*$/i, "").trim();
}

/**
 * The same idea under another name? "Peptides & Biohacking: New Year Reset" is the partners' "Peptides and biohacking";
 * "Trading & Investing: Money Reset" is 'Trading & Investing ("Money Reset")'. Parenthesised words and a subtitle after
 * a colon do not make a new idea.
 */
export function sameTopic(a: string, b: string): boolean {
  const k = (t: string) => topicKey(topicName(t).replace(/\(([^)]*)\)/g, " $1 "));
  const head = (t: string) => topicKey(topicName(t).split(":")[0]!.replace(/\(.*?\)/g, " "));
  const ka = k(a), kb = k(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `) || head(a) === head(b);
}

/** Where the owner-approved playbook lives: a Documents entry whose id is kept in `tlc_setting` under this key. */
export const PLAYBOOK_DOCUMENT_SETTING = "playbook_document_id";

export interface TopicsEmailPick {
  month: string;
  topic: string;
  origin: TlcIdeaOrigin;
  angle: string;
  categories: readonly string[];
  /** The glossy one-sheet, as a brand would see it. */
  onePagerUrl: string;
}
export interface TopicsEmailAlternative {
  topic: string;
  origin: TlcIdeaOrigin;
  reason: string;
  brands: readonly string[];
}

/** Words that only ever describe Parker's internal reasoning. None may reach a partner's email. */
const WORKING_NOTES = /\b(reject(?:ed|s|ing)?|not picked|why not|ruled out|turned down|passed over)\b/i;

/**
 * Why this email must not go, or [] when it may. Every month present exactly once, exactly nine
 * alternatives (none repeating a pick), each with a reason and at least one brand, a one-sheet link
 * per pick, and no working notes anywhere in what the partners read.
 */
export function topicsEmailProblems(months: readonly string[], picks: readonly TopicsEmailPick[], alts: readonly TopicsEmailAlternative[]): string[] {
  const out: string[] = [];
  for (const m of months) {
    const n = picks.filter((p) => p.month === m).length;
    if (n !== 1) out.push(`${monthWords(m)} has ${n} picks; it needs exactly one`);
  }
  for (const p of picks) if (!months.includes(p.month)) out.push(`a pick for ${p.month}, which this email is not for`);
  for (const p of picks) if (!/^https:\/\//.test(p.onePagerUrl)) out.push(`${monthWords(p.month)} has no one-sheet link`);
  for (const x of [...picks, ...alts]) if (!isIdeaOrigin(x.origin)) out.push(`"${x.topic}" has no origin label`);
  if (alts.length !== TLC_ALTERNATIVES) out.push(`${alts.length} alternatives; it needs ${TLC_ALTERNATIVES}`);
  const pickNames = new Set(picks.map((p) => p.topic.toLowerCase()));
  const seen = new Set<string>();
  for (const a of alts) {
    const k = a.topic.toLowerCase();
    if (!a.topic || !a.reason) out.push(`an alternative without a topic or a reason`);
    if (a.brands.length === 0) out.push(`the alternative "${a.topic}" names no brand that would pay`);
    if (pickNames.has(k)) out.push(`the alternative "${a.topic}" repeats a pick`);
    if (seen.has(k)) out.push(`the alternative "${a.topic}" is listed twice`);
    seen.add(k);
  }
  const text = [...picks.flatMap((p) => [p.topic, p.angle, ...p.categories]), ...alts.flatMap((a) => [a.topic, a.reason, ...a.brands])].join("\n");
  const note = WORKING_NOTES.exec(text);
  if (note) out.push(`it carries Parker's working notes ("${note[0]}"); those stay on the card`);
  return out;
}

/** The email itself, from data. Throws when `topicsEmailProblems` says it must not go. */
export function topicsEmail(input: { months: readonly string[]; picks: readonly TopicsEmailPick[]; alternatives: readonly TopicsEmailAlternative[]; goAheadOn: string }): {
  what: string;
  tldr: string;
  tldrBullets: string[];
  sections: Array<{ label: string; bullets: string[] }>;
  details: string;
} {
  const problems = topicsEmailProblems(input.months, input.picks, input.alternatives);
  if (problems.length) throw new Error(`the TLC topics email must not go: ${problems.join("; ")}`);
  const picks = [...input.picks].sort((a, b) => a.month.localeCompare(b.month));
  const year = picks[0]!.month.slice(0, 4);
  const alts = input.alternatives.map((a) => `${a.topic} (${TLC_IDEA_ORIGIN_LABEL[a.origin]}): ${a.reason} Brands that would pay: ${a.brands.join(", ")}.`);
  const chunks: string[][] = [];
  for (let i = 0; i < alts.length; i += 3) chunks.push(alts.slice(i, i + 3));
  return {
    what: `TLC topics for ${picks.map((p) => monthWords(p.month).slice(0, 3)).join(", ")} ${year}`,
    tldr: `My ${picks.length} picks for ${picks.map((p) => monthWords(p.month)).join(", ")}, each with the one-sheet a brand would see, plus ${input.alternatives.length} alternatives. They go ahead on ${input.goAheadOn} unless either of you says no.`,
    tldrBullets: ['Reply "no" to stop all of them', 'Reply "no to <month>" or "swap <month> for <alternative>" to change one', "Silence means go"],
    sections: [
      ...picks.map((p) => ({
        label: `${monthWords(p.month)}: ${p.topic}`,
        bullets: [p.angle, `Where the idea came from: ${TLC_IDEA_ORIGIN_LABEL[p.origin]}`, `Sponsor categories: ${p.categories.join(", ")}`, `The one-sheet a brand would see: ${p.onePagerUrl} (also attached)`],
      })),
      ...chunks.map((c, i) => ({ label: `${input.alternatives.length} alternatives (${i * 3 + 1}–${i * 3 + c.length})`, bullets: c })),
    ],
    details: `Brand sending stays off. Nothing goes to any brand until you approve the one-sheet.`,
  };
}
