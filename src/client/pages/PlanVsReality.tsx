import { useMemo } from "react";
import { useApi } from "../lib/api";
import type { DeploymentSlices, PlanSlices } from "@shared/fund/allocation";
import { paceGeometry, paceSeries, usdWords } from "@shared/fund/pace";

/**
 * WHERE THE FUND IS AGAINST ITS PLAN — Fund strategy's second band (design/FUND_STRATEGY_DESIGN.md §3.2).
 *
 * Portfolio shows what the money BOUGHT: a total, a table, a deployed slice on the ring. This band
 * shows only the DISTANCE from the plan — the pace of initial-cheque capital over the investment
 * period against the plan line from first close, and one row per pool saying how far each is from
 * where the plan puts it. Never a deployed slice, never a company list: `validate:fund-strategy-split`
 * holds the line and `validate:portfolio`'s one-ring rule keeps the ring on Portfolio.
 *
 * Every figure comes from `/api/portfolio/allocation` — `planSlices` over the current policies, the
 * ledger's deployed total, the dated timeline (0212) — and from the reserve allocations. Fees paid to
 * date has no source in this system and is shown as "not recorded", never as zero.
 */

export interface AllocationResponse {
  fund: { id: string; name: string; first_close_on: string | null };
  plan: PlanSlices;
  deployment: DeploymentSlices & { timeline: Array<{ on: string; usd: number }>; secondaries_deployed: number };
  companies: number;
  provisional: boolean;
  note: string | null;
}

export function PlanVsReality({
  fundId,
  targetPositions,
  investmentPeriodYears,
  onAmend,
  reloadKey = 0,
}: {
  fundId: string | null;
  targetPositions: number | null;
  investmentPeriodYears: number;
  /** Opens the construction Amend tray, where first close is typed. */
  onAmend: () => void;
  /** Bumped by the page when a version was saved, so the band re-reads the plan and the clock. */
  reloadKey?: number;
}): JSX.Element | null {
  const alloc = useApi<AllocationResponse>(fundId ? `/api/portfolio/allocation?fund_id=${encodeURIComponent(fundId)}` : null, [fundId, reloadKey]);
  const reserves = useApi<{ reserve_allocations: Array<{ amount: number; status?: string }> }>(fundId ? "/api/allocation/reserve-allocations" : null, [fundId, reloadKey]);

  const today = new Date().toISOString().slice(0, 10);
  const series = useMemo(() => {
    const d = alloc.data;
    if (!d) return null;
    return paceSeries({
      firstCloseOn: d.fund.first_close_on,
      investmentPeriodYears,
      planInitialUsd: d.plan.initial,
      timeline: d.deployment.timeline ?? [],
      today,
    });
  }, [alloc.data, investmentPeriodYears, today]);

  if (!fundId) return null;
  const d = alloc.data;
  const drawn = (reserves.data?.reserve_allocations ?? []).filter((a) => a.status !== "RELEASED").reduce((sum, a) => sum + (Number(a.amount) || 0), 0);

  return (
    <section className="band" data-testid="fund-plan-vs-reality">
      <div className="band-head">
        <h3>Where the fund is against its plan</h3>
        <span className="band-when">the distance, not the holdings — those are on Portfolio</span>
      </div>
      <div className="two-col">
        <article className="card" data-testid="fund-pace">
          <div className="section-head"><h4>Initial-cheque capital — pace against the plan</h4></div>
          {!d || !series ? (
            <p className="muted small">Reading the plan…</p>
          ) : series.state === "no_size" ? (
            <p className="state-empty" data-testid="fund-pace-no-size">No fund size is recorded, so there is no plan to pace against. Set the thesis first.</p>
          ) : (
            <>
              {series.state === "no_clock" && (
                <div className="notice notice-gate" data-testid="fund-pace-no-clock" role="status">
                  <p>{series.verdict}</p>
                  <div className="actions">
                    <button type="button" className="btn-strong" data-testid="fund-pace-record-first-close" onClick={onAmend}>Record first close</button>
                    <span className="muted small">Typed behind Amend, or set by the first signed commitment on LP.</span>
                  </div>
                </div>
              )}
              {series.state === "running" && (
                <p data-testid="fund-pace-verdict"><strong>{series.verdict}</strong></p>
              )}
              {d.deployment.overspend > 0 && (
                <p className="notice notice-gate" data-testid="fund-pace-overspend" role="status">
                  Deployed exceeds the initial-cheque pool by {usdWords(d.deployment.overspend)}. Either the plan is out of date — Amend it below — or a cheque drew on capital the plan set aside for reserves.
                </p>
              )}
              <PaceChart series={series} planInitial={d.plan.initial} period={investmentPeriodYears} companies={d.companies} />
              <ul className="pace-key" aria-hidden="true">
                <li><i className="plan" /> the plan — {usdWords(d.plan.initial)} over {investmentPeriodYears} years{series.state === "no_clock" ? " (no start date yet)" : ""}</li>
                <li><i /> actually out — {usdWords(series.deployedToday)}</li>
              </ul>
            </>
          )}
        </article>

        <article className="card" data-testid="fund-gap">
          <div className="section-head"><h4>The gap, pool by pool</h4></div>
          {!d ? (
            <p className="muted small">Reading the plan…</p>
          ) : (
            <ul className="gap-rows" data-testid="fund-gap-rows">
              <GapRow
                label="Initial cheques"
                testid="initial"
                pct={d.plan.initial > 0 ? Math.min(100, (d.deployment.deployed / d.plan.initial) * 100) : 0}
                figure={`${usdWords(d.deployment.deployed)} out`}
                delta={d.plan.initial > 0 ? `${usdWords(Math.max(0, d.plan.initial - d.deployment.deployed))} still to write` : "no pool planned"}
              />
              <GapRow
                label="Companies"
                testid="companies"
                pct={targetPositions ? Math.min(100, (d.companies / targetPositions) * 100) : 0}
                figure={`${d.companies} in`}
                delta={targetPositions ? `${Math.max(0, targetPositions - d.companies)} to find` : "no target set"}
              />
              <GapRow
                label="Reserves"
                testid="reserves"
                pct={d.plan.reserves > 0 ? Math.min(100, (drawn / d.plan.reserves) * 100) : 0}
                figure={`${usdWords(drawn)} drawn`}
                delta={drawn > 0 ? `${usdWords(Math.max(0, d.plan.reserves - drawn))} of ${usdWords(d.plan.reserves)} left` : "nothing drawn yet"}
              />
              <GapRow
                label="Secondaries"
                testid="secondaries"
                pct={d.plan.secondaries > 0 ? Math.min(100, (d.deployment.secondaries_deployed / d.plan.secondaries) * 100) : 0}
                figure={`${usdWords(d.deployment.secondaries_deployed)} bought`}
                delta={d.deployment.secondaries_deployed > 0 ? `${usdWords(Math.max(0, d.plan.secondaries - d.deployment.secondaries_deployed))} of the sleeve left` : "sleeve untouched"}
              />
              <li data-testid="fund-gap-fees">
                <span className="gap-label">Fees and expenses</span>
                <span className="bar" aria-hidden="true"><i style={{ width: "0%" }} /></span>
                <span className="gap-figure"><span className="to-confirm">paid to date — not recorded</span></span>
                <span className="gap-delta">no fee ledger yet · {usdWords(d.plan.fees)} planned off the top</span>
              </li>
            </ul>
          )}
          <p className="muted small">What the money bought is on Portfolio; here only the distance from the plan.</p>
        </article>
      </div>
    </section>
  );
}

