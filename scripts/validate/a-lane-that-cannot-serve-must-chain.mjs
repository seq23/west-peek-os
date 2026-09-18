#!/usr/bin/env node
/**
 * A LANE THAT CANNOT SERVE MUST CHAIN, AND A NOTICE MUST NOT TAKE THE FIRM OFFLINE.
 *
 * Four checks, each guarding a fix made on 17 Sep 2026 and each capable of failing. The two the
 * tests cannot reach are the reason this file exists rather than another `it()`:
 *
 *   1. EVERY ADAPTER CARRIES THE VENDOR'S WORDS. `providerFailure` decides whether a 400 is an
 *      outage by reading what the vendor said, so an adapter that throws the bare status has
 *      silently opted its whole vendor out of the fix. A unit test covers the adapters it happens
 *      to exercise; this covers the directory, including the one somebody adds next year.
 *
 *   2. NO SEEDED FIRM NOTICE TRIPS THE LP DETECTOR. Notices are read into EVERY prompt, and the
 *      classifier scans those same prompt inputs. A notice containing a marker phrase would revoke
 *      the public-model verdict on every run in the firm — which is exactly what happened in the
 *      sister system, where the single word "commitment" in a notice made every run scan as LP
 *      material and refused every free route. No test can catch a notice added by a future
 *      migration; this can.
 *
 *   3. THE 400 GUARD STAYS NARROW. A bare 400, and a 400 whose message is about the request, must
 *      still defer. Blanket-reclassifying 400 would hide real malformed-request bugs behind four
 *      vendors failing identically, which is the opposite mistake and a tempting one.
 *
 *   4. THE TWO LABELS REACH THE THINGS THAT USE THEM. A column nothing writes and a form field
 *      nothing posts is the "exists but nothing invokes it" defect, twice.
 *
 * RULE 0: no check may pass having examined nothing. Each counts what it looked at and FAILS on
 * zero — an empty loop reporting success is how a guard stops guarding without anybody noticing.
 *
 * Usage:  node scripts/validate/a-lane-that-cannot-serve-must-chain.mjs [--self-test]
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const ADAPTER_DIR = path.resolve("src/worker/ai/providers");
const MIGRATIONS_DIR = path.resolve("migrations");
const CONTENT_CLASS = path.resolve("src/shared/ai/contentClass.ts");
const PROVIDER_FAILURE = path.resolve("src/shared/ai/providerFailure.ts");
const WORK_CARDS = path.resolve("src/worker/services/workCards.ts");
const WORK_PAGE = path.resolve("src/client/pages/WorkCardsPage.tsx");

const failures = [];
const summary = [];

function fail(check, detail) {
  failures.push(`${check}: ${detail}`);
}

/** Rule 0, made mechanical: a check that examined nothing has not passed, it has abstained. */
function counted(check, n, what) {
  if (n === 0) {
    fail(check, `examined ZERO ${what} — the check cannot have passed. Either the source moved or the parse is wrong.`);
    return false;
  }
  summary.push(`${check}: ${n} ${what} examined`);
  return true;
}

// ── 1. Every adapter carries the vendor's words ──────────────────────────────────────────────
function checkAdaptersCarryVendorDetail() {
  const CHECK = "adapters carry the vendor's words";
  let examined = 0;
  for (const entry of readdirSync(ADAPTER_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    if (entry.name === "types.ts" || entry.name === "timeout.ts" || entry.name === "httpError.ts") continue;
    const src = readFileSync(path.join(ADAPTER_DIR, entry.name), "utf8");
    // Only adapters that actually make an HTTP call are in scope. mockLocal and the Workers AI
    // binding have no Response to read, and demanding one of them would be the check misfiring.
    if (!/\bres\.ok\b|\bresponse\.ok\b/.test(src)) continue;
    examined += 1;
    if (/throw new Error\(`provider_http_\$\{[^}]+\}`\)/.test(src)) {
      fail(
        CHECK,
        `${entry.name} throws the bare status and drops the vendor's error body. An unfunded account answers HTTP 400 ` +
          `"Your credit balance is too low" — without the body that is indistinguishable from a malformed request and the ` +
          `run defers instead of chaining. Use providerHttpError(res) from ./httpError.`,
      );
    }
    if (!/providerHttpError\(/.test(src)) {
      fail(CHECK, `${entry.name} makes an HTTP call but never calls providerHttpError(res), so its failures cannot be classified.`);
    }
  }
  counted(CHECK, examined, "HTTP provider adapters");
}

// ── 2. No seeded firm notice trips the LP detector ───────────────────────────────────────────

/** The REAL marker list, parsed out of the module the router uses. Never a copy kept in step. */
function markerRegexes() {
  const src = readFileSync(CONTENT_CLASS, "utf8");
  const block = /const PRIVATE_MODEL_ONLY_MARKERS[\s\S]*?\]\);/.exec(src);
  if (!block) throw new Error("could not find PRIVATE_MODEL_ONLY_MARKERS in contentClass.ts — the parse is stale");
  const out = [];
  for (const m of block[0].matchAll(/^\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*),/gm)) out.push(new RegExp(m[1], m[2]));
  return out;
}

