import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * THE DEALS SURFACES, MEASURED RATHER THAN ASSERTED.
 *
 * design/DEALS_SECTION_DESIGN.md §12.7: the Deals tabs are held to the same numbers Home is
 * (e2e/d2-home-measured.spec.ts) — 0 horizontal overflow at five widths, 0 contrast failures, 0
 * tap targets under 24px, 0 clickables broken over two lines — measured in the browser on every
 * run, because a number that only ever existed in a report is a number nobody notices going wrong.
 *
 * ONE CONTRACT, ONE DESCRIBE PER TAB. The helpers at the top are shared; each tab adds a
 * `test.describe` beneath and drives its own page through them. A tab's describe also proves the
 * page's own copy: what the masthead answers, what the rail says, that no figure is invented.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. Every sweep asserts it found something first. A contrast
 * sweep over an unrendered page passes trivially and tells you the page is perfect.
 */

export const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
  { name: "1280 — the laptop the pages were drawn at", width: 1280, height: 900 },
];

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

export async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

/**
 * Contrast over every rendered text node inside one surface root.
 *
 * The background is resolved by walking up the ancestors until something is not transparent, which
 * is what the browser does; taking `backgroundColor` off the text's own element would score most of
 * the page against `rgba(0,0,0,0)` and pass everything. Runs inside the page: `rootTestId` is the
 * only input.
 */
function measureContrast(rootTestId: string): Array<{ text: string; ratio: number; need: number; px: number }> {
  const lum = (c: number[]): number => {
    const f = c.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0]! + 0.7152 * f[1]! + 0.0722 * f[2]!;
  };
  const parse = (s: string): number[] | null => {
    const m = s.match(/[\d.]+/g);
    return m ? m.slice(0, 3).map(Number) : null;
  };
  const alpha = (s: string): number => {
    const m = s.match(/[\d.]+/g);
    return m && m.length > 3 ? Number(m[3]) : 1;
  };
  const ratio = (a: number[], b: number[]): number => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x! + 0.05) / (y! + 0.05);
  };
  const bgOf = (el: Element): number[] => {
    let n: Element | null = el;
    while (n) {
      const s = getComputedStyle(n);
      if (alpha(s.backgroundColor) > 0.01) return parse(s.backgroundColor) ?? [255, 255, 255];
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const root = document.querySelector(`[data-testid="${rootTestId}"]`);
  const out: Array<{ text: string; ratio: number; need: number; px: number }> = [];
  if (!root) return out;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const el = node.parentElement;
    if (!el || !el.getClientRects().length) continue;
    // The dashed row-shape is a drawing of a row, hidden from assistive tech and dimmed on purpose;
    // it is not copy and is not scored. Everything a reader is meant to read is.
    if (el.closest('[aria-hidden="true"]')) continue;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.opacity === "0") continue;
    const fg = parse(s.color);
    if (!fg) continue;
    const px = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    out.push({ text: node.nodeValue.trim().slice(0, 60), ratio: ratio(fg, bgOf(el)), need, px });
  }
  return out;
}

/** Anything a finger can press inside the surface, with the box it actually occupies. */
function measureTargets(rootTestId: string): Array<{ label: string; w: number; h: number; rects: number }> {
  const root = document.querySelector(`[data-testid="${rootTestId}"]`);
  if (!root) return [];
  const sel = 'button, a[href], input, select, textarea, summary, [role="button"]';
  return [...root.querySelectorAll(sel)].flatMap((el) => {
    if (el.closest('[aria-hidden="true"]')) return [];
    const rects = [...el.getClientRects()];
    if (rects.length === 0) return [];
    const r = el.getBoundingClientRect();
    return [
      {
        label: (el.getAttribute("data-testid") || el.textContent || el.tagName).trim().slice(0, 50),
        w: r.width,
        h: r.height,
        // A clickable broken over two lines is two hit areas with a seam down the middle, and the
        // seam is where a thumb lands. Rect count is how you see it; a bounding box hides it.
        rects: rects.length,
      },
    ];
  });
}

