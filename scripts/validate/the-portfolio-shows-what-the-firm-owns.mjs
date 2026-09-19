#!/usr/bin/env node
/**
 * the-portfolio-shows-what-the-firm-owns.mjs — `npm run validate:portfolio`.
 *
 * ONE ASSERTION: THE PORTFOLIO PAGE AND THE FUND STRATEGY PAGE DESCRIBE THE SAME PORTFOLIO, AND A
 * COMPANY THE FIRM INVESTED IN CANNOT FALL OUT OF IT.
 *
 * WHAT WENT WRONG, 18 Sep 2026. Production held one CLOSED investment — Sensori, a $10K SPV,
 * backfilled because it closed before Fund I existed — and zero `position` rows, because a position
 * is booked only by executing a transaction and a pre-fund SPV never walked that ladder. Portfolio's
 * "What we own" read `position` alone and said "The fund holds nothing yet"; Fund strategy's
 * composition bars read CLOSED opportunities and drew Sensori at 100%. The Portfolio page's own
 * header comment RECORDED the disagreement — as the reason the bars had been removed from it. A
 * rule written in prose governs nothing until something fails when it is broken.
 *
 * WHAT IS CHECKED, over code with comments stripped (a sentence must never satisfy a scan):
 *   1 · ONE LIST. `services/portfolioHoldings.ts` reads BOTH closed opportunities and open
 *       positions, and its closed-opportunity SELECT never joins `position` — the join is exactly
 *       how the unbooked company would be dropped again. Composition and the allocation view in
 *       that file are computed from `portfolioHoldings(`, and no other worker file defines a
 *       composition handler.
 *   2 · ONE ROUTE BLOCK. `index.ts` carries a contiguous `// === Phase Portfolio ===` block holding
 *       `/api/portfolio/holdings`, `/composition` and `/allocation`, and none of the three is
 *       routed anywhere else.
 *   3 · THE PAGE READS THE LIST. `PortfolioPage.tsx` fetches `/api/portfolio/holdings`, renders
 *       its `holdings-list` from that response, and hosts `<Composition />` and
 *       `<PortfolioAllocation`.
 *   4 · ONE RING. Exactly one file under `src/client` draws the ring (`strokeDasharray`), it is
 *       `AllocationRing.tsx`, and both hosts import it. The operator asked for the graphs on both
 *       pages; the obvious move was to copy the SVG, and two copies drift.
 *   5 · ONE ARITHMETIC. `planSlices(` is defined once, in `@shared/fund/allocation`, and called by
 *       both `FundAllocation.tsx` (Fund strategy) and `portfolioHoldings.ts` (Portfolio). No page
 *       computes `− fees − secondaries − reserves` on its own.
 *   6 · TOKENS ONLY. Every slice colour in `allocation.ts` is a `var(--…)` token; the brand scan
 *       covers `src/client` and this file lives in `src/shared`.
 *   7 · THE TEST IS REAL. `tests/portfolioHoldings.test.ts` exists, hard-fails when its fixture
 *       holds no closed-but-unbooked investment (`toBeGreaterThan(0)`), exercises all three
 *       routes, diffs `planSlices` against the server, and excuses nothing (`.skip`, `.only`,
 *       `.todo`).
 *   8 · HARD-FAILS ON ZERO. A missing anchor file, an empty route block, or a scan that examined
 *       no rule at all exits 1 rather than reporting a clean board.
 *
 * `--self-test` mutates the REAL shipped sources into each failure this exists to catch and
 * requires every one to be caught, alongside the shipped versions, which must pass.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const FILES = {
  service: "src/worker/services/portfolioHoldings.ts",
  index: "src/worker/index.ts",
  page: "src/client/pages/PortfolioPage.tsx",
  ring: "src/client/pages/AllocationRing.tsx",
  // Fund strategy's ring host moved to the construction band on 19 Sep 2026 (design/FUND_STRATEGY_DESIGN.md §3.3).
  fundAllocation: "src/client/pages/FundConstruction.tsx",
  portfolioAllocation: "src/client/pages/PortfolioAllocation.tsx",
  shared: "src/shared/fund/allocation.ts",
  test: "tests/portfolioHoldings.test.ts",
};

const ROUTES = ["/api/portfolio/holdings", "/api/portfolio/composition", "/api/portfolio/allocation"];

function read(rel) {
  return stripTsComments(readFileSync(path.join(ROOT, rel), "utf8"));
}

/** Every `.ts`/`.tsx` under a directory, relative paths. */
function walk(dir) {
  const out = [];
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walk(rel));
    else if (/\.tsx?$/.test(entry.name)) out.push({ rel, text: read(rel) });
  }
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

