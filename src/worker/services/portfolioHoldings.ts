import type { Env } from "../env";
import type { FirmUserIdentity } from "../auth";
import type { RouteContext } from "../router";
import { json } from "../router";
import { privacyVisibilityClause } from "./authorize";
import { deploymentSlices, planSlices } from "../../shared/fund/allocation";
import type { ReserveDoc, SleeveDoc } from "../../shared/fund/sleeveMath";

/**
 * What the firm owns — ONE list, read by everything that claims to describe the portfolio.
 *
 * THE COMPANY THAT WAS NOT THERE. Operator, 18 Sep 2026: "the one company we invested in should
 * go there". Production holds exactly one CLOSED `investment_opportunity` — Sensori, a $10K SPV,
 * backfilled because it closed before Fund I existed and never saw an IC (migration 0050). It has
 * no `position` row: a position is booked only by `executeTransaction`, which walks share class →
 * draft → partner approval → execute, and a pre-fund SPV with placeholder economics has never been
 * walked up that ladder. Portfolio's "What we own" read `position` alone, so it said "The fund holds
 * nothing yet" while Fund strategy's composition bars, reading CLOSED opportunities, drew Sensori
 * at 100%. Two surfaces, two portfolios, on the same afternoon — and the Portfolio page's own header
 * comment recorded the disagreement as the reason the bars had been removed from it.
 *
 * THE FIX IS THE QUERY, NOT A POSITION ROW. Booking Sensori into Fund I would put a pre-fund SPV
 * with stand-in share counts into the fund's cost basis — and from there into TVPI and the LP
 * letter. That is a lie into the one document this system is most careful about. What is TRUE is
 * that the firm invested in it, and that is what a closed opportunity records. So this list is the
 * union of two facts, each kept as itself:
 *   · a CLOSED opportunity  — the firm invested. Always appears. `booked` says whether the fund
 *                             has a position for it yet.
 *   · an OPEN position      — the fund holds it. Carries the cost basis and the current mark.
 * Merged per company, so a company that is both is one row, not two.
 *
 * Composition (by kind, by sector) and the deployment ring are computed FROM this list, so the set
 * of companies Portfolio names, the bars Fund strategy draws, and the deployed figure on the ring
 * cannot disagree — there is nothing else for them to read. `tests/portfolioHoldings.test.ts` pins
 * it: a closed investment with no position must appear, and the numbers on both pages must match.
 *
 * Fund performance (`/api/funds/:id/performance`) is deliberately NOT changed: it stays the fund's
 * own ledger, positions only, because that is what an LP is owed.
 */

