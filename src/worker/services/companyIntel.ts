import { json } from "../router";
import type { RouteContext } from "../router";

/**
 * Company Intelligence and the Follow-On Decision Centre (P35, V1 #32 and #39).
 *
 * Both were spine-only: the records existed across six tables and there was no single place that
 * answered "what do we know about this company" or "which companies are pulling ahead".
 *
 * WHAT MAKES THIS A COMPANY INTELLIGENCE PAGE AND NOT A DATA DUMP. Everything shown carries its
 * provenance and its date. A metric with no as-of date is worse than no metric — it invites a
 * partner to quote a number in a meeting without knowing whether it is from last week or last
 * year. So `as_of_date` travels with every value, and claims arrive with their source count.
 *
 * READ-ONLY. Follow-on REVIEWS are recorded through the existing portfolio service and its
 * approval path; this surface shows what is waiting and what was decided.
 */

/**
 * GET /api/companies/:id/intelligence — everything the firm knows about one company.
 *
 * Six queries rather than one join: these are genuinely separate records with different dates and
 * different privacy labels, and flattening them into one row set would silently multiply rows
 * (a company with 5 metrics and 3 claims would produce 15).
 */
export async function handleCompanyIntelligence(ctx: RouteContext): Promise<Response> {
  const id = ctx.params.id;
  if (!id) return json({ error: "invalid_input" }, { status: 400 });

  const company = await ctx.env.WP_OS_DB.prepare(
    "SELECT id, canonical_name, website, description, status, privacy_label FROM canonical_company WHERE id = ?1",
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!company) return json({ error: "not_found" }, { status: 404 });

  const q = async (sql: string) =>
    (await ctx.env.WP_OS_DB.prepare(sql).bind(id).all<Record<string, unknown>>()).results ?? [];

  const [metrics, alerts, claims, updates, positions, opportunities] = await Promise.all([
    // Latest value per metric_key. A company reports the same metric every period, and showing all
    // of them makes the current number hard to find; the history stays available per metric.
    q(`SELECT m.metric_key, m.value, m.as_of_date, m.period_label, m.source
         FROM portfolio_metric_snapshot m
         JOIN (SELECT metric_key, MAX(as_of_date) AS latest FROM portfolio_metric_snapshot
                WHERE company_id = ?1 GROUP BY metric_key) x
           ON x.metric_key = m.metric_key AND x.latest = m.as_of_date
        WHERE m.company_id = ?1
        ORDER BY m.metric_key`),
    q(`SELECT id, alert_type, metric_key, severity, status, occurrence_count, last_seen_at
         FROM portfolio_alert WHERE company_id = ?1 AND status != 'RESOLVED'
        ORDER BY severity DESC, last_seen_at DESC LIMIT 25`),
    q(`SELECT c.id, c.claim_text, c.claim_status, c.confidence, c.created_at,
              (SELECT COUNT(*) FROM claim_source s WHERE s.claim_id = c.id) AS source_count
         FROM diligence_claim c
        WHERE c.company_id = ?1 AND c.superseded_by IS NULL
        ORDER BY c.created_at DESC LIMIT 40`),
    q(`SELECT id, period_label, received_at, summary, source
         FROM portfolio_update WHERE company_id = ?1
        ORDER BY received_at DESC LIMIT 10`),
    q(`SELECT p.id, p.quantity, p.cost_basis, p.status, p.opened_at, f.name AS fund_name
         FROM position p LEFT JOIN fund f ON f.id = p.fund_id
        WHERE p.company_id = ?1 ORDER BY p.opened_at DESC`),
    q(`SELECT id, title, opportunity_type, status, created_at
         FROM investment_opportunity WHERE company_id = ?1
        ORDER BY created_at DESC LIMIT 10`),
  ]);

  const ownership = await ctx.env.WP_OS_DB.prepare(
    `SELECT ownership_pct, fully_diluted_shares, as_of_date, source
       FROM ownership_snapshot WHERE company_id = ?1 ORDER BY as_of_date DESC LIMIT 1`,
  )
    .bind(id)
    .first<Record<string, unknown>>();

  return json({
    company,
    metrics,
    alerts,
    claims,
    updates,
    positions,
    opportunities,
    ownership: ownership ?? null,
    // Counted here so the page can say "nothing known yet" honestly instead of rendering six empty
    // sections that look like a loading failure.
    known: metrics.length + alerts.length + claims.length + updates.length + positions.length,
    unsourced_claims: claims.filter((c) => Number(c.source_count ?? 0) === 0).length,
  });
}

/**
 * GET /api/follow-on — the Follow-On Decision Centre (V1 #39).
 *
 * Canon §12.4 asks for "companies pulling ahead" with pro-rata analysis prepared. Two lists,
 * deliberately separate: reviews already queued, and companies that look like they warrant one.
 * Merging them would blur a recorded decision with a suggestion.
 */
