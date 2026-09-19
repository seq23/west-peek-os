import { useMemo } from "react";
import { useApi } from "../lib/api";
import type { ReserveDoc, SleeveDoc } from "@shared/fund/sleeveMath";
import { planRingSlices, planSlices } from "@shared/fund/allocation";
import { AllocationRing } from "./AllocationRing";

/**
 * Where the fund actually goes — the whole $30M, as parts of one thing.
 *
 * WHY A DONUT HERE AND NOWHERE ELSE. A ring is a weak way to compare magnitudes and a good way to
 * read PART-OF-A-WHOLE, which is exactly the question about fund construction: fees, reserves and
 * two sleeves add to the fund and nothing else. Four slices, one hundred per cent, no comparison
 * being asked for.
 *
 * IT IS DELIBERATELY NOT A DONUT OF PORTFOLIO COMPANIES. That is the chart this page would
 * obviously grow, and it would be wrong twice: with one position it is a circle at 100%, and with
 * twenty it becomes twenty slices nobody can read. Companies are ranked bars underneath, where
 * length compares honestly and a long tail stays legible.
 *
 * THE SLICES ARE POLICY, NOT MEASUREMENT. Fees, reserves and the sleeve split come from the fund's
 * own policy versions, so the ring shows what the firm DECIDED. What is actually deployed is drawn
 * over it as a separate mark, because "planned" and "spent" are different claims and a chart that
 * blends them is how a fund convinces itself it is further along than it is.
 *
 * Colours are the validated West Peek categorical palette — the brand orange leads, and every
 * adjacent pair clears the colourblind separation floor on this page's own paper.
 *
 * THE DRAWING AND THE ARITHMETIC ARE NOT HERE ANY MORE. The ring is `AllocationRing` and the four
 * figures are `planSlices` in `@shared/fund/allocation`, because Portfolio draws the same ring with
 * what has been deployed against it and the operator asked for the graphs on both pages. One
 * definition, two hosts; a test feeds both from one fixture and diffs the numbers.
 */

const usd = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `$${Math.round(n / 1_000)}K`;

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

export function FundAllocation({ fundId }: { fundId: string | null }) {
  const mandate = useApi<{ versions: Array<{ mandate_json?: string }>; current: { mandate_json?: string } | null }>(
    fundId ? `/api/funds/${fundId}/policies/mandate` : null,
    [fundId],
  );
  const sleeve = useApi<{ versions: Array<{ sleeve_json?: string }>; current: { sleeve_json?: string } | null }>(
    fundId ? `/api/funds/${fundId}/policies/sleeve` : null,
    [fundId],
  );
  const reserve = useApi<{ versions: Array<{ reserve_json?: string }>; current: { reserve_json?: string } | null }>(
    fundId ? `/api/funds/${fundId}/policies/reserve` : null,
    [fundId],
  );

  const parsed = useMemo(() => {
    const read = <T,>(raw: string | undefined): T => {
      try {
        return JSON.parse(raw ?? "{}") as T;
      } catch {
        return {} as T;
      }
    };
    // `current`, not `[0]`: the ring drew the first mandate ever written, not the one in force.
    const m = read<{ target_size_usd?: number }>(mandate.data?.current?.mandate_json);
    const s = read<SleeveDoc>(sleeve.data?.current?.sleeve_json);
    const r = read<ReserveDoc>(reserve.data?.current?.reserve_json);
    /*
     * DERIVED, NOT READ. These used to take `target_usd` and `reserve_usd` straight off the policy
     * document — the same independently-stored figures that disagreed with their own percentages by
     * $200K and $280K. The percentage is the policy; the dollars are a computation over an
     * investable base that moves. Reading the stored figure here would have drawn a ring of numbers
     * the register was simultaneously reporting as wrong.
     */
    return { fundSize: m.target_size_usd ?? 0, sleeveDoc: s, reserveDoc: r };
  }, [mandate.data, sleeve.data, reserve.data]);

  if (!fundId) return null;
  if (parsed.fundSize === 0) {
    return (
      <section className="card" data-testid="allocation-empty">
        <h3>Where the fund goes</h3>
        <p className="state-empty">
          No fund size recorded yet, so there is nothing to divide up. Set the thesis first.
        </p>
      </section>
    );
  }

  const plan = planSlices(parsed.fundSize, parsed.sleeveDoc, parsed.reserveDoc);
  const slices = planRingSlices(plan);

  return (
    <section className="card viz-root" data-testid="fund-allocation">
      <h3>Where the fund goes</h3>
      <p className="muted small">
        The whole {usd(parsed.fundSize)}, as the firm has decided to divide it. This is the plan, not
        what has been spent — what has been spent is drawn against this on Portfolio.
      </p>
      <AllocationRing slices={slices} total={parsed.fundSize} caption="committed" testid="allocation" />
    </section>
  );
}
