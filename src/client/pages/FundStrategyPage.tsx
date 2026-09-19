import { useMemo, useState } from "react";
import { useApi } from "../lib/api";
import { DashboardDoor } from "./DashboardDoor";
import { PlanVsReality, type AllocationResponse } from "./PlanVsReality";
import { FundConstruction, type MandateDoc } from "./FundConstruction";
import { DeckPanel } from "./DeckPanel";
import { ReservesBand } from "./ReservesBand";
import { ScenariosBand } from "./ScenariosBand";
import { ArtifactShelf } from "./ArtifactShelf";
import { usd, type SleeveDoc } from "@shared/fund/sleeveMath";

/**
 * FUND STRATEGY — where the fund is going (design/FUND_STRATEGY_DESIGN.md, approved 19 Sep 2026).
 *
 * The owner: "another design overhaul of the fund strategy page — I don't think we should repeat
 * the same stuff that is on the portfolio page (at least in the same way), and the link to our
 * venture deals dashboards should be bigger and more prominent."
 *
 * THE SPLIT (§2): Portfolio owns what the portfolio IS — the holdings, the deployment ring, the
 * composition bars, what is going wrong, who has not reported. Fund strategy owns where the fund is
 * GOING — the plan, how far reality is from it, the reserves, the deck the plan is told in, and the
 * numbers to model the next cheque with. Nothing here draws a deployed slice or lists a company;
 * `validate:fund-strategy-split` fails the build if `Composition` or the cockpit ever mounts here.
 *
 * SIX BANDS, IN THE ORDER THE DECISION RUNS: Model it (the door — the page's one orange control) ·
 * Where the fund is against its plan · How the fund is built · The deck · What the reserves are for ·
 * Scenarios. One masthead answer, derived from counts the page already loads.
 */

interface FundRow { id: string; name: string; vintage_year?: number | null; first_close_on?: string | null }