function measureOverflow(rootTestId: string, w: number): string[] {
  const root = document.querySelector(`[data-testid="${rootTestId}"]`);
  if (!root) return [`${rootTestId} did not render`];
  return [...root.querySelectorAll("*")]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      const ox = getComputedStyle(el).overflowX;
      if (ox === "auto" || ox === "scroll") return false;
      return r.width > 0 && Math.round(r.right) > w + 1;
    })
    .map(
      (el) =>
        `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}[${el.getAttribute("data-testid") || ""}] "${(el.textContent || "").trim().slice(0, 40)}" → ${Math.round(el.getBoundingClientRect().right)}px`,
    )
    .slice(0, 8);
}

/**
 * The four numbers, at the current viewport, for one surface. Returns a one-line report.
 * `minTextNodes` / `minClickables` are the Rule 0 floors — a page with fewer than that has not
 * rendered, and a sweep over it is not a pass.
 */
export async function holdTheNumbers(
  page: Page,
  rootTestId: string,
  vp: { name: string; width: number },
  floors: { minTextNodes: number; minClickables: number },
): Promise<string> {
  // Let the 90ms colour transitions finish: a rail node measured mid-transition from surface to ink
  // scores its white numeral against a light background and reports a defect the page does not have.
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(([id, w]) => measureOverflow(id as string, w as number), [rootTestId, vp.width] as const);
  expect(overflow, `horizontal overflow inside ${rootTestId} at ${vp.name}`).toEqual([]);
  const docWide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(docWide, `the document itself scrolls sideways at ${vp.name}`).toBeLessThanOrEqual(1);

  const nodes = await page.evaluate((id) => measureContrast(id), rootTestId);
  expect(nodes.length, `Rule 0 — measured ${nodes.length} text nodes in ${rootTestId} at ${vp.name}; a sweep over nothing is not a pass`).toBeGreaterThanOrEqual(floors.minTextNodes);
  const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
  expect(
    failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px — "${f.text}"`),
    `contrast in ${rootTestId} at ${vp.name}`,
  ).toEqual([]);
  const min = Math.min(...nodes.map((n) => n.ratio));

  const targets = await page.evaluate((id) => measureTargets(id), rootTestId);
  expect(targets.length, `Rule 0 — found ${targets.length} clickables in ${rootTestId} at ${vp.name}`).toBeGreaterThanOrEqual(floors.minClickables);
  const small = targets.filter((t) => t.h < 24 || t.w < 24);
  expect(small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)}`), `tap targets under 24px in ${rootTestId} at ${vp.name}`).toEqual([]);
  const wrapped = targets.filter((t) => t.rects > 1);
  expect(wrapped.map((t) => `${t.label} — ${t.rects} rects`), `clickables broken over more than one line in ${rootTestId} at ${vp.name}`).toEqual([]);

  return `${vp.name}: ${nodes.length} text nodes, min ${min.toFixed(2)}:1, 0 below AA · ${targets.length} clickables, 0 under 24px, 0 wrapped · 0 horizontal overflow`;
}

// The measuring functions run inside the page, so they are installed there once per navigation.
export async function installMeasures(page: Page): Promise<void> {
  await page.addInitScript(
    `${measureContrast.toString()}\n${measureTargets.toString()}\n${measureOverflow.toString()}\n` +
      "window.measureContrast = measureContrast; window.measureTargets = measureTargets; window.measureOverflow = measureOverflow;",
  );
}

/* ═══════════════════════════════════════════════════════════════════════════════════════════════
   THESIS + SECONDARIES (design §7, §8 — the D5 tab branch)

   Both pages read the fund's policy versions, so the describe seeds ONE fund with the commissioning
   policies (scripts/seed/commission-fund.mjs figures, by API) and then proves the pages show those
   figures and not others: the sleeve is $7,200,000 because 30% × $24M, not the $7.0M the policy
   also stores; the version's date is 2026-08-18 because that is `effective_from`, not today.
   ═══════════════════════════════════════════════════════════════════════════════════════════════ */

