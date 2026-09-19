#!/usr/bin/env node
/**
 * A HEADING-SCALE RULE MUST REACH A HEADING THE CLIENT ACTUALLY EMITS.
 *
 * WHY THIS EXISTS, and it is not hypothetical. On 17 Sep 2026 the operator said the headings on
 * Home "have no visual weight". They had none because the stylesheet had never touched them. Two
 * rules were written against tags the page does not emit:
 *
 *     .home-masthead h1 { font-size: var(--text-2xl); font-weight: 700 }   ← the page emits h2
 *     .home-section-head h2 { font-size: var(--text-lg); font-weight: 700 } ← 27 h3s and 7 h4s
 *
 * `.home-section-head` is used in 34 places across the client, so the SECOND of those meant every
 * section heading in the product rendered at the browser's default weight and size, next to body
 * copy the stylesheet had styled properly. Nothing failed. No test went red. The build was green,
 * the classes all existed, `validate:css-classes` passed — because that scan asks the opposite
 * question, whether every class the page applies is defined. It cannot see a rule that is defined,
 * valid, and aimed at nothing.
 *
 * THIS IS THE COMPLEMENT OF THAT SCAN, in the one place the cost is highest. A dead colour rule is
 * a wrong shade; a dead heading rule removes the page's hierarchy entirely, which is the single
 * defect the 18 Sep redesign existed to repair. Once repaired it must not silently return — a
 * rename of one wrapper class, or an `h3` promoted to `h2` for the document outline, brings it
 * straight back with no symptom a reader could point at.
 *
 * WHAT IT CHECKS. Every descendant selector in `src/client/styles.css` of the shape
 * `.some-class h1..h6` that sets `font-size` or `font-weight` — the two properties that make a
 * heading read as a heading. For each, the client tree must contain at least one element with that
 * class which has one of those heading tags inside it. Selector lists are checked as a whole (one
 * live branch is enough: `h2, h3, h4` is a deliberate hedge against exactly this failure), and a
 * rule that is only ever a hedge still has to have one live branch.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK. Bare `h1 { }` and `.card h1` are matched by nesting the
 * scan cannot see through in JSX composition, so only the class-plus-tag shape is examined; that
 * is the shape both real bugs took. And it proves reachability, not appearance — whether the
 * resulting size is the right one is a design question this file has no opinion about.
 *
 * DECLARED AHEAD. The Deals section put its classes into the stylesheet before its pages existed
 * (design/DEALS_SECTION_DESIGN.md §12.1), so `.masthead h2` and `.band-head h3` were, for a while,
 * exactly the shape of the bug above. A dead rule is tolerated here ONLY while
 * `design/DEALS_SECTION_CLASSES.json` says the rule's class is still awaiting a tab that owns it;
 * the moment every owner has landed, dead is dead. The register itself is checked by
 * `validate:css-classes` — see lib/declared-ahead.mjs. The pass line says how many are waiting.
 *
 * ZERO IS A FAILURE. A run that finds no heading-scale selectors, or no .tsx files, exits non-zero
 * rather than printing a pass, because a scan that examined nothing has proven nothing. That is the
 * defect class this repo keeps finding: "runs but inert".
 *
 * `--self-test` plants each failure and requires the scan still catches it, per AGENTS.md.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { REGISTER, allOwnersLanded, parseRegister, pendingOwners, readRegister } from "./lib/declared-ahead.mjs";

const CSS = "src/client/styles.css";
const ROOT = "src/client";

const TAGS = ["h1", "h2", "h3", "h4", "h5", "h6"];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/* Comments are blanked but their NEWLINES are kept, so reported line numbers are the real ones.
   Collapsing them to spaces put every number after the first comment block out by hundreds. */
const stripComments = (css) =>
  css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));

/**
 * Every heading-scale rule in the stylesheet, as { line, selector, branches: [{ cls, tag }] }.
 *
 * A branch is one `.class … hN` pair out of the selector list. Intermediate selector parts are
 * ignored — `.a .b h3` is recorded against `.b`, the nearest class, which is the one whose rename
 * would kill the rule.
 */
