import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoSurface, openDealFace } from "./support/nav";

/**
 * THE DEALS SECTION, MEASURED RATHER THAN ASSERTED (design/DEALS_SECTION_DESIGN.md §10, §12.7).
 *
 * The same four numbers Home and Work were held to on 18 Sep — 0 horizontal overflow at four
 * widths, 0 wrapped clickables, 0 tap targets under 24px, 0 contrast failures — plus a heading
 * scale measured in the browser: the masthead answer above the band heads above the panel heads.
 *
 * One `describe` per tab. Each tab's agent adds its own; the coordinator merges the file by hand.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. Every sweep asserts it found something first, and the
 * Dealflow seed asserts the rows it made actually landed — a contrast sweep over an unrendered
 * page passes trivially and reports the page as perfect. The Dealflow seed puts a real proposal
 * on the Waiting-on-you band (so the band, the proposal card, the count pill and the orange rail
 * node are all rendered and measured), a deal at the committee (so the committee band has a row
 * and the record's committee face has a packet), and an emailed arrival nobody has looked at.
 */

const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
  { name: "1280 — the laptop", width: 1280, height: 900 },
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
 * Contrast over every rendered text node inside the surface. The background is resolved by walking
 * up the ancestors until something is not transparent, which is what the browser does.
 */
