import { useApi } from "../lib/api";
import { HowThisWorks } from "./HowThisWorks";

/**
 * Secondaries (P39, V1 #16, canon §10).
 *
 * A separate page, not a tab on Investment. Canon §10.1 makes sleeve separation a rule and §33
 * requires it be enforced; putting secondaries beside primaries invites the blending the rule
 * exists to prevent.
 *
 * The separation rule is printed on the page. It is already enforced in code — separate approval
 * action keys, separate sleeve policy — and the missing half was making that visible. A rule nobody
 * can see being applied is one people assume has lapsed.
 */

interface Opportunity {
  id: string; title: string; opportunity_type: string; status: string;
  company_name: string | null; seller_name: string | null; broker_name: string | null;
  price_per_share: number | null; discount_premium: number | null; quantity: number | null;
}

export function SecondariesPage({ onNavigate }: { onNavigate: (k: string) => void }): JSX.Element {
  const state = useApi<{
    opportunities: Opportunity[]; purchases: number; sales: number; separation_rule: string;
  }>("/api/secondaries");

  const list = state.data?.opportunities ?? [];
  const purchases = list.filter((o) => o.opportunity_type === "SECONDARY_PURCHASE");
  const sales = list.filter((o) => o.opportunity_type === "SECONDARY_SALE");

  function table(rows: Opportunity[], testid: string) {
    if (rows.length === 0) {
      // "Nothing here." twice on a page told the operator nothing about how anything gets here.
      return (
        <p className="state-empty">
          None yet. A secondary lands here the moment you mark a deal as one on Dealflow — there is
          no separate entry on this page, and nothing to keep in step.
        </p>
      );
    }
    return (
      <ul className="card-list small" data-testid={testid}>
        {rows.map((o) => (
          <li key={o.id} data-testid={`secondary-${o.id}`}>
            <span className="help-tag help-tag-muted">{o.status.toLowerCase()}</span>{" "}
            <strong>{o.company_name ?? o.title}</strong>{" "}
            <span className="muted small">
              {o.quantity ? `${o.quantity} units` : ""}
              {o.price_per_share ? ` @ ${o.price_per_share}` : ""}
              {o.discount_premium != null ? ` · ${(o.discount_premium * 100).toFixed(0)}% to last round` : ""}
              {o.seller_name ? ` · seller ${o.seller_name}` : ""}
              {o.broker_name ? ` · broker ${o.broker_name}` : ""}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="page" data-testid="secondaries-page">
      <h2>Secondaries</h2>
      <p className="muted">Purchases and sales in the secondary sleeve.</p>

      {/* WHERE THESE COME FROM, and where to go to price one. The page listed two empty tables and
          a separation rule, and answered neither question. */}
      <div className="form-row secondaries-doors">
        <button type="button" className="btn-strong" data-testid="secondaries-add" onClick={() => onNavigate("investment")}>
          Add a secondary
        </button>
        {/* The modelling dashboard is a separate product and deliberately not embedded — this is a
            signpost, framed by what you would go there to do rather than as a bare address. */}
        <a
          className="link-button"
          data-testid="secondaries-venturedeals"
          href="https://venturedeals.joinwestpeek.com"
          target="_blank"
          rel="noreferrer noopener"
        >
          Model a secondary scenario →
        </a>
        <span className="muted small">
          Pricing, discount to last round and what a block does to ownership are worked out in the
          VentureDeals dashboard.
        </span>
      </div>

      <p className="notice" data-testid="secondaries-separation">
        {state.data?.separation_rule ?? "Secondaries run as a separate sleeve from early-stage primaries."}
      </p>

      <section className="card">
        <h3>Purchases <span className="muted small">{purchases.length}</span></h3>
        {table(purchases, "secondaries-purchases")}
      </section>

      <section className="card">
        <h3>Sales <span className="muted small">{sales.length}</span></h3>
        {table(sales, "secondaries-sales")}
      </section>

      <HowThisWorks
        title="Secondaries"
        testId="secondaries"
        what="The secondary sleeve: purchases of existing shares and sales out of the portfolio, kept apart from early-stage primaries."
        when="When sourcing, pricing or deciding on a secondary transaction."
        operatorDoes={["Review what is in the sleeve and its pricing against the last round."]}
        aiDoes={["Nothing decides here. Pricing observations and watchlist signals are recorded elsewhere and surface as evidence."]}
        requiresOperator={["Every secondary approval, through the secondary sleeve's own approval path — never the primary one."]}
        next="Cross-sleeve capital allocation has its own comparison and its own reserved approval, so moving capital between sleeves is always an explicit act."
        blocked={["A secondary cannot be approved through the early-stage path: the action keys are different, and brokerage separation is enforced in code, not convention."]}
      />
    </div>
  );
}