/** Rule 1 — one list, read from both facts, never joined away. `sources` is {rel: strippedText}. */
export function checkOneList(service, workerFiles) {
  const bad = [];
  if (!/export async function portfolioHoldings\s*\(/.test(service)) {
    bad.push("portfolioHoldings.ts no longer exports `portfolioHoldings(` — the one list is gone");
  }
  const closedSelect = service.match(/FROM investment_opportunity o[\s\S]*?\.all</);
  if (!closedSelect) {
    bad.push("portfolioHoldings.ts does not read `FROM investment_opportunity` — closed investments would vanish");
  } else {
    if (!/o\.status = 'CLOSED'/.test(closedSelect[0])) bad.push("the closed-opportunity SELECT no longer filters `o.status = 'CLOSED'`");
    if (/JOIN\s+position\b/i.test(closedSelect[0])) {
      bad.push("the closed-opportunity SELECT joins `position` — that is exactly how the unbooked company disappears");
    }
  }
  if (!/FROM position p\b/.test(service)) bad.push("portfolioHoldings.ts does not read `FROM position` — booked holdings would vanish");

  for (const handler of ["handlePortfolioComposition", "handlePortfolioAllocation", "handlePortfolioHoldings"]) {
    const body = service.match(new RegExp(`export async function ${handler}\\s*\\([\\s\\S]*?\\n}\\n`));
    if (!body) bad.push(`portfolioHoldings.ts does not define \`${handler}\``);
    else if (!/portfolioHoldings\s*\(/.test(body[0])) bad.push(`\`${handler}\` does not read \`portfolioHoldings(\` — a second portfolio`);
  }

  for (const f of workerFiles) {
    if (f.rel === FILES.service) continue;
    if (/function handlePortfolioComposition\b/.test(f.text)) bad.push(`${f.rel} defines a second composition handler`);
  }
  return bad;
}

/**
 * Rule 2 — one contiguous route block, and the three routes live only there.
 *
 * `indexRaw` is index.ts UNSTRIPPED, and the one reader of this file that is: the block marker
 * `// === Phase Portfolio ===` IS a comment, by the coordinator's convention for this branch, so it
 * has to be found in the raw text. DELIBERATELY DOES NOT STRIP COMMENTS for that one lookup. Every
 * route check below runs over the stripped text, so a sentence naming a route can neither satisfy
 * nor block the scan.
 */
export function checkRouteBlock(indexRaw) {
  const bad = [];
  const start = indexRaw.indexOf("// === Phase Portfolio ===");
  if (start < 0) {
    bad.push("index.ts has no `// === Phase Portfolio ===` block");
    return { bad, routes: 0 };
  }
  const rest = indexRaw.slice(start);
  const end = rest.search(/\n\s*\/\/ === Phase |\n\s*;|\);\n/);
  const block = stripTsComments(end < 0 ? rest : rest.slice(0, end + 3));
  const outsideBlock = stripTsComments(indexRaw.slice(0, start) + (end < 0 ? "" : rest.slice(end + 3)));
  let routes = 0;
  for (const r of ROUTES) {
    if (!block.includes(`"${r}"`)) bad.push(`${r} is not routed inside the Phase Portfolio block`);
    else routes += 1;
    if (outsideBlock.includes(`"${r}"`)) bad.push(`${r} is routed somewhere outside the Phase Portfolio block as well`);
  }
  return { bad, routes };
}

/** Rule 3 — the page reads the list and hosts the two drawings. */
export function checkPage(page) {
  const bad = [];
  if (!page.includes('"/api/portfolio/holdings"')) bad.push("PortfolioPage.tsx does not fetch /api/portfolio/holdings");
  const list = page.match(/data-testid="holdings-list"[\s\S]*?<\/ul>/);
  if (!list) bad.push("PortfolioPage.tsx has no `holdings-list`");
  else if (!/own\?\.holdings\s*\?\?\s*\[\]\)\.map\(/.test(list[0])) {
    bad.push("the `holdings-list` is not rendered from the holdings response — it would read positions alone again");
  }
  // `<Composition />` or `<Composition level="h4" />` — hosted either way; a prop is not a second drawing.
  if (!/<Composition\b[^>]*\/>/.test(page)) bad.push("PortfolioPage.tsx does not host <Composition />");
  if (!/<PortfolioAllocation\b/.test(page)) bad.push("PortfolioPage.tsx does not host <PortfolioAllocation");
  return bad;
}

/** Rule 4 — one ring, two hosts. */
export function checkOneRing(clientFiles) {
  const bad = [];
  const drawers = clientFiles.filter((f) => /strokeDasharray/.test(f.text)).map((f) => f.rel);
  if (drawers.length === 0) bad.push("no file under src/client draws the ring at all");
  for (const d of drawers) {
    if (d !== FILES.ring) bad.push(`${d} draws its own ring (strokeDasharray) — the ring is AllocationRing.tsx, once`);
  }
  for (const host of [FILES.fundAllocation, FILES.portfolioAllocation]) {
    const f = clientFiles.find((x) => x.rel === host);
    if (!f) bad.push(`${host} is missing`);
    else if (!/import \{[^}]*\bAllocationRing\b[^}]*\} from "\.\/AllocationRing"/.test(f.text)) {
      bad.push(`${host} does not import AllocationRing — it is not hosting the shared ring`);
    }
  }
  return bad;
}