const COMMISSIONING = {
  mandate: {
    vintage: 2026,
    target_size_usd: 30_000_000,
    hard_cap_usd: 50_000_000,
    geography: ["US"],
    stage: ["PRE_SEED", "SEED"],
    sectors: ["AI", "FUTURE_OF_WORK", "HEALTH_TECH", "ED_TECH", "CONSUMER"],
    cross_cutting_filter: "benefits from community",
    check_size_usd: { min: 500_000, max: 750_000 },
    target_ownership_pct: 8,
    minimum_ownership_pct: 5,
    target_positions: 20,
    thesis_statement:
      "Pre-seed and seed companies in AI, future of work, health tech, ed tech and consumer, where community is a durable advantage rather than a marketing channel.",
    open_question: "Deck p4 and the Terms page list the sectors two different ways; this mandate uses the operator's five.",
  },
  sleeve: {
    basis: "investable capital after fees and expenses",
    committed_usd: 30_000_000,
    estimated_fees_usd: 5_000_000,
    estimated_expenses_usd: 1_000_000,
    estimated_investable_usd: 24_000_000,
    sleeves: [
      { key: "EARLY_STAGE_PRIMARY", target_pct: 70, target_usd: 17_000_000, stage: "PRE_SEED" },
      { key: "SECONDARY_PURCHASE", target_pct: 30, target_usd: 7_000_000, stage: "SERIES_B_C" },
    ],
  },
  reserve: { reserve_pct: 40, basis: "early-stage sleeve" },
  concentration: { max_single_company_pct: 10, basis: "committed capital" },
};

async function seedCommissionedFund(request: APIRequestContext): Promise<{ id: string; name: string }> {
  const name = `D5 Fund ${Date.now()}`;
  const fund = (await (await request.post("/api/funds", { headers: MP, data: { name } })).json()) as { id: string };
  for (const [kind, policy] of Object.entries(COMMISSIONING)) {
    const res = await request.post(`/api/funds/${fund.id}/policies/${kind}`, {
      headers: MP,
      data: { version_no: 1, effective_from: "2026-08-18", policy },
    });
    expect(res.status(), `seeding ${kind} v1`).toBe(201);
  }
  return { id: fund.id, name };
}