export interface HoldingRow {
  company_id: string;
  company: string;
  sector: string | null;
  /** EARLY_STAGE_PRIMARY, FOLLOW_ON, SECONDARY_PURCHASE… — the opportunity's own vocabulary. */
  kind: string;
  /** "SPV", "direct" — from the closed terms when recorded. */
  vehicle: string | null;
  /** The fund holds a position for it. False means: invested, recorded as closed, not yet booked. */
  booked: boolean;
  fund_id: string | null;
  fund_name: string | null;
  position_id: string | null;
  /** What went in. Booked cost basis when booked; otherwise the closed terms' amount. Null if unknown. */
  amount_in: number | null;
  /** The amount rests on placeholder economics (migration 0052). */
  provisional: boolean;
  placeholder_note: string | null;
  /** When the investment closed, as recorded — the backfilled `as_of_date` or the position's open. */
  invested_on: string | null;
  ownership_pct: number | null;
  ownership_as_of: string | null;
  valuation: { value: number; source: string; basis: string | null; as_of: string } | null;
  last_check_in: string | null;
  open_asks: number;
  open_alerts: number;
  open_follow_on_reviews: number;
  // ── Phase D: portfolio (design §6) ──
  /** The closed deal this row stands on, when there is one. Book it names it so the stand-ins heal. */
  opportunity_id: string | null;
  /** Where the deal stands: CLOSED by decision, or entered as history (backfilled). */
  stage: { status: string; backfilled: boolean } | null;
  /**
   * The row's standing, which is the Book-it state machine:
   *   unbooked → draft (a DRAFT transaction) → awaiting (PENDING_APPROVAL, one card) → booked.
   *   `declined`: the card was rejected or sent back — edit and resend.
   */
  standing: "unbooked" | "draft" | "awaiting" | "declined" | "booked";
  /** The booking in flight, when the standing is draft/awaiting/declined. */
  booking: {
    transaction_id: string;
    status: string;
    approval_card_id: string | null;
    card_state: string | null;
    quantity: number;
    price_per_share: number;
    net_amount: number;
    transaction_date: string;
    fund_id: string | null;
    vehicle: string | null;
    created_by: string;
    created_at: string;
  } | null;
  /** Shares held and the price paid, from the ledger, when booked. */
  shares: { quantity: number; price_per_share: number | null; security_class_id: string } | null;
  /** The per-company reserve (0210): the newest row, or null when none was ever set. */
  reserve: { amount: number; as_of: string; note: string | null } | null;
  /** A SECONDARY_SALE opened from this row and still live on Dealflow (decision Q5). */
  sale: { opportunity_id: string; status: string } | null;
}

/** Ownership concentration, per company, against the plan's cap (design §6: "concentration line"). */
export interface ConcentrationView {
  /** From the current concentration_policy_version; null when the fund has no policy yet. */
  max_single_company_pct: number | null;
  /** The committed capital the cap is a share of — the mandate's target size, as the ring's total. */
  committed_usd: number;
  cap_usd: number | null;
  rows: Array<{ company_id: string; company: string; at_cost_usd: number; pct_of_committed: number; ownership_pct: number | null; level: "ok" | "near" | "at" }>;
}

interface ClosedRow {
  id: string;
  backfilled_at: string | null;
  company_id: string;
  company: string;
  sector: string | null;
  opportunity_type: string;
  price_per_share: number | null;
  quantity: number | null;
  terms_json: string;
  placeholder_fields: string | null;
  placeholder_note: string | null;
  as_of_date: string | null;
}

interface PositionRow {
  position_id: string;
  company_id: string;
  company: string;
  sector: string | null;
  fund_id: string;
  fund_name: string;
  cost_basis: number;
  quantity: number;
  security_class_id: string;
  opened_at: string;
  transaction_type: string | null;
  txn_price: number | null;
  reserve_minor: number | null;
  reserve_as_of: string | null;
  reserve_note: string | null;
  value_minor: number | null;
  mark_source: string | null;
  mark_basis: string | null;
  mark_as_of: string | null;
}

