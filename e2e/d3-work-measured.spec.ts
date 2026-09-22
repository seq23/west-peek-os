import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * WORK, MEASURED RATHER THAN ASSERTED — AND MEASURED AT DAY-200 VOLUME.
 *
 * The 18 Sep redesign was held to the same four numbers as Home (0 contrast failures, 0 tap targets
 * under 24px, 0 horizontal overflow at four widths, 0 wrapped clickables) plus two this page needs
 * and Home does not, because this is the surface whose length grows without bound:
 *
 *   5 · THE DESK DOES NOT GROW WITH THE RECORD. Everything the firm has ever finished used to sit
 *       in the desk's scroll. Measured before the change against 531 finished cards: 5,101px on a
 *       laptop, 7,104px on a phone, 496 finished rows competing with 2 that had stopped. This spec
 *       seeds a real record and requires the desk to stay the length it is with an empty one.
 *
 *   6 · THE RECORD IS REACHABLE AT THE BOTTOM AS WELL AS THE TOP. The old page rendered
 *       `finished.slice(0, 50)` of a payload the server capped at 500, so on day 200 the thing she
 *       was looking for was simply absent — and nothing said so. The seeded needle here is the
 *       OLDEST card in the record, so finding it proves retrieval rather than recency.
 *
 * WHY THIS PAGE AND NOT ALL OF THEM. Work is the other surface the operator opens daily, it is the
 * one this redesign touched, and — unlike every other page — its length is a function of how long
 * the firm has been running. A layout that is correct on day 1 and unusable on day 200 passes every
 * review that looks at it today.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. Every loop below asserts it found something first, and
 * the volume seed asserts the rows actually landed. A contrast sweep over an unrendered page passes
 * trivially and reports the page as perfect.
 */

const VIEWPORTS = [
  { name: "320 — the narrowest phone still in use", width: 320, height: 800 },
  { name: "375 — iPhone SE / mini", width: 375, height: 812 },
  { name: "414 — the large-phone class", width: 414, height: 896 },
  { name: "768 — portrait tablet, where the rail folds away", width: 768, height: 1024 },
];

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

/** The oldest card in the seeded record, and the one the search has to be able to reach. */
const NEEDLE = "Kirx Diaz retrospective — the needle in the record";

/**
 * A token unique to each CALL of `seedRecord`, not to the module.
 *
 * Every spec in this suite drives ONE local D1, and `seedRecord` runs twice in this file, so the
 * collapse count stops being any one test's to predict — the first version read "ran 6×" against a
 * module-level token, which is the collapse working correctly over six identical cards and the
 * assertion being wrong about how many there were. A per-call token makes these three unambiguously
 * these three, and still proves the collapse over rows the SERVER grouped.
 */
let seeds = 0;
const packetTitle = (token: string) => `Parker: build the October 2026 Room packet (${token})`;

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

async function openWork(page: Page): Promise<void> {
  /* Below 900px the rail is a sheet behind the top bar; `gotoSurface` walks the same path an
     operator does at whatever width the test is holding. */
  await gotoSurface(page, "Work");
  await expect(page.getByTestId("work-cards-page")).toBeVisible();
  await expect(page.getByTestId("work-answer")).toBeVisible();
  /* Which address is on screen is a reading position that survives a re-navigation to a surface
     already open, so this puts the desk back rather than assuming it. */
  await page.getByTestId("work-view-desk").click();
  /* The answer line renders from counts that start at zero, so it is visible BEFORE the board has
     answered. Waiting on the tiles — which are the last thing the desk renders — is what makes a
     measurement of this page a measurement of the loaded page. */
  await expect(page.getByTestId("work-elsewhere")).toBeVisible();
}

/**
 * A REAL RECORD, MADE THROUGH THE REAL ROUTES.
 *
 * Not inserted into D1 behind the product's back: a record built by POSTing cards and moving them
 * to DONE is a record the product could actually have produced, and it exercises the same
 * classification defaults every card gets. `runs` identical copies of one title prove the collapse
 * on rows the server grouped rather than on a fixture the test wrote.
 */
