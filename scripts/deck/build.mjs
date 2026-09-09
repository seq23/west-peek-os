#!/usr/bin/env node
/**
 * Render the LP deck from the fund records, to PDF.
 *
 * WHY A SCRIPT ON HER MAC RATHER THAN THE WORKER. The Worker has a Browser Rendering binding and
 * could do this — but the binding bills per session and the deck is rendered by a human deciding to
 * rebuild it, not on a schedule. Running it here uses the Playwright Chromium the e2e suite already
 * installs, costs nothing, and keeps the render reproducible offline. `recordDeckVersion` in the
 * Worker is what files the result, so the version history is identical either way.
 *
 * EVERY FIGURE COMES FROM PRODUCTION D1. Nothing is passed in on the command line and nothing is
 * typed into a slide — that is the entire point of the exercise, and `tests/deckDefinition.test.ts`
 * fails the build if a bare number appears where a record exists.
 *
 * Usage:
 *   node scripts/deck/build.mjs                    # render to ~/.boss-os/deck/
 *   node scripts/deck/build.mjs --out /tmp/x.pdf
 *   node scripts/deck/build.mjs --local            # read the local D1 instead of production
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : (args[i + 1] ?? true);
};
const LOCAL = args.includes("--local");
const OUT = String(flag("out", join(homedir(), ".boss-os", "deck", `west-peek-fund-i-${new Date().toISOString().slice(0, 10)}-built.pdf`)));

const say = (s) => process.stdout.write(`${s}\n`);
const die = (s) => { process.stderr.write(`\n✗ ${s}\n`); process.exit(1); };

/** One query against D1, returning rows. */
function query(sql) {
  const base = ["d1", "execute", "west-peek-os-db", "--json", "--command", sql];
  const argv = LOCAL ? ["wrangler", ...base, "--local"] : ["wrangler", ...base, "--env", "production", "--remote"];
  const out = execFileSync("npx", argv, { encoding: "utf8", maxBuffer: 1e8 });
  const start = out.indexOf("[");
  if (start === -1) throw new Error(`no JSON in wrangler output: ${out.slice(0, 300)}`);
  return JSON.parse(out.slice(start))[0].results ?? [];
}

const parse = (raw) => { try { return JSON.parse(raw ?? "{}"); } catch { return {}; } };

say("1/4  reading the fund records…");
const fund = query("SELECT id, name FROM fund LIMIT 1")[0];
if (!fund) die("there is no fund, so there is nothing for a deck to be about");

const latest = (table, column) => {
  const rows = query(`SELECT version_no, ${column} AS doc FROM ${table} WHERE fund_id = '${fund.id}' ORDER BY version_no DESC`);
  // Skip a version whose document cannot be read rather than failing the render: these tables are
  // append-only, so a bad row is corrected by a later one and must not block every future deck.
  for (const row of rows) {
    try { return { version: row.version_no, doc: JSON.parse(row.doc) }; } catch { /* next */ }
  }
  return { version: null, doc: {} };
};

const mandate = latest("investment_mandate_version", "mandate_json");
const sleeve = latest("sleeve_policy_version", "sleeve_json");
const reserve = latest("reserve_policy_version", "reserve_json");

/*
 * THE SHARED MODULES, BUNDLED RATHER THAN REIMPLEMENTED.
 *
 * Node cannot import TypeScript directly, and the obvious workaround — copying the arithmetic into
 * this script — would create a SECOND implementation of the sleeve maths that can disagree with the
 * app's. That is precisely the defect the whole deck exercise exists to remove, so it is not
 * available as a shortcut. esbuild ships with vite, which is already a dependency, so one bundle
 * step keeps exactly one copy of the maths and one copy of the renderer.
 */
