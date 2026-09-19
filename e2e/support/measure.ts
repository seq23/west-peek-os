import { expect, type Page } from "@playwright/test";

/**
 * The Deals section's four numbers, measured in the browser (design/DEALS_SECTION_DESIGN.md §12.7).
 *
 * The Home spec (`d2-home-measured.spec.ts`) holds Home to 0 contrast failures, 0 tap targets under
 * 24px, 0 horizontal overflow and 0 wrapped clickables, at four widths. The Deals tabs are held to
 * the same four, plus the touch floor: below 900px every button is 44px (the stylesheet's own
 * promise), and on a coarse pointer so is every link. The measurers live here so each tab's
 * `describe` in `deals-surfaces.spec.ts` is a few lines that say WHICH surfaces to measure, not
 * how — and so a number that only ever existed in a design review is measured on every run.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. `measureSurface` asserts it found text and clickables
 * before it reports a pass; a sweep over an unrendered page is not a clean page.
 */

export const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
  { name: "1280 — the laptop the desk is read on", width: 1280, height: 900 },
] as const satisfies readonly Viewport[];

export interface Viewport {
  name: string;
  width: number;
  height: number;
}

/** The floor a finger needs below the shell's phone breakpoint; the floor a pointer needs above it. */
export function targetFloor(width: number): number {
  return width < 900 ? 44 : 24;
}

export async function signIn(page: Page, email = "sequoia@westpeek.ventures"): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill(email);
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

/**
 * Contrast over every rendered text node inside the root.
 *
 * The background is resolved by walking up the ancestors until something is not transparent, which
 * is what the browser does; taking `backgroundColor` off the text's own element would score most of
 * the page against `rgba(0,0,0,0)` and pass everything.
 */
function measureContrast(rootSelector: string): Array<{ text: string; ratio: number; need: number; px: number }> {
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
  const root = document.querySelector(rootSelector);
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
    // Off-screen text for a screen reader has no colour to measure.
    if (el.closest(".sr-only")) continue;
    const fg = parse(s.color);
    if (!fg) continue;
    const px = parseFloat(s.fontSize);
    const bold = Number(s.fontWeight) >= 700;
    // WCAG "large text": 18.66px bold, or 24px at any weight.
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    out.push({ text: node.nodeValue.trim().slice(0, 60), ratio: ratio(fg, bgOf(el)), need, px });
  }
  return out;
}

/**
 * Anything a finger can press, with the box it actually occupies.
 *
 * A control whose hit area is a `::before` inset (the recording switch, 44×24 with a 10px inset)
 * is measured with that inset, because that is the box a finger meets.
 */
function measureTargets(rootSelector: string): Array<{ label: string; w: number; h: number; rects: number; kind: string }> {
  const root = document.querySelector(rootSelector);
  if (!root) return [];
  const sel = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"], [role="switch"]';
  return [...root.querySelectorAll(sel)].flatMap((el) => {
    const rects = [...el.getClientRects()];
    if (rects.length === 0) return [];
    if (el instanceof HTMLInputElement && el.type === "file") return [];
    const r = el.getBoundingClientRect();
    let w = r.width;
    let h = r.height;
    const before = getComputedStyle(el, "::before");
    if (before.position === "absolute" && before.content !== "none") {
      const top = parseFloat(before.top);
      const left = parseFloat(before.left);
      if (Number.isFinite(top) && top < 0) h += -2 * top;
      if (Number.isFinite(left) && left < 0) w += -2 * left;
    }
    const tag = el.tagName.toLowerCase();
    const kind = tag === "button" || tag === "a" || el.getAttribute("role") === "button" || el.getAttribute("role") === "tab" || el.getAttribute("role") === "switch" ? "press" : "field";
    return [
      {
        label: (el.getAttribute("data-testid") || el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 50),
        w,
        h,
        // A clickable broken over two lines is two hit areas with a seam down the middle, and the
        // seam is where a thumb lands. Rect count is how you see it; a bounding box hides it.
        rects: rects.length,
        kind,
      },
    ];
  });
}

export interface SurfaceReport {
  textNodes: number;
  minContrast: number;
  clickables: number;
}

/**
 * Measure one surface at the viewport the page currently holds. `rootTestId` is the surface's root;
 * `label` names it in every assertion message. Asserts the four numbers and returns what it counted.
 */