test.describe("Thesis — the document, the fit rail, the versions (design §7)", () => {
  test("with no fund the page says so; nothing is drawn from nothing", async ({ page, request }) => {
    const funds = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: unknown[] };
    test.skip(funds.funds.length > 0, "a fund already exists in this run's database — the no-fund state is not reachable");
    await signIn(page);
    await gotoSurface(page, "Thesis");
    await expect(page.getByTestId("thesis-no-fund")).toContainText("No fund exists yet");
    await expect(page.getByTestId("thesis-rail")).toHaveCount(0);
  });

  test("the fit rail reads the policy in Wyatt's order, the date is effective_from, Amend is a disclosure", async ({ page, request }) => {
    const fund = await seedCommissionedFund(request);
    await installMeasures(page);
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSurface(page, "Thesis");
    await expect(page.getByTestId("thesis-page")).toBeVisible();

    // The masthead: eyebrow names the fund and the version; the answer is derived from the fill.
    await expect(page.getByTestId("thesis-eyebrow")).toContainText(`${fund.name} · investment thesis · version 1 of 1`);
    await expect(page.getByTestId("thesis-answer")).toHaveText("One sentence, and the numbers it commits us to.");

    // The statement on the orange banner — the recorded exception — with the version stamp.
    await expect(page.getByTestId("thesis-statement")).toContainText("community is a durable advantage");
    await expect(page.getByTestId("thesis-version")).toContainText("Version 1");
    await expect(page.getByTestId("thesis-version")).toContainText("effective 2026-08-18");
    const today = new Date().toISOString().slice(0, 10);
    await expect(page.getByTestId("thesis-version")).not.toContainText(today);

    // Six checks in the order they are applied; the filter is the orange one and says so in words.
    const labels = await page.getByTestId("thesis-rail").locator(".stage-label").allTextContents();
    expect(labels.map((l) => l.replace(/\s*—.*$/, "").trim())).toEqual(["Stage", "Sector", "The filter", "Cheque", "Ownership", "Shape"]);
    await expect(page.getByTestId("thesis-check-filter").locator(".stage-node")).toHaveClass(/stage-node-current/);
    await expect(page.getByTestId("thesis-check-filter")).toContainText("the judgement call");
    await expect(page.getByTestId("thesis-rail").locator(".stage-node-current")).toHaveCount(1);
    await expect(page.getByTestId("thesis-check-stage")).toContainText("Pre-seed · Seed");
    await expect(page.getByTestId("thesis-check-sector")).toContainText("AI · Future of work · Health tech · Ed tech · Consumer");
    await expect(page.getByTestId("thesis-check-filter")).toContainText("benefits from community — applied across all 5");
    await expect(page.getByTestId("thesis-check-cheque")).toContainText("$500,000 – $750,000");
    await expect(page.getByTestId("thesis-check-ownership")).toContainText("8% · walk below 5%");
    await expect(page.getByTestId("thesis-check-shape")).toContainText("20 positions · $30M (cap $50M) · US");
    await expect(page.getByTestId("thesis-rail").locator(".stage-node-filled")).toHaveCount(5);

    // The returner sentence is arithmetic on the mandate: 8% entry → 4% at exit → $750,000,000.
    await expect(page.getByTestId("thesis-consequence")).toContainText("$750,000,000");
    await expect(page.getByTestId("thesis-open-question")).toContainText("Unresolved:");

    // Construction: the computed dollars beside the percentages, read from the policies.
    await expect(page.getByTestId("construction-reserve")).toHaveText("40% of the early sleeve · $6,720,000");
    await expect(page.getByTestId("construction-max")).toHaveText("10% of committed capital · $3,000,000");
    await expect(page.getByTestId("construction-sleeves")).toHaveText("70% primary · 30% secondary, of $24M investable");
    await expect(page.getByTestId("construction-fees")).toHaveText("$5,000,000 + $1,000,000, off the top");

    // Versions: the rail marks the current one; the next number is stated.
    await expect(page.getByTestId("thesis-v-1")).toHaveClass(/v-current/);
    await expect(page.getByTestId("thesis-version-rail")).toContainText("the next amendment becomes v2");

    // Amend is a disclosure: closed by default, opens with focus on the first field, Escape closes.
    await expect(page.getByTestId("thesis-inputs")).toHaveCount(0);
    const amend = page.getByTestId("thesis-edit-toggle");
    await expect(amend).toHaveAttribute("aria-expanded", "false");
    await amend.click();
    await expect(amend).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByTestId("thesis-inputs")).toBeVisible();
    await expect(page.getByTestId("thesis-input-statement")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("thesis-inputs")).toHaveCount(0);
    await expect(amend).toHaveAttribute("aria-expanded", "false");

    // Amending writes v2 and the rail moves; v1 stays readable.
    await amend.click();
    await page.getByTestId("thesis-input-positions").fill("22");
    await page.getByTestId("thesis-save").click();
    await expect(page.getByTestId("thesis-message")).toContainText("Saved as version 2");
    await expect(page.getByTestId("thesis-v-2")).toHaveClass(/v-current/);
    await expect(page.getByTestId("thesis-v-1")).not.toHaveClass(/v-current/);
    await expect(page.getByTestId("thesis-check-shape")).toContainText("22 positions");
    await expect(page.getByTestId("thesis-eyebrow")).toContainText("version 2 of 2");
  });

  test("Thesis holds its measured numbers at five widths, with the form closed and open", async ({ page, request }) => {
    const funds = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string }> };
    if (funds.funds.length === 0) await seedCommissionedFund(request);
    await installMeasures(page);
    await signIn(page);
    const report: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoSurface(page, "Thesis");
      await expect(page.getByTestId("thesis-rail")).toBeVisible();
      report.push(await holdTheNumbers(page, "thesis-page", vp, { minTextNodes: 30, minClickables: 4 }));
      await page.getByTestId("thesis-edit-toggle").click();
      await expect(page.getByTestId("thesis-inputs")).toBeVisible();
      report.push("  + form open · " + (await holdTheNumbers(page, "thesis-page", vp, { minTextNodes: 40, minClickables: 12 })));
      await page.keyboard.press("Escape");
    }
    console.log("THESIS MEASURED\n  " + report.join("\n  "));
  });
});

