#!/usr/bin/env node
/**
 * Every `var(--token)` must resolve to a token the stylesheet actually defines.
 *
 * WHY THIS EXISTS. On 5 Sep 2026 a scan of this tree found `var(--wp-accent)` used in three rules
 * and defined nowhere. `.job-card.is-on` lost its accent edge - the marker whose whole job is to
 * make on/off read before any text does - and two avatar circles lost their background entirely,
 * rendering as initials on nothing.
 *
 * It had been that way through every green CI run, because an unresolved custom property is the
 * quietest failure CSS has: no error, no warning, no console noise. The declaration is simply
 * dropped at computed-value time and the element inherits. That is the same symptom class as a
 * misspelt className, which this repo already turns into a build failure - so this does the same.
 *
 * A `var()` with a fallback is safe by construction and is not a defect.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = "src/client";
const CSS = "src/client/styles.css";

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx") || p.endsWith(".ts") || p.endsWith(".css")) out.push(p);
  }
  return out;
}

/** Tokens the stylesheet declares: `--name:` at the start of a declaration. */
export function definedTokens(css) {
  const out = new Set();
  for (const m of css.matchAll(/(^|[;{\s])(--[a-zA-Z0-9-]+)\s*:/g)) out.add(m[2]);
  return out;
}

/** Bare `var(--name)` references — a fallback makes the reference safe, so those are excluded. */
export function usedWithoutFallback(source) {
  const out = new Set();
  for (const m of source.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) if (m[2] === ")") out.add(m[1]);
  return out;
}

export function scan(cssText, files, read = (f) => stripCommentsFor(f, readFileSync(f, "utf8"))) {
  const defined = definedTokens(cssText);
  const problems = [];
  for (const f of files) {
    for (const token of usedWithoutFallback(read(f))) {
      if (!defined.has(token)) problems.push(`${f}: var(${token}) resolves to nothing`);
    }
  }
  return problems;
}

function selfTest() {
  const cases = [
    ["defined token passes", ".a { color: var(--wp-ink); }", "--wp-ink: #000;", 0],
    ["undefined token fails", ".a { color: var(--wp-accent); }", "--wp-ink: #000;", 1],
    ["the exact defect this was written for", ".j { border-left: 3px solid var(--wp-accent); }", "--wp-orange: #f05a1a;", 1],
    ["fallback makes it safe", ".a { color: var(--wp-gone, red); }", "--wp-ink: #000;", 0],
    ["inline style in tsx is scanned", 'style={{ color: "var(--wp-gone)" }}', "--wp-ink: #000;", 1],
    ["whitespace inside var() is handled", ".a { color: var( --wp-gone ); }", "--wp-ink: #000;", 1],
  ];
  let failed = 0;
  for (const [name, source, css, expected] of cases) {
    const got = scan(css, ["f"], () => source).length;
    if (got !== expected) {
      console.error(`SELF-TEST FAILED — ${name}: expected ${expected}, got ${got}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
  console.log(`SELF-TEST PASSED: ${cases.length}/${cases.length} cases.`);
}

const files = walk(ROOT);
// A scan that examines nothing is not a passing scan.
if (files.length === 0) {
  console.error(`CSS VARIABLE SCAN FAILED — examined 0 files under ${ROOT}.`);
  process.exit(1);
}

const problems = scan(stripCommentsFor(CSS, readFileSync(CSS, "utf8")), files);
if (problems.length > 0) {
  console.error("CSS VARIABLE SCAN FAILED — these resolve to nothing and are silently dropped:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nAn unresolved custom property does not error and does not warn: the declaration is");
  console.error("dropped and the element inherits. Rename the reference, define the token, or give");
  console.error("the var() a fallback.");
  process.exit(1);
}
console.log(`CSS VARIABLE SCAN PASSED: every var(--token) in ${ROOT} resolves in ${CSS}.`);
selfTest();
