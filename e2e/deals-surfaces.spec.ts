import { expect, test, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * THE DEALS SURFACES, MEASURED RATHER THAN ASSERTED (design/DEALS_SECTION_DESIGN.md §12.7).
 *
 * The 18 Sep redesign of the Deals section was held to four numbers on its artboards — 0 contrast
 * failures, 0 tap targets under 24px, 0 horizontal overflow at four widths, 0 wrapped clickables —
 * and a number that only ever existed in a report is a number nobody will notice going wrong. So
 * each tab is measured in the browser, on every run, on the same contract Home is held to
 * (`d2-home-measured.spec.ts`), plus the tab's one journey.
 *
 * ONE DESCRIBE PER TAB. Each tab's branch adds its own describe with the same contract; the
 * measuring functions are shared here so the six tabs cannot be held to six different rulers.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. Every loop asserts it found something first. A contrast
 * sweep over an unrendered page passes trivially and tells you the page is perfect.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

export const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
  { name: "1280 — the desk", width: 1280, height: 900 },
];

async function signIn(page: Page, email = "sequoia@westpeek.ventures"): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill(email);
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

/**
 * Contrast over every rendered text node inside the surface. The background is resolved by walking
 * up the ancestors until something is not transparent, which is what the browser does.
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

/** Anything a finger can press, with the box it actually occupies. */
function measureTargets(rootTestId: string): Array<{ label: string; w: number; h: number; rects: number }> {
  const root = document.querySelector(`[data-testid="${rootTestId}"]`);
  if (!root) return [];
  const sel = 'button, a[href], input, select, textarea, summary, [role="button"]';
  return [...root.querySelectorAll(sel)].flatMap((el) => {
    const rects = [...el.getClientRects()];
    if (rects.length === 0) return [];
    const r = el.getBoundingClientRect();
    return [
      {
        label: (el.getAttribute("data-testid") || el.textContent || el.tagName).trim().slice(0, 50),
        w: r.width,
        h: r.height,
        rects: rects.length,
      },
    ];
  });
}

/** The four numbers, at one width, for one surface. Returns the report line. */
async function measureSurface(page: Page, rootTestId: string, vp: (typeof VIEWPORTS)[number]): Promise<string> {
  const overflow = await page.evaluate(
    ({ w, root }) => {
      const el = document.querySelector(`[data-testid="${root}"]`);
      if (!el) return [`${root} did not render`];
      return [...el.querySelectorAll("*")]
        .filter((n) => {
          const r = n.getBoundingClientRect();
          const ox = getComputedStyle(n).overflowX;
          if (ox === "auto" || ox === "scroll") return false;
          // A descendant of a declared scroller is asked about inside that scroller, not the page.
          if (n.closest(".table-wrap, .faces, .table-scroll")) return false;
          return r.width > 0 && Math.round(r.right) > w + 1;
        })
        .map((n) => `${n.tagName.toLowerCase()}.${(n.className || "").toString().split(" ")[0]}[${n.getAttribute("data-testid") || ""}] "${(n.textContent || "").trim().slice(0, 40)}" → ${Math.round(n.getBoundingClientRect().right)}px`)
        .slice(0, 8);
    },
    { w: vp.width, root: rootTestId },
  );
  expect(overflow, `horizontal overflow at ${vp.name}`).toEqual([]);
  const docWide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(docWide, `the document itself scrolls sideways at ${vp.name}`).toBeLessThanOrEqual(1);

  const nodes = await page.evaluate(measureContrast, rootTestId);
  expect(nodes.length, `Rule 0 — measured 0 text nodes at ${vp.name}; a sweep over nothing is not a pass`).toBeGreaterThan(30);
  const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
  expect(failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px — "${f.text}"`), `contrast at ${vp.name}`).toEqual([]);
  const min = Math.min(...nodes.map((n) => n.ratio));

  const targets = await page.evaluate(measureTargets, rootTestId);
  expect(targets.length, `Rule 0 — found 0 clickables at ${vp.name}`).toBeGreaterThan(5);
  const small = targets.filter((t) => t.h < 24 || t.w < 24);
  expect(small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)}`), `tap targets under 24px at ${vp.name}`).toEqual([]);
  const wrapped = targets.filter((t) => t.rects > 1);
  expect(wrapped.map((t) => `${t.label} — ${t.rects} rects`), `clickables broken over more than one line at ${vp.name}`).toEqual([]);

  return `${vp.name}: ${nodes.length} text nodes, min ${min.toFixed(2)}:1, 0 below AA · ${targets.length} clickables, 0 under 24px, 0 wrapped · 0 horizontal overflow`;
}