function GapRow({ label, testid, pct, figure, delta }: { label: string; testid: string; pct: number; figure: string; delta: string }): JSX.Element {
  return (
    <li data-testid={`fund-gap-${testid}`}>
      <span className="gap-label">{label}</span>
      <span className="bar" role="img" aria-label={`${label}: ${figure}, ${delta}`}><i style={{ width: `${Math.max(pct > 0 ? 1 : 0, Math.min(100, pct))}%` }} /></span>
      <span className="gap-figure">{figure}</span>
      <span className="gap-delta">{delta}</span>
    </li>
  );
}

function PaceChart({ series, planInitial, period, companies }: { series: ReturnType<typeof paceSeries>; planInitial: number; period: number; companies: number }): JSX.Element {
  const g = paceGeometry(series, planInitial, period);
  const label =
    series.state === "running"
      ? `Pace chart: ${series.verdict} The plan line runs from first close to ${usdWords(planInitial)} at ${period} years.`
      : `Pace chart: ${usdWords(series.deployedToday)} out against a plan of ${usdWords(planInitial)} over ${period} years; the plan line has no start date yet.`;
  return (
    <svg className="pace" viewBox={`0 0 ${g.width} ${g.height}`} role="img" aria-label={label} data-testid="fund-pace-chart">
      <line className="axis" x1={g.x0} y1={g.y0} x2={g.x1} y2={g.y0} />
      <line className="grid" x1={g.x0} y1={g.y1} x2={g.x1} y2={g.y1} />
      <text x={g.x0 - 6} y={g.y1 + 4} textAnchor="end">{g.yTop}</text>
      <text x={g.x0 - 6} y={g.y0 + 4} textAnchor="end">$0</text>
      {series.state === "running" && <line className="plan" x1={g.plan.x1} y1={g.plan.y1} x2={g.plan.x2} y2={g.plan.y2} />}
      {g.ticks.map((t, i) => (
        <text key={t.label} x={t.x} y={g.y0 + 16} textAnchor={i === 0 ? "start" : i === g.ticks.length - 1 ? "end" : "middle"}>{t.label}</text>
      ))}
      <polyline className="actual" points={g.actualPath} />
      {g.planToday && <circle className="mark-plan" cx={g.planToday.x} cy={g.planToday.y} r={5} />}
      {g.today && (
        <>
          <circle className="mark" cx={g.today.x} cy={g.today.y} r={5} />
          <text className="lbl-strong" x={Math.min(g.today.x + 8, g.x1 - 90)} y={Math.max(g.today.y - 10, g.y1 + 12)}>
            today · {usdWords(series.deployedToday)} · {companies} {companies === 1 ? "company" : "companies"}
          </text>
        </>
      )}
    </svg>
  );
}
