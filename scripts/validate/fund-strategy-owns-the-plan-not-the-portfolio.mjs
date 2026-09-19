#!/usr/bin/env node
/**
 * validate:fund-strategy-split — PORTFOLIO OWNS WHAT THE PORTFOLIO IS; FUND STRATEGY OWNS WHERE THE
 * FUND IS GOING (design/FUND_STRATEGY_DESIGN.md §2, approved 19 Sep 2026).
 *
 * The owner: "I don't think we should repeat the same stuff that is on the portfolio page." The
 * audit found `Composition` rendered on both pages and `CockpitPage` — top risks, deteriorating,
 * improving, stale, support asks — mounted under Fund strategy beside Portfolio's four bands that say
 * the same things. The split is a rule, so something must read it: this walks the Fund strategy
 * page's component tree (the page file and every `./pages/*` module it imports, one level down) and
 * fails if any of the monitoring components is mounted there, or if the page draws a deployed slice
 * (`deploymentRingSlices`) — the ring here is the PLAN ring; the deployment ring is Portfolio's, and
 * `validate:portfolio`'s one-ring rule keeps it there.
 *
 * Also held: the dashboard door is the page's ONE `.btn-primary`, on an anchor that opens a new tab
 * with `rel="noreferrer noopener"`; no other file in the tree carries a primary.
 *
 * Hard-fails when it examines zero mounts or zero files. `--self-test` restores the audited page
 * (Composition and the cockpit mounted) and proves it is caught.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PAGES = path.join(ROOT, "src/client/pages");
const PAGE = path.join(PAGES, "FundStrategyPage.tsx");
const APP = path.join(ROOT, "src/client/App.tsx");

const FORBIDDEN_MOUNTS = ["Composition", "PortfolioComposition", "CockpitPage", "PortfolioAllocation", "FollowOnPage", "ModelingPage"];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

/** The page and every ./pages module it imports — the tree the rule governs. */
export function treeOf(pageSrc, readModule) {
  const files = { "FundStrategyPage.tsx": pageSrc };
  for (const m of pageSrc.matchAll(/from "\.\/([A-Za-z0-9_]+)"/g)) {
    const src = readModule(m[1]);
    if (src !== null) files[`${m[1]}.tsx`] = src;
  }
  return files;
}

export function checkSplit(files, appSrc) {
  const violations = [];
  let mounts = 0;
  for (const [name, raw] of Object.entries(files)) {
    const src = stripComments(raw);
    const mounted = [...src.matchAll(/<([A-Z][A-Za-z0-9]*)\b/g)].map((m) => m[1]);
    mounts += mounted.length;
    for (const tag of mounted) {
      if (FORBIDDEN_MOUNTS.includes(tag)) violations.push(`${name} mounts <${tag}> — that is Portfolio's; Fund strategy shows only the distance from the plan`);
    }
    if (/deploymentRingSlices/.test(src)) violations.push(`${name} draws the deployment ring — the ring here is the plan ring; deployed is Portfolio's`);
    if (name !== "DashboardDoor.tsx" && /btn-primary/.test(src)) violations.push(`${name} carries a .btn-primary — the page's one orange control is the dashboard door`);
  }
  const door = files["DashboardDoor.tsx"];
  if (!door) violations.push("the page does not mount the dashboard door");
  else {
    const d = stripComments(door);
    if (!/<a\s[^>]*className="btn-primary btn-lg"/.test(d)) violations.push("the dashboard door is not the page's .btn-primary.btn-lg anchor");
    if (!/rel="noreferrer noopener"/.test(d) || !/target="_blank"/.test(d)) violations.push("the door opens without noreferrer noopener in a new tab");
    if ((d.match(/btn-primary/g) ?? []).length !== 1) violations.push("the door carries more than one primary");
  }
  // App.tsx: the route mounts the page component and nothing of the old stack.
  const app = stripComments(appSrc);
  const at = app.indexOf('active === "fund-strategy"');
  if (at < 0) violations.push("App.tsx does not route fund-strategy");
  else {
    const window = app.slice(Math.max(0, at - 200), at + 300);
    if (!/<FundStrategyPage\b/.test(window)) violations.push("the fund-strategy route does not mount FundStrategyPage");
    for (const tag of FORBIDDEN_MOUNTS) if (new RegExp(`<${tag}\\b`).test(window)) violations.push(`App.tsx mounts <${tag}> on the fund-strategy route`);
  }
  if (/STRATEGY_STEPS|function AllocationPage\b/.test(app)) violations.push("the old Fund strategy stack (STRATEGY_STEPS / AllocationPage) is still in App.tsx");
  return { violations, examined: mounts + Object.keys(files).length };
}

