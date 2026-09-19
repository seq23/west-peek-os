import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { deliverMail } from "./support/mail";

/**
 * THE DEALS SURFACES, MEASURED RATHER THAN ASSERTED (design/DEALS_SECTION_DESIGN.md §12.7).
 *
 * The section's redesign is held to the numbers Home and Work are held to — 0 contrast failures,
 * 0 tap targets under 24px, 0 horizontal overflow, 0 wrapped clickables — at FIVE widths, because
 * the artboards were measured at 320/375/414/768 and the desktop boards drawn at 1280. Each tab's
 * agent adds a `describe` here as it lands (§12.5 for Companies); the contract is the same for all
 * of them, and it is one file so the five never disagree about what "measured" means.
 *
 * OPACITY IS COMPOSITED, unlike the Home and Work measurers. The Companies register dims a passed
 * company's facts (`.deal-row-out`, opacity .72) and the spec's claim is that the REASON stays at
 * full ink — a measurer that reads `color` off the element and ignores the ancestor's opacity would
 * pass 11px muted text at an effective 3.2:1 and report it perfect. So the foreground is blended
 * toward the resolved background by the product of every ancestor's opacity before the ratio is
 * taken, which is what the eye gets.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. Every loop asserts it found something first, the seed
 * asserts every row it made is on the page, and a sweep over an unrendered page is a red run.
 */

const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
  { name: "1280 — the desktop artboards", width: 1280, height: 900 },
];

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

/**
 * Contrast over every rendered text node inside a surface, with opacity composited.
 *
 * The background is resolved by walking up the ancestors until something is not transparent, which
 * is what the browser does; the foreground is then blended toward it by the accumulated opacity of
 * the text's element and every ancestor, which is also what the browser does and what the Home and
 * Work measurers leave out.
 */
function measureContrast(rootTestId: string): Array<{ text: string; ratio: number; need: number; px: number; alpha: number }> {
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
  const alphaOf = (s: string): number => {
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
      if (alphaOf(s.backgroundColor) > 0.01) return parse(s.backgroundColor) ?? [255, 255, 255];
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const opacityOf = (el: Element): number => {
    let a = 1;
    let n: Element | null = el;
    while (n) {
      a *= Number(getComputedStyle(n).opacity);
      n = n.parentElement;
    }
    return a;
  };
  const root = document.querySelector(`[data-testid="${rootTestId}"]`);
  const out: Array<{ text: string; ratio: number; need: number; px: number; alpha: number }> = [];
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
    const bg = bgOf(el);
    const alpha = opacityOf(el);
    const seen = fg.map((v, i) => alpha * v + (1 - alpha) * bg[i]!);
    const px = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    // WCAG "large text": 18.66px bold, or 24px at any weight.
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    out.push({ text: node.nodeValue.trim().slice(0, 60), ratio: ratio(seen, bg), need, px, alpha });
  }
  return out;
}

/** Anything a finger can press, with the box it actually occupies. */
function measureTargets(rootTestId: string): Array<{ label: string; w: number; h: number; rects: number; textLink: boolean }> {
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
        // A clickable broken over two lines is two hit areas with a seam down the middle, and the
        // seam is where a thumb lands. Rect count is how you see it; a bounding box hides it.
        rects: rects.length,
        textLink: el.classList.contains("link-button"),
      },
    ];
  });
}

/**
 * THE TAP FLOOR, AND THE ONE DEFECT THIS SPEC FOUND IN A FILE ITS TABS DO NOT OWN.
 *
 * 24px everywhere (WCAG 2.5.8). `styles.css` §Touch targets means `.link-button` — the inline
 * text link, the product's most-used control — to be 44px wherever the pointer is coarse, and
 * keeps it compact on a mouse at desktop widths on purpose ("the compact look is deliberate").
 * MEASURED, the coarse-pointer rule never reaches it: `.surface-body button.link-button
 * { min-height: auto }` (0,2,1) outranks `@media (pointer: coarse) .link-button { min-height: 44px }`
 * (0,1,0), so on a touch laptop or an iPad in landscape every text link above 900px is 22.5px tall.
 * A guard that cannot reach what it governs. Under 900px a different block (`@media (max-width:
 * 900px) .surface-body button.link-button`) carries the specificity and the links are 44px, which
 * is why Home and Work — measured to 768 — never saw it.
 *
 * `styles.css` belongs to the tokens agent (design/DEALS_SECTION_DESIGN.md §12.1), so the sweep
 * below holds every OTHER target to 24px at every width and pointer, reports the compact desktop
 * links by count, and the dedicated test after it is marked `test.fail` with the fix named: it goes
 * red the day the rule reaches the links, so whoever raises the selector's specificity removes the
 * marker in the same change and the floor becomes strict.
 */

