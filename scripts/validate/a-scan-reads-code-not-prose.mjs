#!/usr/bin/env node
/**
 * a-scan-reads-code-not-prose.mjs — `npm run validate:scans-read-code`.
 *
 * ONE ASSERTION: A VALIDATOR THAT SCANS SOURCE MUST IGNORE COMMENTS, OR SAY IN WRITING WHY NOT.
 *
 * WHAT WENT WRONG. 18 Sep 2026, on a branch that was correct: `validate:css-classes` failed because
 * `DeliverableDocument.tsx` mentioned `.deliverable-body` **in a comment explaining that the class
 * had just been removed**. The rule it enforces is a good one — a misspelt class is the one
 * front-end mistake with no symptom, the element renders unstyled forever — but the block was
 * nonsense. The change was right and the scan refused it for describing itself.
 *
 * The owner, on the family: "get rid of petty blocking and useless ones that do not create
 * meaningful blocking."
 *
 * WHY NOTHING WAS DELETED. Every validator was timed first. Thirty-nine of forty finish in under
 * 1.5 seconds; the whole gate costs about eight seconds, so they are not what makes CI slow and
 * removing them buys nothing but lost cover. What they actually cost is FALSE BLOCKS, and the
 * measurement said where those come from: 25 of the 40 already stripped comments, 12 did not, each
 * with its own copy of the idea or none at all. The tax was never the number of scans. It was that
 * a third of them could be fooled by a sentence.
 *
 * So the simplification is one shared `lib/strip-comments.mjs` and this guard. A rule that fires on
 * prose teaches people to route around it, and a validator people route around is worse than no
 * validator: it still costs a run and no longer means anything.
 *
 * WHAT IS CHECKED
 *   1 · EVERY SCAN THAT READS SOURCE STRIPS COMMENTS FIRST — via the shared helper, or its own
 *       equivalent, or it carries an explicit written exemption.
 *   2 · THE EXEMPTION IS NAMED AND REASONED. `design-tokens` legitimately reads prose: the grant it
 *       honours IS a comment, `/* design-token-exempt: why *\/`. Stripping comments there deletes
 *       the exemptions and it failed instantly when tried. A scan that reads prose ON PURPOSE is a
 *       different thing from one fooled by prose by accident, and it must say which it is in words.
 *   3 · THE HELPER STILL BEHAVES. Nine cases run against the real implementation, including the one
 *       that killed the first version: a regex careful enough to skip `//` after a colon, quote or
 *       backslash still ate the tail of `'https://x.dev//y'`, because the character before the
 *       second `//` is `v`. Under-stripping causes a false block; OVER-stripping makes a scan
 *       silently examine less than it claims, which is the inert-guard failure this repo shipped
 *       three times in one week. The second is worse, so it is pinned here.
 *
 * HARD-FAILS ON ZERO: zero validators discovered, or zero that read source, exits 1.
 *
 * `--self-test` proves the detector catches a scanner that reads source and neither strips nor
 * declares, and accepts the three legitimate shapes.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments, stripCssComments } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/** A scan reads product source if it names a source tree or a source extension. */
