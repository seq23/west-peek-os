import type { DeckFigures } from "./render";
import {
  initialCapitalUsd, investableBase, reserveUsd, sleeveTargetUsd,
  type ReserveDoc, type SleeveDoc,
} from "../fund/sleeveMath";

/**
 * The deck's figures, from the fund records and from nothing else.
 *
 * ONE FUNCTION, TWO CALLERS. The Worker's rebuild (services/deck.ts) and the Mac render
 * (scripts/deck/build.mjs) each used to build this object themselves, field by field — two lists
 * of the same keys, which is how one of them falls behind the records. Both now call this, and
 * tests/deckFigures.test.ts pins that neither builds its own.
 *
 * NO LITERALS. Every value is a field of the mandate, the fee/capital-split (sleeve) record or the
 * reserve record, or derived from them by sleeveMath. Fund terms are data in production D1, never
 * in this public repo: an absent field prints the deck's loud "not recorded" gap, never a guess.
 */

export interface MandateDoc {
  target_size_usd?: number;
  sectors?: string[];
  target_positions?: number;
  check_size_usd?: { min?: number; max?: number; typical?: number };
  management_fee_pct?: number;
  management_fee_schedule?: string;
  carried_interest_pct?: number;
  target_ownership_pct?: number;
  follow_on_check_usd?: { min?: number; max?: number; companies?: number };
  secondary_check_usd?: { min?: number; max?: number; positions?: number };
  concentration_cap_usd?: number;
  gp_commitment_pct?: number;
  gp_commitment_usd?: number;
  target_net_multiple_lps?: number;
}

export interface FigureInputs {
  mandate: MandateDoc;
  sleeve: SleeveDoc;
  reserve: ReserveDoc;
  /** Opportunities by relationship origin, for the community share. */
  origins: Array<{ o: string | null; n: number }>;
  positionsHeld: number;
  asOf: Date;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function figuresFromDocs(input: FigureInputs): DeckFigures {
  const { mandate, sleeve, reserve } = input;
  const early = (sleeve.sleeves ?? []).find((s) => s.key === "EARLY_STAGE_PRIMARY") ?? null;
  const secondary = (sleeve.sleeves ?? []).find((s) => s.key === "SECONDARY_PURCHASE") ?? null;
  const totalOpps = input.origins.reduce((sum, r) => sum + Number(r.n), 0);
  const community = input.origins.filter((r) => r.o === "COMMUNITY_INTRO").reduce((sum, r) => sum + Number(r.n), 0);
  return {
    fund_size: num(mandate.target_size_usd),
    fees: num(sleeve.estimated_fees_usd) || null,
    expenses: num(sleeve.estimated_expenses_usd) || null,
    investable_base: investableBase(sleeve) || null,
    early_sleeve_usd: early ? sleeveTargetUsd(sleeve, early) : null,
    early_sleeve_pct: early?.target_pct ?? null,
    secondary_sleeve_usd: secondary ? sleeveTargetUsd(sleeve, secondary) : null,
    secondary_sleeve_pct: secondary?.target_pct ?? null,
    reserve_pct: num(reserve.reserve_pct),
    // READ FROM THE MANDATE, never back-derived from the fee total (that printed 1.67% once).
    mgmt_fee_pct: num(mandate.management_fee_pct),
    carry_pct: num(mandate.carried_interest_pct),
    reserve_usd: reserveUsd(sleeve, reserve) || null,
    initial_capital_usd: initialCapitalUsd(sleeve, reserve) || null,
    target_positions: num(mandate.target_positions),
    check_min: num(mandate.check_size_usd?.min),
    check_max: num(mandate.check_size_usd?.max),
    sectors: mandate.sectors ?? [],
    community_sourced: totalOpps > 0 ? { through_community: community, total: totalOpps } : null,
    positions_held: input.positionsHeld,
    as_of_date: input.asOf.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
    check_typical: num(mandate.check_size_usd?.typical),
    target_ownership_pct: num(mandate.target_ownership_pct),
    follow_on_min: num(mandate.follow_on_check_usd?.min),
    follow_on_max: num(mandate.follow_on_check_usd?.max),
    follow_on_companies: num(mandate.follow_on_check_usd?.companies),
    secondary_check_min: num(mandate.secondary_check_usd?.min),
    secondary_check_max: num(mandate.secondary_check_usd?.max),
    secondary_positions: num(mandate.secondary_check_usd?.positions),
    concentration_cap: num(mandate.concentration_cap_usd),
    gp_commit_pct: num(mandate.gp_commitment_pct),
    gp_commit_usd: num(mandate.gp_commitment_usd),
    target_net_multiple: num(mandate.target_net_multiple_lps),
    mgmt_fee_schedule:
      typeof mandate.management_fee_schedule === "string" && mandate.management_fee_schedule.trim()
        ? mandate.management_fee_schedule.trim()
        : null,
  };
}
