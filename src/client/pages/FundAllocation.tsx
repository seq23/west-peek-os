import { useMemo } from "react";
import { useApi } from "../lib/api";

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
 */

interface Slice {
  key: string;
  label: string;
  usd: number;
  color: string;
  note: string;
}

const usd = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `$${Math.round(n / 1_000)}K`;

/** Ring geometry with a 2px gap between neighbours, so segments never bleed into one another. */
function ring(slices: Slice[], total: number): Array<Slice & { dash: string; offset: number; pct: number }> {
  const C = 2 * Math.PI * 54;
  let acc = 0;
  return slices.map((s) => {
    const pct = total > 0 ? s.usd / total : 0;
    const len = Math.max(0, pct * C - 2);
    const out = { ...s, pct: pct * 100, dash: `${len} ${C - len}`, offset: -acc };
    acc += pct * C;
    return out;
  });
}

export function FundAllocation({ fundId }: { fundId: string | null }) {
  const mandate = useApi<{ versions: Array<{ mandate_json?: string }> }>(
    fundId ? `/api/funds/${fundId}/policies/mandate` : null,
    [fundId],
  );
  const sleeve = useApi<{ versions: Array<{ sleeve_json?: string }> }>(
    fundId ? `/api/funds/${fundId}/policies/sleeve` : null,
    [fundId],
  );
  const reserve = useApi<{ versions: Array<{ reserve_json?: string }> }>(
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
    const m = read<{ target_size_usd?: number }>(mandate.data?.versions?.[0]?.mandate_json);
    const s = read<{ estimated_fees_usd?: number; estimated_expenses_usd?: number; sleeves?: Array<{ key: string; target_usd?: number }> }>(
      sleeve.data?.versions?.[0]?.sleeve_json,
    );
    const r = read<{ reserve_usd?: number }>(reserve.data?.versions?.[0]?.reserve_json);
    return { fundSize: m.target_size_usd ?? 0, sleeveDoc: s, reserveUsd: r.reserve_usd ?? 0 };
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

  const fees = (parsed.sleeveDoc.estimated_fees_usd ?? 0) + (parsed.sleeveDoc.estimated_expenses_usd ?? 0);
  const secondaries = parsed.sleeveDoc.sleeves?.find((x) => x.key === "SECONDARY_PURCHASE")?.target_usd ?? 0;
  const reserves = parsed.reserveUsd;
  // Whatever is left is the money that buys initial positions — derived rather than stated, so the
  // four slices always sum to the fund exactly.
  const initial = Math.max(0, parsed.fundSize - fees - secondaries - reserves);

  const slices: Slice[] = [
    { key: "initial", label: "Initial cheques", usd: initial, color: "var(--viz-1)", note: "What actually buys ownership" },
    { key: "reserves", label: "Reserves", usd: reserves, color: "var(--viz-2)", note: "Defending ownership through the Series A" },
    { key: "secondaries", label: "Secondaries", usd: secondaries, color: "var(--viz-3)", note: "The J-curve answer" },
    { key: "fees", label: "Fees and expenses", usd: fees, color: "var(--viz-4)", note: "Off the top, before anything is invested" },
  ].filter((s) => s.usd > 0);

  const segments = ring(slices, parsed.fundSize);

  return (
    <section className="card viz-root" data-testid="fund-allocation">
      <h3>Where the fund goes</h3>
      <p className="muted small">
        The whole {usd(parsed.fundSize)}, as the firm has decided to divide it. This is the plan, not
        what has been spent.
      </p>

      <div className="allocation-body">
        <svg viewBox="0 0 130 130" width="180" height="180" role="img" aria-label={`Fund allocation of ${usd(parsed.fundSize)}`}>
          <circle cx="65" cy="65" r="54" fill="none" stroke="var(--wp-line)" strokeWidth="18" />
          {segments.map((s) => (
            <circle
              key={s.key}
              cx="65"
              cy="65"
              r="54"
              fill="none"
              stroke={s.color}
              strokeWidth="18"
              strokeDasharray={s.dash}
              strokeDashoffset={s.offset}
              transform="rotate(-90 65 65)"
            >
              <title>{`${s.label}: ${usd(s.usd)} (${s.pct.toFixed(0)}%)`}</title>
            </circle>
          ))}
          <text x="65" y="61" textAnchor="middle" className="ring-total">{usd(parsed.fundSize)}</text>
          <text x="65" y="76" textAnchor="middle" className="ring-caption">committed</text>
        </svg>

        {/* Direct labels rather than colour alone: identity never depends on telling two hues apart. */}
        <ul className="allocation-legend" data-testid="allocation-legend">
          {segments.map((s) => (
            <li key={s.key} data-testid={`allocation-${s.key}`}>
              <span className="legend-swatch" style={{ background: s.color }} aria-hidden="true" />
              <span className="legend-label">{s.label}</span>
              <span className="legend-value">{usd(s.usd)}</span>
              <span className="legend-pct">{s.pct.toFixed(0)}%</span>
              <span className="legend-note">{s.note}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* The table view, always present: a chart nobody can read is not a fallback, it is a wall. */}
      <details className="allocation-table">
        <summary>The same numbers as a table</summary>
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Part</th><th className="num">Amount</th><th className="num">Share</th></tr>
            </thead>
            <tbody>
              {segments.map((s) => (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td className="num">{usd(s.usd)}</td>
                  <td className="num">{s.pct.toFixed(1)}%</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{usd(parsed.fundSize)}</strong></td>
                <td className="num"><strong>100%</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
