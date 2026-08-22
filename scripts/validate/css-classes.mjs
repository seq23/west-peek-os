#!/usr/bin/env node
/**
 * Every className the client uses must have a rule in the stylesheet.
 *
 * WHY THIS EXISTS. Rebuilding Events & Rooms on 21 Aug 2026 turned up NINE class names in one page
 * that the stylesheet had never defined — `pill`, `card-head`, `lede`, `prewrap`, `negative`,
 * `stack`, `primary`, `warn` and friends. Status badges rendered as bare shouting capitals with no
 * badge around them; "Propose a Room" rendered as a default grey button; the agenda overflowed
 * sideways. Nothing failed, no test went red, and the page simply looked wrong for no reason a
 * reader could point at — which is a large part of what the operator has been calling jumbled.
 *
 * A repo-wide scan then found the same disease in the SHARED structural classes: `.page`, the
 * wrapper on nine pages, had no rule at all; `.tablewrap` had none, so a wide table pushed the whole
 * page sideways on the very surface held up as the layout standard.
 *
 * A misspelt class is the one front-end mistake with no symptom. This turns it into a build failure.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CSS = "src/client/styles.css";
const ROOT = "src/client";

/**
 * Classes that are deliberately not styled. Kept SHORT and each one justified — a long list here
 * would turn this scan into decoration.
 */
const ALLOWED_UNSTYLED = new Set([
  // Applied by the chart library to its own generated nodes, styled through its own variables.
  "viz-root",
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** Class names with a rule somewhere in the stylesheet. */
export function definedClasses(css) {
  // Comments are blanked first: a class name mentioned in prose is not a definition.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  return new Set([...code.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)].map((m) => m[1]));
}

/**
 * Class names a file actually applies.
 *
 * A template literal is split on its interpolations and only the LITERAL fragments are taken, so
 * `` `stage-chip-${key}` `` contributes nothing rather than a phantom `stage-chip-`. A fragment that
 * ends mid-word is a prefix, not a class, and is dropped for the same reason.
 */
export function usedClasses(src) {
  const found = new Map();
  const add = (cls, ok) => {
    if (ok && cls) found.set(cls, true);
  };
  for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
    const literal = m[1] ?? m[3];
    if (literal !== undefined) {
      for (const c of literal.split(/\s+/)) add(c, true);
      continue;
    }
    const tpl = m[2] ?? "";
    // Split on interpolations; a fragment adjacent to one may be a prefix or a suffix.
    const parts = tpl.split(/\$\{[^}]*\}/);
    parts.forEach((part, i) => {
      const tokens = part.split(/\s+/);
      tokens.forEach((tok, j) => {
        if (!tok) return;
        const touchesLeft = i > 0 && j === 0;
        const touchesRight = i < parts.length - 1 && j === tokens.length - 1;
        add(tok, !touchesLeft && !touchesRight);
      });
    });
  }
  return found;
}

function scan(cssText, files) {
  const defined = definedClasses(cssText);
  const problems = [];
  for (const f of files) {
    for (const cls of usedClasses(readFileSync(f, "utf8")).keys()) {
      if (!defined.has(cls) && !ALLOWED_UNSTYLED.has(cls)) problems.push(`${f}: .${cls} is applied but has no rule`);
    }
  }
  return problems;
}

function selfTest() {
  const css = ".real { color: red; }\n/* .mentioned-in-a-comment is not a definition */\n";
  const cases = [
    ['<div className="real" />', 0, "a defined class passes"],
    ['<div className="ghost" />', 1, "an undefined class is caught"],
    ['<div className="real ghost" />', 1, "one bad class in a list is caught"],
    ['<div className="mentioned-in-a-comment" />', 1, "a class named only inside a comment is NOT defined"],
    ["<div className={`real ${x}`} />", 0, "a literal fragment before an interpolation is checked"],
    ["<div className={`ghost ${x}`} />", 1, "…and caught when undefined"],
    ["<div className={`pre-${x}`} />", 0, "a prefix cut by an interpolation is not a class"],
    ["<div className={`${x}-suf`} />", 0, "a suffix cut by an interpolation is not a class"],
  ];
  const defined = definedClasses(css);
  let failed = 0;
  for (const [src, want, why] of cases) {
    const got = [...usedClasses(src).keys()].filter((c) => !defined.has(c)).length;
    if (got !== want) {
      console.error(`SELF-TEST FAILED (${why}): expected ${want}, got ${got} — ${src}`);
      failed += 1;
    }
  }
  if (failed) process.exit(1);
  console.log(`SELF-TEST PASSED: ${cases.length}/${cases.length} cases, including the two interpolation traps.`);
}

const problems = scan(readFileSync(CSS, "utf8"), walk(ROOT));
if (problems.length > 0) {
  console.error("CSS CLASS SCAN FAILED — these are applied to elements and style nothing:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nDefine a rule in styles.css, use an existing class, or remove it. A misspelt class");
  console.error("is the one front-end mistake with no symptom: the element renders, unstyled, forever.");
  process.exit(1);
}
console.log(`CSS CLASS SCAN PASSED: every className in ${ROOT} has a rule in ${CSS}.`);
selfTest();
