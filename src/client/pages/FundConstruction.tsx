import { useEffect, useMemo, useState } from "react";
import { api, useApi } from "../lib/api";
import {
  initialCapitalUsd, investableBase, reserveUsd, sleeveTargetUsd, usd,
  type ReserveDoc, type SleeveDoc,
} from "@shared/fund/sleeveMath";
import { planRingSlices, planSlices } from "@shared/fund/allocation";
import { AllocationRing } from "./AllocationRing";

/**
 * HOW THE FUND IS BUILT — Fund strategy's third band (design/FUND_STRATEGY_DESIGN.md §3.3).
 *
 * THE POLICY READS AS THREE SENTENCES AT REST; the editor opens behind Amend. The nine number
 * inputs used to be open on every visit, at reading weight, with their React defaults (25
 * companies, $250K–$750K, 2%) rendering before the stored policy arrived — a flash of invented
 * numbers on a page whose whole history is invented numbers (audit #4). Now the sentences are the
 * stored policy and nothing else; the tray is seeded from `current` when it opens.
 *
 * THE PERCENTAGE IS THE INPUT AND THE DOLLAR IS THE OUTPUT — that single rule is the whole editor.
 * `sleeve_policy_version` v1 stored 70% AND $17.0M against a $24.0M base, disagreeing by $200K; a
 * form with two editable fields that can disagree puts that straight back. So everything computable
 * is rendered, never entered, and the affordability line recomputes as she types.
 *
 * SAVING WRITES A NEW VERSION. Never a mutation. That versioning is the only reason the August
 * discrepancies were recoverable at all. First close (0212) is typed here too — the one field on the
 * fund record itself rather than on a policy version, because a date is not a policy.
 */

interface PolicyResponse<T> { current: T | null }
interface MandateRow { version_no: number; mandate_json: string; effective_from?: string }
interface SleeveRow { version_no: number; sleeve_json: string }
interface ReserveRow { version_no: number; reserve_json: string }

export interface MandateDoc {
  target_size_usd?: number;
  sectors?: string[];
  target_positions?: number;
  check_size_usd?: { min?: number; max?: number };
  investment_period_years?: number;
  [k: string]: unknown;
}

const SECTOR_CHOICES = [
  { key: "AI", label: "AI" },
  { key: "HEALTH_TECH", label: "Healthcare" },
  { key: "CONSUMER", label: "Consumer" },
  { key: "ED_TECH", label: "Education" },
  { key: "FUTURE_OF_WORK", label: "Future of work" },
  { key: "FINTECH", label: "Fintech" },
  { key: "CLIMATE", label: "Climate" },
];

const sectorLabel = (key: string): string => SECTOR_CHOICES.find((s) => s.key === key)?.label ?? key.toLowerCase().replace(/_/g, " ");

function parse<T>(raw: string | undefined | null): T {
  try { return JSON.parse(raw ?? "{}") as T; } catch { return {} as T; }
}

/** The three sentences, from the stored policy alone — nothing here is a default. */
export function policySentences(m: MandateDoc, s: SleeveDoc, r: ReserveDoc): { fund: string; split: string; companies: string } | null {
  if (typeof m.target_size_usd !== "number") return null;
  const fees = s.estimated_fees_usd ?? 0;
  const life = 10;
  const feePct = m.target_size_usd > 0 ? (fees / m.target_size_usd / life) * 100 : 0;
  const early = (s.sleeves ?? []).find((x) => x.key === "EARLY_STAGE_PRIMARY");
  const secondary = (s.sleeves ?? []).find((x) => x.key === "SECONDARY_PURCHASE");
  const positions = m.target_positions;
  const sectors = (m.sectors ?? []).map(sectorLabel);
  const sectorWords = sectors.length === 0 ? "" : sectors.length === 1 ? `, in ${sectors[0]}` : `, in ${sectors.slice(0, -1).join(", ")} and ${sectors[sectors.length - 1]}`;
  return {
    fund: `A ${usd(m.target_size_usd)} fund, charging ${Number.isFinite(feePct) && feePct > 0 ? `${Number(feePct.toFixed(2))}%` : "—"} a year over ${life} years, with ${usd(s.estimated_expenses_usd ?? 0)} of expenses — ${usd(investableBase(s))} investable.`,
    split: early && secondary
      ? `Split ${early.target_pct ?? "—"}% early stage (${usd(sleeveTargetUsd(s, early))}) / ${secondary.target_pct ?? "—"}% secondaries (${usd(sleeveTargetUsd(s, secondary))}), with ${r.reserve_pct ?? "—"}% of the early-stage sleeve held in reserve (${usd(reserveUsd(s, r))}).`
      : "The sleeve split is not on the record yet.",
    companies: positions
      ? `${positions} companies at ${usd(m.check_size_usd?.min ?? 0)}–${usd(m.check_size_usd?.max ?? 0)} each${sectorWords}.`
      : "No target position count is on the record yet.",
  };
}