function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try {
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function portfolioHoldings(env: Env, identity: FirmUserIdentity): Promise<HoldingRow[]> {
  const visibility = privacyVisibilityClause(identity, "o.privacy_label");

  const closed = (
    await env.WP_OS_DB.prepare(
      `SELECT o.id, o.backfilled_at, o.company_id, c.canonical_name AS company, c.sector, o.opportunity_type,
              o.price_per_share, o.quantity, o.terms_json, o.placeholder_fields, o.placeholder_note, o.as_of_date
         FROM investment_opportunity o
         JOIN canonical_company c ON c.id = o.company_id
        WHERE ${visibility} AND o.status = 'CLOSED' AND o.archived_at IS NULL
        ORDER BY o.as_of_date, o.created_at`,
    ).all<ClosedRow>()
  ).results ?? [];

  const positions = (
    await env.WP_OS_DB.prepare(
      `SELECT p.id AS position_id, p.company_id, c.canonical_name AS company, c.sector,
              p.fund_id, f.name AS fund_name, p.cost_basis, p.quantity, p.security_class_id, p.opened_at,
              t.transaction_type, t.price_per_share AS txn_price,
              r.amount_minor AS reserve_minor, r.as_of_date AS reserve_as_of, r.note AS reserve_note,
              m.value_minor, m.source AS mark_source, m.basis AS mark_basis, m.as_of_date AS mark_as_of
         FROM position p
         JOIN canonical_company c ON c.id = p.company_id
         JOIN fund f ON f.id = p.fund_id
         LEFT JOIN "transaction" t ON t.id = p.acquired_via_transaction_id
         LEFT JOIN position_reserve r
           ON r.id = (SELECT id FROM position_reserve WHERE position_id = p.id
                       ORDER BY as_of_date DESC, created_at DESC LIMIT 1)
         LEFT JOIN position_mark m
           ON m.id = (SELECT id FROM position_mark WHERE position_id = p.id
                       ORDER BY as_of_date DESC, created_at DESC LIMIT 1)
        WHERE p.status = 'OPEN'
        ORDER BY p.opened_at`,
    ).all<PositionRow>()
  ).results ?? [];

  const byCompany = new Map<string, HoldingRow>();
  // What each company has cost, kept per source until the end: the ledger's cost basis wins when
  // there is one, the closed terms' amount stands in until then.
  const closedAmount = new Map<string, number | null>();
  const bookedCost = new Map<string, number>();

  for (const r of closed) {
    const terms = parseJson<{ vehicle?: string; amount_invested_usd?: number }>(r.terms_json, {});
    const placeholders = parseJson<string[]>(r.placeholder_fields, []);
    const fromShares = r.price_per_share !== null && r.quantity !== null ? r.price_per_share * r.quantity : null;
    const amount = typeof terms.amount_invested_usd === "number" ? terms.amount_invested_usd : fromShares;
    const existing = byCompany.get(r.company_id);
    if (existing) {
      // A second closed deal on a company the list already carries: add the money, keep the rest.
      const prior = closedAmount.get(r.company_id) ?? null;
      closedAmount.set(r.company_id, prior === null && amount === null ? null : (prior ?? 0) + (amount ?? 0));
      existing.provisional = existing.provisional || placeholders.length > 0;
      continue;
    }
    closedAmount.set(r.company_id, amount);
    byCompany.set(r.company_id, {
      company_id: r.company_id,
      company: r.company,
      sector: r.sector,
      kind: r.opportunity_type,
      vehicle: typeof terms.vehicle === "string" ? terms.vehicle : null,
      booked: false,
      fund_id: null,
      fund_name: null,
      position_id: null,
      amount_in: null,
      provisional: placeholders.length > 0,
      placeholder_note: r.placeholder_note,
      invested_on: r.as_of_date,
      ownership_pct: null,
      ownership_as_of: null,
      valuation: null,
      last_check_in: null,
      open_asks: 0,
      open_alerts: 0,
      open_follow_on_reviews: 0,
      opportunity_id: r.id,
      stage: { status: "CLOSED", backfilled: r.backfilled_at !== null },
      standing: "unbooked",
      booking: null,
      shares: null,
      reserve: null,
      sale: null,
    });
  }

  const reserveOf = (p: PositionRow) =>
    p.reserve_minor === null || p.reserve_as_of === null ? null : { amount: Math.round(p.reserve_minor) / 100, as_of: p.reserve_as_of, note: p.reserve_note };

  for (const p of positions) {
    const valuation =
      p.value_minor === null || p.mark_source === null || p.mark_as_of === null
        ? null
        : { value: Math.round(p.value_minor) / 100, source: p.mark_source, basis: p.mark_basis, as_of: p.mark_as_of };
    bookedCost.set(p.company_id, (bookedCost.get(p.company_id) ?? 0) + p.cost_basis);
    const existing = byCompany.get(p.company_id);
    if (existing) {
      existing.booked = true;
      existing.fund_id = p.fund_id;
      existing.fund_name = p.fund_name;
      existing.position_id = existing.position_id ?? p.position_id;
      // A booked cost basis is a ledger fact; placeholder economics on the closed record no longer
      // describe what the firm paid.
      existing.provisional = false;
      existing.placeholder_note = null;
      existing.valuation = existing.valuation ?? valuation;
      existing.invested_on = existing.invested_on ?? p.opened_at.slice(0, 10);
      existing.standing = "booked";
      existing.shares = existing.shares ?? { quantity: p.quantity, price_per_share: p.txn_price, security_class_id: p.security_class_id };
      existing.reserve = existing.reserve ?? reserveOf(p);
      continue;
    }
    byCompany.set(p.company_id, {
      company_id: p.company_id,
      company: p.company,
      sector: p.sector,
      kind: p.transaction_type === "FOLLOW_ON" ? "FOLLOW_ON" : p.transaction_type === "PURCHASE" ? "SECONDARY_PURCHASE" : "EARLY_STAGE_PRIMARY",
      vehicle: null,
      booked: true,
      fund_id: p.fund_id,
      fund_name: p.fund_name,
      position_id: p.position_id,
      amount_in: null,
      provisional: false,
      placeholder_note: null,
      invested_on: p.opened_at.slice(0, 10),
      ownership_pct: null,
      ownership_as_of: null,
      valuation,
      last_check_in: null,
      open_asks: 0,
      open_alerts: 0,
      open_follow_on_reviews: 0,
      opportunity_id: null,
      stage: null,
      standing: "booked",
      booking: null,
      shares: { quantity: p.quantity, price_per_share: p.txn_price, security_class_id: p.security_class_id },
      reserve: reserveOf(p),
      sale: null,
    });
  }

  for (const [id, row] of byCompany) {
    row.amount_in = row.booked ? (bookedCost.get(id) ?? 0) : (closedAmount.get(id) ?? null);
  }

  if (byCompany.size === 0) return [];

  // The facts a partner asks next, per company, in one pass each rather than one query per row.
  const ids = [...byCompany.keys()];
  const marks = ids.map((_, i) => `?${i + 1}`).join(", ");
  const bind = (stmt: D1PreparedStatement) => stmt.bind(...ids);

  const ownership = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT company_id, ownership_pct, as_of_date FROM ownership_snapshot s
          WHERE company_id IN (${marks})
            AND as_of_date = (SELECT MAX(as_of_date) FROM ownership_snapshot WHERE company_id = s.company_id)`,
      ),
    ).all<{ company_id: string; ownership_pct: number; as_of_date: string }>()
  ).results ?? [];
  for (const o of ownership) {
    const row = byCompany.get(o.company_id);
    if (row && row.ownership_pct === null) {
      row.ownership_pct = o.ownership_pct;
      row.ownership_as_of = o.as_of_date;
    }
  }

  const checkIns = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT company_id, MAX(seen) AS last_seen FROM (
           SELECT company_id, substr(received_at, 1, 10) AS seen FROM portfolio_update WHERE company_id IN (${marks})
           UNION ALL
           SELECT company_id, as_of_date AS seen FROM portfolio_metric_snapshot WHERE company_id IN (${marks})
         ) GROUP BY company_id`,
      ),
    ).all<{ company_id: string; last_seen: string | null }>()
  ).results ?? [];
  for (const c of checkIns) {
    const row = byCompany.get(c.company_id);
    if (row) row.last_check_in = c.last_seen;
  }

  const asks = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT company_id, COUNT(*) AS n FROM support_request
          WHERE company_id IN (${marks}) AND status IN ('OPEN', 'MATCHED') GROUP BY company_id`,
      ),
    ).all<{ company_id: string; n: number }>()
  ).results ?? [];
  for (const a of asks) {
    const row = byCompany.get(a.company_id);
    if (row) row.open_asks = a.n;
  }

  const alerts = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT company_id, COUNT(*) AS n FROM portfolio_alert
          WHERE company_id IN (${marks}) AND status = 'OPEN' GROUP BY company_id`,
      ),
    ).all<{ company_id: string; n: number }>()
  ).results ?? [];
  for (const a of alerts) {
    const row = byCompany.get(a.company_id);
    if (row) row.open_alerts = a.n;
  }

  const reviews = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT company_id, COUNT(*) AS n FROM follow_on_review
          WHERE company_id IN (${marks}) AND status = 'OPEN' GROUP BY company_id`,
      ),
    ).all<{ company_id: string; n: number }>()
  ).results ?? [];
  for (const r of reviews) {
    const row = byCompany.get(r.company_id);
    if (row) row.open_follow_on_reviews = r.n;
  }

  // ── Phase D: the booking in flight, and the sale opened from the row ──
  // The newest DRAFT / PENDING_APPROVAL transaction per company is the row's standing between
  // unbooked and booked; the card's own state says whether a partner sent it back. Read from the
  // same tables the ledger writes, never inferred from the page's last click.
  const inFlight = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT t.id, t.company_id, t.status, t.approval_card_id, a.state AS card_state, t.quantity, t.price_per_share,
                t.net_amount, t.transaction_date, t.fund_id, t.vehicle, t.created_by, t.created_at
           FROM "transaction" t
           LEFT JOIN approval_card a ON a.id = t.approval_card_id
          WHERE t.company_id IN (${marks}) AND t.status IN ('DRAFT','PENDING_APPROVAL','APPROVED')
          ORDER BY t.created_at DESC`,
      ),
    ).all<{
      id: string; company_id: string; status: string; approval_card_id: string | null; card_state: string | null;
      quantity: number; price_per_share: number; net_amount: number; transaction_date: string;
      fund_id: string | null; vehicle: string | null; created_by: string; created_at: string;
    }>()
  ).results ?? [];
  for (const t of inFlight) {
    const row = byCompany.get(t.company_id);
    if (!row || row.booking) continue;
    row.booking = {
      transaction_id: t.id,
      status: t.status,
      approval_card_id: t.approval_card_id,
      card_state: t.card_state,
      quantity: t.quantity,
      price_per_share: t.price_per_share,
      net_amount: t.net_amount,
      transaction_date: t.transaction_date,
      fund_id: t.fund_id,
      vehicle: t.vehicle,
      created_by: t.created_by,
      created_at: t.created_at,
    };
    if (row.standing !== "booked") {
      const sentBack = t.card_state === "rejected" || t.card_state === "revise_requested";
      row.standing = t.status === "DRAFT" ? "draft" : sentBack ? "declined" : "awaiting";
    }
  }

  const sales = (
    await bind(
      env.WP_OS_DB.prepare(
        `SELECT id, company_id, status FROM investment_opportunity
          WHERE company_id IN (${marks}) AND opportunity_type = 'SECONDARY_SALE'
            AND status NOT IN ('CLOSED','PASS','WITHDRAWN') AND archived_at IS NULL
          ORDER BY created_at DESC`,
      ),
    ).all<{ id: string; company_id: string; status: string }>()
  ).results ?? [];
  for (const s of sales) {
    const row = byCompany.get(s.company_id);
    if (row && !row.sale) row.sale = { opportunity_id: s.id, status: s.status };
  }

  return [...byCompany.values()].sort((a, b) => a.company.localeCompare(b.company));
}