export function headingScaleRules(css) {
  const code = stripComments(css);
  const rules = [];
  // Selector text (no braces, no at-rule) followed by a declaration block.
  for (const m of code.matchAll(/([^{}@;]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    const body = m[2];
    if (!/(^|[\s;])(font-size|font-weight)\s*:/.test(body)) continue;

    const branches = [];
    for (const part of selector.split(",")) {
      const s = part.trim();
      // `.cls ... hN` with the heading last and at least one class before it.
      // The NEAREST class wins: `.card .brief-masthead h3` is recorded against `brief-masthead`,
      // because that is the class whose rename would kill the rule.
      const hit = s.match(/\.(-?[A-Za-z_][\w-]*)(?:[:[][^\s]*)?\s+(h[1-6])\s*$/);
      if (hit) branches.push({ cls: hit[1], tag: hit[2] });
    }
    if (branches.length === 0) continue;

    /* The selector match starts after the previous rule's `}`, so it swallows the blank lines and
       the blanked-out comment block above — point at the selector's own first character instead,
       or every number is reported a comment-block early. */
    const line = code.slice(0, m.index + m[1].search(/\S/)).split("\n").length;
    rules.push({ line, selector: selector.replace(/\s+/g, " "), branches });
  }
  return rules;
}

/**
 * Which `class → heading tag` pairs the client actually emits.
 *
 * Deliberately coarse: an element carrying the class, and somewhere after it before that element's
 * own closing, a heading tag. JSX is not parsed — a parser here would be a second renderer to keep
 * correct. The scan takes the next 4000 characters after the className as the element's
 * neighbourhood, which is far more than any real component head and cannot produce a FALSE FAILURE
 * (the risk runs the other way, towards missing a dead rule, and a scan that over-reports is one
 * people delete).
 */
export function emittedPairs(sources) {
  const pairs = new Set();
  for (const src of sources) {
    for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{"([^"]*)"\})/g)) {
      const literal = (m[1] ?? m[3] ?? m[2] ?? "").replace(/\$\{[^}]*\}/g, " ");
      const classes = literal.split(/\s+/).filter(Boolean);
      if (classes.length === 0) continue;
      const after = src.slice(m.index, m.index + 4000);
      for (const tag of TAGS) {
        if (!new RegExp(`<${tag}[\\s/>]`).test(after)) continue;
        for (const cls of classes) pairs.add(`${cls} ${tag}`);
      }
    }
  }
  return pairs;
}

/**
 * `register` (optional) is a parsed declared-ahead register. A dead rule whose every branch names a
 * registered class with an owner still to land is moved from `dead` to `awaiting`, each carrying
 * the tabs it waits for. A malformed register tolerates nothing.
 */
export function scan(css, sources, register = null) {
  const rules = headingScaleRules(css);
  const pairs = emittedPairs(sources);
  const dead = [];
  const awaiting = [];
  for (const r of rules) {
    if (r.branches.some((b) => pairs.has(`${b.cls} ${b.tag}`))) continue;
    const tolerated =
      register &&
      register.problems.length === 0 &&
      r.branches.every((b) => b.cls in register.classes && !allOwnersLanded(register, b.cls));
    if (tolerated) awaiting.push({ ...r, tabs: [...new Set(r.branches.flatMap((b) => pendingOwners(register, b.cls)))] });
    else dead.push(r);
  }
  return { rules, dead, awaiting };
}