async function seedRecord(request: APIRequestContext): Promise<{ made: number; token: string }> {
  const token = `r${Date.now().toString(36)}s${(seeds += 1)}`;
  let made = 0;
  const finish = async (title: string, description: string) => {
    const res = await request.post("/api/work-cards", {
      headers: MP,
      data: { title, next_action: "nothing — it is finished", description },
    });
    expect(res.status(), await res.text()).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const done = await request.patch(`/api/work-cards/${id}`, { headers: MP, data: { state: "DONE" } });
    expect(done.status(), await done.text()).toBe(200);
    made += 1;
  };

  // The needle first, so it is the oldest thing in the record and cannot be found by recency.
  await finish(NEEDLE, "• the one row this search has to be able to reach");

  for (let i = 0; i < 60; i += 1) {
    await finish(`Routine output ${i} — ${["brief", "triage", "packet", "pitch", "check-in"][i % 5]}`, `• result ${i}`);
  }
  /*
   * THREE IDENTICAL RUNS OF A HAND-MADE CARD (Addendum 4, 22 Sep 2026: superseding the plain
   * "identical runs collapse" fix). `POST /api/work-cards` with no `kind` makes a plain,
   * `startableByHand` card — the ordinary one-off case, never a recurring job's. Her decision:
   * "a one-off assignment is never identical to anything else and should never collapse, even if
   * it looks similar to another" — so these three stay three separate rows. Only a card whose
   * `kind` is job-opened (Room/Workshop packets, the Productions jobs) collapses identical runs,
   * and that path is not reachable through the hand door by design (`startableByHand: false`) —
   * proven instead at the row level in `tests/workRecordFilters.test.ts`.
   */
  for (let i = 0; i < 3; i += 1) {
    await finish(packetTitle(token), "• Room requested: an event for Black lawyers in our network");
  }
  return { made, token };
}

/**
 * Contrast over every rendered text node inside the Work surface.
 *
 * The background is resolved by walking up the ancestors until something is not transparent, which
 * is what the browser does; taking `backgroundColor` off the text's own element would score most of
 * the page against `rgba(0,0,0,0)` and pass everything.
 */
function measureContrast(): Array<{ text: string; ratio: number; need: number; px: number }> {
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
  const root = document.querySelector('[data-testid="work-cards-page"]');
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
    // WCAG "large text": 18.66px bold, or 24px at any weight.
    const need = px >= 24 || (px >= 18.66 && bold) ? 3 : 4.5;
    out.push({ text: node.nodeValue.trim().slice(0, 60), ratio: ratio(fg, bgOf(el)), need, px });
  }
  return out;
}

/** Anything a finger can press, with the box it actually occupies. */
function measureTargets(): Array<{ label: string; w: number; h: number; rects: number }> {
  const root = document.querySelector('[data-testid="work-cards-page"]');
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
      },
    ];
  });
}

/** Every heading the surface emits, with the size it actually computes to. */
function measureRanks(): Array<{ tag: string; px: number; weight: number; text: string }> {
  const root = document.querySelector('[data-testid="work-cards-page"]');
  if (!root) return [];
  return [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => {
      const s = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        px: parseFloat(s.fontSize),
        weight: Number(s.fontWeight),
        text: (el.textContent || "").trim().slice(0, 50),
      };
    });
}

