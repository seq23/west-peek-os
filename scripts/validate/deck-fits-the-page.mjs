#!/usr/bin/env node
/**
 * NOTHING ON A DECK PAGE RUNS UNDER THE FOOTER (26 Oct 2026).
 *
 * v18 of the LP deck printed figure rows under the footer on pages 5, 7 and 10, where the page's
 * `overflow:hidden` cut them off — and the stepped fee ran off the right edge. Nothing measured the
 * rendered page; a reader found it. This renders the deck in a REAL browser (Playwright's Chromium)
 * and reads every block's box against its page's footer, using the same measuring function the
 * Worker runs before it writes a final PDF (`MEASURE_OVERFLOW_JS` in src/shared/deck/render.ts).
 *
 * Two fixtures: the deck definition itself with long, realistic values in every figure, and a
 * preview-shaped deck using every block kind (tables, pictures, quotes, people, long lists) at
 * sizes that MUST continue onto a second page. Both must fit; both must produce pages (zero pages is
 * a failure, never a pass).
 *
 * `--self-test` breaks the layout on purpose (every block forced taller than the page allows) and
 * requires the measurement to catch it — a guard that cannot see a broken page does not run.
 */
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const selfTest = process.argv.includes("--self-test");

const bundle = join(tmpdir(), `wp-deck-fit-${process.pid}.mjs`);
execFileSync("npx", ["esbuild", "src/shared/deck/render.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundle}`], { stdio: ["ignore", "pipe", "pipe"] });
const { renderDeckHtml, MEASURE_OVERFLOW_JS } = await import(pathToFileURL(bundle).href);
const defBundle = join(tmpdir(), `wp-deck-def-${process.pid}.mjs`);
execFileSync("npx", ["esbuild", "src/shared/deck/definition.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${defBundle}`], { stdio: ["ignore", "pipe", "pipe"] });
const { DECK_SLIDES } = await import(pathToFileURL(defBundle).href);

/** Made-up figures, longest plausible spelling of each. Fund terms never live in this repo. */
const FIGURES = {
  fund_size: 31_700_000, fees: 4_750_000, expenses: 620_000, investable_base: 26_330_000,
  early_sleeve_usd: 18_430_000, early_sleeve_pct: 70, secondary_sleeve_usd: 7_900_000, secondary_sleeve_pct: 30,
  reserve_pct: 40, mgmt_fee_pct: 2, carry_pct: 20, reserve_usd: 7_370_000, initial_capital_usd: 11_060_000,
  target_positions: 27, check_min: 255_000, check_max: 525_000, sectors: ["AI", "HEALTH_TECH", "CONSUMER", "ED_TECH", "FUTURE_OF_WORK"],
  community_sourced: null, positions_held: 0, as_of_date: "September 2026", check_typical: 410_000, target_ownership_pct: 2.9,
  follow_on_min: 520_000, follow_on_max: 1_050_000, follow_on_companies: 11, secondary_check_min: 510_000,
  secondary_check_max: 1_550_000, secondary_positions: 12, concentration_cap: 3_100_000, gp_commit_pct: 1,
  gp_commit_usd: 317_000, target_net_multiple: 2.1,
  mgmt_fee_schedule: "1.9% a year in years 1–5 ($3.1M), then 0.9% a year in years 6–10 ($1.4M): $4.5M over the fund's life",
};

const PIC = (w, h, fill) =>
  `data:image/svg+xml;base64,${Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${fill}"/></svg>`).toString("base64")}`;
const ASSETS = { a: PIC(300, 300, "#888"), b: PIC(400, 120, "#446"), tall: PIC(400, 900, "#222") };
const LONG = "A sentence long enough to wrap across more than one line of the slide at the body size, as real copy does.";

/** Every block kind, including enough of them that pages must continue. Fake names only. */
const RICH = [
  { key: "cover", layout: "cover", headline: "“A FAKE COVER LINE.”", standfirst: "Somewhere · Elsewhere (and everywhere in between)", aside: { asset: "b" }, slots: [{ kind: "text", text: "Fund I — Early stage fund" }, { kind: "figure", label: "As of", bind: "as_of_date" }] },
  { key: "collage", layout: "photo", aside: { asset: "tall" }, headline: "FOUNDERS TRUST US BECAUSE OF OUR COMMUNITY, NOT JUST CAPITAL.", slots: [
    { kind: "heading", text: "What makes it valuable" },
    { kind: "images", height: 64, items: [{ asset: "a", alt: "", caption: "Peer-to-peer, not transactional. Members help each other." }, { asset: "a", alt: "", caption: "Community members are experienced" }, { asset: "a", alt: "", caption: "Access to early customers and partners" }] },
    { kind: "heading", text: "We host" },
    { kind: "images", height: 64, items: [{ asset: "a", alt: "", caption: "Pitch competitions in front of top investors" }, { asset: "a", alt: "", caption: "Office hours with experts on growth, sales and more" }, { asset: "a", alt: "", caption: "Dinners where you can meet your co-founder, early hire or first customer" }] },
  ] },
  { key: "team", layout: "panel", aside: { text: "WE'RE A **TEST** DUO WITH A BACKGROUND IN **THINGS**.\n\n**TOGETHER** WE HAVE DONE WORK ACROSS OUR NETWORKS." }, headline: "THE TEAM", slots: [
    { kind: "person", name: "Alex Example", photo: "a", points: [LONG, LONG, LONG], logos: ["b", "b", "b"] },
    { kind: "person", name: "Sam Example", photo: "a", points: [LONG, LONG, LONG], logos: ["b", "b"] },
  ] },
  { key: "table", headline: "SELECT EARLY STAGE ANGEL INVESTMENTS", slots: [
    { kind: "table", columns: ["Company", "Year", "Thesis alignment", "Community", "Notes"], rows: Array.from({ length: 9 }, (_, i) => [{ asset: "b", alt: `Co ${i}` }, "2019", "Consumer / Future of work", "Writers, creators, independent publishers", LONG]) },
  ] },
  { key: "split", layout: "split", headline: "PIPELINE: DEAL A", standfirst: "Winner of one of our pitch competitions", slots: [
    { kind: "image", asset: "a", alt: "", round: true, height: 120 }, { kind: "text", text: LONG }, { kind: "quote", text: `${LONG} ${LONG}`, by: "A. Founder, Example Co" },
  ], right: [{ kind: "text", text: "Founder: background in things" }, { kind: "text", text: "Thesis alignment: Ed tech" }, { kind: "text", text: "Community: Educators" }] },
  { key: "terms", headline: "FUND I TERMS.", slots: [
    { kind: "table", rows: [["Fund size", { bind: "fund_size" }], ["Management fee", { bind: "mgmt_fee_schedule" }], ["Carried interest", { bind: "carry_pct" }], ["Sector focus", { bind: "sectors" }], ["SPVs + direct investment", LONG], ["Structure", "Delaware Limited Partnership"], ["Fund life", "10 years + 2 one-year extensions"]] },
    ...Array.from({ length: 8 }, () => ({ kind: "figure", label: "GP commitment, in dollars", bind: "gp_commit_usd" })),
  ] },
  { key: "many", headline: "A SLIDE WITH FAR TOO MANY POINTS FOR ONE PAGE", standfirst: LONG, slots: Array.from({ length: 30 }, () => ({ kind: "text", text: LONG })) },
];

const BREAK = `<style>.body ul.slots > li{min-height:400px!important}</style>`;

const { chromium } = await import("playwright");
// CI installs the matching browser (ci.yml); a machine with another revision can point at it.
const browser = await chromium.launch(process.env.DECK_FIT_CHROMIUM ? { executablePath: process.env.DECK_FIT_CHROMIUM } : {});
let failed = false;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const check = async (name, slides, broken) => {
    let html = renderDeckHtml(FIGURES, slides, ASSETS).replace(/<link[^>]+fonts\.(?:googleapis|gstatic)[^>]*>/g, "");
    if (broken) html = html.replace("</head>", `${BREAK}</head>`);
    await page.setContent(html, { waitUntil: "load" });
    const pages = await page.evaluate(() => document.querySelectorAll("section.slide").length);
    const over = await page.evaluate(MEASURE_OVERFLOW_JS);
    return { name, pages, over };
  };
  if (selfTest) {
    const r = await check("definition, broken on purpose", DECK_SLIDES, true);
    if (r.over.length === 0) {
      console.error("✗ self-test: a layout forced past the footer was NOT caught — the measurement sees nothing");
      failed = true;
    } else console.log(`✓ self-test: the broken layout was caught (${r.over.length} blocks past the footer)`);
  } else {
    for (const [name, slides, minPages] of [["the deck definition", DECK_SLIDES, DECK_SLIDES.length], ["a preview using every block kind", RICH, RICH.length + 3]]) {
      const r = await check(name, slides, false);
      if (r.pages < minPages) {
        console.error(`✗ ${name}: ${r.pages} pages rendered, expected at least ${minPages} (a long slide must continue, and zero pages is never a pass)`);
        failed = true;
      }
      if (r.over.length) {
        console.error(`✗ ${name}: ${r.over.length} block(s) run off the page:`);
        for (const o of r.over.slice(0, 20)) console.error(`   page ${o.page}: ${o.edge ?? "bottom"} +${o.by}px — "${o.what}"`);
        failed = true;
      } else console.log(`✓ ${name}: ${r.pages} pages, nothing crosses the footer or the right edge`);
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
