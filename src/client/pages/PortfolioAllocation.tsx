import { useApi } from "../lib/api";
import { deploymentRingSlices, type DeploymentSlices, type PlanSlices } from "@shared/fund/allocation";
import { usd } from "@shared/fund/sleeveMath";
import { AllocationRing } from "./AllocationRing";

/**
 * The fund's plan with what has actually been deployed drawn against it — Portfolio's host of the
 * ring Fund strategy draws.
 *
 * Operator, 18 Sep 2026: "some of the pictorial graphs in portfolio allocation from the fund
 * strategy page" belong on Portfolio. The one that does is this: not where the fund is GOING —
 * that stays on Fund strategy — but where it IS against that plan. Deployed, still to deploy,
 * reserves, secondaries, fees: the same four plan figures, from the same function, with the
 * initial-cheque slice split by what has gone out.
 *
 * The figures come from `/api/portfolio/allocation`, which calls the same `planSlices` Fund
 * strategy calls in the browser over the same current policies, and sums `amount_in` over the
 * same holdings list the page shows above it. `tests/portfolioHoldings.test.ts` feeds both from
 * one fixture and diffs them.
 */
export function PortfolioAllocation({ fundId, level = "h3" }: { fundId: string | null; level?: "h3" | "h4" }): JSX.Element | null {
  // Under Portfolio's band head (Phase D) the panel's own head is the third rank.
  const Head = level;
  const data = useApi<{
    fund: { id: string; name: string };
    plan: PlanSlices;
    deployment: DeploymentSlices;
    companies: number;
    provisional: boolean;
    note: string | null;
  }>(fundId ? `/api/portfolio/allocation?fund_id=${encodeURIComponent(fundId)}` : null, [fundId]);

  if (!fundId) return null;
  const d = data.data;
  if (!d) return null;

  if (d.plan.fundSize === 0) {
    return (
      <section className="card" data-testid="portfolio-allocation-empty">
        <Head>Where the money is, against the plan</Head>
        <p className="state-empty">{d.note}</p>
      </section>
    );
  }

  const slices = deploymentRingSlices(d.deployment);

  return (
    <section className="card viz-root" data-testid="portfolio-allocation">
      <Head>Where the money is, against the plan</Head>
      <p className="muted small">
        Of the {usd(d.plan.fundSize)} the firm decided to divide on Fund strategy, {usd(d.deployment.deployed)} is
        in {d.companies} compan{d.companies === 1 ? "y" : "ies"} today and {usd(d.deployment.remaining)} of
        initial-cheque capital is still to write. Reserves, secondaries and fees are the plan's own figures.
      </p>
      <AllocationRing slices={slices} total={d.plan.fundSize} caption="committed" testid="portfolio-allocation" />
      {d.deployment.overspend > 0 && (
        <p className="notice small" data-testid="portfolio-allocation-overspend">
          Deployed is {usd(d.deployment.overspend)} past what the plan leaves for initial cheques. Either the plan
          moves on Fund strategy, or the reserves are being drawn on.
        </p>
      )}
      {d.note && <p className="muted small" data-testid="portfolio-allocation-note">{d.note}</p>}
    </section>
  );
}