test("Work holds its measured numbers at day-200 volume: contrast, tap targets, overflow, unwrapped clickables", async ({
  page,
  request,
}) => {
  test.slow();
  await signIn(page);

  const { made: seeded } = await seedRecord(request);
  expect(seeded, "Rule 0 — seeded 0 finished cards; a volume test with no volume is not a test").toBeGreaterThan(60);

  const report: string[] = [];

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openWork(page);

    // ── 1 · NO HORIZONTAL OVERFLOW, ON ALL THREE ADDRESSES ────────────────────────────────────
    for (const view of ["desk", "record", "machinery"] as const) {
      await page.getByTestId(`work-view-${view}`).click();
      if (view === "record") await expect(page.getByTestId("work-record")).toBeVisible();
      await page.waitForTimeout(600);

      const overflow = await page.evaluate(
        (w) => {
          const root = document.querySelector('[data-testid="work-cards-page"]');
          if (!root) return ["work-cards-page did not render"];
          return [...root.querySelectorAll("*")]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              /* A deliberately scrollable box (a wide table in its own overflow-x container) is
                 not an overflowing page; its own width is what is asked about. NOTE the hole this
                 leaves, which the tab strip fell into on 18 Sep: a CHILD of a scroller is still
                 measured, and it should be — an address parked at 351px on a 320px screen is a
                 lost address whether or not its parent can be dragged. */
              const ox = getComputedStyle(el).overflowX;
              if (ox === "auto" || ox === "scroll") return false;
              return r.width > 0 && Math.round(r.right) > w + 1;
            })
            .map(
              (el) =>
                `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}[${el.getAttribute("data-testid") || ""}] "${(el.textContent || "").trim().slice(0, 40)}" → ${Math.round(el.getBoundingClientRect().right)}px`,
            )
            .slice(0, 8);
        },
        vp.width,
      );
      expect(overflow, `horizontal overflow on ${view} at ${vp.name}`).toEqual([]);

      const docWide = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(docWide, `the document itself scrolls sideways on ${view} at ${vp.name}`).toBeLessThanOrEqual(1);

      // ── 2 · CONTRAST ────────────────────────────────────────────────────────────────────────
      const nodes = await page.evaluate(measureContrast);
      expect(
        nodes.length,
        `Rule 0 — measured 0 text nodes on ${view} at ${vp.name}; a sweep over nothing is not a pass`,
      ).toBeGreaterThan(15);
      const failures = nodes.filter((n) => n.ratio < n.need - 0.005);
      expect(
        failures.map((f) => `${f.ratio.toFixed(2)}:1 (needs ${f.need}) at ${f.px}px — "${f.text}"`),
        `contrast on ${view} at ${vp.name}`,
      ).toEqual([]);

      // ── 3 · TAP TARGETS, AND NONE OF THEM WRAPPED ───────────────────────────────────────────
      const targets = await page.evaluate(measureTargets);
      expect(targets.length, `Rule 0 — found 0 clickables on ${view} at ${vp.name}`).toBeGreaterThan(3);
      const small = targets.filter((t) => t.h < 24 || t.w < 24);
      expect(
        small.map((t) => `${t.label} — ${Math.round(t.w)}×${Math.round(t.h)}`),
        `tap targets under 24px on ${view} at ${vp.name}`,
      ).toEqual([]);
      const wrapped = targets.filter((t) => t.rects > 1);
      expect(
        wrapped.map((t) => `${t.label} — ${t.rects} rects`),
        `clickables broken over more than one line on ${view} at ${vp.name}`,
      ).toEqual([]);

      const min = Math.min(...nodes.map((n) => n.ratio));
      report.push(
        `${vp.name} · ${view}: ${nodes.length} text nodes, min ${min.toFixed(2)}:1, 0 below AA · ` +
          `${targets.length} clickables, 0 under 24px, 0 wrapped · 0 horizontal overflow`,
      );
    }
  }

  console.log("WORK MEASURED\n  " + report.join("\n  "));
});

/**
 * THE HEADING SCALE, MEASURED IN THE BROWSER RATHER THAN READ OFF THE STYLESHEET.
 *
 * `validate:heading-scale` proves a rule REACHES a heading. It has no opinion about the resulting
 * size, and cannot have one — which left the real defect on this page untouched: every `h3` and
 * every `h4` inside the Work surface computed to 18px/700, because `.home-section-head h2, h3, h4`
 * is one rule with one size. The rules were live and the hierarchy was still gone.
 *
 * So the rank separation is a number here: the answer line must be meaningfully larger than the
 * band heads, and the band heads meaningfully larger than body copy. Three ranks of meaning, three
 * ranks of type.
 */
test("Work has three ranks of type, not one", async ({ page, request }) => {
  await signIn(page);

  /* A rank comparison needs something at every rank. On an empty firm there are no bands and no
     band note, so one live card is the fixture — and the Rule-0 guard below is what caught this. */
  const made = await request.post("/api/work-cards", {
    headers: MP,
    data: { title: "A card so the desk has a band to measure", next_action: "be measured" },
  });
  expect(made.status(), await made.text()).toBe(201);

  await page.setViewportSize({ width: 1280, height: 900 });
  await openWork(page);

  const ranks = await page.evaluate(measureRanks);
  expect(ranks.length, "Rule 0 — found no headings on the Work surface at all").toBeGreaterThan(1);

  const answer = ranks.find((r) => r.tag === "h2");
  expect(answer, "the Work surface emits no h2 — the answer line is the page's own rank 0").toBeTruthy();

  const bands = ranks.filter((r) => r.tag === "h3");
  expect(bands.length, "Rule 0 — no band headings were measured").toBeGreaterThan(0);

  const bodyPx = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="work-cards-page"] .work-band-note');
    return el ? parseFloat(getComputedStyle(el).fontSize) : 0;
  });
  expect(bodyPx, "Rule 0 — no band note was measured, so there is nothing to compare against").toBeGreaterThan(0);

  const biggestBand = Math.max(...bands.map((b) => b.px));
  expect(
    answer!.px,
    `the answer line (${answer!.px}px) must outrank the band heads (${biggestBand}px) by at least 4px — ` +
      "both at one size is the defect this redesign exists to repair",
  ).toBeGreaterThanOrEqual(biggestBand + 4);
  expect(
    biggestBand,
    `the band heads (${biggestBand}px) must outrank body copy (${bodyPx}px) by at least 4px`,
  ).toBeGreaterThanOrEqual(bodyPx + 4);

  console.log(
    `WORK RANKS: answer ${answer!.px}px/${answer!.weight} > bands ${biggestBand}px > note ${bodyPx}px`,
  );
});

