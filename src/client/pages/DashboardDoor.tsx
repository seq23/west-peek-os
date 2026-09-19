import { useMemo, useState } from "react";
import { useApi } from "../lib/api";

/**
 * THE DASHBOARD DOOR — Fund strategy's first band (design/FUND_STRATEGY_DESIGN.md §3.1).
 *
 * The owner, 19 Sep 2026: "the link to our venture deals dashboards should be bigger and more
 * prominent." It was a `.btn-strong` inside a card in the seventh block down. It is now the band
 * directly under the masthead, and the page's ONE orange control (approval question 1, decided).
 *
 * WHY THERE IS NO CALCULATOR HERE. `seq23/secondaries` is a dashboard suite the team built and
 * deployed at venturedeals.joinwestpeek.com — secondary deals, primary rounds (priced, post-money
 * SAFE, convertible note) and fund construction. Its arithmetic was ported into `shared/dealmath`
 * with a line-by-line source map and hand-verified worked examples (docs/DEAL_MATH_VERIFICATION.md),
 * and that is what deal packets, follow-on reviews and allocation run on — so a number modelled
 * there and a number on a deal here come from the same rules. One deliberate difference: where the
 * dashboard's IRR returns its last attempt when the calculation never settles, this system returns
 * nothing at all; an unconverged rate should not reach a memo looking like a number.
 *
 * WHAT THE BAND ADDS is the one thing a bare link cannot: the dashboard does not know which fund
 * you run. The six mandate figures are read from the mandate itself and can be copied in one press.
 */

export const DASHBOARD_URL = "https://venturedeals.joinwestpeek.com";

