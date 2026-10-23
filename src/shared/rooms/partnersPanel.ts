/**
 * THE PARTNERS PANEL — every brand "yes", on every Rooms event (owner, 22 Oct 2026).
 *
 * ONE read model over BOTH places a sponsor lives, so there are never two lists: the Learning Club's
 * `tlc_deal` rows and a general Room's `evt_sponsor_prospect` rows. Per event: each brand that said
 * yes (name, Partner or Presenting, the amount, the stage: said yes, call, agreed, paid), its date,
 * a link to the conversation, a "New yes" badge for 7 days, and progress toward the event's own
 * target. TLC's target is the sponsor cash for $10,000 net ($15,000); a general Room uses its own
 * `sponsor_target_usd`, and with none it shows the committed dollars and says "no target set".
 *
 * PURE. The worker reads the rows (`services/partnersPanel.ts`); this turns them into the panel.
 */

import { TLC_TIERS, isTlcTier } from "../tlc/learningClub";

export type PartnerStage = "SAID_YES" | "CALL" | "AGREED" | "PAID";
export const PARTNER_STAGE_WORDS: Record<PartnerStage, string> = { SAID_YES: "said yes", CALL: "call", AGREED: "agreed", PAID: "paid" };
export const NEW_YES_DAYS = 7;

export interface TlcDealIn {
  id: string;
  event_id: string;
  brand: string;
  tier: string | null;
  stage: string;
  cash_offer_usd: number | null;
  counter_usd: number | null;
  in_kind_offer?: string | null;
  yes_at: string | null;
  replied_at: string | null;
  updated_at: string;
  decision_card_id: string | null;
}
export interface TlcEventIn {
  id: string;
  month: string;
  topic: string | null;
  event_date: string;
}
export interface RoomSponsorIn {
  id: string;
  event_id: string | null;
  org_name: string;
  tier: string;
  stage: string;
  committed_usd: number | null;
  ask_high_usd: number | null;
  ask_low_usd: number | null;
  contact_url: string | null;
  source_url: string | null;
  updated_at: string;
}
export interface RoomEventIn {
  id: string;
  title: string;
  starts_at: string | null;
  sponsor_target_usd: number | null;
}

export interface PanelPartner {
  id: string;
  brand: string;
  role: string;
  amountUsd: number;
  stage: PartnerStage;
  stageWords: string;
  yesAt: string;
  isNew: boolean;
  threadUrl: string | null;
}
export interface PanelEvent {
  /** Product and other in-kind help, shown apart: "In kind: Brand (spirit for the night)". Never counted toward the target. */
  inKind: Array<{ id: string; brand: string; what: string | null; stageWords: string }>;
  inKindWords: string | null;
  /** Anything wrong with the mix (e.g. a cash partner beside a Title partner). */
  warnings: string[];
  source: "TLC" | "ROOMS";
  eventId: string;
  title: string;
  when: string | null;
  partners: PanelPartner[];
  committedUsd: number;
  committedCount: number;
  targetUsd: number | null;
  partnersNeeded: number | null;
  /** "$5,000 of $15,000 · 1 of ~3 partners", or "$5,000 committed · no target set". */
  progressWords: string;
  progressPct: number | null;
}

const usd = (n: number): string => `$${Math.round(n).toLocaleString("en-US")}`;
const COMMITTED: readonly PartnerStage[] = ["AGREED", "PAID"];

function tlcStage(stage: string): PartnerStage | null {
  if (stage === "PAID" || stage === "DELIVERED") return "PAID";
  if (stage === "AGREED") return "AGREED";
  if (stage === "CALL" || stage === "WAITING_ON_OWNERS") return "CALL";
  return null;
}
function roomStage(stage: string): PartnerStage | null {
  if (stage === "COMMITTED") return "AGREED";
  if (stage === "IN_CONVERSATION") return "CALL";
  return null;
}

function isNew(yesAt: string, now: Date): boolean {
  const t = Date.parse(yesAt);
  return Number.isFinite(t) && now.getTime() - t <= NEW_YES_DAYS * 86_400_000 && now.getTime() >= t;
}

function progress(committedUsd: number, count: number, targetUsd: number | null, needed: number | null): { words: string; pct: number | null } {
  if (!targetUsd) return { words: `${usd(committedUsd)} committed · no target set`, pct: null };
  const pct = Math.min(100, Math.round((committedUsd / targetUsd) * 100));
  return { words: `${usd(committedUsd)} of ${usd(targetUsd)}${needed ? ` · ${count} of ~${needed} partners` : ""}`, pct };
}

