import type { RingSlice } from "@shared/fund/allocation";

/**
 * The allocation ring — ONE drawing, hosted on Fund strategy (the plan) and on Portfolio (the same
 * plan with what has actually been deployed drawn against it).
 *
 * WHY IT IS EXTRACTED RATHER THAN COPIED. Fund strategy drew this inline. The operator asked for
 * "the pictorial graphs in portfolio allocation from the fund strategy page" on Portfolio, and the
 * obvious move was to copy the SVG across. Two copies of a chart drift the way two copies of a
 * number drift: a gap fixed here and not there, a legend reworded on one page. So the SVG, the
 * legend and the table live here once, and each host passes in the segments it means.
 *
 * WHY A DONUT. A ring is a weak way to compare magnitudes and a good way to read PART-OF-A-WHOLE,
 * which is exactly the question about a fund: the parts add to the fund and nothing else.
 *
 * Colours arrive as token names on the slices (`var(--viz-*)`, `var(--wp-line)`); nothing here
 * declares one.
 */

const usd = (n: number): string =>
  n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M` : `$${Math.round(n / 1_000)}K`;

/** Ring geometry with a 2px gap between neighbours, so segments never bleed into one another. */
export function ringSegments(slices: RingSlice[], total: number): Array<RingSlice & { dash: string; offset: number; pct: number }> {
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

export function AllocationRing({
  slices,
  total,
  caption,
  testid,
  format = usd,
  ariaLabel,
}: {
  slices: RingSlice[];
  total: number;
  /** The word under the total inside the ring: "committed", "deployed". */
  caption: string;
  /** Prefix for the legend rows' test ids, so two hosts on one page stay distinguishable. */
  testid: string;
  /**
   * How a value is written. Dollars by default — the fund hosts. The meeting room's "chart this"
   * answers (Phase C) are counts and metrics, not money, and pass their own. The ring is still the
   * one ring: on 18 Sep 2026 `validate:portfolio` caught RoomPanel drawing its own strokeDasharray
   * geometry, and this prop is what let it host the same drawing instead of a second one.
   */
  format?: (n: number) => string;
  /** The accessible name for the drawing; defaults to the fund hosts' wording. */
  ariaLabel?: string;
}): JSX.Element {
  const segments = ringSegments(slices, total);
  return (
    <>
      <div className="allocation-body">
        <svg viewBox="0 0 130 130" width="180" height="180" role="img" aria-label={ariaLabel ?? `Allocation of ${format(total)}`}>
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
              <title>{`${s.label}: ${format(s.usd)} (${s.pct.toFixed(0)}%)`}</title>
            </circle>
          ))}
          <text x="65" y="61" textAnchor="middle" className="ring-total">{format(total)}</text>
          <text x="65" y="76" textAnchor="middle" className="ring-caption">{caption}</text>
        </svg>

        {/* Direct labels rather than colour alone: identity never depends on telling two hues apart. */}
        <ul className="allocation-legend" data-testid={`${testid}-legend`}>
          {segments.map((s) => (
            <li key={s.key} data-testid={`${testid}-${s.key}`}>
              <span className="legend-swatch" style={{ background: s.color }} aria-hidden="true" />
              <span className="legend-label">{s.label}</span>
              <span className="legend-value">{format(s.usd)}</span>
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
                  <td className="num">{format(s.usd)}</td>
                  <td className="num">{s.pct.toFixed(1)}%</td>
                </tr>
              ))}
              <tr>
                <td><strong>Total</strong></td>
                <td className="num"><strong>{format(total)}</strong></td>
                <td className="num"><strong>100%</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
