import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import {
  initialCapitalUsd, investableBase, reserveUsd, sleeveTargetUsd, usd,
  type ReserveDoc, type SleeveDoc,
} from "@shared/fund/sleeveMath";

/**
 * Changing the fund's construction, without a migration and without anybody's help.
 *
 * Operator, 9 Sep 2026: "we need to be able to adjust this ourselves in the OS UI", and again:
 * "always leave in the UI flexibility for us to change things". Until this existed, moving the split
 * from 70/30 meant asking somebody to write a migration — a system she asks somebody to operate
 * rather than one she operates.
 *
 * THE PERCENTAGE IS THE INPUT AND THE DOLLAR IS THE OUTPUT, and that single rule is the whole design.
 * A form with two editable fields that can disagree is the defect this repo spent a day removing:
 * `sleeve_policy_version` v1 stored 70% AND $17.0M against a $24.0M base, disagreeing by $200K, and
 * the reserve stored the same pair disagreeing by $280K. A naive editor puts that straight back
 * through the front door. So everything computable is rendered, never entered — investable base,
 * each sleeve in dollars, reserves, and the capital left for initial cheques.
 *
 * THE CONSEQUENCE IS SHOWN BEFORE SAVING, NOT AFTER. She chose 70/30 of investable capital knowing
 * it takes early stage from $21M to $16.8M — but she only knew because somebody put it in front of
 * her. The affordability line recomputes as she types, so the next decision of that shape is made
 * with its cost visible rather than discovered a month later by a validator.
 *
 * SAVING WRITES A NEW VERSION. Never a mutation. That versioning is the only reason the August
 * discrepancies were recoverable at all.
 */

interface PolicyResponse<T> {
  current: T | null;
}

interface MandateRow { version_no: number; mandate_json: string }
interface SleeveRow { version_no: number; sleeve_json: string }
interface ReserveRow { version_no: number; reserve_json: string }

interface MandateDoc {
  target_size_usd?: number;
  sectors?: string[];
  target_positions?: number;
  check_size_usd?: { min?: number; max?: number };
  [k: string]: unknown;
}

/** The five the firm settled on, plus the ones the deck has used, so the picker is not a text box. */
const SECTOR_CHOICES = [
  { key: "AI", label: "AI" },
  { key: "HEALTH_TECH", label: "Healthcare" },
  { key: "CONSUMER", label: "Consumer" },
  { key: "ED_TECH", label: "Education" },
  { key: "FUTURE_OF_WORK", label: "Future of work" },
  { key: "FINTECH", label: "Fintech" },
  { key: "CLIMATE", label: "Climate" },
];

function parse<T>(raw: string | undefined | null): T {
  try {
    return JSON.parse(raw ?? "{}") as T;
  } catch {
    return {} as T;
  }
}