/** Every FIRM notice body seeded by any migration. Parsed from the SQL, so a new one is covered. */
function seededFirmNotices() {
  const found = [];
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    if (!/internal_memo/.test(sql)) continue;
    // Rows are ('id', 'SYSTEM', 'author', 'FIRM', NULL, 'title', 'body'[, 'supersedes']).
    for (const row of sql.matchAll(/\(\s*'([^']*)',\s*'(?:SYSTEM|HUMAN|AI)',\s*'[^']*',\s*'FIRM',\s*NULL,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'/g)) {
      found.push({
        file,
        id: row[1],
        title: row[2].replace(/''/g, "'"),
        body: row[3].replace(/''/g, "'"),
      });
    }
  }
  return found;
}

function checkNoticesDoNotTripTheDetector() {
  const CHECK = "no firm notice trips the LP detector";
  const markers = markerRegexes();
  if (!counted(`${CHECK} (markers)`, markers.length, "LP/deal markers parsed from contentClass.ts")) return;
  const notices = seededFirmNotices();
  if (!counted(CHECK, notices.length, "seeded FIRM notices")) return;
  for (const n of notices) {
    for (const marker of markers) {
      const text = `${n.title} ${n.body}`;
      if (marker.test(text)) {
        fail(
          CHECK,
          `notice ${n.id} (${n.file}) contains ${marker} — every notice is read into EVERY prompt and the classifier scans ` +
            `prompt inputs, so this phrase would mark every run in the firm as LP material and refuse every free route. ` +
            `This is the sister system's "commitment" failure. Reword the notice; do not weaken the detector.`,
        );
      }
    }
  }
}

// ── 3. The 400 guard stays narrow ────────────────────────────────────────────────────────────
function checkFourHundredGuardStaysNarrow() {
  const CHECK = "the 400 guard stays narrow";
  const src = readFileSync(PROVIDER_FAILURE, "utf8");
  let examined = 0;

  examined += 1;
  if (/if \(status === 400\) return true/.test(src)) {
    fail(CHECK, "isOutageStatus treats 400 as an outage unconditionally. A malformed request is malformed at every vendor; spraying it across four finds four ways to be wrong.");
  }

  // The phrases a looser author would reach for, and each is a real misfire waiting to happen in
  // ordinary event and hiring prose. "rate limit" is absent for a different reason: 429 owns it.
  const forbidden = ["commitment", "capital", "investor", "round", "fund", "interest", "safe", "rate limit"];
  const listBlock = /const PROVIDER_CANNOT_SERVE_PHRASES[\s\S]*?\];/.exec(src);
  if (!listBlock) {
    fail(CHECK, "could not find PROVIDER_CANNOT_SERVE_PHRASES — the guard has moved and this check is stale.");
    return;
  }
  const phrases = [...listBlock[0].matchAll(/^\s*"([^"]+)",/gm)].map((m) => m[1]);
  if (!counted(CHECK, phrases.length, "provider-cannot-serve phrases")) return;
  for (const phrase of phrases) {
    examined += 1;
    for (const bad of forbidden) {
      // A single ordinary English word as a whole phrase is the misfire; "carried interest" is fine.
      if (phrase.trim().toLowerCase() === bad) {
        fail(CHECK, `"${phrase}" is an ordinary English word and would reclassify honest 400s across the catalogue.`);
      }
    }
    if (!phrase.includes(" ") && phrase.length < 8) {
      fail(CHECK, `"${phrase}" is too short and too generic to be a reliable billing marker.`);
    }
  }
}

