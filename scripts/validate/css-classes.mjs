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
 *
 * THE OTHER DIRECTION, for classes declared ahead of their pages. The Deals section was built
 * tokens-first (design/DEALS_SECTION_DESIGN.md §12.1): every class six tabs would need went into
 * the stylesheet on one branch before any page wore one, so the tab branches could not disagree.
 * This scan cannot see a rule nobody uses, so those classes are listed in
 * `design/DEALS_SECTION_CLASSES.json` with the tab that owns each, and the register is checked
 * here from both sides — see lib/declared-ahead.mjs. It hard-fails on an empty register.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripCssComments, stripTsComments } from "./lib/strip-comments.mjs";
import { REGISTER, checkRegister, parseRegister, readRegister, registerSummary } from "./lib/declared-ahead.mjs";

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
  const addTemplate = (tpl) => {
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
  };
  for (const m of src.matchAll(/className="([^"]*)"/g)) for (const c of m[1].split(/\s+/)) add(c, true);

  /*
   * A CLASS CHOSEN BY AN EXPRESSION IS STILL A CLASS. `className={open ? "deal-row-selected" : ""}`
   * and `className={["stage-node", done ? "stage-node-done" : ""].join(" ")}` were invisible to
   * the first version of this scan, which read only a bare string or a whole template literal —
   * so a misspelt class inside a ternary had no symptom, and, in the other direction, a class the
   * Dealflow rail applied through a ternary counted as worn by nothing (18 Sep 2026). The whole
   * expression is walked to its closing brace and every string literal and template fragment in
   * it is a class. A literal that is not a class does not occur inside `className={…}`: the
   * expression evaluates to the attribute, and there is nothing else for a string there to be.
   */
  /*
   * A CLASS COMPUTED INTO A VARIABLE IS STILL A CLASS. `const dot = closed ? "stage-dot-closed" :
   * "stage-dot-current"; … className={dot}` is how both the Dealflow and the Companies compact
   * rails choose a dot, and the expression walk below sees only `dot`. On 19 Sep 2026 the two
   * branches each passed the declared-ahead register alone — the other tab was still pending —
   * and the merged head failed with `.stage-dot-current is worn by nothing`, which was false.
   * So every bare identifier inside a className expression is followed ONE step to a `const`,
   * `let` or `var` declaration in the same file, and that initializer is read with the same
   * literal rules. One step, not a data-flow analysis: a class that arrives through a second
   * variable or a function return is a shape this scan does not claim to see, and the register
   * will say so rather than the scan guessing.
   */
  const declOf = (name) => {
    const d = src.match(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*(?::[^=]+)?=\\s*`));
    if (!d) return null;
    let i = d.index + d[0].length;
    let depth = 0;
    const start = i;
    for (; i < src.length; i += 1) {
      const ch = src[i];
      if (ch === "(" || ch === "[" || ch === "{") depth += 1;
      else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
      else if (ch === ";" && depth === 0) break;
      else if (ch === "\n" && depth === 0 && /^\s*(?:const|let|var|return|for|if|while|\}|<)/.test(src.slice(i + 1, i + 12))) break;
    }
    return src.slice(start, i);
  };
  const readExpr = (expr) => {
    const interpolations = [];
    for (const t of expr.matchAll(/`([^`]*)`/g)) {
      addTemplate(t[1]);
      for (const inner of t[1].matchAll(/\$\{([^}]*)\}/g)) interpolations.push(inner[1]);
    }
    const plain = [expr.replace(/`[^`]*`/g, " "), ...interpolations].join(" ; ");
    for (const q of plain.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const before = plain.slice(0, q.index).replace(/\s+$/, "");
      const after = plain.slice(q.index + q[0].length).replace(/^\s+/, "");
      if (/[=!]=$/.test(before) || /^[=!]=/.test(after)) continue;
      if (/\.(includes|has|startsWith|endsWith|get|indexOf|test)\($/.test(before)) continue;
      for (const c of (q[1] ?? q[2] ?? "").split(/\s+/)) add(c, true);
    }
  };
  for (const m of src.matchAll(/className=\{/g)) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      i += 1;
    }
    const expr = src.slice(start, i - 1);
    // Only an identifier in a VALUE position is followed — the whole expression, an array element,
    // a ternary branch — never a condition (`open ? …`), a property (`item.kind`) or a call. And
    // its initializer is read only when every literal in it is class-shaped (lowercase kebab):
    // `const cls = closed ? "stage-dot-closed" : "stage-dot-current"` is a class variable;
    // `const status = "SCREENING"` and `const path = "/api/x"` are values that merely pass
    // through a className expression somewhere else.
    const bare = expr.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, (q) => " ".repeat(q.length));
    for (const m2 of bare.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) {
      const id = m2[1];
      if (["true", "false", "undefined", "null", "join", "filter", "Boolean", "map", "cx", "clsx"].includes(id)) continue;
      const before = bare.slice(0, m2.index).replace(/\s+$/, "").slice(-1);
      const after = bare.slice(m2.index + id.length).replace(/^\s+/, "").slice(0, 1);
      if (!(before === "" || "[,?:(".includes(before))) continue;
      if ("?.(=&|".includes(after) && after !== "") continue;
      const init = declOf(id);
      if (!init) continue;
      const lits = [...init.matchAll(/"([^"]*)"|'([^']*)'/g)].map((q) => q[1] ?? q[2] ?? "");
      if (lits.length === 0 || !lits.every((l) => l.trim() === "" || /^[a-z][a-z0-9-]*(\s+[a-z][a-z0-9-]*)*$/.test(l))) continue;
      readExpr(init);
    }
    const interpolations = [];
    for (const t of expr.matchAll(/`([^`]*)`/g)) {
      addTemplate(t[1]);
      // A literal INSIDE an interpolation — `${done ? "on" : ""}` — is a plain literal and is read
      // as one, below, with the same comparison rule.
      for (const inner of t[1].matchAll(/\$\{([^}]*)\}/g)) interpolations.push(inner[1]);
    }
    const plain = [expr.replace(/`[^`]*`/g, " "), ...interpolations].join(" ; ");
    for (const q of plain.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      // A literal being COMPARED is a value, not a class: `status === "OPEN" ? "badge-ok" : …`.
      // So is the argument of a membership test: `LIVE.includes("SCREENING")`.
      const before = plain.slice(0, q.index).replace(/\s+$/, "");
      const after = plain.slice(q.index + q[0].length).replace(/^\s+/, "");
      if (/[=!]=$/.test(before) || /^[=!]=/.test(after)) continue;
      if (/\.(includes|has|startsWith|endsWith|get|indexOf|test)\($/.test(before)) continue;
      for (const c of (q[1] ?? q[2] ?? "").split(/\s+/)) add(c, true);
    }
  }
  return found;
}

function scan(cssText, files) {
  const defined = definedClasses(cssText);
  const problems = [];
  for (const f of files) {
    // PROSE IS NOT USE. A comment naming a class it has just removed is not an element wearing it —
    // this scan blocked a correct change on 18 Sep for exactly that. See lib/strip-comments.mjs.
    for (const cls of usedClasses(stripTsComments(readFileSync(f, "utf8"))).keys()) {
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
    ['<div className={open ? "real" : "ghost"} />', 1, "a class chosen by a ternary is checked"],
    ['<div className={["real", done ? "ghost" : ""].filter(Boolean).join(" ")} />', 1, "a class inside an array join is checked"],
    ['<div className={busy ? "real" : undefined} />', 0, "a ternary with no bad literal passes"],
    ['<div className={state === "OPEN" ? "real" : "real"} />', 0, "a literal being compared is a value, not a class"],
    ['<div className={LIVE.includes("OPEN") ? "real" : "real"} />', 0, "the argument of a membership test is a value, not a class"],
    ["<div className={`real ${done ? \"ghost\" : \"\"}`} />", 1, "a literal inside a template interpolation is checked"],
    ['const dot = closed ? "real" : "ghost";\n<li className={dot} />', 1, "a class computed into a const and worn by name is checked"],
    ['const dot = ["real", done ? "ghost" : ""].filter(Boolean).join(" ");\n<li className={dot} />', 1, "…through an array join too"],
    ['const dot = closed ? "real" : "real";\n<li className={dot} />', 0, "…and passes when every literal is defined"],
    ['const other = "ghost";\n<li className="real" />', 0, "a const nobody wears is not a class"],
    ['const status = "GHOST";\n<li className={status === "GHOST" ? "real" : "real"} />', 0, "a value const in a condition is not followed"],
    ['const path = "/api/ghost";\n<li className={real ? "real" : "real"} />', 0, "a const with a non-class literal is not followed"],
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

  // The declared-ahead register, both directions. Fixture-driven: each case is a register, what
  // the stylesheet defines, what the client emits, and how many problems that must produce.
  const reg = (landed, classes) =>
    parseRegister({ tabs: { meetings: { landed }, dealflow: { landed: false } }, classes }, "fixture");
  const registerCases = [
    ["a declared-ahead class with a rule, unworn, tab pending — allowed", reg(false, { masthead: ["meetings"] }), ["masthead"], [], 0],
    ["a declared-ahead class with NO rule is caught even while its tab is pending", reg(false, { masthead: ["meetings"] }), [], [], 1],
    ["the tab landed and the class is worn — allowed", reg(true, { masthead: ["meetings"] }), ["masthead"], ["masthead"], 0],
    ["the tab landed and nothing wears the class — dead on arrival, caught", reg(true, { masthead: ["meetings"] }), ["masthead"], [], 1],
    ["the class is worn but the register still says pending — stale register, caught", reg(false, { masthead: ["meetings"] }), ["masthead"], ["masthead"], 1],
    ["shared class: one owner landed, one pending, unworn — allowed until the last owner lands", reg(true, { band: ["meetings", "dealflow"] }), ["band"], [], 0],
    ["an empty register is a failure, not a pass", parseRegister({ tabs: { meetings: { landed: false } }, classes: {} }, "fixture"), [], [], 1],
    ["an owner that is not a tab is a failure", reg(false, { masthead: ["portfolio"] }), ["masthead"], [], 1],
    ["a class with no owner is a failure", reg(false, { masthead: [] }), ["masthead"], [], 1],
  ];
  let regFailed = 0;
  for (const [why, r, defined, emitted, want] of registerCases) {
    const got = checkRegister(r, new Set(defined), new Set(emitted)).length;
    if (got !== want) {
      console.error(`SELF-TEST FAILED (register: ${why}): expected ${want} problem(s), got ${got}`);
      regFailed += 1;
    }
  }
  if (regFailed) process.exit(1);
  console.log(
    `SELF-TEST PASSED: ${cases.length}/${cases.length} cases, including the two interpolation traps;` +
      ` ${registerCases.length}/${registerCases.length} declared-ahead register cases.`,
  );
}

/**
 * The stylesheet's braces balance, and never go negative.
 *
 * A rule deleted while its closing brace is left behind produces a stray `}` that esbuild reports
 * only as a WARNING during minification — the build still succeeds, and everything after that point
 * is parsed at the wrong nesting level. One shipped exactly that way: a `}` orphaned after a comment
 * block at line 1877, which the operator would only ever have seen as "the styling looks wrong".
 *
 * Checked here rather than trusted to a build warning, because this file already exists to catch the
 * one front-end mistake with no symptom, and an unbalanced stylesheet is the same disease at a larger
 * scale. Depth is tracked rather than just totals: a matched pair in the wrong ORDER balances to zero
 * and is still broken.
 */
function braceBalance(css) {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length));
  let depth = 0;
  const lines = code.split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === "{") depth += 1;
      else if (ch === "}") depth -= 1;
      if (depth < 0) return `a stray closing brace at ${CSS}:${i + 1} — everything after it is parsed at the wrong nesting level`;
    }
  }
  return depth === 0 ? null : `${depth} unclosed rule(s) in ${CSS}`;
}