export function FundStrategyPage({ onNavigate }: { onNavigate?: (key: string) => void }): JSX.Element {
  const funds = useApi<{ funds: FundRow[] }>("/api/funds");
  const fund = funds.data?.funds?.[0] ?? null;
  const fundId = fund?.id ?? null;
  const basis = useApi<{ first_close_on: string | null; fund_size: number | null; fund_size_source: string }>(fundId ? `/api/funds/${fundId}/basis` : null, [fundId]);
  const mandate = useApi<{ current: { mandate_json: string; version_no: number } | null }>(fundId ? `/api/funds/${fundId}/policies/mandate` : null, [fundId]);
  const sleeve = useApi<{ current: { sleeve_json: string; version_no: number } | null }>(fundId ? `/api/funds/${fundId}/policies/sleeve` : null, [fundId]);
  const reserve = useApi<{ current: { version_no: number } | null }>(fundId ? `/api/funds/${fundId}/policies/reserve` : null, [fundId]);
  const alloc = useApi<AllocationResponse>(fundId ? `/api/portfolio/allocation?fund_id=${encodeURIComponent(fundId)}` : null, [fundId]);
  const [amendOpen, setAmendOpen] = useState(false);
  const [savedNonce, setSavedNonce] = useState(0);

  const mandateDoc = useMemo<MandateDoc>(() => { try { return JSON.parse(mandate.data?.current?.mandate_json ?? "{}") as MandateDoc; } catch { return {}; } }, [mandate.data]);
  const sleeveDoc = useMemo<SleeveDoc>(() => { try { return JSON.parse(sleeve.data?.current?.sleeve_json ?? "{}") as SleeveDoc; } catch { return {}; } }, [sleeve.data]);
  const targetPositions = typeof mandateDoc.target_positions === "number" ? mandateDoc.target_positions : null;
  const period = typeof mandateDoc.investment_period_years === "number" && mandateDoc.investment_period_years > 0 ? mandateDoc.investment_period_years : 4;
  const firstCloseOn = basis.data?.first_close_on ?? fund?.first_close_on ?? null;

  const masthead = useMemo(() => {
    const d = alloc.data;
    const loading = funds.loading || (Boolean(fundId) && (alloc.loading || mandate.loading));
    if (loading) return { answer: "Reading the plan…", detail: "" };
    if (!fund) return { answer: "No fund on the record yet.", detail: "Commission one and its plan appears here." };
    if (!d || d.plan.fundSize === 0) return { answer: "No fund size is recorded yet.", detail: "Set the thesis on the Thesis page, or Amend the construction below, and the plan is drawn from it." };
    const inCount = d.companies;
    const toGo = targetPositions === null ? null : Math.max(0, targetPositions - inCount);
    const answer = targetPositions === null
      ? `${inCount} ${inCount === 1 ? "company" : "companies"} in; no target count set.`
      : `${words(inCount)} ${inCount === 1 ? "company" : "companies"} in, ${words(toGo ?? 0).toLowerCase()} to the plan.`;
    const cheque = mandateDoc.check_size_usd?.min && mandateDoc.check_size_usd?.max ? ` at ${usd(mandateDoc.check_size_usd.min)}–${usd(mandateDoc.check_size_usd.max)}` : "";
    const perYear = targetPositions ? Math.round(targetPositions / period) : null;
    const detail = `${usd(d.deployment.deployed)} of the ${usd(d.plan.initial)} set aside for initial cheques is out. The plan is ${targetPositions ?? "—"} companies${cheque} over a ${period}-year investment period${perYear ? ` — ${perYear} a year, about ${usd(d.plan.initial / period)} a year` : ""}.`;
    return { answer, detail };
  }, [alloc.data, alloc.loading, funds.loading, fund, fundId, mandate.loading, mandateDoc, targetPositions, period]);

  const eyebrow = [
    "Fund strategy",
    fund?.name,
    fund?.vintage_year ? `vintage ${fund.vintage_year}` : null,
    mandate.data?.current ? `mandate v${mandate.data.current.version_no}` : null,
    sleeve.data?.current ? `sleeve v${sleeve.data.current.version_no}` : null,
    reserve.data?.current ? `reserve v${reserve.data.current.version_no}` : null,
  ].filter(Boolean).join(" · ");

  return (
    <section data-testid="fund-strategy-page">
      <header className="masthead" data-testid="fund-strategy-masthead">
        <div className="masthead-date">{eyebrow}</div>
        <h2 data-testid="fund-strategy-answer">{masthead.answer}</h2>
        {masthead.detail && <p className="masthead-second" data-testid="fund-strategy-detail">{masthead.detail}</p>}
      </header>

      <DashboardDoor fundId={fundId} />
      <PlanVsReality fundId={fundId} targetPositions={targetPositions} investmentPeriodYears={period} onAmend={() => setAmendOpen(true)} reloadKey={savedNonce} />
      <FundConstruction
        fundId={fundId}
        firstCloseOn={firstCloseOn}
        open={amendOpen}
        onOpenChange={setAmendOpen}
        onSaved={() => { basis.reload(); alloc.reload(); mandate.reload(); sleeve.reload(); reserve.reload(); setSavedNonce((n) => n + 1); }}
      />
      <section className="band" data-testid="fund-deck">
        <div className="band-head">
          <h3>The deck — what the firm sends</h3>
          <span className="band-when">the plan above, as it is told to LPs</span>
        </div>
        <DeckPanel onNavigate={onNavigate} />
      </section>
      <ReservesBand fundId={fundId} onNavigate={onNavigate} />
      <ScenariosBand fundId={fundId} investableDefault={typeof sleeveDoc.estimated_investable_usd === "number" ? sleeveDoc.estimated_investable_usd : null} />
      {fundId && (
        <section className="band" data-testid="fund-built">
          <div className="band-head">
            <h3>Built about the fund</h3>
            <span className="band-when">dashboards, decks and documents from the record — kept here, opened under Documents</span>
          </div>
          <ArtifactShelf about={fundId} showObject={false} emptyNote="Nothing has been built about the fund yet. Ask the room for a dashboard, a deck or a document, or give an employee a card that asks for one." testId="fund-built-rows" />
        </section>
      )}
    </section>
  );
}

/** "One", "nineteen" — the masthead reads as a sentence, not a scoreboard, up to twenty. */
function words(n: number): string {
  const small = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen", "Twenty"];
  return n >= 0 && n <= 20 ? small[n]! : String(n);
}