function measureContrast(rootId: string): Array<{ text: string; ratio: number; need: number; px: number }> {
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
  const root = document.querySelector(`[data-testid="${rootId}"]`);
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
    // A disabled control is dimmed on purpose and is exempt from AA (WCAG 1.4.3, inactive UI).
    if (el.closest(":disabled, [aria-disabled='true']")) continue;
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
function measureTargets(rootId: string): Array<{ label: string; w: number; h: number; rects: number }> {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return [];
  const sel = 'button, a[href], input, select, textarea, summary, [role="button"], [role="tab"]';
  return [...root.querySelectorAll(sel)].flatMap((el) => {
    const rects = [...el.getClientRects()];
    if (rects.length === 0) return [];
    // A file input renders its own native control; its box is the browser's, not the page's.
    if (el instanceof HTMLInputElement && el.type === "file") return [];
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

/** Elements whose right edge is past the viewport, excluding declared inner scrollers. */
function measureOverflow(rootId: string, w: number): string[] {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return [`${rootId} did not render`];
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

/** Every heading the surface emits, with the size it actually computes to. */
function measureRanks(rootId: string): Array<{ tag: string; px: number; weight: number; text: string }> {
  const root = document.querySelector(`[data-testid="${rootId}"]`);
  if (!root) return [];
  return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const s = getComputedStyle(el);
      return { tag: el.tagName.toLowerCase(), px: parseFloat(s.fontSize), weight: Number(s.fontWeight), text: (el.textContent || "").trim().slice(0, 50) };
    });
}

/**
 * One sweep of one rendered state: overflow, document width, contrast, targets, wrapped clickables.
 * Returns a report line. Every assertion carries the state and the width so a failure reads.
 */
async function sweep(page: Page, rootId: string, state: string, vp: { name: string; width: number }): Promise<string> {
  // A condition, not a duration: the fonts are in and two frames have painted at this width, so the
  // boxes being measured are the boxes a reader would see.
  await page.evaluate(() => document.fonts.ready.then(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
  const overflow = await page.evaluate(([id, w]) => measureOverflowInPage(id as string, w as number), [rootId, vp.width] as const);
  expect(overflow, `horizontal overflow on ${state} at ${vp.name}`).toEqual([]);
  const docWide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(docWide, `the document itself scrolls sideways on ${state} at ${vp.name}`).toBeLessThanOrEqual(1);

  const nodes = await page.evaluate((id) => measureContrastInPage(id), rootId);
  expect(nodes.length, `Rule 0 — measured 0 text nodes on ${state} at ${vp.name}`).toBeGreaterThan(15);
  const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
  expect(failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px — "${f.text}"`), `contrast on ${state} at ${vp.name}`).toEqual([]);

  const targets = await page.evaluate((id) => measureTargetsInPage(id), rootId);
  expect(targets.length, `Rule 0 — found 0 clickables on ${state} at ${vp.name}`).toBeGreaterThan(3);
  const small = targets.filter((t) => t.h < 24 || t.w < 24);
  expect(small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)}`), `tap targets under 24px on ${state} at ${vp.name}`).toEqual([]);
  const wrapped = targets.filter((t) => t.rects > 1);
  expect(wrapped.map((t) => `${t.label} — ${t.rects} rects`), `clickables broken over more than one line on ${state} at ${vp.name}`).toEqual([]);

  const min = Math.min(...nodes.map((n) => n.ratio));
  return `${vp.name} · ${state}: ${nodes.length} text nodes, min ${min.toFixed(2)}:1 · ${targets.length} clickables, 0 under 24px, 0 wrapped · 0 overflow`;
}

/* The measurers are installed on the page once so `sweep` can call them by name. */
declare global {
  // eslint-disable-next-line no-var
  var measureContrastInPage: typeof measureContrast;
  // eslint-disable-next-line no-var
  var measureTargetsInPage: typeof measureTargets;
  // eslint-disable-next-line no-var
  var measureOverflowInPage: typeof measureOverflow;
  // eslint-disable-next-line no-var
  var measureRanksInPage: typeof measureRanks;
}
async function installMeasurers(page: Page): Promise<void> {
  await page.addInitScript(
    `window.measureContrastInPage = ${measureContrast.toString()};
     window.measureTargetsInPage = ${measureTargets.toString()};
     window.measureOverflowInPage = ${measureOverflow.toString()};
     window.measureRanksInPage = ${measureRanks.toString()};`,
  );
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// DEALFLOW (design §4, artboards E1, E2)
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * A REAL BOARD, MADE THROUGH THE REAL ROUTES: a company at Screening with a stage move proposed
 * from a meeting (the Waiting band's one-click accept), a company at the committee with its packet
 * (the committee band and the record's committee face), and an emailed arrival nobody has looked
 * at (the attention badge and the third kind of waiting item).
 */
async function seedDealflow(request: APIRequestContext): Promise<{ proposed: string; committee: string; emailed: string; proposalId: string; committeeDealId: string; emailedDealId: string; meetingId: string }> {
  const token = `M${Date.now().toString(36)}`;
  const mk = async (name: string, startAt: string[], extra: Record<string, unknown> = {}) => {
    const co = await request.post("/api/companies", { headers: MP, data: { canonical_name: name } });
    expect(co.status(), await co.text()).toBe(201);
    const { id: companyId } = (await co.json()) as { id: string };
    const opp = await request.post("/api/opportunities", {
      headers: MP,
      data: { company_id: companyId, opportunity_type: "EARLY_STAGE_PRIMARY", title: `${name} — seed`, relationship_origin: "COMMUNITY_INTRO", ...extra },
    });
    expect(opp.status(), await opp.text()).toBe(201);
    const { id: dealId } = (await opp.json()) as { id: string };
    for (const to of startAt) {
      const t = await request.post(`/api/opportunities/${dealId}/transition`, { headers: MP, data: { to } });
      expect(t.status(), await t.text()).toBe(200);
    }
    return { companyId, dealId };
  };

  const proposed = `${token} Psyflo`;
  const a = await mk(proposed, ["SCREENING"]);
  const meeting = await request.post("/api/meetings", {
    headers: MP,
    data: { title: `${token} founder call`, meeting_type: "FOUNDER", company_id: a.companyId, occurred_at: new Date().toISOString() },
  });
  expect(meeting.status(), await meeting.text()).toBe(201);
  const { id: meetingId } = (await meeting.json()) as { id: string };
  const proposal = await request.post(`/api/meetings/${meetingId}/stage-proposals`, {
    headers: MP,
    data: { opportunity_id: a.dealId, to_status: "DILIGENCE", rationale: "The fit question is answered well enough to spend six weeks on it." },
  });
  expect(proposal.status(), await proposal.text()).toBe(201);
  const { id: proposalId } = (await proposal.json()) as { id: string };

  const committee = `${token} Northwind Robotics`;
  const b = await mk(committee, ["SCREENING", "DILIGENCE", "IC_READY"]);

  // An emailed arrival nobody has looked at: `source_channel` starting `email:` and never moved.
  const emailed = `${token} Vynlo`;
  const c = await mk(emailed, [], { source_channel: "email:founder@example.com" });

  // The board must carry both, with the proposal on it — Rule 0 for the seed itself.
  const board = (await (await request.get("/api/dealflow/board", { headers: MP })).json()) as {
    deals: Array<{ id: string; status: string; unreviewed: boolean }>;
    proposals: Array<{ id: string }>;
  };
  expect(board.deals.find((d) => d.id === a.dealId)?.status, "the proposed deal must be at Screening").toBe("SCREENING");
  expect(board.deals.find((d) => d.id === b.dealId)?.status, "the committee deal must be at the committee").toBe("IC_READY");
  expect(board.proposals.some((p) => p.id === proposalId), "the board must carry the proposal").toBe(true);
  expect(board.deals.find((d) => d.id === c.dealId)?.unreviewed, "the emailed arrival must read as not yet looked at").toBe(true);
  return { proposed, committee, emailed, proposalId, committeeDealId: b.dealId, emailedDealId: c.dealId, meetingId };
}

async function openDealflow(page: Page): Promise<void> {
  await gotoSurface(page, "Dealflow");
  await expect(page.getByTestId("dealflow-page")).toBeVisible();
  await expect(page.getByTestId("dealflow-answer")).toBeVisible();
  await expect(page.getByTestId("stage-rail")).toBeVisible();
  // The last band renders after its own read; waiting on it makes this a measurement of the loaded page.
  await expect(page.getByTestId("deal-provenance")).toBeVisible();
}

test.describe("Dealflow", () => {
  test("holds its measured numbers on the pipeline and on the record's five faces, at five widths", async ({ page, request }) => {
    test.slow();
    await installMeasurers(page);
    await signIn(page);
    const seed = await seedDealflow(request);
    const report: string[] = [];

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openDealflow(page);

      // The seed is on the page: the proposal card, the count pill, the orange node in words.
      await expect(page.getByTestId(`proposal-${seed.proposalId}`)).toBeVisible();
      await expect(page.getByTestId("dealflow-waiting-count")).toBeVisible();
      await expect(page.getByTestId("stage-node-SCREENING")).toHaveAttribute("aria-label", /the act is here/);
      await expect(page.getByTestId(`ic-row-${seed.committeeDealId}`)).toBeVisible();
      await expect(page.getByTestId(`waiting-unreviewed-${seed.emailedDealId}`)).toBeVisible();
      await expect(page.getByTestId(`deal-unreviewed-${seed.emailedDealId}`)).toHaveText("by email · not yet looked at");

      report.push(await sweep(page, "dealflow-page", "pipeline", vp));

      // A rail node narrows the list, and says so.
      await page.getByTestId("stage-node-IC_READY").click();
      await expect(page.getByTestId("stage-node-IC_READY")).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByTestId("deal-list")).toContainText(seed.committee);
      await expect(page.getByTestId("deal-list")).not.toContainText(seed.proposed);
      report.push(await sweep(page, "dealflow-page", "rail filter", vp));

      // The inline reason field, open on a row, then closed without a pass.
      await page.getByTestId("dealflow-filter-LIVE").click();
      const row = page.locator('[data-testid^="deal-"]', { hasText: seed.proposed }).first();
      const dealId = (await row.getAttribute("data-testid"))!.replace("deal-", "");
      await page.getByTestId(`deal-pass-${dealId}`).click();
      await expect(page.getByTestId(`deal-pass-reason-${dealId}-text`)).toBeFocused();
      report.push(await sweep(page, "dealflow-page", "reason field open", vp));
      await page.getByTestId(`deal-pass-reason-${dealId}-cancel`).click();

      // The add-company form, open.
      await page.getByTestId("dealflow-add-toggle").click();
      await expect(page.getByTestId("dealflow-add-form")).toBeVisible();
      report.push(await sweep(page, "dealflow-page", "add form", vp));
      await page.getByTestId("dealflow-add-toggle").click();

      // The record, on every face — the committee face with its packet and the packet's own faces.
      await page.getByTestId(`ic-open-${seed.committeeDealId}`).click();
      await expect(page.getByTestId("deal-record")).toBeVisible();
      await expect(page.getByTestId("deal-face-committee")).toHaveAttribute("aria-selected", "true");
      await expect(page.getByTestId(`ic-deal-${seed.committeeDealId}`)).toBeVisible();
      await page.getByTestId(`ic-open-packet-${seed.committeeDealId}`).click();
      await expect(page.getByTestId("deal-packet")).toBeVisible();
      await expect(page.getByTestId("ic-diligence")).toBeVisible();
      report.push(await sweep(page, "dealflow-page", "record · committee + packet", vp));
      for (const face of ["standing", "deal", "known", "history"] as const) {
        await openDealFace(page, face);
        report.push(await sweep(page, "dealflow-page", `record · ${face}`, vp));
      }
      await page.getByTestId("deal-record-close").click();
      await expect(page.getByTestId("deal-record")).toHaveCount(0);
    }

    console.log("DEALFLOW MEASURED\n  " + report.join("\n  "));
  });

  test("has three ranks of type, not one", async ({ page, request }) => {
    await installMeasurers(page);
    await signIn(page);
    await seedDealflow(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDealflow(page);

    const ranks = await page.evaluate(() => measureRanksInPage("dealflow-page"));
    expect(ranks.length, "Rule 0 — found no headings on Dealflow at all").toBeGreaterThan(3);
    const answer = ranks.filter((r) => r.tag === "h2");
    const bands = ranks.filter((r) => r.tag === "h3");
    const panels = ranks.filter((r) => r.tag === "h4");
    expect(answer, "one h2 — the masthead answer").toHaveLength(1);
    expect(bands.length, "the bands").toBeGreaterThanOrEqual(3);
    const minAnswer = Math.min(...answer.map((r) => r.px));
    const maxBand = Math.max(...bands.map((r) => r.px));
    expect(minAnswer, `the answer (${minAnswer}px) must sit clearly above the band heads (${maxBand}px)`).toBeGreaterThan(maxBand + 2);
    if (panels.length > 0) {
      const maxPanel = Math.max(...panels.map((r) => r.px));
      const minBand = Math.min(...bands.map((r) => r.px));
      expect(minBand, `band heads (${minBand}px) must sit above panel heads (${maxPanel}px)`).toBeGreaterThan(maxPanel);
    }
  });

  test("a proposal from a meeting is one click, and declining takes a reason inline", async ({ page, request }) => {
    await installMeasurers(page);
    await signIn(page);
    const seed = await seedDealflow(request);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openDealflow(page);

    // No dialog, ever.
    page.on("dialog", (d) => {
      void d.dismiss();
      throw new Error(`a browser dialog opened (${d.type()}) — reasons are inline fields`);
    });

    const card = page.getByTestId(`proposal-${seed.proposalId}`);
    await expect(card).toContainText(`Move ${seed.proposed} from Screening to Diligence`);

    // Declining with nothing typed is refused in the field, with an instruction, and moves nothing.
    await page.getByTestId(`proposal-decline-${seed.proposalId}`).click();
    const field = page.getByTestId(`proposal-decline-reason-${seed.proposalId}-text`);
    await expect(field).toBeFocused();
    await page.getByTestId(`proposal-decline-reason-${seed.proposalId}-confirm`).click();
    await expect(field).toHaveAttribute("aria-invalid", "true");
    await expect(card).toContainText("Say why in a few words");
    await page.getByTestId(`proposal-decline-reason-${seed.proposalId}-cancel`).click();

    // Accepting is one click: the deal moves, the proposal leaves the band, the rail's act moves on.
    await page.getByTestId(`proposal-accept-${seed.proposalId}`).click();
    await expect(card).toHaveCount(0);
    const board = async () =>
      ((await (await request.get("/api/dealflow/board", { headers: MP })).json()) as { deals: Array<{ company_name: string; status: string }> }).deals.find(
        (d) => d.company_name === seed.proposed,
      )?.status;
    await expect.poll(board).toBe("DILIGENCE");
    // With the proposal gone the act is at the committee: the orange node moved, in words.
    await expect(page.getByTestId("stage-node-SCREENING")).not.toHaveAttribute("aria-label", /the act is here/);
    // The proposal is ACCEPTED on the meeting's own record, decided by a person — the click was
    // `decideStageProposal`, not a second write path.
    const after = (await (await request.get(`/api/meetings/${seed.meetingId}/after`, { headers: MP })).json()) as {
      stage_proposals: Array<{ id: string; state: string; decided_by: string | null }>;
    };
    const decided = after.stage_proposals.find((p) => p.id === seed.proposalId);
    expect(decided?.state).toBe("ACCEPTED");
    expect(decided?.decided_by, "accepted by a person, recorded by id").toBeTruthy();
  });
});