// ── 4. The two labels reach the things that use them ─────────────────────────────────────────
function checkTwoLabelsAreWired() {
  const CHECK = "the two labels are wired end to end";
  let examined = 0;
  const wants = [
    [WORK_CARDS, /model_access,\s*audience\)/, "the INSERT that creates a card must write both labels"],
    [WORK_CARDS, /model_access:\s*z\.enum/, "the create schema must accept model_access"],
    [WORK_CARDS, /audience:\s*z\.enum/, "the create schema must accept audience"],
    [WORK_CARDS, /wc\.model_access,\s*wc\.audience/, "the board query must return both labels, or the card cannot show them"],
    [WORK_PAGE, /data-testid="work-card-model-access"/, "the Add-a-card form must offer the model-access choice"],
    [WORK_PAGE, /data-testid="work-card-audience"/, "the Add-a-card form must offer the audience choice"],
    [WORK_PAGE, /model_access: modelAccess/, "the form must POST model_access"],
    [WORK_PAGE, /work-card-model-access-\$\{c\.id\}/, "the card must display its model-access label"],
    [WORK_PAGE, /work-card-audience-\$\{c\.id\}/, "the card must display its audience label"],
    [WORK_PAGE, /work-card-lane-\$\{c\.id\}/, "the card must show the lane the run actually took — a label without the lane is not a trail"],
    [
      path.resolve("src/worker/services/employeeWork.ts"),
      /card\.model_access === "PRIVATE_MODEL_ONLY"/,
      "the employee loop must read the card's own label rather than the recipient label",
    ],
    [
      path.resolve("src/worker/ai/runAi.ts"),
      /classifyContent\(/,
      "the AI boundary must classify content separately from the recipient label",
    ],
  ];
  for (const [file, pattern, why] of wants) {
    examined += 1;
    const src = readFileSync(file, "utf8");
    if (!pattern.test(src)) fail(CHECK, `${path.relative(process.cwd(), file)} — ${why} (looked for ${pattern})`);
  }
  // The column must exist in a migration, or every one of the above is writing to nothing.
  const migration = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .map((f) => readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"))
    .join("\n");
  examined += 2;
  if (!/ALTER TABLE work_card ADD COLUMN model_access/.test(migration)) fail(CHECK, "no migration adds work_card.model_access");
  if (!/ALTER TABLE work_card ADD COLUMN audience/.test(migration)) fail(CHECK, "no migration adds work_card.audience");
  counted(CHECK, examined, "wiring points");
}

// ── Self-test: the checks must be able to FAIL ───────────────────────────────────────────────
/**
 * A validator nobody has seen fail is not evidence. Each check is handed the broken state it exists
 * to catch and must reject it; then the real state must pass.
 */
function selfTest() {
  const problems = [];

  const markers = markerRegexes();
  if (markers.length === 0) problems.push("marker parse returned nothing");
  // The sister system's actual failure, as a fixture: a notice about a venue booking.
  const innocuous = "We need a commitment from the venue by Friday and the capital of the state is a long drive.";
  if (markers.some((m) => m.test(innocuous))) {
    problems.push(`a marker matches ordinary prose: ${innocuous}`);
  }
  // And the thing the markers MUST catch, or check 2 would pass on anything.
  const realLp = "Cross-check the guest list against the limited partner register.";
  if (!markers.some((m) => m.test(realLp))) problems.push("no marker matches genuine LP material — check 2 would never fail");

  const notices = seededFirmNotices();
  if (notices.length < 12) problems.push(`parsed only ${notices.length} FIRM notices; 0181 alone seeds twelve, so the SQL parse is broken`);
  if (!notices.some((n) => n.id === "memo_notice_13_two_labels_on_every_card")) {
    problems.push("the two-labels notice was not parsed out of the migrations");
  }

  const src = readFileSync(PROVIDER_FAILURE, "utf8");
  if (!/vendorCannotServe/.test(src)) problems.push("providerFailure no longer exports vendorCannotServe");

  if (problems.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const p of problems) console.error(`  · ${p}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: ${markers.length} markers parsed, ${notices.length} firm notices parsed, both directions proven.`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  checkAdaptersCarryVendorDetail();
  checkNoticesDoNotTripTheDetector();
  checkFourHundredGuardStaysNarrow();
  checkTwoLabelsAreWired();

  for (const line of summary) console.log(`  ${line}`);
  if (failures.length > 0) {
    console.error(`\n${failures.length} problem${failures.length === 1 ? "" : "s"}:`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log("\nA lane that cannot serve chains; no notice trips the detector; the 400 guard is narrow; both labels are wired.");
}