export function partnersPanel(
  input: {
    tlcEvents: ReadonlyArray<TlcEventIn & { sponsor_goal_usd?: number | null }>;
    tlcDeals: readonly TlcDealIn[];
    roomEvents: readonly RoomEventIn[];
    roomSponsors: readonly RoomSponsorIn[];
    tlcTargetUsd: number;
    cardUrl: (id: string) => string;
  },
  now: Date,
): PanelEvent[] {
  const out: PanelEvent[] = [];
  for (const ev of input.tlcEvents) {
    const partners: PanelPartner[] = [];
    const inKind: PanelEvent["inKind"] = [];
    for (const d of input.tlcDeals.filter((x) => x.event_id === ev.id)) {
      if (d.stage === "DECLINED" || d.stage === "STOPPED") continue;
      const stage = tlcStage(d.stage) ?? (d.yes_at ? "SAID_YES" : null);
      if (!stage) continue;
      const tier = isTlcTier(d.tier) ? d.tier : null;
      if (tier === "PRODUCT") {
        inKind.push({ id: d.id, brand: d.brand, what: d.in_kind_offer ?? null, stageWords: PARTNER_STAGE_WORDS[stage] });
        continue;
      }
      const amount = d.cash_offer_usd ?? d.counter_usd ?? (tier ? TLC_TIERS[tier].priceUsd : null) ?? TLC_TIERS.PARTNER.priceUsd!;
      const yesAt = d.yes_at ?? d.replied_at ?? d.updated_at;
      partners.push({
        id: d.id, brand: d.brand, role: tier ? TLC_TIERS[tier].label : "Partner", amountUsd: amount, stage, stageWords: PARTNER_STAGE_WORDS[stage],
        yesAt, isNew: isNew(yesAt, now), threadUrl: d.decision_card_id ? input.cardUrl(d.decision_card_id) : null,
      });
    }
    const committed = partners.filter((p) => COMMITTED.includes(p.stage));
    const committedUsd = committed.reduce((s, p) => s + p.amountUsd, 0);
    const target = ev.sponsor_goal_usd && ev.sponsor_goal_usd > 0 ? ev.sponsor_goal_usd : input.tlcTargetUsd;
    const warnings: string[] = [];
    if (committed.some((p) => p.role === TLC_TIERS.TITLE.label) && committed.length > 1) warnings.push("A Title partner is the only cash partner that night; another cash partner is also agreed.");
    out.push({
      source: "TLC", eventId: ev.id, title: `The Learning Club: ${ev.topic ?? "topic not picked yet"}`, when: ev.event_date,
      partners: partners.sort((a, b) => b.yesAt.localeCompare(a.yesAt)), committedUsd, committedCount: committed.length,
      targetUsd: target, partnersNeeded: null,
      progressWords: `${usd(committedUsd)} of ${usd(target)} · ${committed.length} partner${committed.length === 1 ? "" : "s"}`,
      progressPct: Math.min(100, Math.round((committedUsd / target) * 100)),
      inKind, inKindWords: inKind.length ? `In kind: ${inKind.map((x) => `${x.brand}${x.what ? ` (${x.what})` : ""}`).join("; ")}` : null, warnings,
    });
  }
  for (const ev of input.roomEvents) {
    const partners: PanelPartner[] = [];
    const inKind: PanelEvent["inKind"] = [];
    for (const s of input.roomSponsors.filter((x) => x.event_id === ev.id)) {
      const stage = roomStage(s.stage);
      if (!stage) continue;
      if (s.tier === "IN_KIND") {
        inKind.push({ id: s.id, brand: s.org_name, what: null, stageWords: PARTNER_STAGE_WORDS[stage] });
        continue;
      }
      partners.push({
        id: s.id, brand: s.org_name, role: s.tier === "PRESENTING" ? "Presenting partner" : "Partner", amountUsd: s.committed_usd ?? s.ask_high_usd ?? s.ask_low_usd ?? 0, stage, stageWords: PARTNER_STAGE_WORDS[stage],
        yesAt: s.updated_at, isNew: isNew(s.updated_at, now), threadUrl: s.contact_url ?? s.source_url ?? null,
      });
    }
    const committed = partners.filter((p) => COMMITTED.includes(p.stage));
    const committedUsd = committed.reduce((s, p) => s + p.amountUsd, 0);
    const pr = progress(committedUsd, committed.length, ev.sponsor_target_usd, null);
    out.push({
      source: "ROOMS", eventId: ev.id, title: ev.title, when: ev.starts_at, partners: partners.sort((a, b) => b.yesAt.localeCompare(a.yesAt)),
      committedUsd, committedCount: committed.length, targetUsd: ev.sponsor_target_usd, partnersNeeded: null, progressWords: pr.words, progressPct: pr.pct,
      inKind, inKindWords: inKind.length ? `In kind: ${inKind.map((x) => x.brand).join("; ")}` : null, warnings: [],
    });
  }
  return out;
}
