#!/usr/bin/env node
/**
 * a-search-that-never-ran-is-not-a-question.mjs — `npm run validate:search-never-ran`.
 *
 * ONE RULE: A SEARCH CALL THAT FAILED MUST NEVER BE REPORTED AS A SEARCH THAT FOUND NOTHING.
 *
 * ── Why a scan (1 Oct 2026) ──────────────────────────────────────────────────────────────────
 *
 * Parker's Room packet, then Walker's monthly Productions card, then (found by looking) Walker's weekly hire search and
 * blog help, all did the same thing: a search retry loop that, on `!found.ok`, wrote `why = "the live search failed…"` and
 * `continue`d — and the caller, finding no results, blocked the card with "nothing good enough to send — tell Walker where
 * to look". The search had never run. The lane's own refusal (the spend setting, no search seat, a vendor down) was thrown
 * away and a person was asked a question that had no answer, on a card the sweep could never classify or resume.
 *
 * Every new job that needs live research is written by copying one of these loops. A fix in four places is a fix that
 * the fifth copy undoes, so the shape itself is held here: a loop that swallows a failed search must ALSO record that the
 * search never ran (`searchDown = …` / `downDetail = …`), and the file must hand that back to the sweep as a failed attempt
 * (`blocked: false, detail: "the live search failed…"`) before it asks anybody anything.
 *
 * WHAT IS CHECKED (each is one function; `--self-test` feeds each its own failing fixture)
 *   1 · every `if (!x.ok) { why = … continue }` swallow in src/worker/services also records `searchDown`/`downDetail`;
 *   2 · a file with such a loop that can block as "nothing_good_enough_to_send" also returns the failed-attempt outcome.
 * A loop that degrades on purpose, and SAYS so in what it produces, may carry `/* search-never-ran-exempt: why *\/` on
 * the line above, and the reason is required.
 *
 * DELIBERATELY DOES NOT STRIP COMMENTS for the one read that looks for that exemption marker — the marker IS a comment, so the
 * raw text is read for it and nothing else. Every check of the code itself runs on the comment-stripped text.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** `if (!found.ok) { why = …; continue; }` — the swallow, on one statement. `found` is the search result in every job; a failed JUDGE is a different thing. */
/** One statement body: anything but a closing brace, except a template literal's own `${…}`. */
const BODY = "(?:[^}\\n]|\\$\\{[^}\\n]*\\})*";
const SWALLOW = new RegExp(`if \\(!(found)\\.ok\\) \\{${BODY}\\bwhy\\s*=${BODY}\\bcontinue\\b${BODY}\\}`, "g");
const RECORDS_DOWN = /\b(?:searchDown|downDetail)\s*=/;
/** A reason is required: at least ten characters before the comment closes. */
const EXEMPT = /search-never-ran-exempt:\s*[^*\s][^*]{9,}/;

export function auditFile(rel, raw, stripped) {
  const bad = [];
  const rawLines = raw.split("\n");
  let swallows = 0;
  for (const m of stripped.matchAll(SWALLOW)) {
    swallows += 1;
    const line = stripped.slice(0, m.index).split("\n").length; // line numbers survive stripping by design
    const above = [rawLines[line - 2] ?? "", rawLines[line - 3] ?? ""].join("\n");
    if (EXEMPT.test(above)) continue;
    if (!RECORDS_DOWN.test(m[0])) {
      bad.push(`${rel}:${line} swallows a failed search into \`why\` without recording that it never ran (searchDown/downDetail) — a lane failure becomes "found nothing"`);
    }
  }
  if (swallows > 0 && /reason:\s*"nothing_good_enough_to_send"/.test(stripped) && !/blocked:\s*false,\s*detail:\s*`the live search failed/.test(stripped)) {
    // Only where some loop is not exempt: an exempt degrade does not need to fail the attempt.
    const allExempt = [...stripped.matchAll(SWALLOW)].every((m) => EXEMPT.test([rawLines[stripped.slice(0, m.index).split("\n").length - 2] ?? "", rawLines[stripped.slice(0, m.index).split("\n").length - 3] ?? ""].join("\n")));
    if (!allExempt) bad.push(`${rel} can block as "nothing_good_enough_to_send" but never returns the failed-attempt outcome (blocked: false, detail: \`the live search failed…\`) for a search that never ran`);
  }
  if (/search-never-ran-exempt:(?!\s*[^*\s][^*]{9,})/.test(raw)) bad.push(`${rel} has a search-never-ran-exempt marker with no reason`);
  return bad;
}

function files(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function audit() {
  const bad = [];
  for (const f of files(path.join(ROOT, "src", "worker", "services"))) {
    const raw = readFileSync(f, "utf8");
    bad.push(...auditFile(path.relative(ROOT, f), raw, stripCommentsFor(f, raw)));
  }
  return bad;
}

function selfTest() {
  const good = "for (;;) {\n  const found = await s();\n  if (!found.ok) { why = `the live search failed: ${found.detail}`; searchDown = found.detail; continue; }\n}\nreturn { finished: false, blocked: false, detail: `the live search failed: ${d}` };\nawait blockCard(env, c, { reason: \"nothing_good_enough_to_send\" });";
  const swallow = good.replace(" searchDown = found.detail;", "");
  const noOutcome = good.replace("return { finished: false, blocked: false, detail: `the live search failed: ${d}` };", "");
  const withMarker = (marker) => swallow.replace("  if (!found.ok)", `  ${marker}\n  if (!found.ok)`);
  const exempt = withMarker("/* search-never-ran-exempt: the Workshop designs from the brief and says so in its output */").replace('await blockCard(env, c, { reason: "nothing_good_enough_to_send" });', "");
  const noReason = withMarker("/* search-never-ran-exempt: */");
  const run = (src) => auditFile("x.ts", src, src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " ")));
  const cases = [
    ["the real sources pass", () => audit().length === 0],
    ["the scan is not vacuous: it finds the real swallow loops (at least four jobs have one)", () => files(path.join(ROOT, "src", "worker", "services")).reduce((n, f) => n + [...stripCommentsFor(f, readFileSync(f, "utf8")).matchAll(SWALLOW)].length, 0) >= 4],
    ["a loop that records the search never ran passes", () => run(good).length === 0],
    ["a loop that swallows a failed search into why is caught", () => run(swallow).length > 0],
    ["a file that can block as nothing-good-enough but never fails the attempt is caught", () => run(noOutcome).length > 0],
    ["an exempt loop with a reason passes", () => run(exempt).length === 0],
    ["an exempt marker with no reason is caught", () => auditFile("x.ts", noReason, noReason.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))).length > 0],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) { console.error(`SEARCH-NEVER-RAN SELF-TEST FAILED: ${failed} of ${cases.length}`); process.exit(1); }
  console.log(`SEARCH-NEVER-RAN SELF-TEST PASSED (${cases.length} fixtures)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const bad = audit();
    if (bad.length > 0) {
      console.error("SEARCH-NEVER-RAN SCAN FAILED:\n" + bad.map((b) => `  - ${b}`).join("\n"));
      process.exit(1);
    }
    console.log("SEARCH-NEVER-RAN SCAN PASSED: no retry loop turns a search that never ran into a search that found nothing.");
  }
}