/**
 * Ownership concentration against the plan (design §6: "concentration line under the table against
 * `concentration_policy_version.max_single_company_pct` × committed — amber ≥ 80% of cap, red at
 * cap — non-colour cue is the words"). Committed is the mandate's target size, the same figure the
 * deployment ring calls "committed", so the cap and the ring agree about what the fund is.
 */
export async function concentrationView(env: Env, holdings: HoldingRow[], fundId: string | null): Promise<ConcentrationView> {
  let maxPct: number | null = null;
  let committed = 0;
  if (fundId) {
    const policy = await env.WP_OS_DB.prepare(
      "SELECT concentration_json AS doc FROM concentration_policy_version WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1",
    )
      .bind(fundId)
      .first<{ doc: string }>();
    const doc = parseJson<{ max_single_company_pct?: number }>(policy?.doc ?? null, {});
    maxPct = typeof doc.max_single_company_pct === "number" ? doc.max_single_company_pct : null;
    const mandate = await env.WP_OS_DB.prepare(
      "SELECT mandate_json AS doc FROM investment_mandate_version WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1",
    )
      .bind(fundId)
      .first<{ doc: string }>();
    const m = parseJson<{ target_size_usd?: number }>(mandate?.doc ?? null, {});
    committed = typeof m.target_size_usd === "number" ? m.target_size_usd : 0;
  }
  const cap = maxPct !== null && committed > 0 ? (committed * maxPct) / 100 : null;
  const rows = holdings
    .map((h) => {
      const atCost = h.amount_in ?? 0;
      const pct = committed > 0 ? (atCost / committed) * 100 : 0;
      const level: "ok" | "near" | "at" = cap === null ? "ok" : atCost >= cap ? "at" : atCost >= cap * 0.8 ? "near" : "ok";
      return { company_id: h.company_id, company: h.company, at_cost_usd: atCost, pct_of_committed: pct, ownership_pct: h.ownership_pct, level };
    })
    .sort((a, b) => b.at_cost_usd - a.at_cost_usd);
  return { max_single_company_pct: maxPct, committed_usd: committed, cap_usd: cap, rows };
}

