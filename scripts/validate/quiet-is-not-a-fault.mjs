#!/usr/bin/env node
/**
 * quiet-is-not-a-fault.mjs — `npm run validate:quiet-is-not-a-fault`.
 *
 * ONE ASSERTION: NO HEALTH CHECK CAN ASK FOR HER ATTENTION BECAUSE NOTHING HAPPENED.
 *
 * WHAT WENT WRONG, 18 Sep 2026. Her Home read:
 *
 *     Decks arriving · Needs a look · nothing has arrived for 25 days · last on 2026-08-23
 *
 * Every word of it true, and it was not a fault. Decks reach this firm a few times a month, so the
 * check was firing on the ordinary condition of the business it watched. Her reply: "decks arriving
 * is not broken. we just dont get decks every day."
 *
 * WHY THIS IS WORSE THAN NO CHECK. On the same screen, at the same moment, one of the morning briefs
 * was genuinely failing — wearing the same amber word. A board that spends attention on nothing does
 * not merely fail to inform; it teaches its reader that this board can be skimmed, and the next thing
 * she skims is the one that mattered. The alarm-fatigue literature is blunt about how fast that
 * happens and how invisible it is from inside.
 *
 * AND WHY RAISING THE THRESHOLD IS NOT THE FIX. Sixty days instead of seven still asserts that
 * silence is evidence. It is evidence of nothing: a quiet quarter and a mailbox that stopped
 * delivering are IDENTICAL in the arrivals table, which is exactly why counting days cannot tell
 * them apart. The honest question is whether the pipeline could receive one — a job that exists, is
 * switched on, is running to its own cadence, with somewhere to put the bytes and nothing sitting
 * unread — and that question is answerable without waiting for a founder to send anything.
 *
 * WHAT IS CHECKED, over every file that builds `HealthCheck`s:
 *   1 · NO `state:` EXPRESSION DEPENDS ON A SILENCE. Any local whose name measures how long it has
 *       been since something arrived is tainted, and so is anything derived from it, to any depth.
 *       `const stale = daysQuiet > 60; state: stale ? "DEGRADED" : "OK"` is the same defect wearing
 *       one more variable, and is caught.
 *   2 · THE SILENCE IS STILL REPORTED. At least one such measurement must reach a `reading:`. The
 *       fix is to stop treating quiet as a fault, NOT to stop telling her how quiet it has been —
 *       deleting the measurement would pass rule 1 and lose something worth knowing.
 *   3 · HARD-FAILS ON ZERO. Zero files, zero checks parsed, zero `state:` expressions or zero
 *       silence measurements anywhere all exit 1: this scan going blind must look like a failure,
 *       not like a clean board.
 *
 * `--self-test` feeds the REAL pre-fix block through the same functions and requires it to be
 * caught, alongside the shipped replacement, which must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER_DIR = path.join(ROOT, "src", "worker");

/**
 * What counts as measuring a silence.
 *
 * DELIBERATELY ABOUT ARRIVALS, NOT ABOUT AGE IN GENERAL. "It last RAN three days ago" is a fine
 * reason to go red — that is the machinery failing to do its job. "Nothing has ARRIVED for
 * twenty-five days" is a fact about the outside world. `sinceLastRunMs` must stay usable in a state
 * expression and `daysQuiet` must not, so the pattern names the second and not the first.
 */
const SILENCE = /(quiet|silen|last_?arrival|nothing_?arrived|days_?since_?(arriv|deck|last_?item))/i;

function readTree(dir, ext = ".ts") {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(ext)) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