/**
 * The four numbers, for one surface at one width. Shared by every tab's describe so the contract
 * cannot drift between them.
 */
async function measureSurface(
  page: Page,
  rootTestId: string,
  vp: (typeof VIEWPORTS)[number],
  where: string,
  pointer: "fine" | "coarse",
): Promise<string> {
  const overflow = await page.evaluate(([id, w]) => {
    const root = document.querySelector(`[data-testid="${id}"]`);
    if (!root) return [`${id} did not render`];
    return [...root.querySelectorAll("*")]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        const ox = getComputedStyle(el).overflowX;
        if (ox === "auto" || ox === "scroll") return false;
        return r.width > 0 && Math.round(r.right) > (w as number) + 1;
      })
      .map(
        (el) =>
          `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}[${el.getAttribute("data-testid") || ""}] "${(el.textContent || "").trim().slice(0, 40)}" → ${Math.round(el.getBoundingClientRect().right)}px`,
      )
      .slice(0, 8);
  }, [rootTestId, vp.width] as const);
  expect(overflow, `horizontal overflow on ${where} at ${vp.name}`).toEqual([]);

  const docWide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(docWide, `the document itself scrolls sideways on ${where} at ${vp.name}`).toBeLessThanOrEqual(1);

  const nodes = await page.evaluate(measureContrast, rootTestId);
  expect(nodes.length, `Rule 0 — measured 0 text nodes on ${where} at ${vp.name}; a sweep over nothing is not a pass`).toBeGreaterThan(15);
  const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
  expect(
    failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px, opacity ${f.alpha.toFixed(2)} — "${f.text}"`),
    `contrast on ${where} at ${vp.name}`,
  ).toEqual([]);

  const targets = await page.evaluate(measureTargets, rootTestId);
  expect(targets.length, `Rule 0 — found 0 clickables on ${where} at ${vp.name}`).toBeGreaterThan(3);
  const coarse = await page.evaluate(() => matchMedia("(pointer: coarse)").matches);
  expect(coarse, `the ${pointer} pointer context did not take`).toBe(pointer === "coarse");
  const compactLinks = vp.width > 900;
  const held = targets.filter((t) => !(compactLinks && t.textLink));
  expect(held.length, `Rule 0 — every clickable on ${where} at ${vp.name} was a text link; nothing was held to the floor`).toBeGreaterThan(0);
  const small = held.filter((t) => t.h < 24 || t.w < 24);
  expect(
    small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)}`),
    `tap targets under 24px on ${where} at ${vp.name}, ${pointer} pointer`,
  ).toEqual([]);
  const compact = compactLinks ? targets.filter((t) => t.textLink && t.h < 24).length : 0;
  const wrapped = targets.filter((t) => t.rects > 1);
  expect(wrapped.map((t) => `${t.label} — ${t.rects} rects`), `clickables broken over more than one line on ${where} at ${vp.name}`).toEqual([]);

  const min = Math.min(...nodes.map((n) => n.ratio));
  return (
    `${vp.name} · ${pointer} pointer · ${where}: ${nodes.length} text nodes, min ${min.toFixed(2)}:1, 0 below AA · ` +
    `${targets.length} clickables, ${compact === 0 ? "0 under 24px" : `${compact} text links under 24px (styles.css .link-button, see the marked test), every other target at the floor`}, 0 wrapped · 0 horizontal overflow`
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// COMPANIES — the register (§5, artboard F)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

interface RegisterRow {
  id: string;
  canonical_name: string;
  deal_id: string | null;
  deal_status: string | null;
  looked_at: boolean | null;
  exit_reason: string | null;
}

/**
 * The register at its four shapes, made through the real doors: a partner's deal (Open: nothing),
 * an emailed deal nobody has looked at (Looked at: not yet), a pass with its reason (the band), and
 * a company that came in with no deal at all (the fault). Each is a state the card has to render,
 * and the measurement below is only a measurement if all four are on the page.
 */
async function seedRegister(request: APIRequestContext): Promise<{
  marker: string;
  manual: RegisterRow;
  mailed: RegisterRow;
  passed: RegisterRow;
  ghost: RegisterRow;
  reason: string;
}> {
  const marker = `E2E-D4-${Date.now().toString(36)}`;
  const reason = "Two of the three named customers turned out to be pilots";

  const company = async (name: string): Promise<string> => {
    const res = await request.post("/api/companies", { headers: MP, data: { canonical_name: name } });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };
  const deal = async (companyId: string, title: string): Promise<string> => {
    const res = await request.post("/api/opportunities", {
      headers: MP,
      data: { company_id: companyId, opportunity_type: "EARLY_STAGE_PRIMARY", title, relationship_origin: "INBOUND" },
    });
    expect(res.status(), await res.text()).toBe(201);
    return ((await res.json()) as { id: string }).id;
  };

  const manualId = await company(`${marker} Manual Co`);
  await deal(manualId, `${marker} Manual Co — pre-seed`);

  const passedId = await company(`${marker} Passed Co`);
  const passedDeal = await deal(passedId, `${marker} Passed Co — pre-seed`);
  const passed = await request.post(`/api/opportunities/${passedDeal}/transition`, { headers: MP, data: { to: "PASS", reason } });
  expect(passed.status(), await passed.text()).toBe(200);

  // The identity spine's own POST makes a company and no deal. It is the shape every intake route
  // has been forbidden from producing (validate:companies-in-pipeline), and the one the fault names.
  const ghostId = await company(`${marker} Ghost Co`);

  const mailedName = `${marker} Mailed Co`;
  await deliverMail(request, {
    from: "Dana Fields <dana@mailed.example>",
    subject: `#wpdealflow ${mailedName}`,
    body: `Company: ${mailedName}\n\nThought you should see this one.`,
  });

  const rows = async (): Promise<RegisterRow[]> =>
    ((await (await request.get("/api/companies/register", { headers: MP })).json()) as { companies: RegisterRow[] }).companies;
  await expect
    .poll(async () => (await rows()).some((c) => c.canonical_name === mailedName && c.deal_id), { timeout: 15_000 })
    .toBe(true);
  const all = await rows();
  const find = (name: string): RegisterRow => {
    const row = all.find((c) => c.canonical_name === name);
    expect(row, `Rule 0 — ${name} is not on the register`).toBeTruthy();
    return row!;
  };
  return {
    marker,
    reason,
    manual: find(`${marker} Manual Co`),
    mailed: find(mailedName),
    passed: find(`${marker} Passed Co`),
    ghost: find(`${marker} Ghost Co`),
  };
}

/**
 * LEAVE THE FIRM AS IT WAS FOUND. The suite shares one database, and a live NEW deal is not inert:
 * every intelligence run acquires the open NEW/SCREENING opportunities as items (services/
 * intelligence.ts `acquireInternal`, scored 0.30 for naming a company), and Home's intelligence
 * module shows the top EIGHT. Eight deals left here pushed journey 1 of p25 — an unscored manual
 * item — out of that window, so the module had nothing new and did not render. Twice in CI,
 * reproducibly, on a spec that never touches Home. The seeded live deals are therefore removed
 * (the product's own "Remove this record", with a reason) once each test has measured them.
 */
async function tidyRegister(request: APIRequestContext, seed: Awaited<ReturnType<typeof seedRegister>>): Promise<void> {
  for (const row of [seed.manual, seed.mailed]) {
    if (!row.deal_id) continue;
    const res = await request.post(`/api/opportunities/${row.deal_id}/archive`, {
      headers: MP,
      data: { reason: `e2e fixture for the Companies measurement (${seed.marker}); removed so it cannot bias another spec's Home` },
    });
    expect(res.status(), await res.text()).toBe(200);
  }
}

async function openCompanies(page: Page): Promise<void> {
  await gotoSurface(page, "Companies");
  await expect(page.getByTestId("companies-register")).toBeVisible();
  await expect(page.getByTestId("companies-answer")).toBeVisible();
  await expect(page.getByTestId("company-grid")).toBeVisible();
}

/** The sweep over every width, in whichever pointer context the caller's `test.use` set. */
async function sweepCompanies(page: Page, request: APIRequestContext, pointer: "fine" | "coarse"): Promise<void> {
  await signIn(page);
  const seed = await seedRegister(request);
  try {
    await sweepSeeded(page, seed, pointer);
  } finally {
    await tidyRegister(request, seed);
  }
}

async function sweepSeeded(page: Page, seed: Awaited<ReturnType<typeof seedRegister>>, pointer: "fine" | "coarse"): Promise<void> {
  const report: string[] = [];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openCompanies(page);
    // Every seeded shape is on this page, or the sweep is over the wrong page.
    for (const row of [seed.manual, seed.mailed, seed.passed, seed.ghost]) {
      await expect(page.getByTestId(`company-${row.id}`)).toBeVisible();
    }
    await expect(page.getByTestId("companies-fault")).toBeVisible();
    await expect(page.getByTestId("companies-passed")).toBeVisible();
    report.push(await measureSurface(page, "companies-register", vp, "register", pointer));

    // With the editor open on one card: the form is the widest thing a card can hold.
    await page.getByTestId(`company-edit-${seed.manual.id}`).click();
    await expect(page.getByTestId(`company-edit-form-${seed.manual.id}`)).toBeVisible();
    report.push(await measureSurface(page, "companies-register", vp, "register, editing", pointer));
    // Closed again before the next width: the card keeps its state across a re-navigation.
    await page.getByTestId(`company-edit-${seed.manual.id}`).click();
    await expect(page.getByTestId(`company-edit-form-${seed.manual.id}`)).toHaveCount(0);
  }
  console.log(`COMPANIES MEASURED (${pointer} pointer)\n  ` + report.join("\n  "));
}