/** GET /api/portfolio/holdings[?fund_id=…] — every company the firm has invested in, with its facts. */
export async function handlePortfolioHoldings(ctx: RouteContext): Promise<Response> {
  const holdings = await portfolioHoldings(ctx.env, ctx.identity!);
  const url = new URL(ctx.request.url);
  // The concentration cap is a fund's policy; read against the fund asked for, else the one the
  // booked positions name, else the firm's first fund — never against no fund while one exists.
  const fundId =
    url.searchParams.get("fund_id") ??
    holdings.find((h) => h.fund_id)?.fund_id ??
    (await ctx.env.WP_OS_DB.prepare("SELECT id FROM fund ORDER BY created_at LIMIT 1").first<{ id: string }>())?.id ??
    null;
  const concentration = await concentrationView(ctx.env, holdings, fundId);
  const booked = holdings.filter((h) => h.booked).length;
  const unbooked = holdings.length - booked;
  const invested = holdings.reduce((sum, h) => sum + (h.amount_in ?? 0), 0);
  // Held at the mark where there is one; at what was paid where there is not — and said so.
  const heldAt = holdings.reduce((sum, h) => sum + (h.valuation?.value ?? h.amount_in ?? 0), 0);
  const unvalued = holdings.filter((h) => h.valuation === null).length;
  return json({
    holdings,
    concentration,
    totals: { companies: holdings.length, booked, unbooked, invested, held_at: heldAt, unvalued },
    rule: "A company appears here when the firm has a CLOSED investment in it or the fund holds an OPEN position in it. Both are read; neither is invented from the other.",
    note:
      unbooked > 0
        ? `${unbooked} of ${holdings.length} ${unbooked === 1 ? "is" : "are"} recorded as closed but not yet booked to a fund, so ${unbooked === 1 ? "it has" : "they have"} no position, no mark and no place in fund performance. Press Book it on the row: one save, one partner's approval, and it is a position.`
        : null,
  });
}

