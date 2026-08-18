import { useMemo } from "react";
import { useApi, type MeResponse } from "../lib/api";

/**
 * Deal modeling — a doorway to the team's own tool, not a second copy of it.
 *
 * WHY THERE IS NO CALCULATOR HERE. There already is one. `seq23/secondaries` is a dashboard suite
 * the team built and deployed at venturedeals.joinwestpeek.com, covering secondary deals, primary
 * rounds (priced, post-money SAFE, convertible note) and fund construction. A version rebuilt
 * inside this app was started and deleted: it covered fewer cases, would have needed maintaining
 * alongside the original, and the first time the two disagreed nobody would have known which to
 * believe.
 *
 * THE ARITHMETIC IS ALREADY SHARED, which is what makes linking safe rather than lazy. That
 * dashboard's math was ported into `shared/dealmath` with a line-by-line source map and worked
 * examples hand-verified in docs/DEAL_MATH_VERIFICATION.md, and it is what deal packets, follow-on
 * reviews and allocation all run on. Checked again on 18 Aug 2026 against partner commit a350ad6:
 * still faithful, with the one documented deviation — this port returns null from xirr when Newton
 * fails to converge, where the partner returns the last iterate. So a number produced in the
 * dashboard and a number on a deal packet come from the same rules.
 *
 * WHAT THIS PAGE ADDS is the one thing a bare link cannot: the dashboard does not know which fund
 * you run, and opens on somebody's defaults every time. So the firm's current mandate is shown
 * ready to carry across, read from the mandate itself rather than retyped — a number copied by
 * hand is how two systems start disagreeing.
 */

const DASHBOARD_URL = "https://venturedeals.joinwestpeek.com";

const usd = (n: number | undefined): string =>
  n === undefined || !Number.isFinite(n)
    ? "—"
    : n >= 1_000_000
      ? `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
      : n >= 1_000
        ? `$${Math.round(n / 1_000)}K`
        : `$${n}`;

interface Mandate {
  target_size_usd?: number;
  management_fee_pct?: number;
  check_size_usd?: { min?: number; max?: number };
  target_ownership_pct?: number;
  minimum_ownership_pct?: number;
  target_positions?: number;
}

export function ModelingPage({ me }: { me: MeResponse }) {
  const funds = useApi<{ funds: Array<{ id: string; name: string }> }>("/api/funds");
  const fund = funds.data?.funds?.[0] ?? null;
  const mandateVersions = useApi<{ versions: Array<{ mandate_json?: string; version_no: number }> }>(
    fund ? `/api/funds/${fund.id}/policies/mandate` : null,
    [fund?.id],
  );
  const reserveVersions = useApi<{ versions: Array<{ reserve_json?: string }> }>(
    fund ? `/api/funds/${fund.id}/policies/reserve` : null,
    [fund?.id],
  );

  const latest = mandateVersions.data?.versions?.[0];
  const mandate = useMemo<Mandate>(() => {
    try {
      return JSON.parse(latest?.mandate_json ?? "{}") as Mandate;
    } catch {
      return {};
    }
  }, [latest]);

  const reservePct = useMemo<number | undefined>(() => {
    try {
      return (JSON.parse(reserveVersions.data?.versions?.[0]?.reserve_json ?? "{}") as { reserve_pct?: number })
        .reserve_pct;
    } catch {
      return undefined;
    }
  }, [reserveVersions.data]);

  return (
    <section data-testid="modeling-page">
      <p className="muted small">
        The firm's deal math lives in the dashboards the team built, {me.fullName} — secondary
        deals, primary rounds and fund construction. This page does not repeat them. It hands you
        the numbers to open them with.
      </p>

      <section className="card" data-testid="modeling-launch">
        <h3>Venture deal dashboards</h3>
        <p>
          Secondary economics, primary rounds — priced, post-money SAFE and convertible note — and
          emerging-manager fund construction. Nothing you enter there leaves your browser.
        </p>
        <p>
          <a
            className="btn-strong"
            href={DASHBOARD_URL}
            target="_blank"
            rel="noreferrer noopener"
            data-testid="modeling-open"
          >
            Open the dashboards
          </a>{" "}
          <span className="muted small">venturedeals.joinwestpeek.com — opens in a new tab</span>
        </p>
      </section>

      <section className="card" data-testid="modeling-mandate">
        <h3>Your numbers, ready to carry across</h3>
        {!latest ? (
          <p className="state-empty" data-testid="modeling-no-mandate">
            No thesis recorded yet, so there is nothing to prefill. Set one on the Thesis page and
            it will appear here.
          </p>
        ) : (
          <>
            <p className="muted small">
              From mandate v{latest.version_no}. The dashboards open on their own defaults and know
              nothing about this fund — these are the values to put in.
            </p>
            <dl className="thesis-grid">
              <div>
                <dt>Fund size</dt>
                <dd>{usd(mandate.target_size_usd)}</dd>
              </div>
              <div>
                <dt>Management fee</dt>
                <dd>{mandate.management_fee_pct ?? "—"}%</dd>
              </div>
              <div>
                <dt>Initial check</dt>
                <dd>
                  {usd(mandate.check_size_usd?.min)} – {usd(mandate.check_size_usd?.max)}
                </dd>
              </div>
              <div>
                <dt>Target ownership</dt>
                <dd>
                  {mandate.target_ownership_pct ?? "—"}%
                  {mandate.minimum_ownership_pct !== undefined && (
                    <span className="muted small"> (walk below {mandate.minimum_ownership_pct}%)</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>Target positions</dt>
                <dd>{mandate.target_positions ?? "—"}</dd>
              </div>
              <div>
                <dt>Reserves</dt>
                <dd>{reservePct === undefined ? "—" : `${reservePct}%`}</dd>
              </div>
            </dl>
          </>
        )}
      </section>

      <section className="card">
        <h3>Why the two agree</h3>
        <p className="small">
          The dashboards' arithmetic was ported into this system function by function, with worked
          examples verified by hand, and it is what deal packets, follow-on reviews and allocation
          all run on. So a figure you model there and a figure on a real deal here come from the
          same rules rather than from two tools that merely look similar.
        </p>
        <p className="muted small">
          One deliberate difference: where the dashboard's IRR returns its last attempt even when
          the calculation never settles, this system returns nothing at all. An unconverged rate is
          not a verified number and should not reach a memo looking like one.
        </p>
        <p className="muted small">
          To commit a number, put it on a deal — that is where it gets an assumption ledger and a
          review. The dashboards are for thinking; this system is for deciding.
        </p>
      </section>
    </section>
  );
}
