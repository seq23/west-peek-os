import { useApi } from "../lib/api";

/**
 * WHAT THE PORTFOLIO IS ACTUALLY MADE OF — Portfolio's composition bars.
 *
 * This file once also hosted Fund strategy's plan ring (`FundAllocation`). On 19 Sep 2026 the ring
 * moved into the construction band (`FundConstruction.tsx`, design/FUND_STRATEGY_DESIGN.md §3.3) and
 * the composition bars stopped appearing on Fund strategy at all — Portfolio owns what the portfolio
 * IS (§2). `validate:portfolio` holds the one-ring rule; `validate:fund-strategy-split` holds the split.
 */

/**
 * What the portfolio is actually made of, right now.
 *
 * A companion to the fund ring above, answering a different question: that one shows where the
 * money is PLANNED to go, this shows what has actually been bought. Composition rather than
 * per-company, because the categories are few and their count stays stable as the portfolio grows —
 * "all of it is early stage" is a true and useful sentence at one holding and at fifty, where a ring
 * of twenty companies is twenty wedges nobody can compare.
 *
 * Counted by money rather than by headcount: three small cheques and one large one is not
 * seventy-five per cent early stage, and counting names hides exactly the concentration that
 * matters.
 */
export function Composition({ level = "h3" }: { level?: "h3" | "h4" } = {}) {
  // Portfolio hosts this under a band head (Phase D), where the panel's own head is the third rank.
  const Head = level;
  const data = useApi<{
    positions: number;
    valued: number;
    unvalued: number;
    total_usd: number;
    by_type: Array<{ key: string; usd: number; pct: number }>;
    by_sector: Array<{ key: string; usd: number; pct: number }>;
    provisional: boolean;
    note: string | null;
  }>("/api/portfolio/composition");

  const d = data.data;
  if (!d) return null;

  if (d.positions === 0) {
    return (
      <section className="card viz-root" data-testid="composition-empty">
        <Head>What the portfolio is made of</Head>
        <p className="state-empty">
          Nothing closed yet. This fills in as investments complete, and answers what share of the
          money sits in each kind of deal.
        </p>
      </section>
    );
  }

  const label = (k: string) =>
    k === "EARLY_STAGE_PRIMARY" ? "Early stage"
      : k === "SECONDARY_PURCHASE" ? "Secondaries"
        : k === "FOLLOW_ON" ? "Follow-on"
          : k === "SECONDARY_SALE" ? "Sold"
            : k;

  const bars = (rows: Array<{ key: string; usd: number; pct: number }>, testid: string) => (
    <ul className="composition-bars" data-testid={testid}>
      {rows.map((r, i) => (
        <li key={r.key} data-testid={`${testid}-${r.key}`}>
          <span className="composition-label">{testid === "composition-type" ? label(r.key) : r.key}</span>
          <span className="composition-track">
            <span
              className="composition-fill"
              style={{ width: `${Math.max(2, r.pct)}%`, background: `var(--viz-${(i % 4) + 1})` }}
            />
          </span>
          <span className="composition-pct">{r.pct.toFixed(0)}%</span>
        </li>
      ))}
    </ul>
  );

  return (
    <section className="card viz-root" data-testid="composition">
      <Head>What the portfolio is made of</Head>
      <p className="muted small">
        {d.valued} holding{d.valued === 1 ? "" : "s"} by money, not by headcount — three small cheques
        and one large one is not an even split.
      </p>

      <div className="lbl">By kind of deal</div>
      {bars(d.by_type, "composition-type")}

      <div className="lbl" style={{ marginTop: "var(--space-lg)" }}>By sector</div>
      {bars(d.by_sector, "composition-sector")}

      {d.unvalued > 0 && (
        <p className="notice small" data-testid="composition-unvalued">
          {d.unvalued} holding{d.unvalued === 1 ? " has" : "s have"} no recorded amount and {d.unvalued === 1 ? "is" : "are"}{" "}
          left out of these percentages. Enter the terms on Dealflow and it will appear here.
        </p>
      )}
      {d.note && <p className="muted small" data-testid="composition-note">{d.note}</p>}
    </section>
  );
}