// ── helpers shared by the journeys ─────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

async function ensureFund(request: Ctx, marker: string): Promise<{ id: string; name: string }> {
  const before = (await (await request.get("/api/funds", { headers: MP })).json()) as { funds: Array<{ id: string; name: string }> };
  if (before.funds.length > 0) return before.funds[0]!;
  const made = await request.post("/api/funds", { headers: MP, data: { name: `${marker} Fund I` } });
  expect(made.status(), await made.text()).toBe(201);
  return (await made.json()) as { id: string; name: string };
}

/** A company closed exactly as Sensori is in production: backfilled, with a $1 × N stand-in. */
async function closedLikeSensori(request: Ctx, name: string, amount: number): Promise<{ companyId: string; opportunityId: string }> {
  const company = (await (
    await request.post("/api/companies", { headers: MP, data: { canonical_name: name, sector: "Consumer" } })
  ).json()) as { id: string };
  const created = await request.post("/api/opportunities", {
    headers: MP,
    data: {
      company_id: company.id,
      opportunity_type: "EARLY_STAGE_PRIMARY",
      title: `${name} — SPV, closed before the fund existed`,
      source_channel: "SPV",
      price_per_share: 1,
      quantity: amount,
      terms: { vehicle: "SPV", amount_invested_usd: amount },
      placeholder_fields: ["price_per_share", "quantity"],
      placeholder_note: "Entry price and share count are STAND-INS totalling the real amount invested.",
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const opportunity = (await created.json()) as { id: string };
  const backfilled = await request.post(`/api/opportunities/${opportunity.id}/backfill`, {
    headers: MP,
    data: { to: "CLOSED", reason: "SPV that closed before Fund I existed; never went through IC", as_of_date: "2025-08-06" },
  });
  expect(backfilled.status(), await backfilled.text()).toBe(200);
  return { companyId: company.id, opportunityId: opportunity.id };
}

async function positionsFor(request: Ctx, companyId: string): Promise<Array<{ id: string; fund_id: string; quantity: number; cost_basis: number; status: string }>> {
  const body = (await (await request.get(`/api/positions?company_id=${companyId}`, { headers: MP })).json()) as {
    positions: Array<{ id: string; fund_id: string; quantity: number; cost_basis: number; status: string }>;
  };
  return body.positions;
}

// ── Portfolio (design §6, artboards G1 and G2) ──────────────────────────────────────────────────

test.describe("Portfolio", () => {
  test("holds its measured numbers at five widths: contrast, tap targets, overflow, unwrapped clickables", async ({ page, request }) => {
    // Measured WITH a row on the page — an empty list examines no holding row, and the row is the
    // thing the artboards were drawn around. Its Book-it form is opened at every width too.
    const marker = `E2E-DEALS-PF-${Date.now()}`;
    await ensureFund(request, marker);
    const { companyId } = await closedLikeSensori(request, `${marker} Measured Co`, 10_000);

    await signIn(page);
    const report: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await gotoSurface(page, "Portfolio");
      await expect(page.getByTestId("portfolio-page")).toBeVisible();
      await expect(page.getByTestId(`holding-row-${companyId}`)).toBeVisible();
      // The last two inserts on the page: the concentration line under the rows and the two hosted
      // drawings. Waiting on them, not on a clock, is what makes the measurement mean something.
      await expect(page.getByTestId("concentration-line")).toBeVisible();
      await expect(page.getByTestId("composition").or(page.getByTestId("composition-empty"))).toBeVisible();
      report.push(await measureSurface(page, "portfolio-page", vp));

      // The form open under the row: the six fields and two buttons at this width.
      await page.getByTestId(`holding-book-${companyId}`).click();
      await expect(page.getByTestId(`holding-form-${companyId}`)).toBeVisible();
      await expect(page.getByTestId(`book-class-${companyId}`)).toBeFocused();
      report.push(`  with Book it open — ${await measureSurface(page, "portfolio-page", vp)}`);
      await page.keyboard.press("Escape");
      await expect(page.getByTestId(`holding-form-${companyId}`)).toHaveCount(0);
    }
    console.log("PORTFOLIO MEASURED\n  " + report.join("\n  "));
  });

  test("journey: unbooked row → Book it → Save → the card → approve → the row reads booked and position has exactly one row", async ({ page, request }) => {
    const marker = `E2E-DEALS-BOOK-${Date.now()}`;
    const fund = await ensureFund(request, marker);
    const { companyId, opportunityId } = await closedLikeSensori(request, `${marker} Sensori`, 10_000);

    await signIn(page, "sequoia@westpeek.ventures");
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoSurface(page, "Portfolio");

    // ── The row, unbooked, and the masthead saying so ──────────────────────────────────────────
    const row = page.getByTestId(`holding-row-${companyId}`);
    await expect(row).toBeVisible();
    await expect(page.getByTestId(`holding-standing-${companyId}`)).toContainText("not yet booked");
    await expect(page.getByTestId(`holding-paid-${companyId}`)).toContainText("stand-in");
    await expect(page.getByTestId("portfolio-answer")).toContainText("not booked");
    expect(await positionsFor(request, companyId), "an unbooked row has no position").toHaveLength(0);

    // ── Book it: the form opens under the row, first field focused, NOTHING pre-filled from
    //    the stand-in ($1 × 10,000 must not be in the boxes) ───────────────────────────────────
    await page.getByTestId(`holding-book-${companyId}`).click();
    const form = page.getByTestId(`holding-form-${companyId}`);
    await expect(form).toBeVisible();
    await expect(page.getByTestId(`book-class-${companyId}`)).toBeFocused();
    await expect(page.getByTestId(`book-price-${companyId}`)).toHaveValue("");
    await expect(page.getByTestId(`book-quantity-${companyId}`)).toHaveValue("");
    await expect(page.getByTestId(`book-date-${companyId}`)).toHaveValue("2025-08-06");

    // The error state: a save with nothing typed names the fields and books nothing.
    await page.getByTestId(`book-save-${companyId}`).click();
    await expect(form.locator(".field-help.err").first()).toBeVisible();
    await expect(page.getByTestId(`book-price-${companyId}`)).toHaveAttribute("aria-invalid", "true");
    expect(await positionsFor(request, companyId)).toHaveLength(0);

    // The real terms, typed by the partner.
    await page.getByTestId(`book-class-${companyId}`).selectOption("__new__");
    await page.getByTestId(`book-class-name-${companyId}`).fill("SPV interest");
    await page.getByTestId(`book-price-${companyId}`).fill("2.50");
    await page.getByTestId(`book-quantity-${companyId}`).fill("4000");
    await page.getByTestId(`book-vehicle-${companyId}`).selectOption("SPV");
    await page.getByTestId(`book-fund-${companyId}`).selectOption(fund.id);
    await expect(page.getByTestId(`book-cost-${companyId}`)).toContainText("$10,000");
    await page.getByTestId(`book-save-${companyId}`).click();

    // ── Saved: the form closes, the row reads awaiting a partner, ONE card exists, no position ──
    await expect(page.getByTestId(`holding-notice-${companyId}`)).toContainText("Saved and sent to Scooter");
    await expect(page.getByTestId(`holding-form-${companyId}`)).toHaveCount(0);
    await expect(page.getByTestId(`holding-standing-${companyId}`)).toContainText("awaiting Scooter");
    await expect(page.getByTestId(`holding-book-${companyId}`)).toBeDisabled();
    await expect(page.getByTestId(`holding-card-${companyId}`)).toBeVisible();
    expect(await positionsFor(request, companyId), "saving books nothing").toHaveLength(0);
    // The stand-ins healed from what was typed.
    const opp = (await (await request.get(`/api/opportunities/${opportunityId}`, { headers: MP })).json()) as {
      price_per_share: number;
      quantity: number;
      placeholder_fields: string;
    };
    expect(opp.price_per_share).toBe(2.5);
    expect(opp.quantity).toBe(4000);
    expect(JSON.parse(opp.placeholder_fields)).toEqual([]);

    const holdings = (await (await request.get("/api/portfolio/holdings", { headers: MP })).json()) as {
      holdings: Array<{ company_id: string; standing: string; booking: { transaction_id: string; approval_card_id: string } | null }>;
    };
    const mine = holdings.holdings.find((h) => h.company_id === companyId)!;
    expect(mine.standing).toBe("awaiting");
    const cardId = mine.booking!.approval_card_id;
    const txnId = mine.booking!.transaction_id;
    expect(cardId).toMatch(/^apc_/);
    const cards = (await (await request.get("/api/approvals?state=pending_review", { headers: MP })).json()) as {
      approvals: Array<{ id: string; object_type: string; object_id: string }>;
    };
    expect(cards.approvals.filter((a) => a.object_type === "transaction" && a.object_id === txnId), "exactly one card per booking").toHaveLength(1);

    // ── The partner's approval, on Approvals: the last human act, and it books ────────────────
    await page.getByTestId(`holding-card-${companyId}`).click();
    await expect(page.getByTestId("approvals-page")).toBeVisible();
    const card = page.getByTestId(`approval-card-${cardId}`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Approving books the position");
    await card.getByTestId(`decision-note-${cardId}`).fill(`${marker}: terms as entered on the row`);
    await card.getByTestId(`approve-${cardId}`).click();
    await expect
      .poll(async () => ((await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string }).state, {
        message: "approving must execute the booking, which consumes the card",
      })
      .toBe("executed");

    // ── position has EXACTLY ONE row, for what was approved, in the fund the draft named ──────
    const positions = await positionsFor(request, companyId);
    expect(positions, "approval is what creates the position, and it must have — once").toHaveLength(1);
    expect(positions[0]!.quantity).toBe(4000);
    expect(positions[0]!.cost_basis).toBe(10_000);
    expect(positions[0]!.fund_id).toBe(fund.id);
    expect(positions[0]!.status).toBe("OPEN");

    // The receipt is spent: the explicit route with the same card is refused and nothing doubles.
    const replay = await request.post(`/api/transactions/${txnId}/execute`, { headers: MP, data: { approval_receipt_id: cardId, fund_id: fund.id } });
    expect(replay.status(), await replay.text()).toBe(409);
    expect(await positionsFor(request, companyId)).toHaveLength(1);

    // ── The row reads booked; Mark it and Reserve for it and Sell are on it ──────────────────
    await gotoSurface(page, "Portfolio");
    await expect(page.getByTestId(`holding-standing-${companyId}`)).toContainText(`booked to ${fund.name}`);
    await expect(page.getByTestId(`holding-paid-${companyId}`)).toContainText("$10,000");
    await expect(page.getByTestId(`holding-paid-${companyId}`)).not.toContainText("stand-in");
    await expect(page.getByTestId(`holding-held-${companyId}`)).toContainText("still just what we paid");

    // Mark it, inline: the mark lands on the row, at the source and date given.
    await page.getByTestId(`holding-mark-${companyId}`).click();
    await expect(page.getByTestId("mark-value")).toBeFocused();
    await page.getByTestId("mark-value").fill("25000");
    await page.getByTestId("mark-source").selectOption("LAST_ROUND");
    await page.getByTestId("mark-basis").fill(`${marker}: seed at $12M post`);
    await page.getByTestId("mark-date").fill("2026-09-01");
    await page.getByTestId("mark-submit").click();
    await expect(page.getByTestId(`holding-notice-${companyId}`)).toContainText("superseded, never overwritten");
    await expect(page.getByTestId(`holding-held-${companyId}`)).toContainText("$25,000");

    // Reserve for it, inline: the reserve lands on the row.
    await page.getByTestId(`holding-reserve-${companyId}`).click();
    await page.getByTestId("reserve-amount").fill("20000");
    await page.getByTestId("reserve-note").fill(`${marker}: the seed extension`);
    await page.getByTestId("reserve-submit").click();
    await expect(page.getByTestId(`holding-reserved-${companyId}`)).toContainText("$20,000");

    // Sell: a SECONDARY_SALE opens on Dealflow, the row says so, and the position is untouched.
    await page.getByTestId(`holding-sell-${companyId}`).click();
    await expect(page.getByTestId(`holding-sale-open-${companyId}`)).toContainText("sale open");
    await expect(page.getByTestId(`holding-sale-${companyId}`)).toBeVisible();
    const deals = (await (await request.get(`/api/opportunities?company_id=${companyId}`, { headers: MP })).json()) as {
      opportunities: Array<{ opportunity_type: string; status: string; source_channel: string }>;
    };
    const sale = deals.opportunities.filter((d) => d.opportunity_type === "SECONDARY_SALE");
    expect(sale, "one sale opened from the row").toHaveLength(1);
    expect(sale[0]!.status).toBe("NEW");
    expect(sale[0]!.source_channel).toBe("portfolio:sell");
    expect((await positionsFor(request, companyId))[0]!.quantity, "opening a sale sells nothing").toBe(4000);
  });
});