export async function measureSurface(page: Page, rootTestId: string, label: string, vp: Viewport): Promise<SurfaceReport> {
  const rootSelector = `[data-testid="${rootTestId}"]`;
  await expect(page.locator(rootSelector).first(), `${label} did not render at ${vp.name}`).toBeVisible();

  // ── 1 · NO HORIZONTAL OVERFLOW ──────────────────────────────────────────────────────────────
  const overflow = await page.evaluate(
    ({ sel, w }) => {
      const root = document.querySelector(sel);
      if (!root) return ["the surface did not render"];
      return [...root.querySelectorAll("*")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          // A deliberately scrollable box (the faces strip, a wide table in its own container, Home's
          // filter rail — design/HOME_DESIGN.md §5 names it the one inner scroller) is not an
          // overflowing page, and neither is what sits inside it.
          if (s.overflowX === "auto" || s.overflowX === "scroll") return false;
          if (el.closest(".faces, .table-wrap, .rail")) return false;
          if (el.closest(".sr-only")) return false;
          return r.width > 0 && Math.round(r.right) > w + 1;
        })
        .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}[${el.getAttribute("data-testid") || ""}] "${(el.textContent || "").trim().slice(0, 40)}" → ${Math.round(el.getBoundingClientRect().right)}px`)
        .slice(0, 8);
    },
    { sel: rootSelector, w: vp.width },
  );
  expect(overflow, `${label}: horizontal overflow at ${vp.name}`).toEqual([]);
  // The document as a whole, with the widest offenders named so a failure says what pushed it.
  const doc = await page.evaluate((w) => {
    const wide = document.documentElement.scrollWidth - document.documentElement.clientWidth;
    const offenders = wide > 1
      ? [...document.body.querySelectorAll("*")]
          .filter((el) => Math.round(el.getBoundingClientRect().right) > w + 1 && el.getBoundingClientRect().width > 0)
          .map((el) => `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}[${el.getAttribute("data-testid") || ""}] → ${Math.round(el.getBoundingClientRect().right)}px`)
          .slice(0, 6)
      : [];
    return { wide, offenders };
  }, vp.width);
  expect(doc.offenders, `${label}: the document scrolls sideways by ${doc.wide}px at ${vp.name}`).toEqual([]);
  expect(doc.wide, `${label}: the document itself scrolls sideways at ${vp.name}`).toBeLessThanOrEqual(1);

  // ── 2 · CONTRAST ────────────────────────────────────────────────────────────────────────────
  const nodes = await page.evaluate(measureContrast, rootSelector);
  expect(nodes.length, `Rule 0 — ${label} measured 0 text nodes at ${vp.name}; a sweep over nothing is not a pass`).toBeGreaterThan(0);
  const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
  expect(
    failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px — "${f.text}"`),
    `${label}: contrast at ${vp.name}`,
  ).toEqual([]);

  // ── 3 · TAP TARGETS, AND NONE OF THEM WRAPPED ───────────────────────────────────────────────
  const targets = await page.evaluate(measureTargets, rootSelector);
  expect(targets.length, `Rule 0 — ${label} has 0 clickables at ${vp.name}`).toBeGreaterThan(0);
  const floor = targetFloor(vp.width);
  const small = targets.filter((t) => t.h < 24 || t.w < 24 || (t.kind === "press" && t.h < floor));
  expect(small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)} (floor ${floor})`), `${label}: tap targets under the floor at ${vp.name}`).toEqual([]);
  const wrapped = targets.filter((t) => t.kind === "press" && t.rects > 1);
  expect(wrapped.map((t) => `${t.label} — ${t.rects} rects`), `${label}: clickables broken over more than one line at ${vp.name}`).toEqual([]);

  // ── 4 · NO WORD BROKEN IN HALF ──────────────────────────────────────────────────────────────
  // A title squeezed into a track narrower than its longest word wraps INSIDE the word ("Sequoi /
  // a //", the Meetings list on 19 Sep 2026: the call doors had taken the row's width). Nothing
  // above catches it — it is not overflow, not a clickable, not contrast. So every heading and
  // name is checked: its box must be at least as wide as its longest word laid on one line.
  const broken = await page.evaluate((sel) => {
    const root = document.querySelector(sel);
    if (!root) return ["the surface did not render"];
    const probe = document.createElement("span");
    probe.style.cssText = "position:absolute;visibility:hidden;white-space:nowrap;left:-9999px;top:0";
    document.body.appendChild(probe);
    const out: string[] = [];
    for (const el of root.querySelectorAll("h1, h2, h3, h4, .deal-name, .masthead-answer, .band-head h3, .holding-name")) {
      const box = (el as HTMLElement).getBoundingClientRect();
      if (box.width === 0) continue;
      const cs = getComputedStyle(el);
      probe.style.font = cs.font;
      probe.style.letterSpacing = cs.letterSpacing;
      const words = (el.textContent || "").split(/\s+/).filter(Boolean);
      let longest = 0;
      for (const w of words) {
        probe.textContent = w;
        longest = Math.max(longest, probe.getBoundingClientRect().width);
      }
      const inner = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      if (longest > inner + 1) {
        out.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} "${(el.textContent || "").trim().slice(0, 40)}" — longest word ${Math.round(longest)}px in a ${Math.round(inner)}px box`);
      }
    }
    probe.remove();
    return out.slice(0, 8);
  }, rootSelector);
  expect(broken, `${label}: a word is broken in half by its box at ${vp.name}`).toEqual([]);

  return { textNodes: nodes.length, minContrast: Math.min(...nodes.map((n) => n.ratio)), clickables: targets.length };
}

export function reportLine(label: string, vp: Viewport, r: SurfaceReport): string {
  return `${label} @ ${vp.width}: ${r.textNodes} text nodes, min ${r.minContrast.toFixed(2)}:1, 0 below AA · ${r.clickables} clickables, 0 under ${targetFloor(vp.width)}px, 0 wrapped · 0 horizontal overflow`;
}