export function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The body of every `checks.push({ … })` in a source file, brace-matched rather than regexed. */
export function pushBlocks(src) {
  const blocks = [];
  const marker = "checks.push({";
  let from = 0;
  for (;;) {
    const at = src.indexOf(marker, from);
    if (at === -1) break;
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (c === "{") depth += 1;
      else if (c === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    blocks.push(src.slice(at + marker.length, i));
    from = i + 1;
  }
  return blocks;
}

/**
 * Top-level `key: value` pairs of an object literal body, split on commas that are not inside a
 * nested brace, bracket, paren, string or template. A naive split on "," tears every ternary in this
 * file in half and would have this scan reading fragments.
 */
export function topLevelFields(body) {
  const fields = {};
  let depth = 0;
  let quote = null;
  let start = 0;
  const parts = [];
  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{" || c === "[" || c === "(") depth += 1;
    else if (c === "}" || c === "]" || c === ")") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  for (const part of parts) {
    const m = part.match(/^\s*([A-Za-z_$][\w$]*)\s*:/);
    if (!m) continue;
    fields[m[1]] = part.slice(part.indexOf(":") + 1);
  }
  return fields;
}

/** `const x = …;` initialisers, so a taint can be followed through them. */
export function declarations(src) {
  const decls = {};
  const re = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = re.lastIndex;
    let depth = 0;
    let quote = null;
    let i = start;
    for (; i < src.length; i += 1) {
      const c = src[i];
      if (quote) {
        if (c === "\\") i += 1;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{" || c === "[" || c === "(") depth += 1;
      else if (c === "}" || c === "]" || c === ")") depth -= 1;
      else if (c === ";" && depth === 0) break;
    }
    decls[m[1]] = src.slice(start, i);
  }
  return decls;
}

const identifiersIn = (text) => new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);

/**
 * Every identifier that measures a silence, or is computed from one — to any depth.
 *
 * The transitive half is the point. A direct-reference scan passes `const stale = daysQuiet > 60`
 * followed by `state: stale ? …`, which is the original defect with one more line in front of it.
 */
export function tainted(src) {
  const decls = declarations(src);
  const set = new Set(Object.keys(decls).filter((n) => SILENCE.test(n)));
  /*
   * Anything that COMPUTES AN AGE from a raw arrival column is a silence measurement too, however it
   * is named: `const gap = Date.now() - new Date(row.last_arrival).getTime()`.
   *
   * The arithmetic is part of the test on purpose. Without it, the row variable holding the QUERY —
   * whose SQL text mentions `last_arrival` because it selects it — is tainted, and with it every
   * honest fact the same query returns: "a deck arrived and was never read" would be unsayable. The
   * distinction is between selecting the column and measuring how long ago it was.
   */
  for (const [name, init] of Object.entries(decls)) {
    if (/last_?arrival/i.test(init) && /(Date\.now\(\)|getTime\(\)|86_?400_?000)/.test(init)) set.add(name);
  }
  for (let pass = 0; pass < 12; pass += 1) {
    let grew = false;
    for (const [name, init] of Object.entries(decls)) {
      if (set.has(name)) continue;
      for (const id of identifiersIn(init)) {
        if (set.has(id)) {
          set.add(name);
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }
  return set;
}

export function auditSource(rel, raw) {
  const src = stripComments(raw);
  const taint = tainted(src);
  const blocks = pushBlocks(src);
  const violations = [];
  let statesSeen = 0;
  let reportedQuiet = false;

  for (const body of blocks) {
    const fields = topLevelFields(body);
    const key = (fields.key ?? "").match(/["'`]([^"'`]+)/)?.[1] ?? "(unnamed)";
    if (fields.state !== undefined) {
      statesSeen += 1;
      const used = identifiersIn(fields.state);
      for (const id of used) {
        if (taint.has(id)) {
          violations.push(
            `${rel}: check "${key}" decides its state from ${id}, which measures how long it has been since ` +
              `something arrived. A quiet stretch is not a fault.`,
          );
        }
      }
      if (/last_?arrival/i.test(fields.state)) {
        violations.push(`${rel}: check "${key}" reads last_arrival directly in its state expression.`);
      }
    }
    if (fields.reading !== undefined) {
      for (const id of identifiersIn(fields.reading)) if (taint.has(id)) reportedQuiet = true;
      if (/last_?arrival/i.test(fields.reading)) reportedQuiet = true;
    }
  }

  return { violations, statesSeen, checksSeen: blocks.length, silenceMeasured: taint.size, reportedQuiet };
}

function selfTest() {
  const failures = [];
  const expect = (what, cond) => {
    if (!cond) failures.push(what);
  };

  // 1 · THE REAL PRE-FIX BLOCK, as it shipped and as she saw it.
  const shipped = `
    const decks = await one("pending_deck", "SELECT MAX(created_at) AS last_arrival FROM pending_deck");
    const QUIET_AFTER_DAYS = 7;
    const waiting = decks?.waiting ?? 0;
    const daysQuiet = decks?.last_arrival ? Math.floor((Date.now() - new Date(decks.last_arrival).getTime()) / 86400000) : null;
    checks.push({
      key: "deck_intake",
      label: "Decks arriving",
      state: waiting > 0 ? "OK" : daysQuiet === null ? "DEGRADED" : daysQuiet >= QUIET_AFTER_DAYS ? "DEGRADED" : "OK",
      reading: \`nothing has arrived for \${daysQuiet} days\`,
      page: "capture",
    });
  `;
  const a = auditSource("shipped.ts", shipped);
  expect("the shipped 25-day amber is caught", a.violations.some((v) => v.includes("daysQuiet")));

  // 2 · The same bug with a later fuse — the fix that is not a fix.
  const laterFuse = shipped.replace("const QUIET_AFTER_DAYS = 7;", "const QUIET_AFTER_DAYS = 60;");
  expect("raising the threshold is still caught", auditSource("later.ts", laterFuse).violations.length > 0);

  // 3 · One more variable in front of it.
  const indirect = `
    const decks = await one("pending_deck", "SELECT MAX(created_at) AS last_arrival FROM pending_deck");
    const daysQuiet = decks?.last_arrival ? 40 : null;
    const laneLooksStale = (daysQuiet ?? 0) > 30;
    checks.push({ key: "deck_intake", label: "Decks arriving", state: laneLooksStale ? "DEGRADED" : "OK", reading: \`\${daysQuiet} days\` });
  `;
  expect("a silence laundered through another variable is caught", auditSource("indirect.ts", indirect).violations.some((v) => v.includes("laneLooksStale")));

  // 4 · A silence measured under a name that hides it, from the raw column.
  const renamed = `
    const decks = await one("pending_deck", "SELECT MAX(created_at) AS last_arrival FROM pending_deck");
    const gap = decks?.last_arrival ? Date.now() - new Date(decks.last_arrival).getTime() : 0;
    const daysQuiet = gap;
    checks.push({ key: "deck_intake", label: "Decks arriving", state: gap > 1000 ? "DEGRADED" : "OK", reading: \`\${daysQuiet}\` });
  `;
  expect("a renamed silence is caught", auditSource("renamed.ts", renamed).violations.length > 0);

  // 5 · The shipped REPLACEMENT passes: faults come from the machinery, quiet only from the reading.
  const fixed = `
    const decks = await one("pending_deck", "SELECT MAX(created_at) AS last_arrival FROM pending_deck");
    const deckJob = await one("scheduled_job", "SELECT status FROM scheduled_job");
    const sinceLastRunMs = deckJob?.last_run_at ? Date.now() - new Date(deckJob.last_run_at).getTime() : null;
    const notRunning = sinceLastRunMs !== null && sinceLastRunMs > 100000;
    const daysQuiet = decks?.last_arrival ? 25 : null;
    const quietWords = \`nothing to read for \${daysQuiet} days\`;
    checks.push({
      key: "deck_intake",
      label: "Decks arriving",
      state: notRunning ? "DOWN" : "OK",
      reading: \`last checked · \${quietWords}\`,
      page: "capture",
    });
  `;
  const f = auditSource("fixed.ts", fixed);
  expect("the shipped replacement passes", f.violations.length === 0);
  expect("and the run-age fault is still allowed to be a fault", f.statesSeen === 1);
  expect("and the quiet is still reported", f.reportedQuiet);

  // 6 · Deleting the measurement is not the fix either: rule 2 must notice.
  const deleted = `
    checks.push({ key: "deck_intake", label: "Decks arriving", state: "OK", reading: "fine" });
  `;
  const d = auditSource("deleted.ts", deleted);
  expect("a board that stopped measuring the quiet at all is visible", !d.reportedQuiet && d.silenceMeasured === 0);

  // 7 · A file with nothing in it must not read as clean.
  expect("an empty file examines nothing", auditSource("empty.ts", "").checksSeen === 0);

  // 8 · The parser must survive the real ternaries: a check whose state spans five lines and
  //     contains commas inside nested calls is one field, not five.
  const gnarly = `
    const waiting = 0;
    checks.push({
      key: "x",
      label: "X",
      state:
        waiting > 0 ? "OK"
        : Math.max(1, 2) > 0 ? "DEGRADED"
        : "OK",
      reading: \`\${waiting} waiting\`,
    });
  `;
  expect("a multi-line ternary state is read as one field", auditSource("gnarly.ts", gnarly).statesSeen === 1);

  if (failures.length > 0) {
    console.error("QUIET-IS-NOT-A-FAULT SELF-TEST FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log("QUIET-IS-NOT-A-FAULT SELF-TEST PASSED (8 fixtures, including the block she was looking at on 18 Sep)");
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const files = Object.entries(readTree(WORKER_DIR)).filter(([, src]) => src.includes("checks.push({"));
  if (files.length === 0) {
    console.error("QUIET-IS-NOT-A-FAULT SCAN FAILED — found no file that builds health checks. Rule 0.");
    process.exit(1);
  }

  const violations = [];
  let checksSeen = 0;
  let statesSeen = 0;
  let silenceMeasured = 0;
  let reportedQuiet = false;
  for (const [rel, src] of files) {
    const r = auditSource(rel, src);
    violations.push(...r.violations);
    checksSeen += r.checksSeen;
    statesSeen += r.statesSeen;
    silenceMeasured += r.silenceMeasured;
    reportedQuiet ||= r.reportedQuiet;
  }

  if (checksSeen === 0 || statesSeen === 0) {
    console.error(
      `QUIET-IS-NOT-A-FAULT SCAN FAILED — parsed ${checksSeen} checks and ${statesSeen} state expressions from ` +
        `${files.length} file(s). Either the board stopped existing or this scan's parser lost its target; both are failures. Rule 0.`,
    );
    process.exit(1);
  }
  if (silenceMeasured === 0 || !reportedQuiet) {
    console.error(
      "QUIET-IS-NOT-A-FAULT SCAN FAILED — nothing on the board measures how long a lane has been quiet, or it\n" +
        "is measured and never shown. The fix was to stop treating quiet as a FAULT, not to stop telling her how\n" +
        "quiet it has been: \"nothing to read since 23 Aug\" is worth knowing and is not worth a light.",
    );
    process.exit(1);
  }

  if (violations.length > 0) {
    console.error("QUIET-IS-NOT-A-FAULT SCAN FAILED — a check asks for her attention because nothing happened:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nOperator, 18 Sep 2026: \"decks arriving is not broken. we just dont get decks every day.\" A check that\n" +
        "fires on the normal condition of the business spends the attention that the check next to it needed —\n" +
        "and on the morning she said that, the check next to it was genuinely failing. Ask whether the pipeline\n" +
        "could receive one, not whether one came.",
    );
    process.exit(1);
  }

  console.log(
    `QUIET-IS-NOT-A-FAULT SCAN PASSED: ${checksSeen} health check(s) across ${files.length} file(s), ` +
      `${statesSeen} state expression(s), none of them decided by a silence; ${silenceMeasured} silence ` +
      `measurement(s) still reported in a reading.`,
  );
}

main();
