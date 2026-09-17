#!/usr/bin/env node
/**
 * one-topic-several-angles.mjs — `npm run validate:angles`.
 *
 * ONE ASSERTION: A MONTHLY PACKET CARRIES ONE SUBJECT, THE FACTS ABOUT IT ARE DERIVED FROM
 * CONSTANTS RATHER THAN RETYPED, AND A MODEL THAT ANSWERS WITH THREE SUBJECTS IS REJECTED RATHER
 * THAN DISCOURAGED.
 *
 * ─── What went wrong, twice, and why a scan rather than only tests ─────────────────────────────
 *
 * FIRST: the October Workshop packet compared a task-triage session against an AI back-office build
 * against a third and called all three "concepts". Operator, 17 Sep 2026: "Black lawyers is a topic.
 * Community is a topic. but angles are things like names / venues / type of event." Three subjects
 * is not a comparison — it is three proposals wearing one word, and the two that lose are thrown
 * away. The fix is structural and the rule is easy to weaken back: one `parseConcepts` that stops
 * checking `angle_on`, or a new stream whose parser never had the check, and it is gone silently.
 *
 * SECOND: `WORKSHOP_LENGTH_MINUTES = 90` was the constant, and "90 minutes" was ALSO typed into
 * seven strings the model reads, the packet text, the PDF and the page. The constant was one of
 * eight copies, so changing it changed nothing. A test can assert today's number; only a scan can
 * assert that the number is never typed into prose again — which is the actual defect.
 *
 * ─── What is checked ───────────────────────────────────────────────────────────────────────────
 *
 *   1 · ONE PLAN. `MONTHLY_PLAN` is the only literal month→topic table. `WORKSHOP_SERIES` must be
 *       DERIVED from it, never re-declared as an object literal of months.
 *   2 · NO DURATION IN PROSE. No source under src/ may contain a bare "N minute(s)" duration for a
 *       Workshop outside `monthlyPlan.ts`/`workshopPacket.ts`'s own constant declarations; the
 *       range is interpolated from `WORKSHOP_LENGTH_RANGE`. `90` specifically may not appear as a
 *       Workshop length anywhere, including the document.
 *   3 · EVERY CONCEPTS PARSER REJECTS DIVERGENCE. Every `parse*Concepts` function in
 *       `src/shared/events/` must call `sameSubject` and must `return null` on the failure — a
 *       parser that merely flags is the "runs but inert" shape wearing a check.
 *   4 · EVERY CONCEPTS PROMPT CARRIES THE RULE. Every `build*ConceptsPrompt` must reach
 *       `angleRules` or spell out `angle_on`, so no stream is left asking for three subjects.
 *   5 · THE STAGE FAILS ON A REJECTION. `services/roomPacket.ts` must turn a null parse into a
 *       stage failure for BOTH streams — a rejection that is swallowed stores nothing and also
 *       tells nobody.
 *   6 · THE DOCUMENT IS READ. A test file must read `docs/WORKSHOPS.md`, because this repo has
 *       twice shipped a specification nothing read.
 *
 * Comments and this file's own prose are stripped before scanning, so the paragraphs above cannot
 * make the scan pass or fail.
 *
 * HARD-FAILS ON ZERO: zero sources, zero parsers, or zero prompts examined all exit 1.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside clean fixtures that must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const EVENTS = path.join("shared", "events");
const PLAN = path.join("shared", "events", "monthlyPlan.ts");
const WORKSHOP = path.join("shared", "events", "workshopPacket.ts");
const SERVICE = path.join("worker", "services", "roomPacket.ts");
const DOC = "docs/WORKSHOPS.md";

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out[path.relative(SRC, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

// ── 1 · ONE PLAN ───────────────────────────────────────────────────────────────────────────────

/**
 * A second month→topic table anywhere is the "two components each keeping their own list with no
 * link" defect. `WORKSHOP_SERIES` in particular must be derived; it used to BE the list, and the
 * externally hosted month could not be expressed in it at all.
 */