const bundlePath = join(tmpdir(), `wp-deck-${process.pid}.mjs`);
execFileSync("npx", ["esbuild",
  "src/shared/deck/render.ts",
  "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const shared = await import(pathToFileURL(bundlePath).href);
const { renderDeckHtml } = shared;

const mathBundle = join(tmpdir(), `wp-math-${process.pid}.mjs`);
execFileSync("npx", ["esbuild",
  "src/shared/fund/sleeveMath.ts",
  "--bundle", "--format=esm", "--platform=node", `--outfile=${mathBundle}`,
], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const { initialCapitalUsd, investableBase, reserveUsd, sleeveTargetUsd } =
  await import(pathToFileURL(mathBundle).href);

const early = (sleeve.doc.sleeves ?? []).find((s) => s.key === "EARLY_STAGE_PRIMARY") ?? null;
const secondary = (sleeve.doc.sleeves ?? []).find((s) => s.key === "SECONDARY_PURCHASE") ?? null;

// The community claim, measured. WITH its denominator — a share of four is a signal, not a statistic.
const origins = query("SELECT relationship_origin AS o, COUNT(*) AS n FROM investment_opportunity GROUP BY relationship_origin");
const totalOpps = origins.reduce((sum, r) => sum + Number(r.n), 0);
const community = origins.filter((r) => r.o === "COMMUNITY_INTRO").reduce((sum, r) => sum + Number(r.n), 0);
const positions = Number(query("SELECT COUNT(*) AS n FROM position")[0]?.n ?? 0);

const figures = {
  fund_size: mandate.doc.target_size_usd ?? null,
  fees: sleeve.doc.estimated_fees_usd ?? null,
  expenses: sleeve.doc.estimated_expenses_usd ?? null,
  investable_base: investableBase(sleeve.doc) || null,
  early_sleeve_usd: early ? sleeveTargetUsd(sleeve.doc, early) : null,
  early_sleeve_pct: early?.target_pct ?? null,
  secondary_sleeve_usd: secondary ? sleeveTargetUsd(sleeve.doc, secondary) : null,
  secondary_sleeve_pct: secondary?.target_pct ?? null,
  reserve_pct: reserve.doc.reserve_pct ?? null,
  /*
   * READ FROM THE MANDATE, NOT BACK-DERIVED FROM THE FEE TOTAL — and the first draft got this
   * wrong in a way worth recording. It computed the rate as fees ÷ fund size ÷ 10 years, which
   * printed "1.67%" on the Terms slide against a mandate that plainly stores 2. Reading the
   * rendered PDF is what caught it.
   *
   * The 1.67% was not a rendering bug: it is the honest consequence of the sleeve policy storing
   * $5M of fees when 2% of $30M over a ten-year life is $6M. That is a SEVENTH inconsistency, of
   * exactly the family this exercise exists to remove, and it is now reported to the register
   * rather than hidden by a derived percentage that quietly agreed with the wrong total.
   */
  mgmt_fee_pct: mandate.doc.management_fee_pct ?? null,
  carry_pct: mandate.doc.carried_interest_pct ?? null,
  reserve_usd: reserveUsd(sleeve.doc, reserve.doc) || null,
  initial_capital_usd: initialCapitalUsd(sleeve.doc, reserve.doc) || null,
  target_positions: mandate.doc.target_positions ?? null,
  check_min: mandate.doc.check_size_usd?.min ?? null,
  check_max: mandate.doc.check_size_usd?.max ?? null,
  sectors: mandate.doc.sectors ?? [],
  community_sourced: totalOpps > 0 ? { through_community: community, total: totalOpps } : null,
  positions_held: positions,
  as_of_date: new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
};

say(`     mandate v${mandate.version} · sleeve v${sleeve.version} · reserve v${reserve.version}`);
for (const [k, v] of Object.entries(figures)) {
  if (v === null || (Array.isArray(v) && v.length === 0)) say(`     ! ${k} is not recorded — the slide will say so rather than print a zero`);
}

/*
 * THE FEE TOTAL AND THE FEE RATE MUST AGREE, and today they do not.
 *
 * The mandate states 2%; the sleeve policy stores $5M of estimated fees. Over a ten-year life 2% of
 * $30M is $6M. Both numbers are on the Terms slide and the construction slide of the same document,
 * so an allocator checking the arithmetic finds the gap before she does. Reported here rather than
 * silently reconciled, because reconciling it would be choosing a figure nobody has decided.
 */
if (figures.mgmt_fee_pct && figures.fund_size && figures.fees) {
  const impliedTenYear = figures.fund_size * (figures.mgmt_fee_pct / 100) * 10;
  if (Math.abs(impliedTenYear - figures.fees) >= 1) {
    say("");
    say(`     ⚠ FEE INCONSISTENCY — the mandate states ${figures.mgmt_fee_pct}% and the sleeve stores`);
    say(`       $${(figures.fees / 1e6).toFixed(1)}M of fees, but ${figures.mgmt_fee_pct}% of $${(figures.fund_size / 1e6).toFixed(0)}M over ten years is`);
    say(`       $${(impliedTenYear / 1e6).toFixed(1)}M. Both appear in this deck. Settle it in the construction editor.`);
    say("");
  }
}

say("2/4  rendering the HTML…");
const html = renderDeckHtml(figures);
const htmlPath = OUT.replace(/\.pdf$/i, ".html");
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(htmlPath, html, "utf8");
say(`     ${htmlPath}`);

say("3/4  printing to PDF…");
const { chromium } = await import("playwright");
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.setContent(html, { waitUntil: "networkidle" });
  // Web fonts must have arrived before the page is printed, or the PDF carries the fallback.
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({
    path: OUT,
    width: "13.333in",
    height: "7.5in",
    printBackground: true,
    margin: { top: "0", right: "0", bottom: "0", left: "0" },
  });
} finally {
  await browser.close();
}

say("4/4  verifying the PDF…");
const { readFileSync } = await import("node:fs");
const bytes = readFileSync(OUT);
const pages = (bytes.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
if (pages === 0) die("the PDF has no pages");
say(`     ${OUT}`);
say(`     ${pages} pages · ${(bytes.length / 1024).toFixed(0)} KB`);
say("\n✓ built from records:");
say(`     fund ${figures.fund_size} · investable ${figures.investable_base}`);
say(`     early ${figures.early_sleeve_usd} (${figures.early_sleeve_pct}%) · secondaries ${figures.secondary_sleeve_usd} (${figures.secondary_sleeve_pct}%)`);
say(`     reserves ${figures.reserve_usd} · for initials ${figures.initial_capital_usd}`);