export function FundConstruction({ fundId }: { fundId: string | null }): JSX.Element | null {
  const mandate = useApi<PolicyResponse<MandateRow>>(fundId ? `/api/funds/${fundId}/policies/mandate` : null);
  const sleeve = useApi<PolicyResponse<SleeveRow>>(fundId ? `/api/funds/${fundId}/policies/sleeve` : null);
  const reserve = useApi<PolicyResponse<ReserveRow>>(fundId ? `/api/funds/${fundId}/policies/reserve` : null);

  // ── The INPUTS. Everything else on this page is computed from these four blocks. ──
  const [fundSizeM, setFundSizeM] = useState(30);
  const [feePct, setFeePct] = useState(2);
  const [fundLifeYears, setFundLifeYears] = useState(10);
  const [expensesM, setExpensesM] = useState(1);
  const [earlyPct, setEarlyPct] = useState(70);
  const [reservePct, setReservePct] = useState(40);
  const [positions, setPositions] = useState(25);
  const [checkMinK, setCheckMinK] = useState(250);
  const [checkMaxK, setCheckMaxK] = useState(750);
  const [sectors, setSectors] = useState<string[]>([]);
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const mandateDoc = parse<MandateDoc>(mandate.data?.current?.mandate_json);
  const sleeveDoc = parse<SleeveDoc>(sleeve.data?.current?.sleeve_json);
  const reserveDoc = parse<ReserveDoc>(reserve.data?.current?.reserve_json);

  /*
   * SEEDED FROM WHAT IS STORED, once the policies arrive. A form that defaults to invented values
   * and then saves them is how a page silently overwrites the real setting — the exact bug the
   * quiet-hours picker had.
   */
  const seedKey = `${mandate.data?.current?.version_no}:${sleeve.data?.current?.version_no}:${reserve.data?.current?.version_no}`;
  useEffect(() => {
    if (!mandate.data?.current && !sleeve.data?.current) return;
    if (typeof mandateDoc.target_size_usd === "number") setFundSizeM(mandateDoc.target_size_usd / 1e6);
    if (typeof mandateDoc.target_positions === "number") setPositions(mandateDoc.target_positions);
    if (typeof mandateDoc.check_size_usd?.min === "number") setCheckMinK(mandateDoc.check_size_usd.min / 1000);
    if (typeof mandateDoc.check_size_usd?.max === "number") setCheckMaxK(mandateDoc.check_size_usd.max / 1000);
    if (Array.isArray(mandateDoc.sectors)) setSectors(mandateDoc.sectors);
    if (typeof sleeveDoc.estimated_expenses_usd === "number") setExpensesM(sleeveDoc.estimated_expenses_usd / 1e6);
    const early = (sleeveDoc.sleeves ?? []).find((s) => s.key === "EARLY_STAGE_PRIMARY");
    if (typeof early?.target_pct === "number") setEarlyPct(early.target_pct);
    if (typeof reserveDoc.reserve_pct === "number") setReservePct(reserveDoc.reserve_pct);
    // The fee percentage is not stored as a rate today; the stored total is derived back to one so
    // the field shows something true rather than a default.
    if (typeof sleeveDoc.estimated_fees_usd === "number" && typeof mandateDoc.target_size_usd === "number") {
      const impliedAnnual = (sleeveDoc.estimated_fees_usd / mandateDoc.target_size_usd / 10) * 100;
      if (Number.isFinite(impliedAnnual) && impliedAnnual > 0) setFeePct(Number(impliedAnnual.toFixed(2)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);

  // ── The OUTPUTS. Computed on every keystroke, displayed, never editable. ──
  const derived = useMemo(() => {
    const fundSize = fundSizeM * 1e6;
    const fees = fundSize * (feePct / 100) * fundLifeYears;
    const expenses = expensesM * 1e6;
    const proposedSleeve: SleeveDoc = {
      basis: "investable capital after fees and expenses",
      committed_usd: fundSize,
      estimated_fees_usd: fees,
      estimated_expenses_usd: expenses,
      estimated_investable_usd: Math.max(0, fundSize - fees - expenses),
      sleeves: [
        { key: "EARLY_STAGE_PRIMARY", target_pct: earlyPct, stage: "PRE_SEED" },
        { key: "SECONDARY_PURCHASE", target_pct: 100 - earlyPct, stage: "SERIES_B_C" },
      ],
    };
    const proposedReserve: ReserveDoc = { reserve_pct: reservePct, basis: "early-stage sleeve" };
    const early = proposedSleeve.sleeves![0]!;
    const secondary = proposedSleeve.sleeves![1]!;

    const forInitials = initialCapitalUsd(proposedSleeve, proposedReserve);
    const needMin = positions * checkMinK * 1000;
    const needMax = positions * checkMaxK * 1000;

    return {
      proposedSleeve,
      proposedReserve,
      base: investableBase(proposedSleeve),
      fees,
      expenses,
      earlyUsd: sleeveTargetUsd(proposedSleeve, early),
      secondaryUsd: sleeveTargetUsd(proposedSleeve, secondary),
      reservesUsd: reserveUsd(proposedSleeve, proposedReserve),
      forInitials,
      needMin,
      needMax,
      headroom: forInitials - needMin,
    };
  }, [fundSizeM, feePct, fundLifeYears, expensesM, earlyPct, reservePct, positions, checkMinK, checkMaxK]);

  const rangeInvalid = checkMinK > checkMaxK;
  const canSave = !saving && !rangeInvalid && sectors.length > 0 && why.trim().length > 0;

  async function save(): Promise<void> {
    if (!fundId) return;
    setSaving(true);
    const nextMandate = {
      ...mandateDoc,
      target_size_usd: fundSizeM * 1e6,
      sectors,
      target_positions: positions,
      check_size_usd: { min: checkMinK * 1000, max: checkMaxK * 1000 },
      changed_note: why.trim(),
    };
    const nextSleeve = { ...derived.proposedSleeve, note: why.trim() };
    const nextReserve = { ...derived.proposedReserve, rationale: (reserveDoc as { rationale?: string }).rationale, note: why.trim() };

    const results = await Promise.all([
      api(`/api/funds/${fundId}/policies/mandate`, {
        method: "POST",
        body: { version_no: (mandate.data?.current?.version_no ?? 0) + 1, effective_from: new Date().toISOString().slice(0, 10), policy: nextMandate },
      }),
      api(`/api/funds/${fundId}/policies/sleeve`, {
        method: "POST",
        body: { version_no: (sleeve.data?.current?.version_no ?? 0) + 1, effective_from: new Date().toISOString().slice(0, 10), policy: nextSleeve },
      }),
      api(`/api/funds/${fundId}/policies/reserve`, {
        method: "POST",
        body: { version_no: (reserve.data?.current?.version_no ?? 0) + 1, effective_from: new Date().toISOString().slice(0, 10), policy: nextReserve },
      }),
    ]);
    setSaving(false);

    const failed = results.filter((r) => r.status >= 400);
    if (failed.length > 0) {
      setMessage(`Saved ${results.length - failed.length} of ${results.length}. Nothing was overwritten — each of these is a new version, so re-saving is safe.`);
    } else {
      setMessage("Saved as a new version. The previous one is still on the record.");
      setWhy("");
    }
    mandate.reload();
    sleeve.reload();
    reserve.reload();
  }

  if (!fundId) return null;

  return (
    <section className="card" data-testid="fund-construction">
      <div className="home-section-head">
        <h3>How the fund is built</h3>
        <span className="muted small">
          mandate v{mandate.data?.current?.version_no ?? "—"} · sleeve v{sleeve.data?.current?.version_no ?? "—"} · reserve v
          {reserve.data?.current?.version_no ?? "—"}
        </span>
      </div>

      {message && <p className="notice" data-testid="construction-message">{message}</p>}

      <p className="muted small">
        You change the percentages and the sizes. Everything below the line is worked out from them
        and cannot be typed — a percentage and a dollar figure that can disagree is what put $200K
        between two readings of this fund in August.
      </p>

      <h4>What you decide</h4>
      <div className="quiet-hours" data-testid="construction-inputs">
        <p className="quiet-hours-line">
          A{" "}
          <input type="number" min={1} step={1} value={fundSizeM} data-testid="input-fund-size"
            aria-label="Fund size in millions" onChange={(e) => setFundSizeM(Number(e.target.value))} />
          M fund, charging{" "}
          <input type="number" min={0} step={0.25} value={feePct} data-testid="input-fee-pct"
            aria-label="Annual management fee percentage" onChange={(e) => setFeePct(Number(e.target.value))} />
          % a year over{" "}
          <input type="number" min={1} step={1} value={fundLifeYears} data-testid="input-fund-life"
            aria-label="Fund life in years" onChange={(e) => setFundLifeYears(Number(e.target.value))} />
          {" "}years, with{" "}
          <input type="number" min={0} step={0.5} value={expensesM} data-testid="input-expenses"
            aria-label="Estimated expenses in millions" onChange={(e) => setExpensesM(Number(e.target.value))} />
          M of expenses.
        </p>
        <p className="quiet-hours-line">
          Split the investable capital{" "}
          <input type="number" min={0} max={100} step={1} value={earlyPct} data-testid="input-early-pct"
            aria-label="Early stage percentage" onChange={(e) => setEarlyPct(Math.max(0, Math.min(100, Number(e.target.value))))} />
          % early stage / <strong data-testid="derived-secondary-pct">{100 - earlyPct}%</strong> secondaries, holding{" "}
          <input type="number" min={0} max={100} step={1} value={reservePct} data-testid="input-reserve-pct"
            aria-label="Reserve percentage of the early stage sleeve" onChange={(e) => setReservePct(Math.max(0, Math.min(100, Number(e.target.value))))} />
          % of the early-stage sleeve in reserve.
        </p>
        <p className="quiet-hours-line">
          Aiming for{" "}
          <input type="number" min={1} step={1} value={positions} data-testid="input-positions"
            aria-label="Target number of positions" onChange={(e) => setPositions(Number(e.target.value))} />
          {" "}companies at{" "}
          <input type="number" min={0} step={50} value={checkMinK} data-testid="input-check-min"
            aria-label="Minimum cheque in thousands" onChange={(e) => setCheckMinK(Number(e.target.value))} />
          K–
          <input type="number" min={0} step={50} value={checkMaxK} data-testid="input-check-max"
            aria-label="Maximum cheque in thousands" onChange={(e) => setCheckMaxK(Number(e.target.value))} />
          K each.
        </p>
        {rangeInvalid && (
          <p className="notice" data-testid="construction-range-error">
            The smallest cheque is larger than the largest. Swap them.
          </p>
        )}
      </div>

      <h4>Sector focus</h4>
      <p className="muted small">
        Decided by Sequoia on 9 Sep 2026, resolving a contradiction between two pages of the deck.
        Change it here and both the thesis slide and the Terms table follow — neither keeps its own copy.
      </p>
      <div className="notification-actions" data-testid="construction-sectors">
        {SECTOR_CHOICES.map((s) => {
          const on = sectors.includes(s.key);
          return (
            <button key={s.key} type="button" className={on ? "btn-strong" : ""} data-testid={`sector-${s.key}`}
              onClick={() => setSectors(on ? sectors.filter((x) => x !== s.key) : [...sectors, s.key])}>
              {on ? "✓ " : ""}{s.label}
            </button>
          );
        })}
      </div>
      {sectors.length === 0 && <p className="muted small">Pick at least one; a fund with no stated sectors has no thesis.</p>}

      {/*
        THE COMPUTED HALF. Rendered, never entered. This is the boundary that stops the editor
        recreating the defect it exists to fix.
      */}
      <h4>What that works out to</h4>
      <div className="figs" data-testid="construction-derived">
        <table>
          <caption>worked out from the figures above — none of this is typed</caption>
          <tbody>
            <tr><td className="n">{usd(fundSizeM * 1e6)}</td><td>committed to the fund</td></tr>
            <tr><td className="n">−{usd(derived.fees)}</td><td>management fees ({feePct}% a year for {fundLifeYears} years)</td></tr>
            <tr><td className="n">−{usd(derived.expenses)}</td><td>fund expenses</td></tr>
            <tr><td className="n" data-testid="derived-base">{usd(derived.base)}</td><td><strong>investable capital</strong></td></tr>
            <tr><td className="n" data-testid="derived-early">{usd(derived.earlyUsd)}</td><td>early stage, {earlyPct}% of investable</td></tr>
            <tr><td className="n" data-testid="derived-secondary">{usd(derived.secondaryUsd)}</td><td>secondaries, {100 - earlyPct}% of investable</td></tr>
            <tr><td className="n" data-testid="derived-reserves">{usd(derived.reservesUsd)}</td><td>reserves, {reservePct}% of the early-stage sleeve</td></tr>
            <tr><td className="n" data-testid="derived-initials">{usd(derived.forInitials)}</td><td><strong>left to write initial cheques with</strong></td></tr>
          </tbody>
        </table>
      </div>

      {/*
        THE AFFORDABILITY LINE, RECOMPUTED LIVE. Nobody had multiplied the position count by the
        cheque range until 9 Sep, and the answer moved by $120K the moment the split was settled.
        Making it visible at the moment of editing is the difference between a form and a decision
        surface.
      */}
      <div className={derived.headroom < 0 ? "note" : "note calm"} data-testid="construction-affordability">
        <p>
          <strong>{positions} companies at {usd(checkMinK * 1000)}–{usd(checkMaxK * 1000)}</strong> needs{" "}
          {usd(derived.needMin)}–{usd(derived.needMax)} of initial capital, and you have{" "}
          {usd(derived.forInitials)}.{" "}
          {derived.headroom >= 0 ? (
            <>Affordable at the bottom of the range with <strong>{usd(derived.headroom)}</strong> to spare
            {derived.needMax > derived.forInitials ? ", but not at the top of it." : ", and at the top of it too."}</>
          ) : (
            <>That is <strong>{usd(-derived.headroom)} short</strong> even with every cheque at the stated
            minimum — fewer companies, a smaller cheque, or a bigger early-stage sleeve.</>
          )}
        </p>
      </div>

      <h4>Why you changed it</h4>
      <p className="muted small">
        Kept on the new version. The sector question was lost in August because a later version dropped
        it without saying why — one sentence here is what stops that happening again.
      </p>
      <input type="text" value={why} data-testid="construction-why" aria-label="Why you changed it"
        placeholder="e.g. moved to 70/30 of investable capital so the table accounts for fees"
        onChange={(e) => setWhy(e.target.value)} style={{ width: "100%" }} />

      <div className="quiet-hours-actions">
        <button type="button" className="btn-strong" disabled={!canSave} data-testid="construction-save"
          onClick={() => void save()}>
          {saving ? "Saving…" : "Save as a new version"}
        </button>
        <span className="muted small">
          Nothing is overwritten. The current version stays on the record and this becomes the next one.
        </span>
      </div>
    </section>
  );
}