/** Rule 5 — one arithmetic, two callers. */
export function checkOneArithmetic(shared, fundAllocation, service, allFiles) {
  const bad = [];
  if (!/export function planSlices\s*\(/.test(shared)) bad.push("allocation.ts no longer defines `planSlices(`");
  for (const [rel, text] of [[FILES.fundAllocation, fundAllocation], [FILES.service, service]]) {
    if (!/\bplanSlices\s*\(/.test(text)) bad.push(`${rel} does not call planSlices( — it is computing (or not drawing) its own split`);
  }
  for (const f of allFiles) {
    if (f.rel === FILES.shared) continue;
    if (/-\s*fees\s*-\s*secondaries\s*-\s*reserves/.test(f.text) || /function planSlices\s*\(/.test(f.text)) {
      bad.push(`${f.rel} computes the fund split on its own instead of calling planSlices(`);
    }
  }
  return bad;
}

/** Rule 6 — tokens only. */
export function checkTokens(shared) {
  const bad = [];
  const colours = [...shared.matchAll(/color:\s*"([^"]*)"/g)].map((m) => m[1]);
  if (colours.length === 0) bad.push("allocation.ts declares no slice colours — the rings would be uncoloured");
  for (const c of colours) {
    if (!/^var\(--[a-z0-9-]+\)$/.test(c)) bad.push(`allocation.ts slice colour "${c}" is not a token`);
  }
  if (/#[0-9a-fA-F]{3,8}\b/.test(shared)) bad.push("allocation.ts carries a literal hex colour");
  return bad;
}

/** Rule 7 — the test is real. */
export function checkTest(test) {
  const bad = [];
  if (!/toBeGreaterThan\(0\)/.test(test)) bad.push("the test no longer hard-fails on a fixture with zero closed investments");
  for (const r of ROUTES) if (!test.includes(r)) bad.push(`the test never calls ${r}`);
  if (!/\bplanSlices\s*\(/.test(test)) bad.push("the test no longer diffs planSlices against the server's allocation");
  if (/\b(?:it|describe|test)\.(?:skip|only|todo)\s*\(/.test(test)) bad.push("the test excuses itself with .skip/.only/.todo");
  if (!/expect\(/.test(test)) bad.push("the test asserts nothing");
  return bad;
}

function selfTest() {
  const failures = [];
  const expectCaught = (label, bad) => {
    if (bad.length === 0) failures.push(`NOT CAUGHT: ${label}`);
  };
  const expectClean = (label, bad) => {
    if (bad.length > 0) failures.push(`FALSE POSITIVE on ${label}: ${bad.join(" / ")}`);
  };

  const service = read(FILES.service);
  const indexRaw = readFileSync(path.join(ROOT, FILES.index), "utf8");
  const page = read(FILES.page);
  const shared = read(FILES.shared);
  const fundAllocation = read(FILES.fundAllocation);
  const test = read(FILES.test);
  const clientFiles = walk("src/client");
  const workerFiles = walk("src/worker");

  // Shipped sources pass.
  expectClean("shipped one-list", checkOneList(service, workerFiles));
  expectClean("shipped route block", checkRouteBlock(indexRaw).bad);
  expectClean("shipped page", checkPage(page));
  expectClean("shipped ring", checkOneRing(clientFiles));
  expectClean("shipped arithmetic", checkOneArithmetic(shared, fundAllocation, service, [...clientFiles, ...workerFiles]));
  expectClean("shipped tokens", checkTokens(shared));
  expectClean("shipped test", checkTest(test));

  // Rule 1 — the exact regression: join the closed SELECT to position.
  expectCaught(
    "closed opportunities joined to position",
    checkOneList(service.replace("JOIN canonical_company c ON c.id = o.company_id", "JOIN canonical_company c ON c.id = o.company_id\n JOIN position px ON px.company_id = o.company_id"), workerFiles),
  );
  expectCaught("closed filter removed", checkOneList(service.replace("o.status = 'CLOSED'", "o.status = 'PASS'"), workerFiles));
  expectCaught("composition computing its own portfolio", checkOneList(service.replace(/const holdings = await portfolioHoldings\(ctx\.env, ctx\.identity!\);\n\n  let provisional/, "const holdings = [];\n\n  let provisional"), workerFiles));
  expectCaught("a second composition handler", checkOneList(service, [...workerFiles, { rel: "src/worker/services/investment.ts", text: "export async function handlePortfolioComposition(ctx) {}" }]));
  expectCaught("positions not read", checkOneList(service.replace("FROM position p", "FROM position_x p"), workerFiles));

  // Rule 2
  expectCaught("no route block", checkRouteBlock(indexRaw.replace("// === Phase Portfolio ===", "// === Phase Elsewhere ===")).bad);
  expectCaught("a route missing from the block", checkRouteBlock(indexRaw.replace('.get("/api/portfolio/holdings", handlePortfolioHoldings)\n', "")).bad);
  expectCaught(
    "a route duplicated outside the block",
    checkRouteBlock(indexRaw.replace('.get("/api/dealflow/board", handleDealflowBoard)', '.get("/api/dealflow/board", handleDealflowBoard)\n  .get("/api/portfolio/composition", handlePortfolioComposition)')).bad,
  );

  // Rule 3 — the page reading positions alone again.
  expectCaught("page not fetching holdings", checkPage(page.replace('"/api/portfolio/holdings"', '"/api/portfolio/positions"')));
  expectCaught("list rendered from positions", checkPage(page.replace("(own?.holdings ?? []).map(", "(p?.holdings ?? []).map(")));
  expectCaught("composition not hosted", checkPage(page.replace(/<Composition\b[^>]*\/>/, "")));
  expectCaught("allocation not hosted", checkPage(page.replace(/<PortfolioAllocation\b/, "<PortfolioNothing")));

  // Rule 4 — a copied ring.
  expectCaught("a second ring", checkOneRing([...clientFiles, { rel: "src/client/pages/Copy.tsx", text: '<circle strokeDasharray="1 2" />' }]));
  expectCaught("Fund strategy not importing the ring", checkOneRing(clientFiles.map((f) => (f.rel === FILES.fundAllocation ? { ...f, text: f.text.replace('from "./AllocationRing"', 'from "./Elsewhere"') } : f))));
  expectCaught("no ring at all", checkOneRing(clientFiles.filter((f) => f.rel !== FILES.ring)));

  // Rule 5 — inline arithmetic back on a page.
  const all = [...clientFiles, ...workerFiles];
  expectCaught("Fund strategy computing its own split", checkOneArithmetic(shared, fundAllocation.replace(/planSlices\(/g, "mine("), service, all));
  expectCaught("a page with the subtraction inline", checkOneArithmetic(shared, fundAllocation, service, [...all, { rel: "src/client/pages/X.tsx", text: "const initial = fundSize - fees - secondaries - reserves;" }]));
  expectCaught("planSlices gone from shared", checkOneArithmetic(shared.replace("export function planSlices(", "export function planSlicez("), fundAllocation, service, all));

  // Rule 6 — a colour that is not a token.
  expectCaught("a hex colour", checkTokens(shared.replace('color: "var(--viz-1)"', 'color: "#f05a1a"')));
  expectCaught("a bare colour word", checkTokens(shared.replace('color: "var(--viz-2)"', 'color: "teal"')));

  // Rule 7 — a test that excuses itself or examines nothing.
  expectCaught("zero-fixture guard removed", checkTest(test.replace("toBeGreaterThan(0)", "toBeGreaterThanOrEqual(0)")));
  expectCaught("a skipped test", checkTest(test.replace("it(\"hard-fails", "it.skip(\"hard-fails")));
  expectCaught("allocation route never called", checkTest(test.replace(/\/api\/portfolio\/allocation/g, "/api/portfolio/nothing")));
  expectCaught("planSlices no longer diffed", checkTest(test.replace(/planSlices\(/g, "other(")));

  if (failures.length > 0) {
    console.error("THE-PORTFOLIO-SHOWS-WHAT-THE-FIRM-OWNS SELF-TEST FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("the-portfolio-shows-what-the-firm-owns: self-test passed (7 shipped-clean, 24 caught).");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  for (const rel of Object.values(FILES)) {
    if (!existsSync(path.join(ROOT, rel))) {
      console.error(`THE-PORTFOLIO-SHOWS-WHAT-THE-FIRM-OWNS SCAN FAILED — ${rel} is missing. Rule 0: this scan found nothing to check.`);
      process.exit(1);
    }
  }

  const service = read(FILES.service);
  const indexRaw = readFileSync(path.join(ROOT, FILES.index), "utf8");
  const page = read(FILES.page);
  const shared = read(FILES.shared);
  const fundAllocation = read(FILES.fundAllocation);
  const test = read(FILES.test);
  const clientFiles = walk("src/client");
  const workerFiles = walk("src/worker");
  if (clientFiles.length === 0 || workerFiles.length === 0) {
    console.error("THE-PORTFOLIO-SHOWS-WHAT-THE-FIRM-OWNS SCAN FAILED — read no client or worker files. Rule 0.");
    process.exit(1);
  }

  const bad = [];
  bad.push(...checkOneList(service, workerFiles));
  const routes = checkRouteBlock(indexRaw);
  bad.push(...routes.bad);
  if (routes.routes === 0) {
    console.error("THE-PORTFOLIO-SHOWS-WHAT-THE-FIRM-OWNS SCAN FAILED — the Phase Portfolio block routes nothing. Rule 0.");
    process.exit(1);
  }
  bad.push(...checkPage(page));
  bad.push(...checkOneRing(clientFiles));
  bad.push(...checkOneArithmetic(shared, fundAllocation, service, [...clientFiles, ...workerFiles]));
  bad.push(...checkTokens(shared));
  bad.push(...checkTest(test));

  if (bad.length > 0) {
    console.error("THE-PORTFOLIO-SHOWS-WHAT-THE-FIRM-OWNS SCAN FAILED — Portfolio and Fund strategy could describe different portfolios:");
    for (const b of bad) console.error(`  ✗ ${b}`);
    console.error(
      "\nOn 18 Sep 2026 Portfolio said the fund held nothing while Fund strategy drew the firm's one investment at\n" +
        "100%, and the page's own comment recorded the disagreement instead of fixing it. One list, one ring, one\n" +
        "arithmetic; both pages read them.",
    );
    process.exit(1);
  }
  console.log(
    `the-portfolio-shows-what-the-firm-owns: ${routes.routes} routes in one block · one list read by 3 handlers · ` +
      `one ring in ${clientFiles.filter((f) => /strokeDasharray/.test(f.text)).length} file with 2 hosts · planSlices called from both pages · ${
        [...shared.matchAll(/color:\s*"var\(/g)].length
      } token colours · test guarded.`,
  );
}

main();