/**
 * THE DESK DOES NOT GROW WITH THE RECORD, AND THE RECORD IS REACHABLE TO ITS OLDEST ROW.
 *
 * These two are the redesign, stated as numbers. Before the change the desk carried every finished
 * card the firm had ever produced — and carried only the most recent fifty of them, so it was
 * simultaneously too long to read and too short to be a record.
 */
test("the desk stays short while the record grows, and the oldest row is still findable", async ({ page, request }) => {
  test.slow();
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 900 });

  /* The suite shares one database, so "the record is empty" is never true by the time this runs.
     Reading the total first turns the assertion into a delta, which is the stronger claim. */
  const before = (await (await request.get("/api/work-cards/record?limit=1", { headers: MP })).json()) as {
    total: { cards: number };
  };

  await openWork(page);
  const emptyDesk = await page.evaluate(
    () => (document.querySelector('[data-testid="work-cards-page"]') as HTMLElement).scrollHeight,
  );
  expect(emptyDesk, "Rule 0 — the desk measured 0px, so nothing was rendered").toBeGreaterThan(100);

  const { made: seeded, token } = await seedRecord(request);
  expect(seeded).toBeGreaterThan(60);

  await page.reload();
  await openWork(page);
  const fullDesk = await page.evaluate(
    () => (document.querySelector('[data-testid="work-cards-page"]') as HTMLElement).scrollHeight,
  );

  /*
   * THE NUMBER THAT MATTERS. Sixty-four finished cards must add no height to the desk, because they
   * are not on it. A little slack is allowed for the counts in the tiles changing width; anything
   * approaching one row's height per card means the record has leaked back onto the desk.
   */
  expect(
    fullDesk - emptyDesk,
    `the desk grew ${fullDesk - emptyDesk}px when ${seeded} cards were finished — finished work is a record, ` +
      "not a to-do, and it must not be in the desk's scroll",
  ).toBeLessThanOrEqual(120);

  // ── THE RECORD ANSWERS ────────────────────────────────────────────────────────────────────────
  await page.getByTestId("work-view-record").click();
  await expect(page.getByTestId("work-record")).toBeVisible();

  const summary = page.getByTestId("work-record-summary");
  await expect(summary).toContainText(`${before.total.cards + seeded} finished`);

  // THE NEEDLE IS THE OLDEST ROW IN THE RECORD. Recency cannot find it; search has to.
  await page.getByTestId("work-record-search").fill("needle in the record");
  await expect(page.getByText(NEEDLE, { exact: false }).first()).toBeVisible({ timeout: 10_000 });

  // ── A ONE-OFF NEVER COLLAPSES, EVEN WHEN IT LOOKS IDENTICAL (Addendum 4) ─────────────────────
  await page.getByTestId("work-record-search").fill(packetTitle(token));
  const packets = page.locator('[data-testid^="work-record-row-"]').filter({ hasText: token });
  await expect(
    packets,
    "a hand-made (one-off) card's three identical runs stay three separate rows, never folded into one",
  ).toHaveCount(3, { timeout: 10_000 });
  await expect(packets.first()).not.toContainText(/ran \d+×/);

  // ── AND A FILTER THAT MATCHES NOTHING SAYS SO ─────────────────────────────────────────────────
  await page.getByTestId("work-record-search").fill("zzz nothing has ever been called this zzz");
  await expect(page.getByTestId("work-record-empty")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("work-record-empty")).toContainText(`${before.total.cards + seeded}`);
});