function fail(msg) { console.error(msg); process.exit(1); }

const readModule = (name) => { const p = path.join(PAGES, `${name}.tsx`); return existsSync(p) ? readFileSync(p, "utf8") : null; };

if (process.argv.includes("--self-test")) {
  const say = (ok, what) => { if (!ok) fail(`SELF-TEST FAILED: ${what}`); };
  const real = treeOf(readFileSync(PAGE, "utf8"), readModule);
  const app = readFileSync(APP, "utf8");
  say(checkSplit(real, app).violations.length === 0 && checkSplit(real, app).examined > 10, `the shipped page fails: ${checkSplit(real, app).violations.join("; ")}`);
  // The audited page: the cockpit and the composition bars mounted under Fund strategy, a second primary, the deployment ring.
  const audited = {
    ...real,
    "FundStrategyPage.tsx": real["FundStrategyPage.tsx"].replace("<DashboardDoor", "<CockpitPage me={me} />\n      <PortfolioComposition />\n      <DashboardDoor"),
    "ReservesBand.tsx": real["ReservesBand.tsx"].replace('data-testid="fund-reserves-to-portfolio"', 'className="btn-primary" data-testid="fund-reserves-to-portfolio"').replace("reserveUsd(", "deploymentRingSlices(reserveUsd("),
  };
  const r = checkSplit(audited, app);
  say(r.violations.length >= 4, `the audited page passed: ${r.violations.join("; ")}`);
  const oldApp = app.replace("<FundStrategyPage onNavigate={navigate} />", "<FundStrategyPage onNavigate={navigate} />").replace('active === "fund-strategy" &&', 'active === "fund-strategy" && <CockpitPage me={me.data!} /> &&') + "\nconst STRATEGY_STEPS = [];";
  say(checkSplit(real, oldApp).violations.length >= 2, "an App.tsx mounting the cockpit on the route, with STRATEGY_STEPS back, passed");
  const noDoor = { ...real }; delete noDoor["DashboardDoor.tsx"];
  say(checkSplit(noDoor, app).violations.some((v) => /does not mount the dashboard door/.test(v)), "a page without the door passed");
  say(checkSplit({ "FundStrategyPage.tsx": "export function FundStrategyPage() { return null; }" }, app).examined <= 1, "an empty tree counted as examined");
  console.log("SELF-TEST PASSED: the audited page (cockpit + composition mounted, a second primary, the deployment ring), an App.tsx with the old stack, and a page without the door are each caught; the shipped tree passes.");
} else {
  if (!existsSync(PAGE)) fail("src/client/pages/FundStrategyPage.tsx does not exist");
  const files = treeOf(readFileSync(PAGE, "utf8"), readModule);
  const { violations, examined } = checkSplit(files, readFileSync(APP, "utf8"));
  if (examined < 10) fail(`FUND STRATEGY SPLIT FAILED: examined only ${examined} items — a rule that reads nothing governs nothing`);
  if (violations.length > 0) fail(`FUND STRATEGY SPLIT FAILED (${violations.length}):\n  - ${violations.join("\n  - ")}`);
  console.log(`FUND STRATEGY SPLIT PASSED: ${Object.keys(files).length} files and ${examined - Object.keys(files).length} mounts examined — nothing of Portfolio's is mounted under Fund strategy, no deployed slice is drawn, and the dashboard door is the page's one primary.`);
}