function run() {
  const css = readFileSync(CSS, "utf8");
  const files = walk(ROOT);

  if (files.length === 0) {
    console.error(`HEADING SCALE SCAN FAILED — examined 0 .tsx files under ${ROOT}.`);
    console.error("A scan that checks nothing is not a passing scan.");
    process.exit(1);
  }

  const { rules, dead, awaiting } = scan(css, files.map((f) => readFileSync(f, "utf8")), readRegister());

  if (rules.length === 0) {
    console.error(`HEADING SCALE SCAN FAILED — found 0 heading-scale selectors in ${CSS}.`);
    console.error("This repo sets its heading scale through `.class hN` rules. Finding none means");
    console.error("either the scale has been deleted or this scan has stopped reading the file.");
    process.exit(1);
  }

  if (dead.length > 0) {
    console.error("HEADING SCALE SCAN FAILED — these rules set a heading scale that reaches no heading:\n");
    for (const r of dead) {
      console.error(`  ${CSS}:${r.line}  ${r.selector}`);
      for (const b of r.branches) console.error(`      no <${b.tag}> is emitted inside className="… ${b.cls} …"`);
    }
    console.error("\nThis is the exact bug the 18 Sep Home redesign repaired: the stylesheet aimed at");
    console.error("h1/h2 while the page emitted h2/h3/h4, so the headings rendered at browser default");
    console.error("and the page lost its hierarchy with nothing going red. Point the selector at the");
    console.error("tag the client emits, or change the markup — but do not leave the rule aimed at air.");
    process.exit(1);
  }

  const waiting =
    awaiting.length === 0
      ? ""
      : ` ${awaiting.length} declared ahead in ${REGISTER} and not yet reaching one, awaiting ` +
        `${[...new Set(awaiting.flatMap((r) => r.tabs))].join(", ")}: ${awaiting.map((r) => r.selector).join("; ")}.`;
  console.log(
    `HEADING SCALE SCAN PASSED: ${rules.length} heading-scale selectors in ${CSS}, ${rules.length - awaiting.length} of them` +
      ` reaching a heading the client emits (${files.length} .tsx files examined).${waiting}`,
  );
}