/**
 * GET /api/portfolio/composition — what the portfolio is made of, by kind and by sector.
 *
 * Computed from `portfolioHoldings`, so the bars on Fund strategy and the list on Portfolio are
 * the same companies and the same money. Counted by money rather than by headcount: three small
 * cheques and one large one is not seventy-five per cent early stage.
 */
export async function handlePortfolioComposition(ctx: RouteContext): Promise<Response> {
  const holdings = await portfolioHoldings(ctx.env, ctx.identity!);

  let provisional = false;
  let unvalued = 0;
  let total = 0;
  const byType = new Map<string, number>();
  const bySector = new Map<string, number>();

  for (const h of holdings) {
    if (h.provisional) provisional = true;
    if (h.amount_in === null) {
      // Counted, not dropped. A holding with no recorded amount is a gap to fill, and a percentage
      // that quietly excludes it reads as though the firm owns less than it does.
      unvalued += 1;
      continue;
    }
    total += h.amount_in;
    const sector = h.sector ?? "Not recorded";
    byType.set(h.kind, (byType.get(h.kind) ?? 0) + h.amount_in);
    bySector.set(sector, (bySector.get(sector) ?? 0) + h.amount_in);
  }

  const slice = (m: Map<string, number>) =>
    [...m.entries()]
      .map(([key, usd]) => ({ key, usd, pct: total > 0 ? (usd / total) * 100 : 0 }))
      .sort((a, b) => b.usd - a.usd);

  return json({
    positions: holdings.length,
    valued: holdings.length - unvalued,
    unvalued,
    total_usd: total,
    by_type: slice(byType),
    by_sector: slice(bySector),
    provisional,
    note: provisional ? "Some amounts rest on placeholder values, so these percentages are provisional." : null,
  });
}

