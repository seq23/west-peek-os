import { useState } from "react";
import { useApi } from "../lib/api";
import { useSelectedFund } from "../lib/selectedFund";
import { EXITS, SPINE, dealTypeLabel, stage, stallRead } from "@shared/investment/pipeline";

/**
 * Secondaries (P39, V1 #16, canon §10) — design/DEALS_SECTION_DESIGN.md §8 (artboard I).
 *
 * THE SAME OBJECT AS DEALFLOW, FILTERED TO THE SLEEVE. `investment_opportunity WHERE
 * opportunity_type IN (SECONDARY_PURCHASE, SECONDARY_SALE)`, on the same six-stage rail, with the
 * questions re-worded for a block. A separate page, not a tab on Dealflow: canon §10.1 makes sleeve
 * separation a rule and §33 requires it be enforced, and putting secondaries beside primaries
 * invites the blending the rule exists to prevent. The rule is stated ONCE, in the identity line
 * under the masthead; it used to be printed three times.
 *
 * THE SLEEVE BUDGET IS READ. `sleeve.target_usd` is `sleeveTargetUsd(SECONDARY_PURCHASE)` on the
 * fund's current sleeve policy and `sleeve.deployed_usd` is the cost of positions opened by a
 * PURCHASE transaction — both from `GET /api/secondaries`, neither typed here. Where the policy
 * does not exist the masthead says so rather than showing $0.
 *
 * THE EMPTY STATE IS THE PAGE. Nothing is in the sleeve today, so the row is drawn once as its
 * SHAPE — dashed, `aria-hidden`, bracketed values — with a sentence saying where each bracket's
 * value would come from. That is honest; two "None yet." cards were not (§1.6 #1).
 *
 * A SALE STARTS ON PORTFOLIO (§13 Q5, owner's decision). "Sell" on a booked holding opens a
 * `SECONDARY_SALE` opportunity on the holding's company; it shows here once it is a deal. Until the
 * Portfolio tab publishes its field names this page reads the ASSUMED shape:
 * `investment_opportunity.opportunity_type = 'SECONDARY_SALE'` with `company_id` set — the columns
 * the table has carried since 0006, and the ones `/api/secondaries` already selects.
 */

interface Opportunity {
  id: string;
  title: string;
  opportunity_type: string;
  status: string;
  company_id: string;
  company_name: string | null;
  seller_name: string | null;
  broker_name: string | null;
  price_per_share: number | null;
  discount_premium: number | null;
  quantity: number | null;
  exit_reason: string | null;
  created_at: string;
  in_stage_since: string;
  last_round_price: number | null;
  last_round_observed_at: string | null;
}

interface SecondariesResponse {
  opportunities: Opportunity[];
  purchases: number;
  sales: number;
  stage_counts: Record<string, number>;
  sleeve: {
    fund_id: string | null;
    fund_name: string | null;
    target_usd: number | null;
    target_source: string;
    deployed_usd: number;
    deployed_source: string;
    positions: number;
  };
  separation_rule: string;
}

const usdFull = (n: number | null | undefined): string =>
  n === undefined || n === null || Number.isNaN(n) ? "—" : `$${Math.round(n).toLocaleString("en-US")}`;

/** The rail's questions, re-worded for a block: what each stage asks of a secondary. */
const BLOCK_QUESTIONS: Record<string, string> = {
  NEW: "A block is offered",
  SCREENING: "Do we want the company?",
  DILIGENCE: "Price against the last round",
  IC_READY: "Seller, broker, block size",
  IC_DECIDED: "Its own approval key",
  CLOSED: "Booked to the sleeve",
};
const BLOCK_LABELS: Record<string, string> = { CLOSED: "Bought · Sold" };