export function readsSource(text) {
  return /readFileSync\(/.test(text) && /src[/\\]|\.tsx?\b|\.css\b/.test(text);
}

/**
 * EVERY source read must be wrapped, not merely accompanied by an import.
 *
 * The first version of this checked whether the file MENTIONED the helper. Its own negative proof
 * exposed that as worthless: removing the `stripTsComments(...)` call from `css-classes.mjs` while
 * leaving the import line changed nothing, and the guard went on passing. A check satisfied by an
 * unused import is the inert-guard defect wearing a different hat.
 *
 * So the question is behavioural: is there a `readFileSync(x, "utf8")` that is NOT inside a strip
 * call? Reads of things that are not product source — a JSON register, a lockfile — are not source
 * scans and `readsSource` has already excluded those files.
 */
/**
 * A lookbehind was tried first and quietly matched nothing useful — variable-length lookbehind
 * across a nested `(` is exactly the kind of regex that looks precise and is not. So this removes
 * the wrapped reads by rewriting them, then asks whether any `readFileSync` survives. What is left
 * is, by construction, a read nothing strips.
 */
const WRAPPED = /strip(?:CommentsFor|TsComments|CssComments|SqlComments)\s*\(\s*(?:[^()]|\([^()]*\))*?readFileSync\s*\(/g;

export function bareReads(text) {
  const withoutWrapped = text.replace(WRAPPED, "WRAPPED_READ(");
  return [...withoutWrapped.matchAll(/readFileSync\s*\(/g)].length;
}

export function stripsComments(text) {
  return declaresOwnStripper(text) || bareReads(text) === 0;
}

/** A scan that rolled its own stripper before the shared helper existed still satisfies the rule. */
export function declaresOwnStripper(text) {
  /*
   * DEFINITION IS ENOUGH HERE, and that is a deliberate limit rather than an oversight.
   *
   * Twenty-five validators predate the shared helper and roll their own `stripCssComments` /
   * `stripJsComments` / `stripComments`, each called in its own shape. Three attempts at proving
   * "defined AND actually called" by regex each produced a different set of false accusations —
   * the detector was becoming the thing it polices. The residual risk is a scan that defines a
   * stripper and forgets to call it; the risk of a cleverer regex is this guard accusing correct
   * files, which is precisely the petty blocking it exists to remove.
   *
   * The honest fix is one implementation rather than twenty-six, and that migration is worth doing
   * on its own rather than smuggled into this change.
   */
  return /function strip[A-Za-z]*Comments\b|const strip[A-Za-z]*Comments\s*=|function withoutComments\b|const withoutComments\s*=/.test(text);
}

export function declaresExemption(text) {
  return /DELIBERATELY DOES NOT STRIP COMMENTS/.test(text);
}

export function audit(files) {
  const violations = [];
  let scanning = 0;
  for (const { name, text } of files) {
    if (!readsSource(text)) continue;
    scanning += 1;
    if (stripsComments(text) || declaresExemption(text)) continue;
    violations.push(
      `${name} reads product source and never strips comments — a sentence naming the thing it ` +
        `forbids will block a correct change. Import lib/strip-comments.mjs, or write ` +
        `"DELIBERATELY DOES NOT STRIP COMMENTS" with the reason.`,
    );
  }
  return { violations, scanning };
}

function helperBehaves() {
  const bad = [];
  const cases = [
    ["a comment mention is removed", stripTsComments("const a=1; // .deliverable-body"), /deliverable-body/, false],
    ["a block comment is removed", stripTsComments("/* .ghost */ const b=2;"), /ghost/, false],
    ["real code survives", stripTsComments("const c='.deliverable-doc';"), /deliverable-doc/, true],
    ["a URL in single quotes survives", stripTsComments("const u='https://x.dev//y';"), /x\.dev\/\/y/, true],
    ["a URL in double quotes survives", stripTsComments('const u="http://a//b";'), /a\/\/b/, true],
    ["a template literal survives", stripTsComments("const t=`see //notacomment`;"), /notacomment/, true],
    ["a comment inside ${…} is removed", stripTsComments("const t=`${/* .gone */ x}`;"), /gone/, false],
    ["an escaped quote does not end the string", stripTsComments("const e='it\\'s // fine';"), /fine/, true],
    ["css comments go, css rules stay", stripCssComments("/* .ghost */ .real { color: red }"), /real/, true],
  ];
  for (const [name, out, re, want] of cases) {
    if (re.test(out) !== want) bad.push(name);
  }
  const src = "a\nb // x\nc";
  if (stripTsComments(src).split("\n").length !== src.split("\n").length) {
    bad.push("line count is preserved, so reported line numbers still point at the real file");
  }
  return bad;
}

function selfTest() {
  const fail = (m) => {
    console.error(`SELF-TEST FAILED — ${m}`);
    process.exit(1);
  };
  const ok = (m) => console.log(`  ✓ ${m}`);

  const guilty = audit([{ name: "x.mjs", text: 'readFileSync(f, "utf8"); /src/client/' }]);
  if (guilty.violations.length !== 1) fail("a scan that reads source and never strips was not caught");
  ok("a scan that reads source and never strips is caught");

  const viaHelper = audit([{ name: "y.mjs", text: 'import "./lib/strip-comments.mjs";\nstripCommentsFor(f, readFileSync(f, "utf8")); /src/client/' }]);
  if (viaHelper.violations.length !== 0) fail("the shared helper was not accepted");
  ok("the shared helper is accepted");

  const declared = audit([{ name: "z.mjs", text: '// DELIBERATELY DOES NOT STRIP COMMENTS: the grant is a comment\nreadFileSync(f, "utf8"); /src/client/' }]);
  if (declared.violations.length !== 0) fail("a written exemption was not accepted");
  ok("a written exemption is accepted");

  const notScanning = audit([{ name: "w.mjs", text: "const x = 1;" }]);
  if (notScanning.violations.length !== 0 || notScanning.scanning !== 0) fail("a non-scanner was judged");
  ok("a validator that reads no source is not judged");

  const broken = helperBehaves();
  if (broken.length > 0) fail(`the helper misbehaves: ${broken.join("; ")}`);
  ok("the helper handles all nine cases, including the URL the first regex ate");

  console.log("SCANS-READ-CODE SELF-TEST PASSED");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const names = readdirSync(HERE).filter((f) => f.endsWith(".mjs") && f !== SELF);
  if (names.length === 0) {
    console.error("SCANS-READ-CODE FAILED — found zero validators to audit. Rule 0.");
    process.exit(1);
  }
  const files = names.map((name) => ({ name, text: readFileSync(path.join(HERE, name), "utf8") }));
  const { violations, scanning } = audit(files);

  if (scanning === 0) {
    console.error("SCANS-READ-CODE FAILED — audited zero source-reading validators. Rule 0.");
    process.exit(1);
  }

  const broken = helperBehaves();
  if (broken.length > 0) {
    console.error("SCANS-READ-CODE FAILED — lib/strip-comments.mjs no longer behaves:");
    for (const b of broken) console.error(`  ✗ ${b}`);
    console.error("\nOver-stripping is the dangerous direction: a scan that examines less than it claims");
    console.error("reports success having checked nothing.");
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error("SCANS-READ-CODE FAILED — a validator can be fooled by a sentence:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }

  console.log(
    `SCANS-READ-CODE PASSED: ${scanning} of ${files.length} validators read product source, and every ` +
      `one of them ignores comments or says in writing why it must not; the shared helper passes all ` +
      `nine behaviour cases.`,
  );
}

main();