/**
 * GET /api/portfolio/allocation?fund_id=… — the fund's plan with what has actually gone out drawn
 * against it. The plan is `planSlices` over the fund's CURRENT policies — the same function Fund
 * strategy calls in the browser — and the one ledger figure is the sum of `amount_in` above.
 */
export async function handlePortfolioAllocation(ctx: RouteContext): Promise<Response> {
  const url = new URL(ctx.request.url);
  const fundId = url.searchParams.get("fund_id");
  if (!fundId) return json({ error: "invalid_input", detail: "fund_id is required" }, { status: 400 });

  const fund = await ctx.env.WP_OS_DB.prepare("SELECT id, name FROM fund WHERE id = ?1").bind(fundId).first<{ id: string; name: string }>();
  if (!fund) return json({ error: "not_found" }, { status: 404 });

  const current = async <T,>(table: string, column: string): Promise<T> => {
    const row = await ctx.env.WP_OS_DB.prepare(`SELECT ${column} AS doc FROM ${table} WHERE fund_id = ?1 ORDER BY version_no DESC LIMIT 1`)
      .bind(fundId)
      .first<{ doc: string }>();
    return parseJson<T>(row?.doc ?? null, {} as T);
  };
  const mandate = await current<{ target_size_usd?: number }>("investment_mandate_version", "mandate_json");
  const sleeve = await current<SleeveDoc>("sleeve_policy_version", "sleeve_json");
  const reserve = await current<ReserveDoc>("reserve_policy_version", "reserve_json");

  const fundSize = typeof mandate.target_size_usd === "number" ? mandate.target_size_usd : 0;
  const holdings = await portfolioHoldings(ctx.env, ctx.identity!);
  const deployed = holdings.reduce((sum, h) => sum + (h.amount_in ?? 0), 0);
  const provisional = holdings.some((h) => h.provisional);

  const plan = planSlices(fundSize, sleeve, reserve);
  return json({
    fund: { id: fund.id, name: fund.name },
    plan,
    deployment: deploymentSlices(plan, deployed),
    companies: holdings.length,
    provisional,
    note:
      fundSize === 0
        ? "No fund size recorded yet, so there is no plan to draw deployment against. Set the thesis on Fund strategy first."
        : provisional
          ? "The deployed figure includes amounts resting on placeholder values, so it is provisional."
          : null,
  });
}