/** Each planted failure must still be caught. A validator nobody has broken on purpose is a guess. */
function selfTest() {
  const cases = [
    {
      name: "a rule aimed at a tag the page does not emit is caught (the reported bug)",
      css: ".home-masthead h1 { font-size: var(--text-2xl); font-weight: 700 }",
      tsx: ['<header className="home-masthead"><h2>Good evening</h2></header>'],
      dead: 1,
    },
    {
      name: "the same rule pointed at the emitted tag passes",
      css: ".home-masthead h2 { font-size: var(--text-2xl); font-weight: 700 }",
      tsx: ['<header className="home-masthead"><h2>Good evening</h2></header>'],
      dead: 0,
    },
    {
      name: "the second reported bug: 34 call sites emitting h3/h4 under a rule aimed at h2",
      css: ".home-section-head h2 { font-size: var(--text-lg) }",
      tsx: ['<div className="home-section-head"><h3>Waiting on you</h3></div>'],
      dead: 1,
    },
    {
      name: "a selector list passes on one live branch, which is the point of hedging",
      css: ".home-section-head h2,\n.home-section-head h3,\n.home-section-head h4 { font-size: var(--text-lg) }",
      tsx: ['<div className="home-section-head"><h3>Waiting on you</h3></div>'],
      dead: 0,
    },
    {
      name: "a selector list every branch of which is dead is still caught",
      css: ".home-section-head h1,\n.home-section-head h2 { font-size: var(--text-lg) }",
      tsx: ['<div className="home-section-head"><h3>Waiting on you</h3></div>'],
      dead: 1,
    },
    {
      name: "a renamed wrapper class kills the rule and is reported",
      css: ".home-band-head h3 { font-size: var(--text-xl) }",
      tsx: ['<div className="home-band-title"><h3>The rest</h3></div>'],
      dead: 1,
    },
    {
      name: "a rule that sets neither font-size nor font-weight is not a heading-scale rule",
      css: ".home-masthead h1 { margin: 0 }",
      tsx: ['<header className="home-masthead"><h2>Good evening</h2></header>'],
      dead: 0,
      rules: 0,
    },
    {
      name: "a class mentioned only inside a CSS comment defines nothing and is not scanned",
      css: "/* .home-masthead h1 { font-size: var(--text-2xl) } */\n.home-masthead h2 { font-size: var(--text-2xl) }",
      tsx: ['<header className="home-masthead"><h2>Good evening</h2></header>'],
      dead: 0,
      rules: 1,
    },
    {
      name: "a deeper descendant is recorded against its nearest class",
      css: ".card .brief-masthead h3 { font-weight: 700 }",
      tsx: ['<header className="brief-masthead"><h3>Executive Intelligence Report</h3></header>'],
      dead: 0,
    },
  ];

  // Declared ahead: the register decides whether a dead rule is waiting or dead.
  const reg = (landed) =>
    parseRegister({ tabs: { meetings: { landed }, dealflow: { landed: false } }, classes: { masthead: ["meetings"], "band-head": ["meetings", "dealflow"] } }, "fixture");
  cases.push(
    {
      name: "a declared-ahead heading rule is tolerated while its tab is pending",
      css: ".masthead h2 { font-size: var(--text-2xl) }",
      tsx: ['<div className="card"><h3>Not a masthead</h3></div>'],
      register: reg(false),
      dead: 0,
      awaiting: 1,
    },
    {
      name: "the same rule is dead once its tab has landed without emitting it",
      css: ".masthead h2 { font-size: var(--text-2xl) }",
      tsx: ['<div className="card"><h3>Not a masthead</h3></div>'],
      register: reg(true),
      dead: 1,
      awaiting: 0,
    },
    {
      name: "a shared class waits until its LAST owner lands",
      css: ".band-head h3 { font-size: var(--text-xl) }",
      tsx: ['<div className="card"><h3>Not a band</h3></div>'],
      register: reg(true),
      dead: 0,
      awaiting: 1,
    },
    {
      name: "a rule on a class the register does not know is dead regardless",
      css: ".home-masthead h1 { font-size: var(--text-2xl) }",
      tsx: ['<header className="home-masthead"><h2>Good evening</h2></header>'],
      register: reg(false),
      dead: 1,
      awaiting: 0,
    },
    {
      name: "a malformed register tolerates nothing",
      css: ".masthead h2 { font-size: var(--text-2xl) }",
      tsx: ['<div className="card"><h3>Not a masthead</h3></div>'],
      register: parseRegister({ tabs: {}, classes: {} }, "fixture"),
      dead: 1,
      awaiting: 0,
    },
    {
      name: "a declared-ahead rule that DOES reach its heading is simply live",
      css: ".masthead h2 { font-size: var(--text-2xl) }",
      tsx: ['<header className="masthead"><h2>Two briefs are ready</h2></header>'],
      register: reg(false),
      dead: 0,
      awaiting: 0,
    },
  );

  let failed = 0;
  for (const c of cases) {
    const { rules, dead, awaiting } = scan(c.css, c.tsx, c.register ?? null);
    if (c.awaiting !== undefined && awaiting.length !== c.awaiting) {
      failed += 1;
      console.error(`SELF-TEST FAILED: ${c.name} — expected ${c.awaiting} awaiting, got ${awaiting.length}`);
    }
    const okDead = dead.length === c.dead;
    const okRules = c.rules === undefined || rules.length === c.rules;
    if (!okDead || !okRules) {
      failed += 1;
      console.error(`SELF-TEST FAILED: ${c.name} — expected ${c.dead} dead / ${c.rules ?? "any"} rules, got ${dead.length} dead / ${rules.length} rules`);
    }
  }

  // The zero-item guard is the one the repo keeps regressing: prove the scan refuses an empty run.
  if (headingScaleRules("").length !== 0) {
    failed += 1;
    console.error("SELF-TEST FAILED: an empty stylesheet somehow produced heading-scale rules");
  }

  if (failed > 0) process.exit(1);
  console.log(`SELF-TEST PASSED: ${cases.length}/${cases.length} cases, including both rules that actually shipped dead and the declared-ahead register.`);
}

if (process.argv.includes("--self-test")) selfTest();
else run();