test.describe("Secondaries — the sleeve, on the same rail (design §8)", () => {
  test("empty: the budget is read from the policy, the row is drawn as its shape, nothing is invented", async ({ page, request }) => {
    const funds = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string }> };
    if (funds.funds.length === 0) await seedCommissionedFund(request);
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSurface(page, "Secondaries");
    await expect(page.getByTestId("secondaries-page")).toBeVisible();

    // $7,200,000 is 30% of the $24M investable base — derived, and not the $7.0M the policy stores.
    await expect(page.getByTestId("secondaries-budget")).toContainText("$0 of $7,200,000");
    await expect(page.getByTestId("secondaries-budget")).toContainText("sleeve_policy_version v1 · 30% of the investable base");
    await expect(page.getByTestId("secondaries-budget")).not.toContainText("7,000,000");
    await expect(page.getByTestId("secondaries-eyebrow")).toContainText("0 bought · 0 sold · $7,200,000 unspent");

    // The rail: six stages, every count zero, no node orange, the questions re-worded for a block.
    const nodes = page.getByTestId("secondaries-rail").locator(".stage-node");
    await expect(nodes).toHaveCount(6);
    for (const n of await nodes.allTextContents()) expect(n.trim()).toBe("0");
    await expect(page.getByTestId("secondaries-rail").locator(".stage-node-current")).toHaveCount(0);
    await expect(page.getByTestId("secondaries-stage-DILIGENCE")).toContainText("Price against the last round");
    await expect(page.getByTestId("secondaries-stage-CLOSED")).toContainText("Bought · Sold");

    // The empty state IS the page: shape hidden from assistive tech, copy says where values come from.
    const shape = page.getByTestId("secondaries-shape-buying");
    await expect(shape).toHaveAttribute("aria-hidden", "true");
    await expect(shape).toContainText("[COMPANY]");
    await expect(page.getByTestId("secondaries-purchases-empty")).toContainText("a pricing observation against the last round");
    await expect(page.getByTestId("secondaries-sales-empty")).toContainText("A sale begins on the holding's row on Portfolio");
    // The separation rule is said once, in the masthead — not three times.
    await expect(page.getByTestId("secondaries-page").getByText(/never the primary path/)).toHaveCount(1);
  });

  test("a purchase and a sale land on the rail, the nodes filter the bands, and the readiness line says what it does not know", async ({
    page,
    request,
  }) => {
    const funds = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string }> };
    if (funds.funds.length === 0) await seedCommissionedFund(request);
    const company = (await (
      await request.post("/api/companies", { headers: MP, data: { canonical_name: `D5 Block Co ${Date.now()}` } })
    ).json()) as { id: string };
    const buy = (await (
      await request.post("/api/opportunities", {
        headers: MP,
        data: {
          company_id: company.id,
          opportunity_type: "SECONDARY_PURCHASE",
          title: "An employee's block",
          seller_name: "An early employee",
          broker_name: "A broker",
          quantity: 1000,
          price_per_share: 12,
          discount_premium: -0.2,
        },
      })
    ).json()) as { id: string };
    // The sale as the Portfolio tab will open it (§13 Q5): SECONDARY_SALE on the holding's company.
    // ASSUMED SHAPE until D3 publishes its field names — the columns /api/secondaries selects.
    const sell = (await (
      await request.post("/api/opportunities", {
        headers: MP,
        data: { company_id: company.id, opportunity_type: "SECONDARY_SALE", title: "Sell part of the holding" },
      })
    ).json()) as { id: string };
    const moved = await request.post(`/api/opportunities/${sell.id}/transition`, { headers: MP, data: { to: "SCREENING" } });
    expect(moved.status()).toBe(200);

    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSurface(page, "Secondaries");
    await expect(page.getByTestId("secondaries-answer")).toContainText("in the sleeve: 1 buying, 1 selling");

    // The rows, with the readiness line honest about what has no writer yet.
    const buyRow = page.getByTestId(`secondary-${buy.id}`);
    await expect(buyRow).toContainText("Secondary — buying · An early employee via A broker · 1,000 units · @ $12 · -20% to last round");
    await expect(buyRow).toContainText("last round: to confirm — no pricing observation on this company");
    await expect(buyRow).toContainText("ownership after the block: to confirm");
    await expect(page.getByTestId("secondaries-shape-buying")).toHaveCount(0);
    await expect(page.getByTestId(`secondary-${sell.id}`)).toContainText("Secondary — selling");

    // A PRIMARY_ROUND observation is read onto the row the moment it exists.
    const obs = await request.post("/api/pricing-observations", {
      headers: MP,
      data: { company_id: company.id, observation_type: "PRIMARY_ROUND", price_per_share: 15, observed_at: "2026-06-01", source: "the cap table" },
    });
    expect(obs.status()).toBe(201);
    await page.reload();
    await expect(page.getByTestId(`secondary-${buy.id}`)).toContainText("last round: $15 · 2026-06-01");

    // The nodes count and filter: NEW holds the purchase, SCREENING the sale.
    await expect(page.getByTestId("secondaries-node-NEW")).toHaveText("1");
    await expect(page.getByTestId("secondaries-node-NEW")).toHaveClass(/stage-node-filled/);
    await expect(page.getByTestId("secondaries-node-SCREENING")).toHaveText("1");
    await page.getByTestId("secondaries-node-SCREENING").click();
    await expect(page.getByTestId("secondaries-node-SCREENING")).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("secondaries-purchases-empty")).toContainText("Nothing we are buying is at Screening");
    await expect(page.getByTestId(`secondary-${sell.id}`)).toBeVisible();
    await expect(page.getByTestId("secondaries-purchases-count")).toContainText("0 at Screening");
    await page.getByTestId("secondaries-clear-filter").click();
    await expect(page.getByTestId(`secondary-${buy.id}`)).toBeVisible();

    // A block waiting on a decision is where the human act is: one orange node, and words for it.
    for (const to of ["SCREENING", "DILIGENCE", "IC_READY"]) {
      const r = await request.post(`/api/opportunities/${buy.id}/transition`, { headers: MP, data: { to } });
      expect(r.status(), `move to ${to}`).toBe(200);
    }
    await page.reload();
    await expect(page.getByTestId("secondaries-node-IC_READY")).toHaveClass(/stage-node-current/);
    await expect(page.getByTestId("secondaries-rail").locator(".stage-node-current")).toHaveCount(1);
    await expect(page.getByTestId("secondaries-stage-IC_READY")).toContainText("the act is here");
  });

  test("Secondaries holds its measured numbers at five widths, with rows on the page", async ({ page, request }) => {
    const funds = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string }> };
    if (funds.funds.length === 0) await seedCommissionedFund(request);
    await installMeasures(page);
    await signIn(page);
    const report: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoSurface(page, "Secondaries");
      await expect(page.getByTestId("secondaries-budget")).toContainText("deployed");
      report.push(await holdTheNumbers(page, "secondaries-page", vp, { minTextNodes: 30, minClickables: 8 }));
    }
    console.log("SECONDARIES MEASURED\n  " + report.join("\n  "));
  });
});