export function SecondariesPage({ onNavigate }: { onNavigate: (k: string) => void }): JSX.Element {
  const selected = useSelectedFund();
  const fund = selected.fund;
  const state = useApi<SecondariesResponse>(
    selected.loading ? null : `/api/secondaries${fund ? `?fund_id=${encodeURIComponent(fund.id)}` : ""}`,
    [selected.loading, fund?.id],
  );
  const [filter, setFilter] = useState<string | null>(null);

  const all = state.data?.opportunities ?? [];
  const counts = state.data?.stage_counts ?? {};
  const shown = filter ? all.filter((o) => o.status === filter) : all;
  const purchases = shown.filter((o) => o.opportunity_type === "SECONDARY_PURCHASE");
  const sales = shown.filter((o) => o.opportunity_type === "SECONDARY_SALE");
  const bought = all.filter((o) => o.opportunity_type === "SECONDARY_PURCHASE" && o.status === "CLOSED").length;
  const sold = all.filter((o) => o.opportunity_type === "SECONDARY_SALE" && o.status === "CLOSED").length;
  const live = all.filter((o) => !EXITS.some((e) => e.key === o.status)).length;
  const sleeve = state.data?.sleeve;
  const unspent = sleeve && sleeve.target_usd !== null ? Math.max(0, sleeve.target_usd - sleeve.deployed_usd) : null;

  // Orange is where the human act is — one node at most. A block waiting on a decision is that.
  const actNode = (counts.IC_READY ?? 0) > 0 ? "IC_READY" : null;

  const eyebrow = [
    new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
    `${bought} bought`,
    `${sold} sold`,
    unspent !== null ? `${usdFull(unspent)} unspent` : "sleeve budget to confirm",
  ].join(" · ");

  const answer = state.loading
    ? "Reading the sleeve…"
    : state.status !== null && state.status !== 200
      ? `The sleeve could not be read (HTTP ${state.status}).`
      : all.length === 0
        ? "Nothing is in the sleeve yet."
        : `${live} in the sleeve: ${all.filter((o) => o.opportunity_type === "SECONDARY_PURCHASE").length} buying, ${all.filter((o) => o.opportunity_type === "SECONDARY_SALE").length} selling.`;

  function row(o: Opportunity): JSX.Element {
    const s = stage(o.status);
    const stall = stallRead(o.status, o.in_stage_since);
    const isExit = s?.isExit ?? false;
    const facts = [
      dealTypeLabel(o.opportunity_type),
      o.seller_name || o.broker_name
        ? `${o.seller_name ?? "seller to confirm"}${o.broker_name ? ` via ${o.broker_name}` : ""}`
        : null,
      o.quantity ? `${o.quantity.toLocaleString("en-US")} units` : null,
      o.price_per_share ? `@ ${usdFull(o.price_per_share)}` : null,
      o.discount_premium != null ? `${(o.discount_premium * 100).toFixed(0)}% to last round` : null,
    ].filter(Boolean);
    return (
      <li key={o.id} className={isExit ? "deal-row deal-row-2 deal-row-out" : "deal-row deal-row-2"} data-testid={`secondary-${o.id}`}>
        <div>
          <div className="deal-name">{o.company_name ?? o.title}</div>
          <div className="deal-sub">{facts.join(" · ")}</div>
          <div className="readiness">
            {o.status === "CLOSED" ? (
              <span className="stage-chip stage-chip-closed">{s?.label ?? o.status}</span>
            ) : (
              <span className="stage-chip">{s?.label ?? o.status}</span>
            )}
            {stall && (
              <span>
                {stall.label} here{stall.stalled ? " — stalled" : ""}
              </span>
            )}
            <span className="dot" />
            <span>
              {o.last_round_price !== null
                ? `last round: ${usdFull(o.last_round_price)}${o.last_round_observed_at ? ` · ${o.last_round_observed_at}` : ""}`
                : "last round: to confirm — no pricing observation on this company"}
            </span>
            <span className="dot" />
            <span>ownership after the block: to confirm — needs an ownership snapshot</span>
            {isExit && o.exit_reason && <span>· {o.exit_reason}</span>}
          </div>
        </div>
        <div className="deal-actions">
          <button type="button" className="btn-strong" data-testid={`secondary-open-${o.id}`} onClick={() => onNavigate("dealflow")}>
            Open on Dealflow
          </button>
        </div>
      </li>
    );
  }

  /* The row's SHAPE while there is none — bracketed, dashed, hidden from assistive tech (a screen
     reader gets the sentence beneath instead). The one inline style on the Deals surfaces: the
     stylesheet is the pattern branch's and carries no `.deal-row-shape` yet. */
  const shape = (kind: "buying" | "selling"): JSX.Element => (
    <div className="deal-row deal-row-2" style={{ opacity: 0.55, borderStyle: "dashed" }} aria-hidden="true" data-testid={`secondaries-shape-${kind}`}>
      <div>
        <div className="deal-name">[COMPANY]</div>
        <div className="deal-sub">
          Secondary — {kind} · [SELLER] via [BROKER] · [BLOCK] units @ [PRICE PER SHARE] · [DISCOUNT]% to last round
        </div>
        <div className="readiness">
          <span className="stage-chip">Screening</span>
          <span>last round: [PRICE] · [DATE]</span>
          <span className="dot" />
          <span>ownership after the block: [%]</span>
        </div>
      </div>
      <div className="deal-actions">
        <button type="button" className="btn-strong" tabIndex={-1}>
          {kind === "buying" ? "Move to diligence" : "Open on Dealflow"}
        </button>
      </div>
    </div>
  );

  return (
    <div className="page" data-testid="secondaries-page">
      <div className="masthead" data-testid="secondaries-masthead">
        <p className="masthead-date" data-testid="secondaries-eyebrow">
          {eyebrow}
        </p>
        <h2 data-testid="secondaries-answer">{answer}</h2>
        <p className="masthead-second" data-testid="secondaries-second">
          A secondary is a deal like any other: it enters on Dealflow marked as a purchase or a sale, walks the
          same stages, and shows here because the sleeve is kept apart on purpose —{" "}
          {state.data?.separation_rule
            ? "its own approval keys, its own policy, never the primary path."
            : "its own approval keys and its own sleeve policy."}
        </p>
      </div>

      {/* THE RAIL: the same six stages, filtered to the sleeve. Nodes are buttons that filter the
          two bands below; ink = has deals, orange = a decision is waiting on a person, green = booked.
          The exits line carries the sleeve budget, read from the response. */}
      <section className="card" data-testid="secondaries-rail-card">
        <ul className="stage-rail" aria-label="The secondary sleeve's pipeline" data-testid="secondaries-rail">
          {SPINE.map((s) => {
            const n = counts[s.key] ?? 0;
            const tone = s.key === actNode ? "current" : s.key === "CLOSED" && n > 0 ? "done" : n > 0 ? "filled" : "plain";
            const node = {
              type: "button" as const,
              "aria-pressed": filter === s.key,
              "aria-label": `${BLOCK_LABELS[s.key] ?? s.label}, ${n} ${n === 1 ? "deal" : "deals"}${s.key === actNode ? " — the act is here" : ""}${filter === s.key ? " (showing only these)" : ""}`,
              "data-testid": `secondaries-node-${s.key}`,
              onClick: () => setFilter((f) => (f === s.key ? null : s.key)),
              children: n,
            };
            return (
              <li key={s.key} data-testid={`secondaries-stage-${s.key}`}>
                <div className="stage-rail-line">
                  <i />
                  {/* One literal class string per tone: validate:css-classes reads only literal
                      fragments of a className, and the register must see each of these worn. */}
                  {tone === "current" ? (
                    <button {...node} className="stage-node stage-node-current" />
                  ) : tone === "done" ? (
                    <button {...node} className="stage-node stage-node-done" />
                  ) : tone === "filled" ? (
                    <button {...node} className="stage-node stage-node-filled" />
                  ) : (
                    <button {...node} className="stage-node" />
                  )}
                  <i />
                </div>
                <span className="stage-label">
                  {BLOCK_LABELS[s.key] ?? s.label}
                  {s.key === actNode && <span className="sr-only"> — the act is here</span>}
                </span>
                <span className="stage-q">{BLOCK_QUESTIONS[s.key] ?? s.question}</span>
              </li>
            );
          })}
        </ul>
        <p className="stage-rail-exits" data-testid="secondaries-budget">
          Same stages as the primary pipeline, filtered to the sleeve ·{" "}
          {sleeve && sleeve.target_usd !== null ? (
            <>
              <strong>
                {usdFull(sleeve.deployed_usd)} of {usdFull(sleeve.target_usd)}
              </strong>{" "}
              deployed <span className="muted">({sleeve.target_source})</span>
            </>
          ) : (
            <>
              <strong>{usdFull(sleeve?.deployed_usd ?? 0)} deployed</strong>, sleeve budget to confirm{" "}
              <span className="muted">({sleeve?.target_source ?? "reading the policy…"})</span>
            </>
          )}
          {(counts.PASS ?? 0) + (counts.WITHDRAWN ?? 0) > 0 && (
            <>
              {" · "}
              {counts.PASS ?? 0} passed, {counts.WITHDRAWN ?? 0} withdrawn
            </>
          )}
          {filter && (
            <>
              {" · "}
              <button type="button" className="link-button" data-testid="secondaries-clear-filter" onClick={() => setFilter(null)}>
                show every stage
              </button>
            </>
          )}
        </p>
      </section>

      <section className="band" data-testid="secondaries-purchases-band">
        <div className="band-head">
          <h3>What have we bought from existing holders?</h3>
          <span className="band-when" data-testid="secondaries-purchases-count">
            {purchases.length}
            {filter ? ` at ${stage(filter)?.label ?? filter}` : ""}
          </span>
        </div>
        {state.loading ? (
          <p className="state-message">Loading…</p>
        ) : state.status !== null && state.status !== 200 ? (
          <p className="state-message" data-testid="secondaries-error">
            The sleeve could not be read: HTTP {state.status}.
          </p>
        ) : purchases.length > 0 ? (
          <ul className="deal-list" data-testid="secondaries-purchases">
            {purchases.map(row)}
          </ul>
        ) : (
          <>
            {!filter && shape("buying")}
            <p className="state-empty" data-testid="secondaries-purchases-empty">
              {filter
                ? `Nothing we are buying is at ${stage(filter)?.label ?? filter}.`
                : "None yet. A secondary lands here the moment you mark a deal as one on Dealflow — there is no separate entry on this page, and nothing to keep in step. The row above is its shape; the bracketed values come from the deal's own record and a pricing observation against the last round, which nothing writes yet."}
            </p>
          </>
        )}
      </section>

      <section className="band" data-testid="secondaries-sales-band">
        <div className="band-head">
          <h3>What have we sold out of the portfolio?</h3>
          <span className="band-when" data-testid="secondaries-sales-count">
            {sales.length}
            {filter ? ` at ${stage(filter)?.label ?? filter}` : ""}
          </span>
        </div>
        {state.loading ? (
          <p className="state-message">Loading…</p>
        ) : sales.length > 0 ? (
          <ul className="deal-list" data-testid="secondaries-sales">
            {sales.map(row)}
          </ul>
        ) : (
          <p className="state-empty" data-testid="secondaries-sales-empty">
            {filter
              ? `Nothing we are selling is at ${stage(filter)?.label ?? filter}.`
              : "Nothing has been sold. A sale begins on the holding's row on Portfolio and shows here once it is a deal."}
          </p>
        )}
      </section>

      {/* WHERE THESE COME FROM, and where to go to price one. The modelling dashboard is a separate
          product and deliberately not embedded — a signpost framed by what you would go there to do. */}
      <div className="form-row" data-testid="secondaries-doors">
        <button type="button" className="btn-strong" data-testid="secondaries-add" onClick={() => onNavigate("dealflow")}>
          Add a secondary on Dealflow
        </button>
        <a
          className="link-button"
          data-testid="secondaries-venturedeals"
          href="https://venturedeals.joinwestpeek.com"
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Model a secondary scenario in VentureDeals (opens in a new tab)"
        >
          Model a secondary scenario in VentureDeals →
        </a>
        <span className="muted small">
          Pricing, discount to last round and what a block does to ownership are worked out there; the observation
          is recorded here.
        </span>
      </div>
    </div>
  );
}
