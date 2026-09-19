import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { VIEWPORTS, measureSurface, reportLine, signIn } from "./support/measure";

/**
 * FUND STRATEGY ON THE SHARED MEASURED CONTRACT (design/FUND_STRATEGY_DESIGN.md §9 step 7).
 *
 * The same contract the six Deals tabs answer to — zero horizontal overflow at five widths, every
 * text node at AA contrast, every clickable at or above the floor and on one line — measured on the
 * page at rest and with the Amend tray open. The seed gives the fund a mandate, a sleeve and a
 * reserve so every band draws with figures rather than empty states; first close is left off the
 * record on purpose so the pace band's "no clock" state is the one measured, then recorded so the
 * running state is measured too.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function seedFund(request: APIRequestContext): Promise<{ fundId: string }> {
  const list = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string }> };
  let fundId = list.funds[0]?.id;
  if (!fundId) {
    const made = await request.post("/api/funds", { headers: MP, data: { name: "West Peek Ventures Fund I", vintage_year: 2026 } });
    expect(made.status()).toBe(201);
    fundId = ((await made.json()) as { id: string }).id;
  }
  const policies = (await (await request.get(`/api/funds/${fundId}/policies/mandate`, { headers: MP })).json()) as { current: { version_no: number } | null };
  if (!policies.current) {
    const v = 1;
    for (const [kind, policy] of [
      ["mandate", { target_size_usd: 30_000_000, management_fee_pct: 2, fund_life_years: 10, check_size_usd: { min: 500_000, max: 750_000 }, target_ownership_pct: 8, minimum_ownership_pct: 5, target_positions: 20, investment_period_years: 4, sectors: ["AI", "HEALTH_TECH"] }],
      ["sleeve", { basis: "investable capital after fees and expenses", committed_usd: 30_000_000, estimated_fees_usd: 6_000_000, estimated_expenses_usd: 1_000_000, estimated_investable_usd: 23_000_000, sleeves: [{ key: "EARLY_STAGE_PRIMARY", target_pct: 70, stage: "PRE_SEED" }, { key: "SECONDARY_PURCHASE", target_pct: 30, stage: "SERIES_B_C" }] }],
      ["reserve", { reserve_pct: 40, basis: "early-stage sleeve", rationale: "Pre-seed reserves are how ownership survives the Series A." }],
      ["concentration", { max_single_company_pct: 10 }],
    ] as const) {
      const res = await request.post(`/api/funds/${fundId}/policies/${kind}`, { headers: MP, data: { version_no: v, effective_from: "2026-01-01", policy } });
      expect([200, 201], `${kind}: ${await res.text()}`).toContain(res.status());
    }
  }
  return { fundId: fundId! };
}

async function openFundStrategy(page: Page): Promise<void> {
  await gotoSurface(page, "Fund strategy");
  await expect(page.getByTestId("fund-strategy-page")).toBeVisible();
  await expect(page.getByTestId("fund-strategy-answer")).not.toContainText("Reading the plan");
  await expect(page.getByTestId("modeling-figures-source")).not.toContainText("Reading the mandate");
  await expect(page.getByTestId("fund-pace")).not.toContainText("Reading the plan");
}

test.describe("Fund strategy", () => {
  test("the page holds its numbers at five widths — the door, the plan band without a clock, the policy at rest", async ({ page, request }) => {
    await seedFund(request);
    await signIn(page);
    const report: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openFundStrategy(page);
      // The answer is derived from counts, and the one orange control is the door.
      await expect(page.getByTestId("fund-strategy-answer")).toContainText(/to the plan|company|companies|No fund size/);
      await expect(page.getByTestId("modeling-open")).toHaveAttribute("href", "https://venturedeals.joinwestpeek.com");
      await expect(page.getByTestId("modeling-open")).toHaveAttribute("rel", "noreferrer noopener");
      await expect(page.locator('[data-testid="fund-strategy-page"] .btn-primary')).toHaveCount(1);
      await expect(page.getByTestId("modeling-mandate")).toContainText("$30M");
      await expect(page.getByTestId("construction-sentences")).toContainText("A $30M fund");
      await expect(page.getByTestId("fund-gap-rows")).toContainText("still to write");
      report.push(reportLine("Fund strategy", vp, await measureSurface(page, "fund-strategy-page", "Fund strategy", vp)));
    }
    console.log("FUND STRATEGY MEASURED\n  " + report.join("\n  "));
  });

  test("the pace band says the clock has not started, then runs once first close is recorded through Amend", async ({ page, request }) => {
    const { fundId } = await seedFund(request);
    await request.patch(`/api/funds/${fundId}/size`, { headers: MP, data: { target_size: 30_000_000, first_close_on: null } });
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFundStrategy(page);
    await expect(page.getByTestId("fund-pace-no-clock")).toContainText("clock starts at first close");
    await expect(page.getByTestId("fund-pace-verdict")).toHaveCount(0);

    // "Record first close" opens Amend; the date is typed there and saved as part of the version.
    await page.getByTestId("fund-pace-record-first-close").click();
    await expect(page.getByTestId("construction-amend")).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("construction-inputs")).toBeVisible();
    await expect(page.getByTestId("input-fund-size")).toHaveValue("30");
    await page.getByTestId("input-first-close").fill("2026-03-02");
    await expect(page.getByTestId("construction-save")).toBeDisabled();
    await page.getByTestId("construction-why").fill("first close recorded from the subscription documents");
    await expect(page.getByTestId("construction-save")).toBeEnabled();
    const report = reportLine("Fund strategy · Amend open", VIEWPORTS[4]!, await measureSurface(page, "fund-strategy-page", "Fund strategy with Amend open", VIEWPORTS[4]!));
    await page.getByTestId("construction-save").click();
    await expect(page.getByTestId("construction-message")).toContainText("Saved as a new version");
    await expect(page.getByTestId("construction-first-close")).toContainText("First close 2026-03-02");
    await expect(page.getByTestId("fund-pace-verdict")).toContainText(/the plan/);
    await expect(page.getByTestId("fund-pace-no-clock")).toHaveCount(0);
    const basis = (await (await request.get(`/api/funds/${fundId}/basis`, { headers: MP })).json()) as { first_close_on: string | null; fund_size_source: string };
    expect(basis.first_close_on).toBe("2026-03-02");
    expect(basis.fund_size_source).toBe("RECORDED");

    // The invalid range is refused in words, and the tray can be closed without saving.
    await page.getByTestId("construction-amend").click();
    await page.getByTestId("input-check-min").fill("900");
    await expect(page.getByTestId("construction-range-error")).toContainText("Swap them");
    await expect(page.getByTestId("construction-save")).toBeDisabled();
    await page.getByTestId("construction-cancel").click();
    await expect(page.getByTestId("construction-inputs")).toHaveCount(0);
    console.log("FUND STRATEGY AMEND MEASURED\n  " + report);
  });

  test("copying the six figures reads the mandate, and the scenarios band opens one against the mandate's size", async ({ page, request, context }) => {
    const { fundId } = await seedFund(request);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFundStrategy(page);
    await page.getByTestId("modeling-copy").click();
    await expect(page.getByTestId("modeling-copy")).toHaveAttribute("data-state", /copied|error/);
    const state = await page.getByTestId("modeling-copy").getAttribute("data-state");
    if (state === "copied") {
      const text = await page.evaluate(() => navigator.clipboard.readText());
      expect(text).toContain("Fund size: $30M");
      expect(text).toContain("Positions: 20");
    }

    // Scenarios: the form asks for the one figure the system does not know, prefilled from the sleeve.
    await page.getByTestId("scenario-new").click();
    await expect(page.getByTestId("scenario-investable")).toHaveValue("23000000");
    await page.getByTestId("scenario-name").fill(`E2E-FS-${Date.now()} construction`);
    await page.getByTestId("scenario-create").click();
    await expect(page.getByTestId("allocation-message")).toContainText("Scenario ok");
    await expect(page.getByTestId("scenario-list")).toContainText("construction");
    const basis = (await (await request.get(`/api/funds/${fundId}/basis`, { headers: MP })).json()) as { ready: boolean };
    expect(basis.ready, "the basis is ready on a fund whose size lives on the mandate").toBe(true);
  });
});