export function FundConstruction({
  fundId,
  firstCloseOn,
  open,
  onOpenChange,
  onSaved,
}: {
  fundId: string | null;
  firstCloseOn: string | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
  onSaved?: () => void;
}): JSX.Element | null {
  const mandate = useApi<PolicyResponse<MandateRow>>(fundId ? `/api/funds/${fundId}/policies/mandate` : null, [fundId]);
  const sleeve = useApi<PolicyResponse<SleeveRow>>(fundId ? `/api/funds/${fundId}/policies/sleeve` : null, [fundId]);
  const reserve = useApi<PolicyResponse<ReserveRow>>(fundId ? `/api/funds/${fundId}/policies/reserve` : null, [fundId]);

  const mandateDoc = parse<MandateDoc>(mandate.data?.current?.mandate_json);
  const sleeveDoc = parse<SleeveDoc>(sleeve.data?.current?.sleeve_json);
  const reserveDoc = parse<ReserveDoc>(reserve.data?.current?.reserve_json);

  // ── The INPUTS, seeded from the stored policy when the tray opens. ──
  const [fundSizeM, setFundSizeM] = useState(0);
  const [feePct, setFeePct] = useState(0);
  const [fundLifeYears, setFundLifeYears] = useState(10);
  const [expensesM, setExpensesM] = useState(0);
  const [earlyPct, setEarlyPct] = useState(0);
  const [reservePct, setReservePct] = useState(0);
  const [positions, setPositions] = useState(0);
  const [checkMinK, setCheckMinK] = useState(0);
  const [checkMaxK, setCheckMaxK] = useState(0);
  const [sectors, setSectors] = useState<string[]>([]);
  const [firstClose, setFirstClose] = useState<string>("");
  const [why, setWhy] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  /*
   * THE TRAY PAINTS ONLY ONCE IT IS SEEDED. Rendering the inputs on the same pass that opens the
   * tray painted them with the empty state for one frame and then flipped every value and every
   * pressed chip — a visible flash, and a 90ms colour transition the measured contract caught
   * mid-way (a pressed chip read at 1.6:1 while it was still fading in). Seeded first, painted once.
   */
  const [seeded, setSeeded] = useState(false);

  const seedKey = `${open}:${mandate.data?.current?.version_no}:${sleeve.data?.current?.version_no}:${reserve.data?.current?.version_no}:${firstCloseOn ?? ""}`;
  useEffect(() => {
    if (!open) return;
    if (typeof mandateDoc.target_size_usd === "number") setFundSizeM(mandateDoc.target_size_usd / 1e6);
    if (typeof mandateDoc.target_positions === "number") setPositions(mandateDoc.target_positions);
    if (typeof mandateDoc.check_size_usd?.min === "number") setCheckMinK(mandateDoc.check_size_usd.min / 1000);
    if (typeof mandateDoc.check_size_usd?.max === "number") setCheckMaxK(mandateDoc.check_size_usd.max / 1000);
    if (Array.isArray(mandateDoc.sectors)) setSectors(mandateDoc.sectors);
    if (typeof sleeveDoc.estimated_expenses_usd === "number") setExpensesM(sleeveDoc.estimated_expenses_usd / 1e6);
    const early = (sleeveDoc.sleeves ?? []).find((s) => s.key === "EARLY_STAGE_PRIMARY");
    if (typeof early?.target_pct === "number") setEarlyPct(early.target_pct);
    if (typeof reserveDoc.reserve_pct === "number") setReservePct(reserveDoc.reserve_pct);
    if (typeof sleeveDoc.estimated_fees_usd === "number" && typeof mandateDoc.target_size_usd === "number" && mandateDoc.target_size_usd > 0) {
      const impliedAnnual = (sleeveDoc.estimated_fees_usd / mandateDoc.target_size_usd / 10) * 100;
      if (Number.isFinite(impliedAnnual) && impliedAnnual > 0) setFeePct(Number(impliedAnnual.toFixed(2)));
    }
    setFirstClose(firstCloseOn ?? "");
    setMessage(null);
    setSeeded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey]);
  useEffect(() => { if (!open) setSeeded(false); }, [open]);

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
      proposedSleeve, proposedReserve, base: investableBase(proposedSleeve), fees, expenses,
      earlyUsd: sleeveTargetUsd(proposedSleeve, early), secondaryUsd: sleeveTargetUsd(proposedSleeve, secondary),
      reservesUsd: reserveUsd(proposedSleeve, proposedReserve), forInitials, needMin, needMax, headroom: forInitials - needMin,
    };
  }, [fundSizeM, feePct, fundLifeYears, expensesM, earlyPct, reservePct, positions, checkMinK, checkMaxK]);

  const rangeInvalid = checkMinK > checkMaxK;
  const firstCloseInvalid = firstClose !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(firstClose);
  const canSave = !saving && !rangeInvalid && !firstCloseInvalid && sectors.length > 0 && why.trim().length > 0;

  async function save(): Promise<void> {
    if (!fundId) return;
    setSaving(true);
    setMessage(null);
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
    const effective = new Date().toISOString().slice(0, 10);
    const results = await Promise.all([
      api(`/api/funds/${fundId}/policies/mandate`, { method: "POST", body: { version_no: (mandate.data?.current?.version_no ?? 0) + 1, effective_from: effective, policy: nextMandate } }),
      api(`/api/funds/${fundId}/policies/sleeve`, { method: "POST", body: { version_no: (sleeve.data?.current?.version_no ?? 0) + 1, effective_from: effective, policy: nextSleeve } }),
      api(`/api/funds/${fundId}/policies/reserve`, { method: "POST", body: { version_no: (reserve.data?.current?.version_no ?? 0) + 1, effective_from: effective, policy: nextReserve } }),
    ]);
    // First close moves only when it changed: the fund record, not a policy version.
    const firstCloseChanged = (firstClose || null) !== (firstCloseOn ?? null);
    const closeResult = firstCloseChanged
      ? await api(`/api/funds/${fundId}/size`, { method: "PATCH", body: { target_size: fundSizeM * 1e6, first_close_on: firstClose || null } })
      : null;
    setSaving(false);
    const failed = [...results, ...(closeResult ? [closeResult] : [])].filter((r) => r.status >= 400);
    if (failed.length > 0) {
      const which = failed.map((f) => (f.status === 403 ? "refused: Managing Partners only" : `HTTP ${f.status}`)).join(", ");
      setMessage({ tone: "bad", text: `Saved ${results.length + (closeResult ? 1 : 0) - failed.length} of ${results.length + (closeResult ? 1 : 0)} (${which}). Nothing was overwritten — each of these is a new version, so re-saving is safe.` });
    } else {
      setMessage({ tone: "ok", text: "Saved as a new version. The previous one is still on the record." });
      setWhy("");
      onOpenChange(false);
      onSaved?.();
    }
    mandate.reload();
    sleeve.reload();
    reserve.reload();
  }

  if (!fundId) return null;
  const refused = [mandate.status, sleeve.status, reserve.status].some((s) => s === 403);
  const sentences = policySentences(mandateDoc, sleeveDoc, reserveDoc);
  const plan = typeof mandateDoc.target_size_usd === "number" ? planSlices(mandateDoc.target_size_usd, sleeveDoc, reserveDoc) : null;
  const storedNeedMin = (mandateDoc.target_positions ?? 0) * (mandateDoc.check_size_usd?.min ?? 0);
  const storedNeedMax = (mandateDoc.target_positions ?? 0) * (mandateDoc.check_size_usd?.max ?? 0);
  const storedInitials = initialCapitalUsd(sleeveDoc, reserveDoc);
  const storedHeadroom = storedInitials - storedNeedMin;

  return (
    <section className="band" data-testid="fund-construction">
      <div className="band-head">
        <h3>How the fund is built</h3>
        <span className="band-when">
          mandate v{mandate.data?.current?.version_no ?? "—"} · sleeve v{sleeve.data?.current?.version_no ?? "—"} · reserve v{reserve.data?.current?.version_no ?? "—"}
        </span>
      </div>
      <div className="two-col">
        <article className="card viz-root" data-testid="fund-allocation">
          <div className="section-head"><h4>Where the {plan ? usd(plan.fundSize) : "fund"} goes</h4></div>
          {plan ? (
            <>
              <p className="muted small">
                The whole {usd(plan.fundSize)}, as the firm has decided to divide it. This is the plan, not what has been spent — what has been spent is drawn against this on Portfolio.
              </p>
              <AllocationRing slices={planRingSlices(plan)} total={plan.fundSize} caption="committed" testid="allocation" />
            </>
          ) : (
            <p className="state-empty" data-testid="allocation-empty">No fund size recorded yet, so there is nothing to divide up. Set the thesis first.</p>
          )}
        </article>

        <article className="card" data-testid="fund-policy">
          <div className="section-head"><h4>The policy, in one breath</h4></div>
          {message && <p className={message.tone === "ok" ? "notice notice-ok" : "notice notice-bad"} data-testid="construction-message" role="status">{message.text}</p>}
          {!sentences ? (
            <p className="state-empty" data-testid="construction-empty">No mandate is on the record yet. Amend below to set one, or set the thesis on the Thesis page.</p>
          ) : (
            <ul className="policy-lines" data-testid="construction-sentences">
              <li className="construct-line" data-testid="construction-line-fund">{bolded(sentences.fund)}</li>
              <li className="construct-line" data-testid="construction-line-split">{bolded(sentences.split)}</li>
              <li className="construct-line" data-testid="construction-line-companies">{bolded(sentences.companies)}</li>
            </ul>
          )}
          {sentences && (mandateDoc.target_positions ?? 0) > 0 && (
            <div className={storedHeadroom < 0 ? "notice notice-gate" : "notice notice-ok"} data-testid="construction-affordability">
              <p>
                <strong>{mandateDoc.target_positions} companies at {usd(mandateDoc.check_size_usd?.min ?? 0)}–{usd(mandateDoc.check_size_usd?.max ?? 0)}</strong> needs {usd(storedNeedMin)}–{usd(storedNeedMax)} of initial capital, and there is {usd(storedInitials)}.{" "}
                {storedHeadroom >= 0
                  ? <>Affordable at the bottom of the range with <strong>{usd(storedHeadroom)}</strong> to spare{storedNeedMax > storedInitials ? ", but not at the top of it." : ", and at the top of it too."}</>
                  : <>That is <strong>{usd(-storedHeadroom)} short</strong> even with every cheque at the stated minimum.</>}
              </p>
            </div>
          )}
          <p className="muted small" data-testid="construction-first-close">
            {firstCloseOn ? `First close ${firstCloseOn} — the clock the pace above runs on.` : "First close is not on the record yet — the pace above has no clock until it is."}
          </p>
          <div className="actions">
            {refused ? (
              <>
                <button type="button" className="btn-strong" disabled aria-disabled="true" data-testid="construction-amend">Amend the construction</button>
                <span className="muted small" data-testid="construction-refused">Fund construction is set by the Managing Partners. You can see where the fund goes; changing it is theirs.</span>
              </>
            ) : (
              <button type="button" className="btn-strong" data-testid="construction-amend" aria-expanded={open} aria-controls="construction-amend-tray" onClick={() => onOpenChange(!open)}>
                {open ? "Close without saving" : "Amend the construction"}
              </button>
            )}
            <span className="version-rail" data-testid="construction-versions">
              <span className="v v-current">v{mandate.data?.current?.version_no ?? "—"} · current</span>
              {mandate.data?.current?.effective_from && <span>effective {mandate.data.current.effective_from}</span>}
            </span>
          </div>

          {open && seeded && !refused && (
            <div className="amend-tray" id="construction-amend-tray" data-testid="construction-inputs">
              <p className="muted small">
                You change the percentages and the sizes. Everything below the line is worked out from them and cannot be typed — a percentage and a dollar figure that can disagree is what put $200K between two readings of this fund in August.
              </p>
              <p className="construct-line">
                A <input type="number" min={1} step={1} value={fundSizeM} data-testid="input-fund-size" aria-label="Fund size in millions" onChange={(e) => setFundSizeM(Number(e.target.value))} />M fund, charging{" "}
                <input type="number" min={0} step={0.25} value={feePct} data-testid="input-fee-pct" aria-label="Annual management fee percentage" onChange={(e) => setFeePct(Number(e.target.value))} />% a year over{" "}
                <input type="number" min={1} step={1} value={fundLifeYears} data-testid="input-fund-life" aria-label="Fund life in years" onChange={(e) => setFundLifeYears(Number(e.target.value))} /> years, with{" "}
                <input type="number" min={0} step={0.5} value={expensesM} data-testid="input-expenses" aria-label="Estimated expenses in millions" onChange={(e) => setExpensesM(Number(e.target.value))} />M of expenses.
              </p>
              <p className="construct-line">
                Split the investable capital <input type="number" min={0} max={100} step={1} value={earlyPct} data-testid="input-early-pct" aria-label="Early stage percentage" onChange={(e) => setEarlyPct(Math.max(0, Math.min(100, Number(e.target.value))))} />% early stage / <strong data-testid="derived-secondary-pct">{100 - earlyPct}%</strong> secondaries, holding{" "}
                <input type="number" min={0} max={100} step={1} value={reservePct} data-testid="input-reserve-pct" aria-label="Reserve percentage of the early stage sleeve" onChange={(e) => setReservePct(Math.max(0, Math.min(100, Number(e.target.value))))} />% of the early-stage sleeve in reserve.
              </p>
              <p className="construct-line">
                Aiming for <input type="number" min={1} step={1} value={positions} data-testid="input-positions" aria-label="Target number of positions" onChange={(e) => setPositions(Number(e.target.value))} /> companies at{" "}
                <input type="number" min={0} step={50} value={checkMinK} data-testid="input-check-min" aria-label="Minimum cheque in thousands" aria-invalid={rangeInvalid} onChange={(e) => setCheckMinK(Number(e.target.value))} />K–
                <input type="number" min={0} step={50} value={checkMaxK} data-testid="input-check-max" aria-label="Maximum cheque in thousands" aria-invalid={rangeInvalid} onChange={(e) => setCheckMaxK(Number(e.target.value))} />K each.
              </p>
              {rangeInvalid && <p className="notice notice-bad" role="alert" data-testid="construction-range-error">The smallest cheque is larger than the largest. Swap them.</p>}
              <p className="construct-line">
                First close on <input type="date" value={firstClose} data-testid="input-first-close" aria-label="First close date" aria-invalid={firstCloseInvalid} onChange={(e) => setFirstClose(e.target.value)} />
                <span className="muted small"> — the day the investment period started; the pace chart's clock. Leave it empty until the first subscription is signed, and LP will set it.</span>
              </p>

              <div className="section-head"><h4>Sector focus</h4></div>
              <div className="sector-chips" data-testid="construction-sectors">
                {SECTOR_CHOICES.map((s) => {
                  const on = sectors.includes(s.key);
                  return (
                    <button key={s.key} type="button" className={on ? "chip btn-strong" : "chip"} aria-pressed={on} data-testid={`sector-${s.key}`} onClick={() => setSectors(on ? sectors.filter((x) => x !== s.key) : [...sectors, s.key])}>
                      {on ? "✓ " : ""}{s.label}
                    </button>
                  );
                })}
              </div>
              {sectors.length === 0 && <p className="muted small">Pick at least one; a fund with no stated sectors has no thesis.</p>}

              <div className="section-head"><h4>What that works out to</h4></div>
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

              {!rangeInvalid && (
                <div className={derived.headroom < 0 ? "notice notice-gate" : "notice notice-ok"} data-testid="construction-affordability-live">
                  <p>
                    <strong>{positions} companies at {usd(checkMinK * 1000)}–{usd(checkMaxK * 1000)}</strong> needs {usd(derived.needMin)}–{usd(derived.needMax)} of initial capital, and you have {usd(derived.forInitials)}.{" "}
                    {derived.headroom >= 0
                      ? <>Affordable at the bottom of the range with <strong>{usd(derived.headroom)}</strong> to spare{derived.needMax > derived.forInitials ? ", but not at the top of it." : ", and at the top of it too."}</>
                      : <>That is <strong>{usd(-derived.headroom)} short</strong> even with every cheque at the stated minimum — fewer companies, a smaller cheque, or a bigger early-stage sleeve.</>}
                  </p>
                </div>
              )}

              <div className="section-head"><h4>Why you changed it</h4></div>
              <p className="muted small">Kept on the new version. The sector question was lost in August because a later version dropped it without saying why — one sentence here is what stops that happening again.</p>
              <input type="text" className="construction-why" value={why} data-testid="construction-why" aria-label="Why you changed it" placeholder="e.g. moved to 70/30 of investable capital so the table accounts for fees" onChange={(e) => setWhy(e.target.value)} />

              <div className="actions">
                <button type="button" className="btn-strong" disabled={!canSave} aria-disabled={!canSave} aria-busy={saving} data-testid="construction-save" onClick={() => void save()}>
                  {saving ? "Saving…" : "Save as a new version"}
                </button>
                <button type="button" data-testid="construction-cancel" onClick={() => onOpenChange(false)}>Never mind</button>
                <span className="muted small">Nothing is overwritten. The current version stays on the record and this becomes the next one.</span>
              </div>
            </div>
          )}
        </article>
      </div>
    </section>
  );
}

/** "$30M" and "70%" in bold inside a sentence, without the sentence being HTML. */
function bolded(sentence: string): JSX.Element {
  const parts = sentence.split(/(\$[\d.,]+[KM]?|\b\d+(?:\.\d+)?%|\b\d+ companies)/g);
  return <>{parts.map((p, i) => (/^(\$[\d.,]+[KM]?|\d+(?:\.\d+)?%|\d+ companies)$/.test(p) ? <strong key={i}>{p}</strong> : <span key={i}>{p}</span>))}</>;
}