test.describe("Companies", () => {
  test("holds its measured numbers at five widths with every card state on the page (mouse)", async ({ page, request }) => {
    test.slow();
    await sweepCompanies(page, request, "fine");
  });

  test.describe("with a finger", () => {
    // Touch emulation is what flips `(pointer: coarse)` in Chromium; it is the case the tap floor
    // exists for, and at 1280 it is a touch laptop or an iPad in landscape.
    test.use({ hasTouch: true });
    test("holds its measured numbers at five widths with every card state on the page (touch)", async ({ page, request }) => {
      test.slow();
      await sweepCompanies(page, request, "coarse");
    });

    test("desktop text links reach the touch floor under a coarse pointer", async ({ page, request }) => {
      // Was `test.fail` until 19 Sep 2026: `.surface-body button.link-button { min-height: auto }`
      // outranked the coarse-pointer floor above 900px. styles.css now repeats the specific selector
      // inside the coarse block, and this is a real assertion from here on.
      await signIn(page);
      const seed = await seedRegister(request);
      try {
        await page.setViewportSize({ width: 1280, height: 900 });
        await openCompanies(page);
        expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
        const links = (await page.evaluate(measureTargets, "companies-register")).filter((t) => t.textLink);
        expect(links.length, "Rule 0 — no text links were measured").toBeGreaterThan(3);
        expect(
          links.filter((t) => t.h < 24).map((t) => `${t.label} — ${Math.round(t.h)}px`),
          `text links under 24px at 1280 with a coarse pointer (seed ${seed.marker})`,
        ).toEqual([]);
      } finally {
        await tidyRegister(request, seed);
      }
    });
  });

  test("the card carries the rail and the clock, the contextual fact, and the fault is named at page level", async ({ page, request }) => {
    await signIn(page);
    const seed = await seedRegister(request);
    try {
      await checkCard(page, request, seed);
    } finally {
      await tidyRegister(request, seed);
    }
  });
});