const usd = (n: number | undefined): string =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${n}`;

export interface Mandate {
  target_size_usd?: number;
  management_fee_pct?: number;
  fund_life_years?: number;
  check_size_usd?: { min?: number; max?: number };
  target_ownership_pct?: number;
  minimum_ownership_pct?: number;
  target_positions?: number;
}

/** The six figures as one clipboard text — the same six the band shows, in the same order. */
export function figuresText(m: Mandate, reservePct: number | undefined, version: number | null): string {
  const lines = [
    `West Peek Ventures — mandate v${version ?? "?"}`,
    `Fund size: ${usd(m.target_size_usd)}`,
    `Management fee: ${m.management_fee_pct ?? "—"}% a year${m.fund_life_years ? ` over ${m.fund_life_years} years` : ""}`,
    `Initial cheque: ${usd(m.check_size_usd?.min)}–${usd(m.check_size_usd?.max)}`,
    `Target ownership: ${m.target_ownership_pct ?? "—"}%${m.minimum_ownership_pct !== undefined ? ` (walk below ${m.minimum_ownership_pct}%)` : ""}`,
    `Positions: ${m.target_positions ?? "—"}`,
    `Reserves: ${reservePct === undefined ? "—" : `${reservePct}% of early stage`}`,
  ];
  return lines.join("\n");
}

type CopyState = "idle" | "copying" | "copied" | "error";

export function DashboardDoor({ fundId }: { fundId: string | null }): JSX.Element {
  const mandateVersions = useApi<{ current: { mandate_json?: string; version_no: number } | null }>(
    fundId ? `/api/funds/${fundId}/policies/mandate` : null,
    [fundId],
  );
  const reserveVersions = useApi<{ current: { reserve_json?: string } | null }>(fundId ? `/api/funds/${fundId}/policies/reserve` : null, [fundId]);
  const [copy, setCopy] = useState<CopyState>("idle");

  const latest = mandateVersions.data?.current ?? null;
  const mandate = useMemo<Mandate>(() => {
    try { return JSON.parse(latest?.mandate_json ?? "{}") as Mandate; } catch { return {}; }
  }, [latest]);
  const reservePct = useMemo<number | undefined>(() => {
    try { return (JSON.parse(reserveVersions.data?.current?.reserve_json ?? "{}") as { reserve_pct?: number }).reserve_pct; } catch { return undefined; }
  }, [reserveVersions.data]);

  const loading = Boolean(fundId) && mandateVersions.loading;
  const mandateFailed = mandateVersions.status !== null && mandateVersions.status >= 500;
  const noMandate = !loading && !mandateFailed && !latest;
  const doorReady = DASHBOARD_URL.length > 0;

  async function copyFigures(): Promise<void> {
    if (!latest) return;
    setCopy("copying");
    try {
      await navigator.clipboard.writeText(figuresText(mandate, reservePct, latest.version_no));
      setCopy("copied");
    } catch {
      setCopy("error");
    }
  }

  return (
    <section className="band" data-testid="fund-door">
      <div className="band-head">
        <h3>Model it</h3>
        <span className="band-when">the team's own dashboards, with this fund's numbers to hand</span>
      </div>
      <article className="card door" data-testid="modeling-launch">
        <div>
          <h4 className="door-head">Model the next cheque in the venture deals dashboards</h4>
          <p className="door-lede">
            The firm's deal math lives in the dashboards the team built. This page does not repeat
            them; it hands you the numbers to open them with, and the arithmetic there is the same
            code deal packets run on.
          </p>
          <ul className="door-answers" aria-label="What the dashboards answer">
            <li>Secondary deals — what a block is worth at a discount to the last round, and to the fund.</li>
            <li>Primary rounds — priced, post-money SAFE and convertible note: ownership, dilution, the exit that returns the fund.</li>
            <li>Fund construction — reserves, cheque size and position count against a fund of this size.</li>
          </ul>
          <div className="door-actions">
            <a
              className="btn-primary btn-lg"
              href={doorReady ? DASHBOARD_URL : undefined}
              target="_blank"
              rel="noreferrer noopener"
              aria-label={`Open the venture deals dashboards — opens ${DASHBOARD_URL.replace(/^https?:\/\//, "")} in a new tab`}
              aria-disabled={!doorReady}
              data-testid="modeling-open"
            >
              Open the dashboards ↗
            </a>
            <button
              type="button"
              className="btn-strong"
              data-testid="modeling-copy"
              data-state={copy}
              aria-busy={copy === "copying"}
              disabled={!latest || copy === "copying"}
              aria-disabled={!latest || copy === "copying"}
              onClick={() => void copyFigures()}
            >
              {copy === "copying" ? "Reading the mandate…" : copy === "copied" ? "Copied — paste into the dashboard" : copy === "error" ? "Could not copy — the figures are on the right" : "Copy these six figures"}
            </button>
            {!latest && !loading && !mandateFailed && (
              <span className="muted small" data-testid="modeling-copy-reason">Nothing to copy until a mandate is set on the Thesis page.</span>
            )}
            <span className="muted small">
              Opens in a new tab. Nothing entered there leaves the browser. To commit a number, put it on a deal — that is where it gets an assumption ledger and a review.
            </span>
          </div>
        </div>
        <div>
          <p className="muted small" data-testid="modeling-figures-source">
            {loading ? "Reading the mandate…" : latest ? `Your numbers, from mandate v${latest.version_no} — the dashboards open on their own defaults.` : mandateFailed ? "" : "No mandate yet."}
          </p>
          {mandateFailed && (
            <p className="notice notice-bad" data-testid="modeling-mandate-error" role="status">
              The mandate could not be read just now. The dashboards still open — take the figures from the Thesis page for now.
            </p>
          )}
          {noMandate && (
            <p className="state-empty" data-testid="modeling-no-mandate">
              No thesis recorded yet, so there is nothing to prefill. Set one on the Thesis page and it will appear here.
            </p>
          )}
          {(loading || latest) && !mandateFailed && (
            <dl className="figures" data-testid="modeling-mandate">
              <div className="kv"><b>Fund size</b>{loading ? "—" : usd(mandate.target_size_usd)}</div>
              <div className="kv"><b>Management fee</b>{loading ? "—" : `${mandate.management_fee_pct ?? "—"}%`}<span className="muted small"> a year{mandate.fund_life_years ? `, ${mandate.fund_life_years} years` : ""}</span></div>
              <div className="kv"><b>Initial cheque</b>{loading ? "—" : `${usd(mandate.check_size_usd?.min)}–${usd(mandate.check_size_usd?.max)}`}</div>
              <div className="kv"><b>Target ownership</b>{loading ? "—" : `${mandate.target_ownership_pct ?? "—"}%`}{mandate.minimum_ownership_pct !== undefined && <span className="muted small"> (walk below {mandate.minimum_ownership_pct}%)</span>}</div>
              <div className="kv"><b>Positions</b>{loading ? "—" : mandate.target_positions ?? "—"}</div>
              <div className="kv"><b>Reserves</b>{loading ? "—" : reservePct === undefined ? "—" : `${reservePct}%`}<span className="muted small"> of early stage</span></div>
            </dl>
          )}
        </div>
      </article>
    </section>
  );
}
