import { expect, test, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * HOME, MEASURED RATHER THAN ASSERTED.
 *
 * The 18 Sep redesign was held to four numbers on its mock — 0 contrast failures, 0 tap targets
 * under 24px, 0 horizontal overflow at four widths, 0 wrapped clickables — and a number that only
 * ever existed in a report is a number nobody will notice going wrong. So the page is measured in
 * the browser, on every run, and the measurements are the assertions.
 *
 * WHY THIS PAGE AND NOT ALL OF THEM. Home is the surface the operator opens twice a day, it is the
 * one the redesign touched, and it is the one where the layout is derived from live counts — which
 * means its shape changes with the firm's state in a way a static review cannot cover.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. Every loop below asserts it found something first. A
 * contrast sweep over an unrendered page passes trivially and tells you the page is perfect.
 */

const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
];

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

async function openHome(page: Page): Promise<void> {
  /* Below 900px the rail is a sheet behind the top bar; `gotoSurface` walks the same path an
     operator does at whatever width the test is holding. */
  await gotoSurface(page, "Home");
  await expect(page.getByTestId("home-page")).toBeVisible();
  // The one late insert on this page. Waiting for it is what makes the CLS assertion meaningful.
  await page.waitForTimeout(1500);
}

/**
 * Contrast over every rendered text node inside Home.
 *
 * The background is resolved by walking up the ancestors until something is not transparent, which
 * is what the browser does; taking `backgroundColor` off the text's own element would score most of
 * the page against `rgba(0,0,0,0)` and pass everything.
 */
const MEASURE_CONTRAST = `() => {
  const lum = (c) => {
    const f = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  };
  const parse = (s) => { const m = s.match(/[\\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
  const alpha = (s) => { const m = s.match(/[\\d.]+/g); return m && m.length > 3 ? Number(m[3]) : 1; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const bgOf = (el) => {
    let n = el;
    while (n) {
      const s = getComputedStyle(n);
      if (alpha(s.backgroundColor) > 0.01) return parse(s.backgroundColor);
      n = n.parentElement;
    }
    return [255, 255, 255];
  };
  const root = document.querySelector('[data-testid="home-page"]');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const out = [];
  let node;
  while ((node = walker.nextNode())) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    const el = node.parentElement;
    if (!el || !el.getClientRects().length) continue;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.opacity === '0') continue;
    const fg = parse(s.color);
    if (!fg) continue;
    const px = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    // WCAG "large text": 18.66px bold, or 24px at any weight.
    const need = (px >= 24 || (px >= 18.66 && bold)) ? 3 : 4.5;
    out.push({ text: node.nodeValue.trim().slice(0, 60), ratio: ratio(fg, bgOf(el)), need, px });
  }
  return out;
}`;

/** Anything a finger can press, with the box it actually occupies. */
const MEASURE_TARGETS = `() => {
  const root = document.querySelector('[data-testid="home-page"]');
  const sel = 'button, a[href], input, select, textarea, summary, [role="button"]';
  return [...root.querySelectorAll(sel)].flatMap((el) => {
    const rects = [...el.getClientRects()];
    if (rects.length === 0) return [];
    const r = el.getBoundingClientRect();
    return [{
      label: (el.getAttribute('data-testid') || el.textContent || el.tagName).trim().slice(0, 50),
      w: r.width, h: r.height,
      // A clickable broken over two lines is two hit areas with a seam down the middle, and the
      // seam is where a thumb lands. Rect count is how you see it; a bounding box hides it.
      rects: rects.length,
    }];
  });
}`;

test("Home holds its measured numbers: contrast, tap targets, overflow, unwrapped clickables", async ({ page }) => {
  await signIn(page);

  const report: string[] = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openHome(page);

    // ── 1 · NO HORIZONTAL OVERFLOW ────────────────────────────────────────────────────────────
    const overflow = await page.evaluate(
      (w) => {
        const root = document.querySelector('[data-testid="home-page"]');
        if (!root) return ["home-page did not render"];
        return [...root.querySelectorAll("*")]
          .filter((el) => {
            const r = el.getBoundingClientRect();
            // A deliberately scrollable box (a wide table in its own overflow-x container) is not
            // an overflowing page; its own width is what is asked about.
            if (getComputedStyle(el).overflowX === "auto" || getComputedStyle(el).overflowX === "scroll") return false;
            return r.width > 0 && Math.round(r.right) > w + 1;
          })
          .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} → ${Math.round(el.getBoundingClientRect().right)}px`)
          .slice(0, 8);
      },
      vp.width,
    );
    expect(overflow, `horizontal overflow at ${vp.name}`).toEqual([]);

    const docWide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(docWide, `the document itself scrolls sideways at ${vp.name}`).toBeLessThanOrEqual(1);

    // ── 2 · CONTRAST ──────────────────────────────────────────────────────────────────────────
    const nodes: Array<{ text: string; ratio: number; need: number; px: number }> = await page.evaluate(MEASURE_CONTRAST);
    expect(nodes.length, `Rule 0 — measured 0 text nodes at ${vp.name}; a sweep over nothing is not a pass`).toBeGreaterThan(30);
    const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
    expect(
      failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px — "${f.text}"`),
      `contrast at ${vp.name}`,
    ).toEqual([]);
    const min = Math.min(...nodes.map((n) => n.ratio));

    // ── 3 · TAP TARGETS, AND NONE OF THEM WRAPPED ─────────────────────────────────────────────
    const targets: Array<{ label: string; w: number; h: number; rects: number }> = await page.evaluate(MEASURE_TARGETS);
    expect(targets.length, `Rule 0 — found 0 clickables on Home at ${vp.name}`).toBeGreaterThan(5);
    const small = targets.filter((t) => t.h < 24 || t.w < 24);
    expect(small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)}`), `tap targets under 24px at ${vp.name}`).toEqual([]);
    const wrapped = targets.filter((t) => t.rects > 1);
    expect(wrapped.map((t) => `${t.label} — ${t.rects} rects`), `clickables broken over more than one line at ${vp.name}`).toEqual([]);

    report.push(
      `${vp.name}: ${nodes.length} text nodes, min ${min.toFixed(2)}:1, 0 below AA · ` +
        `${targets.length} clickables, 0 under 24px, 0 wrapped · 0 horizontal overflow`,
    );
  }

  console.log("HOME MEASURED\n  " + report.join("\n  "));
});

/**
 * THE LAYOUT SHIFT, MEASURED.
 *
 * `/api/me/connections` answers at roughly 2.5s and `ConnectPanel` is Home's first child, so
 * returning null until then dropped the entire page by one strip's height at the moment a partner
 * had started reading. The fix reserves the height. This proves the page does not move: the answer
 * line's y position before the strip arrives must equal its position after.
 */
test("Home does not move under the reader when the setup strip arrives", async ({ page }) => {
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSurface(page, "Home");
  await expect(page.getByTestId("home-page")).toBeVisible();

  const answer = page.getByTestId("home-answer");
  await expect(answer).toBeVisible();
  const before = (await answer.boundingBox())!.y;

  // Wait past the connections round trip, whichever way it resolves.
  await page.waitForTimeout(4000);
  const after = (await answer.boundingBox())!.y;

  expect(Math.abs(after - before), "the answer line moved when the setup strip landed").toBeLessThanOrEqual(1);
});