export async function handleFollowOnCentre(ctx: RouteContext): Promise<Response> {
  const reviews = await ctx.env.WP_OS_DB.prepare(
    `SELECT r.id, r.company_id, r.status, r.reviewed_by, r.reviewed_at, r.review_note, r.created_at,
            c.canonical_name AS company_name
       FROM follow_on_review r
       LEFT JOIN canonical_company c ON c.id = r.company_id
      -- 'OPEN' is what an undecided review actually is. This read 'PENDING', which the status
      -- column cannot hold: its CHECK is ('OPEN','REVIEWED','CLOSED') and the default is 'OPEN'
      -- (migration 0011). So the ordering collapsed into one bucket, and pending_count below was
      -- permanently 0 — the "N pending" badge could never render, and a review nobody had decided
      -- sorted underneath ones that were finished.
      ORDER BY CASE r.status WHEN 'OPEN' THEN 0 ELSE 1 END, r.created_at DESC
      LIMIT 100`,
  ).all<Record<string, unknown>>();

  // "Pulling ahead" is a stated rule, not a model opinion: a held position plus a metric that
  // improved against its own previous reading. Anything cleverer would be a judgement the system
  // is not entitled to make on the partners' behalf.
  const candidates = await ctx.env.WP_OS_DB.prepare(
    /*
     * THE POSITION TRAVELS WITH THE CANDIDATE, so the review can be opened from here.
     *
     * Detection worked, the review worked, the decision worked — and a partner could not get from
     * the first to the second, because `FollowOnPage` only LISTED candidates. Opening a review needs
     * the holding it is a follow-on TO, and the row already joins `position` to find the candidate
     * at all. Carrying those columns out is what turns a list into a place you can act.
     */
    `SELECT c.id AS company_id, c.canonical_name AS company_name,
            m.metric_key, m.value AS latest_value, m.as_of_date,
            prev.value AS previous_value,
            p.id AS position_id, p.quantity AS held_shares, p.cost_basis AS existing_cost,
            p.fund_id AS fund_id
       FROM position p
       JOIN canonical_company c ON c.id = p.company_id
       JOIN portfolio_metric_snapshot m ON m.company_id = c.id
       JOIN (SELECT company_id, metric_key, MAX(as_of_date) AS latest
               FROM portfolio_metric_snapshot GROUP BY company_id, metric_key) x
         ON x.company_id = m.company_id AND x.metric_key = m.metric_key AND x.latest = m.as_of_date
       LEFT JOIN portfolio_metric_snapshot prev
         ON prev.company_id = m.company_id AND prev.metric_key = m.metric_key
        AND prev.as_of_date = (SELECT MAX(as_of_date) FROM portfolio_metric_snapshot
                                WHERE company_id = m.company_id AND metric_key = m.metric_key
                                  AND as_of_date < m.as_of_date)
      WHERE p.status = 'OPEN'
        AND prev.value IS NOT NULL
        AND m.value > prev.value
      ORDER BY (m.value - prev.value) / NULLIF(prev.value, 0) DESC
      LIMIT 25`,
  ).all<Record<string, unknown>>();

  return json({
    reviews: reviews.results ?? [],
    // Same fix, same reason: the undecided state is OPEN. Counting "PENDING" counted nothing, so a
    // partner with three reviews waiting on them was told there were none.
    pending_count: (reviews.results ?? []).filter((r) => r.status === "OPEN").length,
    candidates: candidates.results ?? [],
    // The rule is published with the result so nobody has to guess what "pulling ahead" meant.
    candidate_rule: "Open position, and the latest reading of a metric is higher than the previous reading for that same metric.",
  });
}

/**
 * GET /api/secondaries — the secondary pipeline (P39, V1 #16, canon §10).
 *
 * WHY THIS IS A SEPARATE SURFACE AND NOT A FILTER ON THE INVESTMENT PAGE. Canon §10.1 makes the
 * separation between the early-stage sleeve and the secondaries brokerage a rule, and §33 requires
 * that "early-stage and secondary workflows remain distinct" and "brokerage separation is
 * enforced". A tab on the primaries page invites exactly the blending the rule exists to prevent.
 *
 * The separation is already enforced where it matters — different approval action keys
 * (`secondary_purchase.approve`, `capital_allocation_cross_sleeve.approve`) and different sleeve
 * policy. This surface makes it VISIBLE, which is the missing half: a rule nobody can see being
 * applied is a rule people assume has lapsed.
 */
export async function handleSecondaries(ctx: RouteContext): Promise<Response> {
  const rows = await ctx.env.WP_OS_DB.prepare(
    `SELECT o.id, o.title, o.opportunity_type, o.status, o.seller_name, o.broker_name,
            o.price_per_share, o.discount_premium, o.quantity, o.created_at,
            c.canonical_name AS company_name
       FROM investment_opportunity o
       LEFT JOIN canonical_company c ON c.id = o.company_id
      WHERE o.opportunity_type IN ('SECONDARY_PURCHASE','SECONDARY_SALE')
      ORDER BY o.created_at DESC
      LIMIT 200`,
  ).all<Record<string, unknown>>();

  const list = rows.results ?? [];
  return json({
    opportunities: list,
    purchases: list.filter((o) => o.opportunity_type === "SECONDARY_PURCHASE").length,
    sales: list.filter((o) => o.opportunity_type === "SECONDARY_SALE").length,
    // Stated on the response so the page cannot render the pipeline without the rule beside it.
    separation_rule:
      "Secondaries run as a separate sleeve from early-stage primaries. They use their own approval action keys and their own sleeve policy; a secondary is never approved through the primary path.",
  });
}