const unbalanced = braceBalance(stripCssComments(readFileSync(CSS, "utf8")));
if (unbalanced) {
  console.error(`CSS CLASS SCAN FAILED — ${unbalanced}.\n`);
  console.error("esbuild reports this only as a warning during minify, so the build still succeeds");
  console.error("and the damage shows up as styling that silently does not apply.");
  process.exit(1);
}

const tsxFiles = walk(ROOT);
// A scan that finds no .tsx files to check is not a pass. Reproduced 2026-09: pointing ROOT at an
// empty directory still printed "CSS CLASS SCAN PASSED" having examined zero files.
if (tsxFiles.length === 0) {
  console.error(`CSS CLASS SCAN FAILED — examined 0 .tsx files under ${ROOT}.`);
  console.error("A scan that checks nothing is not a passing scan. Confirm ROOT resolves to the real");
  console.error("client tree before trusting this result.");
  process.exit(1);
}

const problems = scan(stripCssComments(readFileSync(CSS, "utf8")), tsxFiles);
if (problems.length > 0) {
  console.error("CSS CLASS SCAN FAILED — these are applied to elements and style nothing:\n");
  for (const p of problems) console.error(`  ${p}`);
  console.error("\nDefine a rule in styles.css, use an existing class, or remove it. A misspelt class");
  console.error("is the one front-end mistake with no symptom: the element renders, unstyled, forever.");
  process.exit(1);
}
console.log(`CSS CLASS SCAN PASSED: every className in ${ROOT} has a rule in ${CSS}.`);

// ── The other direction: classes declared ahead of their pages ─────────────────────────────────
{
  const register = readRegister();
  const defined = definedClasses(stripCssComments(readFileSync(CSS, "utf8")));
  const emitted = new Set();
  for (const f of tsxFiles) for (const cls of usedClasses(stripTsComments(readFileSync(f, "utf8"))).keys()) emitted.add(cls);
  const problems = checkRegister(register, defined, emitted);
  if (problems.length > 0) {
    console.error(`DECLARED-AHEAD REGISTER FAILED — ${REGISTER} and the product disagree:\n`);
    for (const p of problems) console.error(`  ${p}`);
    console.error("\nA class declared before its page is allowed to be unworn only while the tab that owns it");
    console.error("is still marked pending. Flip `landed` in the PR that emits the classes; drop an entry (and");
    console.error("its rule) when the page it was named for turned out not to need it.");
    process.exit(1);
  }
  console.log(`DECLARED-AHEAD REGISTER PASSED: ${registerSummary(register, emitted)}.`);
}
selfTest();
