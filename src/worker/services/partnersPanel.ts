import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { actorFromIdentity } from "./authorize";
import { PARTNERS } from "../../shared/registry/partners";
import { partnersPanel, type PanelEvent } from "../../shared/rooms/partnersPanel";
import { TLC_SPONSOR_CASH_TARGET_USD, TLC_TIERS } from "../../shared/tlc/learningClub";

/**
 * THE PARTNERS PANEL'S ONE SERVER READ (owner, 22 Oct 2026). Live from the rows that already exist,
 * `tlc_deal` and `evt_sponsor_prospect`, through the one pure model in shared/rooms/partnersPanel.ts.
 * It sends nothing and writes nothing.
 */
export async function readPartnersPanel(env: Env, now: Date): Promise<PanelEvent[]> {
  const all = async <T>(sql: string): Promise<T[]> => (await env.WP_OS_DB.prepare(sql).all<T>()).results ?? [];
  return partnersPanel(
    {
      tlcEvents: await all("SELECT id, month, topic, event_date FROM tlc_event WHERE status NOT IN ('CANCELLED') ORDER BY month"),
      tlcDeals: await all("SELECT id, event_id, brand, tier, stage, cash_offer_usd, counter_usd, yes_at, replied_at, updated_at, decision_card_id FROM tlc_deal"),
      roomEvents: await all("SELECT id, title, starts_at, sponsor_target_usd FROM evt_event WHERE status NOT IN ('CANCELLED') ORDER BY COALESCE(starts_at, created_at) DESC LIMIT 200"),
      roomSponsors: await all("SELECT id, event_id, org_name, tier, stage, committed_usd, ask_high_usd, ask_low_usd, contact_url, source_url, updated_at FROM evt_sponsor_prospect WHERE event_id IS NOT NULL"),
      tlcTargetUsd: TLC_SPONSOR_CASH_TARGET_USD,
      tlcPartnerPriceUsd: TLC_TIERS.PARTNER.priceUsd,
      tlcPresentingPriceUsd: TLC_TIERS.PRESENTING.priceUsd,
      cardUrl: (id) => `#/work/${encodeURIComponent(id)}`,
    },
    now,
  );
}

/** GET /api/rooms/partners — partners only. */
export async function handleRoomsPartners(ctx: RouteContext): Promise<Response> {
  const actor = actorFromIdentity(ctx.identity!);
  if (actor.type !== "HUMAN" || !PARTNERS.some((p) => p.firmUserId === actor.firmUserId)) {
    return json({ error: "forbidden", detail: "the partners panel is for the partners" }, { status: 403 });
  }
  return json({ events: await readPartnersPanel(ctx.env, new Date()) });
}