export function checkOnePlan(sources) {
  const violations = [];
  let literalTables = 0;
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    /*
     * A MONTH TABLE IS TWO OR MORE YYYY-MM LITERALS IN ONE FILE, whatever shape they are in — the
     * old one was an object keyed by month, the new one is an array of rows carrying `month:`, and
     * the next one would be something else again. Counting the literals catches all three.
     */
    const months = new Set([...src.matchAll(/["'`](\d{4}-\d{2})["'`]/g)].map((m) => m[1]));
    if (months.size < 2) continue;
    literalTables += 1;
    if (file !== PLAN) {
      violations.push(`${file} declares a literal month→topic table; MONTHLY_PLAN in ${PLAN} is the only one`);
    }
  }
  const workshop = stripComments(sources[WORKSHOP] ?? "");
  if (/export const WORKSHOP_SERIES\s*:/.test(workshop)) {
    violations.push(`${WORKSHOP} re-declares WORKSHOP_SERIES; it must be derived from MONTHLY_PLAN and re-exported`);
  }
  const plan = stripComments(sources[PLAN] ?? "");
  if (!/WORKSHOP_SERIES[\s\S]{0,400}MONTHLY_PLAN\.filter/.test(plan)) {
    violations.push(`${PLAN} does not derive WORKSHOP_SERIES from MONTHLY_PLAN`);
  }
  return { violations, literalTables };
}

// ── 2 · NO DURATION IN PROSE ───────────────────────────────────────────────────────────────────

/**
 * The defect, stated precisely: a WORKSHOP's length written as a literal in a string a model or a
 * reader sees, rather than interpolated from the constant.
 *
 * SCOPED TO WORKSHOP PROSE, deliberately. A Room's run of show says "20 minutes" and the sweep says
 * "every 15 minutes"; those are different facts with different owners, and a scan that flagged them
 * would be noise a reader learns to ignore — which is how a check stops being a check. So a line is
 * only a violation when the same string also talks about a Workshop, or when it is in
 * `workshopPacket.ts`, whose every string is about one.
 *
 * `90` is the exception and is refused ANYWHERE in the scanned prose, because that is the specific
 * number that drifted and there is no legitimate Workshop use of it left.
 */
export function checkNoDurationInProse(sources, doc) {
  const violations = [];
  let scanned = 0;
  const DECLARATION = /export const WORKSHOP_LENGTH_(MIN|MAX)_MINUTES\s*=\s*\d+/;
  const DURATION = /["'`][^"'`]{0,300}?\b(\d{2,3})[\s-]minute/i;
  for (const [file, raw] of Object.entries(sources)) {
    if (file === PLAN) continue;
    const src = stripComments(raw);
    scanned += 1;
    const aboutWorkshops = file === WORKSHOP;
    for (const line of src.split("\n")) {
      if (DECLARATION.test(line)) continue;
      const hit = DURATION.exec(line);
      if (!hit) continue;
      const mentionsWorkshop = aboutWorkshops || /workshop/i.test(line);
      if (!mentionsWorkshop && hit[1] !== "90") continue;
      violations.push(`${file} writes "${hit[1]} minutes" into prose about a Workshop; interpolate WORKSHOP_LENGTH_RANGE instead`);
    }
  }
  if (/\b90[\s-]minute/i.test(doc)) violations.push(`${DOC} still says "90 minutes"`);
  return { violations, scanned };
}

/**
 * One exported function's whole body: from its `export function NAME` to the next `export ` or the
 * end of the file.
 *
 * WRITTEN THIS WAY AFTER THE OBVIOUS VERSION WAS WRONG AND SILENTLY PASSING NOTHING. Matching to
 * the first `\n}` captured only the PARAMETER LIST, because these functions take a multi-line
 * object type whose closing `}): string {` is itself a `}` at column zero. Every body therefore
 * looked like it contained no `angleRules` call, and the scan reported violations for code that was
 * correct — the friendlier failure. The same bug the other way round would have passed everything.
 */
function bodiesOf(src, namePattern) {
  const out = [];
  const re = new RegExp(`export (?:async )?function (${namePattern})\\b`, "g");
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const next = src.indexOf("\nexport ", start + 1);
    out.push({ name: m[1], body: src.slice(start, next === -1 ? src.length : next) });
  }
  return out;
}

// ── 3 · EVERY CONCEPTS PARSER REJECTS DIVERGENCE ───────────────────────────────────────────────

export function checkParsersReject(sources) {
  const violations = [];
  let parsers = 0;
  for (const [file, raw] of Object.entries(sources)) {
    if (!file.startsWith(EVENTS)) continue;
    const src = stripComments(raw);
    for (const { name, body } of bodiesOf(src, "parse\\w*Concepts")) {
      parsers += 1;
      if (!/sameSubject\(/.test(body)) {
        violations.push(`${file}: ${name}() does not compare every angle's subject with sameSubject()`);
      }
      if (!/sameSubject\([^)]*\)\)\s*\)?\s*return null|some\(\(d\) => !sameSubject[\s\S]{0,60}return null/.test(body)) {
        violations.push(`${file}: ${name}() does not RETURN NULL when the angles are on different subjects — flagging is not rejecting`);
      }
    }
  }
  return { violations, parsers };
}

// ── 4 · EVERY CONCEPTS PROMPT CARRIES THE RULE ─────────────────────────────────────────────────

export function checkPromptsCarryTheRule(sources) {
  const violations = [];
  let prompts = 0;
  for (const [file, raw] of Object.entries(sources)) {
    if (!file.startsWith(EVENTS)) continue;
    const src = stripComments(raw);
    for (const { name, body } of bodiesOf(src, "build\\w*ConceptsPrompt")) {
      prompts += 1;
      if (!/angleRules\(/.test(body) && !/angle_on/.test(body)) {
        violations.push(`${file}: ${name}() never states the one-topic rule — it must reach angleRules() or spell out angle_on`);
      }
      if (!/topic/.test(body)) {
        violations.push(`${file}: ${name}() does not take the month's topic; it would be asking for three subjects`);
      }
    }
  }
  return { violations, prompts };
}

// ── 5 · THE STAGE FAILS ON A REJECTION ─────────────────────────────────────────────────────────

export function checkStageFails(sources) {
  const violations = [];
  const src = stripComments(sources[SERVICE] ?? "");
  let branches = 0;
  for (const m of src.matchAll(/const parsed = (parseWorkshopConcepts|parseConcepts)\([\s\S]{0,200}?\n/g)) {
    branches += 1;
  }
  for (const m of src.matchAll(/(parseWorkshopConcepts|parseConcepts)\([^;]*\);\s*\n\s*if \(!parsed\)\s*return (await )?fail/g)) {
    // counted below
  }
  const fails = [...src.matchAll(/if \(!parsed\) return (await failStage|fail)\(/g)].length;
  if (branches === 0) violations.push(`${SERVICE} calls no concepts parser; this scan is reading the wrong file`);
  if (fails < branches) {
    violations.push(`${SERVICE}: ${branches} concepts parse(s) but only ${fails} of them fail the stage — a swallowed rejection stores nothing AND tells nobody`);
  }
  return { violations, branches };
}

// ── 6 · THE DOCUMENT IS READ ───────────────────────────────────────────────────────────────────

export function checkDocumentIsRead() {
  const dir = path.join(ROOT, "tests");
  const readers = readdirSync(dir).filter((f) => f.endsWith(".ts") && readFileSync(path.join(dir, f), "utf8").includes(DOC));
  return {
    violations: readers.length === 0 ? [`no test reads ${DOC}; a specification nothing reads is how this drifted twice`] : [],
    readers: readers.length,
  };
}

// ── The self-test ──────────────────────────────────────────────────────────────────────────────

const CLEAN_PARSER = `
export function parseWorkshopConcepts(raw, setTopic) {
  const declared = rows.map((c) => str(c.angle_on));
  if (declared.some((d) => !sameSubject(d, topic))) return null;
  return { topic, concepts };
}
`;
const PRE_FIX_PARSER = `
export function parseConcepts(raw) {
  const concepts = [];
  for (const c of rows) concepts.push({ title: str(c.title) });
  return { concepts };
}
`;
const FLAGGING_PARSER = `
export function parseConcepts(raw, topic) {
  const declared = rows.map((c) => str(c.angle_on));
  const drifted = declared.some((d) => !sameSubject(d, topic));
  return { topic, concepts, drifted };
}
`;
const PRE_FIX_PROMPT = `
export function buildConceptsPrompt(input) {
  return ["Ideate THREE distinct concepts for the " + input.month + " Room, compare them, and choose one."].join("\\n");
}
`;
const CLEAN_PROMPT = `
export function buildConceptsPrompt(input) {
  return [angleRules({ topic: input.topic, stream: "ROOM", setBy: input.setBy })].join("\\n");
}
`;

function selfTest() {
  const cases = [];
  const add = (name, got, want) => cases.push({ name, ok: got === want, got, want });

  // 1 · a second month table, and a re-declared WORKSHOP_SERIES.
  const twoTables = {
    [PLAN]: 'export const MONTHLY_PLAN = [{ month: "2026-09" }, { month: "2026-11" }];\nexport const WORKSHOP_SERIES = Object.fromEntries(MONTHLY_PLAN.filter((p) => p.status === "SET").map((p) => [p.month, p.topic]));',
    [WORKSHOP]: 'export const WORKSHOP_SERIES: Readonly<Record<string, string>> = { "2026-09": "AI", "2026-11": "Community" };',
  };
  add("a second month→topic table is caught", checkOnePlan(twoTables).violations.length > 0, true);
  add(
    "the real shape passes",
    checkOnePlan({ [PLAN]: twoTables[PLAN], [WORKSHOP]: "export { WORKSHOP_SERIES };" }).violations.length,
    0,
  );

  // 2 · the real pre-fix prose.
  const prose = { "shared/events/workshopPacket.ts": 'const X = ["A West Peek Workshop is a 90-minute VIRTUAL working session"];' };
  add("a duration typed into prose is caught", checkNoDurationInProse(prose, "").violations.length > 0, true);
  add(
    "the constant declarations themselves are allowed",
    checkNoDurationInProse({ "shared/events/workshopPacket.ts": "export const WORKSHOP_LENGTH_MIN_MINUTES = 45;\nexport const WORKSHOP_LENGTH_MAX_MINUTES = 60;" }, "").violations.length,
    0,
  );
  add("a document still saying 90 minutes is caught", checkNoDurationInProse({}, "a 90-minute session").violations.length > 0, true);

  // 3 · the parsers.
  add("the pre-fix parser with no subject check is caught", checkParsersReject({ [`${EVENTS}/roomPacket.ts`]: PRE_FIX_PARSER }).violations.length > 0, true);
  add("a parser that FLAGS instead of rejecting is caught", checkParsersReject({ [`${EVENTS}/roomPacket.ts`]: FLAGGING_PARSER }).violations.length > 0, true);
  add("the real parser passes", checkParsersReject({ [`${EVENTS}/workshopPacket.ts`]: CLEAN_PARSER }).violations.length, 0);

  // 4 · the prompts.
  add("the pre-fix prompt asking for three concepts is caught", checkPromptsCarryTheRule({ [`${EVENTS}/roomPacket.ts`]: PRE_FIX_PROMPT }).violations.length > 0, true);
  add("the real prompt passes", checkPromptsCarryTheRule({ [`${EVENTS}/roomPacket.ts`]: CLEAN_PROMPT }).violations.length, 0);

  // 5 · a swallowed rejection.
  const swallowed = { [SERVICE]: "const parsed = parseConcepts(text, topic);\nif (!parsed) state.concepts = [];\n" };
  add("a rejection that does not fail the stage is caught", checkStageFails(swallowed).violations.length > 0, true);
  add(
    "the real shape passes",
    checkStageFails({ [SERVICE]: 'const parsed = parseConcepts(text, topic);\nif (!parsed) return await failStage("the angles");\n' }).violations.length,
    0,
  );

  // The empty-loop guards themselves.
  add("zero parsers is reported rather than passing", checkParsersReject({}).parsers, 0);
  add("zero prompts is reported rather than passing", checkPromptsCarryTheRule({}).prompts, 0);

  const failed = cases.filter((c) => !c.ok);
  for (const c of cases) console.log(`  ${c.ok ? "✓" : "✗"} ${c.name}`);
  if (failed.length > 0) {
    console.error(`\nANGLE SCAN SELF-TEST FAILED: ${failed.length} of ${cases.length} fixtures.`);
    process.exit(1);
  }
  console.log(`\nANGLE SCAN SELF-TEST PASSED: ${cases.length} fixtures, including the real pre-fix shapes.`);
}

// ── Main ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const sources = readTree(SRC);
  const doc = readFileSync(path.join(ROOT, DOC), "utf8");

  if (Object.keys(sources).length === 0) {
    console.error(`ANGLE SCAN FAILED — examined 0 sources under ${path.relative(ROOT, SRC)}.`);
    process.exit(1);
  }

  const plan = checkOnePlan(sources);
  const prose = checkNoDurationInProse(sources, doc);
  const parsers = checkParsersReject(sources);
  const prompts = checkPromptsCarryTheRule(sources);
  const stage = checkStageFails(sources);
  const document = checkDocumentIsRead();

  // THE EMPTY-LOOP GUARDS. Two streams each have a concepts parser and a concepts prompt. Finding
  // none means this scan is reading the wrong tree, not that the rule holds.
  if (parsers.parsers === 0) {
    console.error("ANGLE SCAN FAILED — found 0 concepts parsers. Two streams have one each; zero means the scan is looking in the wrong place.");
    process.exit(1);
  }
  if (prompts.prompts === 0) {
    console.error("ANGLE SCAN FAILED — found 0 concepts prompts.");
    process.exit(1);
  }
  if (plan.literalTables === 0) {
    console.error("ANGLE SCAN FAILED — found 0 month→topic tables; MONTHLY_PLAN must be one of them.");
    process.exit(1);
  }

  const violations = [...plan.violations, ...prose.violations, ...parsers.violations, ...prompts.violations, ...stage.violations, ...document.violations];
  if (violations.length > 0) {
    console.error("ANGLE SCAN FAILED — a month's packet could carry more than one subject, or a fact about it is retyped rather than derived:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nOne topic a month, per stream; the concepts are ANGLES on it — a different name, framing,");
    console.error("format, venue or experience, never a different subject. The topic is settled before ideation");
    console.error("and stored once; a model that answers with three subjects is REJECTED by the parser, which");
    console.error("fails the stage. See docs/WORKSHOPS.md and src/shared/events/monthlyPlan.ts.");
    process.exit(1);
  }

  console.log(
    `ANGLE SCAN PASSED: ${plan.literalTables} month→topic table (MONTHLY_PLAN), WORKSHOP_SERIES derived from it; ` +
      `${prose.scanned} sources and ${DOC} carry no retyped Workshop duration; ${parsers.parsers} concepts parser(s) ` +
      `each reject a divergent subject by returning null; ${prompts.prompts} concepts prompt(s) each state the rule; ` +
      `${stage.branches} parse(s) in the chain fail the stage on a rejection; ${document.readers} test(s) read ${DOC}.`,
  );
}
