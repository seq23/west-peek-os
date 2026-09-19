/**
 * THE PACE AGAINST THE PLAN — the one chart Fund strategy draws that Portfolio does not
 * (design/FUND_STRATEGY_DESIGN.md §3.2). Pure arithmetic and geometry, so `tests/pace.test.ts`
 * can drive every state without a DOM and the page only draws what this returns.
 *
 * WHAT IT NEVER DOES: guess the origin. The plan line runs from first close over the investment
 * period to the initial-cheque pool; a fund whose `first_close_on` is not on the record has no
 * origin, and the state says so rather than drawing from the vintage year (approval question 3,
 * decided). The verdict is a sentence, never a colour.
 */

export interface PacePoint {
  /** YYYY-MM-DD — the day the money went. */
  on: string;
  usd: number;
}

export interface PaceInput {
  firstCloseOn: string | null;
  investmentPeriodYears: number;
  /** `planSlices().initial` — what is set aside for initial cheques. */
  planInitialUsd: number;
  /** Executed purchases against the early-stage sleeve, any order. */
  timeline: PacePoint[];
  /** YYYY-MM-DD. */
  today: string;
}

export type PaceState = "no_size" | "no_clock" | "running";

export interface PaceSeries {
  state: PaceState;
  /** Years since first close, clamped to the period; null without a clock. */
  yearsIn: number | null;
  /** Where the plan line stands today, in dollars; null without a clock. */
  planByToday: number | null;
  /** Cumulative deployed as of today. */
  deployedToday: number;
  /** Cumulative points in time order: t in years from first close (0 when no clock), usd cumulative. */
  actual: Array<{ t: number; usd: number; on: string }>;
  /** The verdict in words, or why there is none. */
  verdict: string;
}

const DAY_MS = 86_400_000;

function daysBetween(a: string, b: string): number {
  return (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS;
}

export function usdWords(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(abs % 1e6 === 0 ? 0 : abs >= 1e7 ? 1 : 2).replace(/\.0+$/, "")}M`;
  if (abs >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

export function paceSeries(input: PaceInput): PaceSeries {
  const period = Math.max(0.25, input.investmentPeriodYears || 4);
  const sorted = [...input.timeline].filter((p) => Number.isFinite(p.usd) && p.usd > 0 && /^\d{4}-\d{2}-\d{2}/.test(p.on)).sort((a, b) => (a.on < b.on ? -1 : a.on > b.on ? 1 : 0));
  let running = 0;
  const cumulative = sorted.map((p) => ({ on: p.on.slice(0, 10), usd: (running += p.usd) }));
  const deployedToday = cumulative.length > 0 ? cumulative[cumulative.length - 1]!.usd : 0;

  if (!(input.planInitialUsd > 0)) {
    return { state: "no_size", yearsIn: null, planByToday: null, deployedToday, actual: cumulative.map((c) => ({ t: 0, ...c })), verdict: "No fund size is recorded, so there is no plan to pace against." };
  }
  if (!input.firstCloseOn) {
    return {
      state: "no_clock", yearsIn: null, planByToday: null, deployedToday,
      actual: cumulative.map((c) => ({ t: 0, ...c })),
      verdict: "The clock starts at first close, which is not on the fund's record yet. Until it is, the plan line has no start date and the pace cannot be judged.",
    };
  }
  const yearsRaw = daysBetween(input.firstCloseOn, input.today) / 365.25;
  const yearsIn = Math.max(0, Math.min(period, yearsRaw));
  const planByToday = input.planInitialUsd * (yearsIn / period);
  const actual = cumulative.map((c) => ({ t: Math.max(0, Math.min(period, daysBetween(input.firstCloseOn!, c.on) / 365.25)), ...c }));
  const gap = deployedToday - planByToday;
  const tolerance = Math.max(1, input.planInitialUsd * 0.01);
  const verdict =
    yearsRaw < 0 ? `First close is recorded as ${input.firstCloseOn}, which is after today; the plan line has not started.`
    : Math.abs(gap) <= tolerance ? `On the plan: ${usdWords(deployedToday)} out against ${usdWords(planByToday)} planned by today.`
    : gap < 0 ? `Behind the plan by ${usdWords(-gap)}: ${usdWords(deployedToday)} out against ${usdWords(planByToday)} planned by today.`
    : `Ahead of the plan by ${usdWords(gap)}: ${usdWords(deployedToday)} out against ${usdWords(planByToday)} planned by today.`;
  return { state: "running", yearsIn, planByToday, deployedToday, actual, verdict };
}

/** The drawing, in a fixed 340×200 geometry; the page scales it with the viewBox. */
export interface PaceGeometry {
  width: number;
  height: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The plan reference line: from the origin to the pool at the end of the period. */
  plan: { x1: number; y1: number; x2: number; y2: number };
  /** The actual polyline, "x,y x,y". */
  actualPath: string;
  today: { x: number; y: number } | null;
  planToday: { x: number; y: number } | null;
  /** Year ticks along the axis. */
  ticks: Array<{ x: number; label: string }>;
  yTop: string;
}

export function paceGeometry(series: PaceSeries, planInitialUsd: number, investmentPeriodYears: number): PaceGeometry {
  const width = 340, height = 200, x0 = 44, x1 = 328, y0 = 168, y1 = 16;
  const period = Math.max(0.25, investmentPeriodYears || 4);
  const top = Math.max(planInitialUsd, series.deployedToday, 1);
  const X = (t: number) => x0 + (Math.max(0, Math.min(period, t)) / period) * (x1 - x0);
  const Y = (usd: number) => y0 - (Math.max(0, Math.min(top, usd)) / top) * (y0 - y1);
  const pts = [{ t: 0, usd: 0 }, ...series.actual.map((a) => ({ t: a.t, usd: a.usd }))];
  const withToday = series.yearsIn !== null ? [...pts, { t: series.yearsIn, usd: series.deployedToday }] : pts;
  return {
    width, height, x0, x1, y0, y1,
    plan: { x1: X(0), y1: Y(0), x2: X(period), y2: Y(planInitialUsd) },
    actualPath: withToday.map((p) => `${X(p.t).toFixed(1)},${Y(p.usd).toFixed(1)}`).join(" "),
    today: series.yearsIn !== null ? { x: X(series.yearsIn), y: Y(series.deployedToday) } : null,
    planToday: series.planByToday !== null && series.yearsIn !== null ? { x: X(series.yearsIn), y: Y(series.planByToday) } : null,
    ticks: Array.from({ length: Math.floor(period) + 1 }, (_, i) => ({ x: X(i), label: i === 0 ? "first close" : `+${i} yr${i === 1 ? "" : "s"}` })),
    yTop: usdWords(top),
  };
}