async function checkCard(page: Page, request: APIRequestContext, seed: Awaited<ReturnType<typeof seedRegister>>): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openCompanies(page);

  // ── The masthead answers from the counts the page loads. ────────────────────────────────
  await expect(page.getByTestId("companies-answer")).toContainText(/\d+ compan(y|ies) on the record/);
  await expect(page.getByTestId("companies-answer")).toContainText("it turned down");

  // ── The rail and its clock, on a live card. ─────────────────────────────────────────────
  const manual = page.getByTestId(`company-${seed.manual.id}`);
  const rail = manual.getByTestId("stage-rail-compact");
  await expect(rail).toBeVisible();
  await expect(rail.locator(".stage-dot")).toHaveCount(6);
  await expect(rail.locator(".stage-dot-current")).toHaveCount(1);
  await expect(manual.getByTestId("stage-clock")).toHaveText(/^New · (today|1 day|\d+ days)$/);
  await expect(rail).toHaveAttribute("aria-label", /^Stage: New · /);
  // The stage is no longer a bare word in the facts; "Stage" is the rail's name, not a dt.
  await expect(manual.locator("dt", { hasText: /^Stage$/ })).toHaveCount(0);
  await expect(manual.getByTestId(`company-fourth-open-${seed.manual.id}`)).toContainText("nothing");

  // ── "Looked at" is the board's own fact, shown here as a chip. ──────────────────────────
  const board = (await (await request.get("/api/dealflow/board", { headers: MP })).json()) as {
    deals: Array<{ id: string; unreviewed: boolean }>;
  };
  const mailedOnBoard = board.deals.find((d) => d.id === seed.mailed.deal_id);
  expect(mailedOnBoard, "the emailed deal must be on the board").toBeTruthy();
  expect(mailedOnBoard!.unreviewed, "the board badges an untouched emailed deal as not yet looked at").toBe(true);
  expect(seed.mailed.looked_at, "the register says the same thing").toBe(false);
  const mailed = page.getByTestId(`company-${seed.mailed.id}`);
  await expect(mailed.getByTestId(`company-fourth-looked-at-${seed.mailed.id}`)).toContainText("not yet");
  await expect(mailed.getByTestId(`company-fourth-looked-at-${seed.mailed.id}`).locator(".badge-attention")).toBeVisible();

  // ── The fault: named at page level, and on the card. ────────────────────────────────────
  const fault = page.getByTestId("companies-fault");
  await expect(fault).toBeVisible();
  await expect(fault).toContainText(`${seed.marker} Ghost Co`);
  // The suite shares one database, so another spec's ghost may be named beside this one.
  await expect(fault).toContainText(/not on the board, and (it|they) should be\./);
  const ghost = page.getByTestId(`company-${seed.ghost.id}`);
  await expect(ghost.getByTestId(`company-no-deal-${seed.ghost.id}`)).toBeVisible();
  await expect(ghost.getByTestId("stage-rail-compact")).toHaveCount(0);
  // The strip is the one thing that must not read as decoration: a left rule in the danger colour.
  const rule = await fault.evaluate((el) => {
    const s = getComputedStyle(el);
    return { width: s.borderLeftWidth, colour: s.borderLeftColor, bg: s.backgroundColor };
  });
  expect(rule.width).toBe("3px");
  expect(rule.colour).not.toBe(rule.bg);

  // ── The strip survives a filter that hides the card. ────────────────────────────────────
  await page.getByTestId("companies-search").fill("zzz nothing is called this zzz");
  await expect(page.getByTestId("companies-empty")).toBeVisible();
  await expect(ghost).toHaveCount(0);
  await expect(fault, "a search that does not match the faulted company must not hide the fault").toBeVisible();
  await expect(fault).toContainText(`${seed.marker} Ghost Co`);
  await page.getByTestId("companies-search").fill("");

  // ── Passed: the facts recede, the reason does not. ──────────────────────────────────────
  const passed = page.getByTestId(`company-${seed.passed.id}`);
  await expect(page.getByTestId("companies-passed")).toContainText("Who did we turn down, and why?");
  await expect(passed.getByTestId(`company-passed-${seed.passed.id}`)).toContainText(seed.reason);
  await expect(passed.getByTestId(`company-passed-${seed.passed.id}`)).toContainText("We said no on");
  const opacities = await passed.evaluate((el) => {
    const eff = (n: Element | null): number => {
      let a = 1;
      while (n) {
        a *= Number(getComputedStyle(n).opacity);
        n = n.parentElement;
      }
      return a;
    };
    const reason = el.querySelector('[data-testid^="company-passed-"]');
    const facts = [...el.querySelectorAll(".company-facts dd")];
    return { reason: eff(reason), facts: facts.map(eff), factCount: facts.length };
  });
  expect(opacities.factCount, "Rule 0 — the passed card rendered no facts to dim").toBeGreaterThan(0);
  expect(opacities.reason, "the reason is the point of keeping the card and must be at full ink").toBe(1);
  for (const f of opacities.facts) expect(f, "the facts recede").toBeLessThan(1);
  await expect(passed.getByTestId("stage-rail-compact")).toHaveCount(0);
  await expect(passed.getByTestId(`company-deal-${seed.passed.id}`)).toHaveText("Look at it again");
  await expect(passed.getByTestId(`company-add-reason-${seed.passed.id}`)).toHaveCount(0);
}
