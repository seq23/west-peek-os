#!/usr/bin/env node
/**
 * spent-attempts-are-terminal.mjs — `npm run validate:spent-attempts`.
 *
 * ONE ASSERTION: NOTHING IN THIS SYSTEM MAY HOLD A SPENT ATTEMPT COUNT IN A STATUS THAT STILL
 * LOOKS LIKE WORK. Running out of attempts is a TERMINAL state and has to be written down as one.
 *
 * ─── THE DEFECT, TWICE IN ONE DAY ──────────────────────────────────────────────────────────────
 *
 *   · `work_card`. "Draft event kit: October workshop with Kirx Diaz" — `state = OPEN`,
 *     `work_attempts = 3`, untouched for fourteen hours. `claimNextCard` takes OPEN and
 *     IN_PROGRESS cards UNDER the ceiling, so nothing could pick it up; it was not BLOCKED, so
 *     none of PR #94's machinery applied — no reason, no doors, no nag. It read as ordinary open
 *     work while being the thing the owner most wanted that day.
 *
 *   · `intelligence_report`. The same shape, the same morning: one partner's brief reached
 *     `GENERATING` with `attempts = 3` and `error_message` NULL, while the other's reached FAILED
 *     with a reason.
 *
 * Two tables grew the identical hole independently, which is what says a third will. This scan is
 * therefore TABLE-DRIVEN: `ATTEMPT_CAPPED` below is a register, and covering a new table is one
 * entry rather than a second validator.
 *
 * ─── TWO GUARDS, LINKED — NOT TWO GUARDS (18 Sep 2026) ─────────────────────────────────────────
 *
 * `intelligence_report`'s repair landed in PR #104 while this was being built, and it brought its
 * own scan: `validate:brief-ends-stated`. That one is DEEPER than a register entry could ever be —
 * it imports `briefTerminality` and runs it over the real cross-product of every status the
 * table's CHECK accepts by every attempt count either side of the cap. Re-checking that table
 * loosely from here would be strictly worse than what already exists.
 *
 * So the register does not duplicate it: it OWNS THE DEFECT CLASS and delegates the table. Each
 * entry names the guard responsible for it, and this scan fails if that guard is not registered in
 * `package.json` AND wired into CI. Two independent validators for one defect class, with nothing
 * linking them, is precisely the "two components each keeping their own list with no link" failure
 * that produced this bug in the first place — committing it in the guards would be a poor joke.
 *
 * The practical effect is the one that matters: `ATTEMPT_CAPPED` is now the single place that
 * knows this defect class exists, and adding the third table costs one entry AND forces whoever
 * adds it to name the guard that covers it.
 *
 * WHAT IS CHECKED, PER REGISTERED TABLE
 *
 *   1 · THE CEILING IS ONE NUMBER. The constant exists in TypeScript, and every SQL guard that
 *       encodes it uses the same value. A ceiling in code and a ceiling in the database with no
 *       link between them is how this comes back.
 *   2 · THE CLAIM BOUNDS ON THE CONSTANT, not on a literal. A query that inlined `3` would drift
 *       from the ceiling silently the first time the ceiling moved.
 *   3 · THE DATABASE REFUSES THE DEAD STATE. Both an INSERT and an UPDATE trigger, because SQLite
 *       fires one per statement kind and a rule enforced on only one of them is enforced on
 *       neither in practice.
 *   4 · SOMETHING SETTLES THE ONES THE TRIGGER CANNOT. A trigger cannot ask whether a lease has
 *       expired, so the settler must cover BOTH shapes the old query missed: a card in the
 *       claimable-but-idle state, and one whose lease is NULL. Missing either is what left the
 *       Kirx card sitting there.
 *   5 · THE BLOCK CARRIES THE FAILURE THE ROW ALREADY HOLDS rather than a fresh generic sentence.
 *       The material exists — it is written on every failed attempt — and throwing it away is how
 *       a terminal card ends up saying nothing useful.
 *   6 · EVERY WRITER THAT PUTS A ROW BACK INTO A CLAIMABLE STATE HAS AN OPINION ABOUT THE
 *       ALLOWANCE. A write that sets the state and says nothing about the count is the exact line
 *       that produced this bug.
 *
 * HARD-FAILS ON ZERO: zero registered tables, zero migrations read, zero put-back writes examined,
 * or zero checks performed, exits 1. A scan that examined nothing is not a passing scan.
 *
 * `--self-test` runs the defects this exists to catch through the same function and requires each
 * to be caught.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

const SWEEP = path.join("src", "worker", "services", "workSweep.ts");
const CARDS = path.join("src", "worker", "services", "workCards.ts");
const BLOCKS = path.join("src", "shared", "work", "blocks.ts");

/**
 * THE REGISTER. One entry per table that counts attempts against a ceiling.
 *
 * Adding a table here is the whole cost of covering it. See the coordination note above for
 * `intelligence_report`, which belongs here once its repair lands.
 */
export const ATTEMPT_CAPPED = [
  {
    table: "work_card",
    /** The npm script responsible for this table. THIS one — the checks below are its own. */
    ownedBy: "validate:spent-attempts",
    delegated: false,
    /** Where the ceiling is declared, and what it must be called. */
    ceilingFile: SWEEP,
    ceilingName: "MAX_WORK_ATTEMPTS",
    /** The statuses from which work is still picked up. Holding a spent count in one is the bug. */
    claimableStates: ["OPEN", "IN_PROGRESS"],
    /** The function that picks work up; it must bound on the constant. */
    claimFn: "claimNextCard",
    /** The function that settles rows the trigger cannot reason about. */
    settleFn: "settleAbandonedCards",
    settleFile: SWEEP,
    /** The column holding what the last failed attempt said, which the block must carry. */
    failureColumn: "work_last_failure",
    /** The triggers that make the dead state unwritable. */
    triggers: [
      "work_card_spent_attempts_cannot_be_open_insert",
      "work_card_spent_attempts_cannot_be_open_update",
    ],
  },
  {
    table: "intelligence_report",
    /*
     * DELEGATED, DELIBERATELY. `scripts/validate/a-brief-always-ends-stated.mjs` runs the real
     * `briefTerminality` over every status the table's CHECK accepts by every attempt count either
     * side of the cap — a far stronger assertion than anything this file could make about a table
     * it does not own. What is enforced HERE is only that the table is on the list and that its
     * guard is still registered and still runs, so the defect class has one register rather than
     * two disconnected ones.
     */
    ownedBy: "validate:brief-ends-stated",
    delegated: true,
  },
];

/** Comments out, line count preserved — prose must not decide the outcome in either direction. */
export function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/g, (_m, p1) => p1)
    .replace(/^\s*--[^\n]*/gm, "");
}

/** The body of a named function, braces balanced. Null when it is not there at all. */
export function functionBody(source, name) {
  const at = source.search(new RegExp(`function\\s+${name}\\s*\\(`));
  if (at < 0) return null;
  const open = source.indexOf("{", at);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  return null;
}

/**
 * The SET CLAUSE of every `UPDATE work_card` in a source.
 *
 * THE SET CLAUSE AND NOT THE STATEMENT, which the first version of this got wrong twice in one
 * run. `UPDATE work_card SET state = 'IN_PROGRESS' WHERE id = ?1 AND state = 'OPEN'` is a CLAIM —
 * the `state = 'OPEN'` in it is a predicate naming what the row must already be, not a write — and
 * flagging it accused the one path that is doing the right thing. Cutting at the first `WHERE`
 * separates "what this write sets" from "which rows it sets it on", which is the only question
 * being asked here.
 */
export function updateSetClauses(code, table = "work_card") {
  const out = [];
  const re = new RegExp(`UPDATE\\s+${table}\\b`, "g");
  let m;
  while ((m = re.exec(code)) !== null) {
    const rest = code.slice(m.index, m.index + 1200);
    const where = rest.search(/\bWHERE\b/i);
    out.push(where < 0 ? rest : rest.slice(0, where));
  }
  return out;
}

export function checkSources(sources, migrations, register = ATTEMPT_CAPPED, packageJson = "", ci = "") {
  const violations = [];
  let checks = 0;
  let putBacksExamined = 0;

  if (register.length === 0) {
    violations.push("the attempt-capped register is empty — this scan would pass by checking nothing.");
    return { violations, checks, putBacksExamined };
  }

  const allMigrations = Object.values(migrations).join("\n");

  /*
   * EVERY REGISTERED TABLE HAS A LIVE GUARD WITH ITS NAME ON IT. A register entry pointing at a
   * script that has been renamed, deleted, or quietly dropped out of CI is worse than no entry:
   * it reads as coverage.
   */
  for (const entry of register) {
    checks += 1;
    if (!entry.ownedBy) {
      violations.push(`${entry.table}: the register entry names no guard. An unowned table is an unguarded table.`);
      continue;
    }
    if (!new RegExp(`"${entry.ownedBy}"\\s*:`).test(packageJson ?? "")) {
      violations.push(
        `${entry.table}: its guard ${entry.ownedBy} is not a script in package.json. Either it was renamed ` +
          "and this entry was not, or the guard is gone and the table is covered by nothing.",
      );
    }
    if (!(ci ?? "").includes(entry.ownedBy)) {
      violations.push(
        `${entry.table}: its guard ${entry.ownedBy} is not run by CI. A validator nothing invokes is the ` +
          "\"exists but nothing invokes it\" defect, and this register exists to make that visible.",
      );
    }
  }

  for (const entry of register) {
    if (entry.delegated) continue;
    const ceilingSource = sources[entry.ceilingFile];
    if (!ceilingSource) {
      violations.push(`${entry.table}: ${entry.ceilingFile} is missing — the ceiling is declared nowhere.`);
      continue;
    }
    const code = stripComments(ceilingSource);

    // ── 1 · one ceiling, in code and in SQL ───────────────────────────────────────────────────
    checks += 1;
    const declared = new RegExp(`${entry.ceilingName}\\s*(?::\\s*number\\s*)?=\\s*(\\d+)`).exec(code);
    if (!declared) {
      violations.push(
        `${entry.table}: ${entry.ceilingName} is not declared in ${entry.ceilingFile}. The ceiling has to be ` +
          "one number that everything else is pinned to.",
      );
      continue;
    }
    const ceiling = Number(declared[1]);

    // ── 3 · the database refuses the dead state ───────────────────────────────────────────────
    for (const trigger of entry.triggers) {
      checks += 1;
      const at = allMigrations.indexOf(trigger);
      if (at < 0) {
        violations.push(
          `${entry.table}: no migration creates the trigger ${trigger}. A rule that lives only in a ` +
            "service is outrun by the next service — that is 0173's argument and it is the same one here.",
        );
        continue;
      }
      // …and it encodes the SAME ceiling. A trigger holding a different number is worse than none:
      // it looks enforced and guards a line nothing else agrees on.
      const body = allMigrations.slice(at, at + 900);
      const guarded = new RegExp(`work_attempts[^;]{0,60}>=\\s*(\\d+)`).exec(body);
      if (!guarded) {
        violations.push(`${entry.table}: ${trigger} does not compare the attempt count against a ceiling at all.`);
      } else if (Number(guarded[1]) !== ceiling) {
        violations.push(
          `${entry.table}: ${trigger} guards at ${guarded[1]} and ${entry.ceilingName} is ${ceiling}. A ceiling ` +
            "in code and a ceiling in the database with no link between them is this repo's recurring defect, " +
            "and it is exactly how this bug returns.",
        );
      }
      if (!/RAISE\s*\(\s*ABORT/.test(body)) {
        violations.push(
          `${entry.table}: ${trigger} does not RAISE(ABORT). A trigger that logs or corrects leaves the row ` +
            "writable, and a correcting one would hand a claimed card a fresh allowance on every claim.",
        );
      }
    }

    // ── 2 · the claim bounds on the constant ──────────────────────────────────────────────────
    checks += 1;
    const claim = functionBody(code, entry.claimFn);
    if (!claim) {
      violations.push(`${entry.table}: ${entry.claimFn} is gone — nothing picks the work up, or it was renamed.`);
    } else {
      if (!new RegExp(`${entry.ceilingName}`).test(claim)) {
        violations.push(
          `${entry.table}: ${entry.claimFn} does not bound on ${entry.ceilingName}. An inlined number drifts ` +
            "from the ceiling the first time the ceiling moves, silently.",
        );
      }
      if (!/work_attempts[\s\S]{0,40}<\s*\?/.test(claim)) {
        violations.push(
          `${entry.table}: ${entry.claimFn} no longer excludes rows at the ceiling. Either it picks up dead ` +
            "work forever, or the ceiling means nothing.",
        );
      }
    }

    // ── 4 · something settles what the trigger cannot ─────────────────────────────────────────
    checks += 1;
    const settleSource = sources[entry.settleFile];
    const settle = settleSource ? functionBody(stripComments(settleSource), entry.settleFn) : null;
    if (!settle) {
      violations.push(
        `${entry.table}: ${entry.settleFn} is gone. A trigger cannot ask whether a lease has expired, so ` +
          "without this nothing ever settles a row that died mid-run.",
      );
    } else {
      /*
       * THE SELECTION, NOT THE MENTION. The first version of this asked whether the state's NAME
       * appeared anywhere in the function — and passed a settler narrowed back to
       * `state = 'IN_PROGRESS'`, because the word OPEN still appeared further down in the
       * lease clause. What has to be true is that the settler's SELECT admits every claimable
       * state, so the list itself is read.
       */
      const selection = /state\s+IN\s*\(([^)]*)\)/i.exec(settle);
      if (!selection) {
        violations.push(
          `${entry.table}: ${entry.settleFn} does not select on a LIST of states. It selected IN_PROGRESS ` +
            "alone, and the card that started this was sitting in OPEN.",
        );
      } else {
        for (const state of entry.claimableStates) {
          if (!new RegExp(`'${state}'`).test(selection[1])) {
            violations.push(
              `${entry.table}: ${entry.settleFn} does not admit '${state}'. Every status the picker reads has ` +
                "to be settled, or a dead row hides in the one that was left out.",
            );
          }
        }
      }
      if (!/lease_until\s+IS\s+NULL/i.test(settle)) {
        violations.push(
          `${entry.table}: ${entry.settleFn} does not cover a NULL lease. releaseLease nulls it in the sweep's ` +
            "`finally` on every tick, so the ordinary dead card has no lease at all — requiring one excluded " +
            "exactly the row this scan exists for.",
        );
      }
      // ── 5 · the block carries the failure the row already holds ────────────────────────────
      checks += 1;
      if (!new RegExp(`${entry.failureColumn}`).test(settle)) {
        violations.push(
          `${entry.table}: ${entry.settleFn} does not read ${entry.failureColumn}. It is written on every failed ` +
            "attempt and already phrased for a partner; blocking the card with a fresh generic sentence " +
            "throws away the only material saying what actually happened.",
        );
      }
    }
  }

  // ── 6 · every put-back has an opinion about the allowance ───────────────────────────────────
  for (const [file, source] of Object.entries(sources)) {
    const code = stripComments(source);
    for (const statement of updateSetClauses(code)) {
      if (!/state\s*=\s*'OPEN'/.test(statement)) continue;
      putBacksExamined += 1;
      if (!/work_attempts/.test(statement)) {
        violations.push(
          `${file} writes state = 'OPEN' without saying anything about work_attempts. A card put back with its ` +
            "count still at the ceiling is unclaimable AND unexplained — which is the whole bug. Reset the " +
            "allowance, or decrement it deliberately.",
        );
      }
    }
  }

  /*
   * THE DYNAMIC WRITER. `handleUpdateWorkCard` builds its SET clause by joining a list, so it has
   * no literal `state = 'OPEN'` for the scan above to find — and it is the writer that actually
   * produced the bug. It is named explicitly rather than hoped for.
   */
  const cards = sources[CARDS];
  if (!cards) {
    violations.push(`${CARDS} is missing — the Work page's own update path cannot be checked.`);
  } else {
    checks += 1;
    putBacksExamined += 1;
    const handler = functionBody(stripComments(cards), "handleUpdateWorkCard");
    if (!handler) {
      violations.push(`${CARDS}: handleUpdateWorkCard is gone — the page's update path was renamed.`);
    } else if (!/work_attempts\s*=\s*0/.test(handler)) {
      violations.push(
        `${CARDS}: handleUpdateWorkCard does not reset work_attempts when it puts a card back. ` +
          "ALLOWED_TRANSITIONS permits BLOCKED → OPEN and IN_PROGRESS → OPEN from the Work page, and this " +
          "was the one door of the five that left the count at the ceiling.",
      );
    }
  }

  // The catalogue has to be able to carry the failure it is handed.
  const blocks = sources[BLOCKS];
  if (blocks) {
    checks += 1;
    const code = stripComments(blocks);
    const at = code.indexOf("stopped_part_way:");
    if (at < 0) {
      violations.push(`${BLOCKS}: the stopped_part_way reason is gone — a spent card has no catalogue entry.`);
    } else if (!/detail\?\.trim\(\)/.test(code.slice(at, at + 700))) {
      violations.push(
        `${BLOCKS}: stopped_part_way ignores the detail it is handed, so the last attempt's own words never ` +
          "reach the owner and she reads a generic sentence instead.",
      );
    }
  }

  return { violations, checks, putBacksExamined };
}

// ── self-test ────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  const cleanMigrations = {
    "0194.sql":
      "CREATE TRIGGER work_card_spent_attempts_cannot_be_open_insert BEFORE INSERT ON work_card WHEN NEW.state = 'OPEN' " +
      "BEGIN SELECT RAISE(ABORT, 'no') WHERE COALESCE(NEW.work_attempts, 0) >= 3; END;\n" +
      "CREATE TRIGGER work_card_spent_attempts_cannot_be_open_update BEFORE UPDATE ON work_card WHEN NEW.state = 'OPEN' " +
      "BEGIN SELECT RAISE(ABORT, 'no') WHERE COALESCE(NEW.work_attempts, 0) >= 3; END;",
  };
  const clean = {
    [SWEEP]:
      "export const MAX_WORK_ATTEMPTS = 3;\n" +
      "export async function claimNextCard(env, now) { return db.prepare(`SELECT id FROM work_card WHERE state IN ('OPEN','IN_PROGRESS') AND COALESCE(work_attempts, 0) < ?2`).bind(now, MAX_WORK_ATTEMPTS); }\n" +
      "export async function settleAbandonedCards(env, now) { const rows = db.prepare(`SELECT id, work_last_failure FROM work_card WHERE state IN ('OPEN', 'IN_PROGRESS') AND COALESCE(work_attempts, 0) >= ?1 AND (state = 'OPEN' OR lease_until IS NULL OR lease_until < ?2)`); return rows; }",
    [CARDS]:
      "export async function handleUpdateWorkCard(ctx) { const allowanceReset = putBack ? ', work_attempts = 0, work_steps = 0, lease_until = NULL' : ''; return run(allowanceReset); }",
    [BLOCKS]: "const CATALOGUE = { stopped_part_way: (f) => ({ needed: f.detail?.trim() || 'Say whether to try again.' }) };",
    "src/worker/services/blocks.ts":
      "await db.prepare(`UPDATE work_card SET state = 'OPEN', work_attempts = 0, lease_until = NULL WHERE id = ?1`).run();",
    // THE CLAIM, which names OPEN in its WHERE and must never be mistaken for a put-back.
    "src/worker/services/employeeWork.ts":
      "await db.prepare(\"UPDATE work_card SET state = 'IN_PROGRESS' WHERE id = ?1 AND state = 'OPEN'\").bind(id).run();",
  };

  const cases = {
    "an empty register": { sources: clean, migrations: cleanMigrations, register: [] },
    "no trigger in any migration": { sources: clean, migrations: {}, register: ATTEMPT_CAPPED },
    "a trigger guarding a different number from the constant": {
      sources: clean,
      migrations: { "0194.sql": cleanMigrations["0194.sql"].replace(/>= 3/g, ">= 5") },
      register: ATTEMPT_CAPPED,
    },
    "a trigger that logs instead of aborting": {
      sources: clean,
      migrations: { "0194.sql": cleanMigrations["0194.sql"].replace(/RAISE\(ABORT, 'no'\)/g, "'noted'") },
      register: ATTEMPT_CAPPED,
    },
    "only the UPDATE trigger, not the INSERT one": {
      sources: clean,
      migrations: {
        "0194.sql": cleanMigrations["0194.sql"].split("\n")[1],
      },
      register: ATTEMPT_CAPPED,
    },
    "a claim that inlines the ceiling": {
      sources: { ...clean, [SWEEP]: clean[SWEEP].replace("MAX_WORK_ATTEMPTS); }", "3); }") },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "a settler that only looks at IN_PROGRESS": {
      sources: { ...clean, [SWEEP]: clean[SWEEP].replace("state IN ('OPEN', 'IN_PROGRESS') AND COALESCE(work_attempts, 0) >= ?1", "state = 'IN_PROGRESS' AND COALESCE(work_attempts, 0) >= ?1") },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "a settler that requires a lease": {
      sources: { ...clean, [SWEEP]: clean[SWEEP].replace("lease_until IS NULL OR ", "") },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "a settler that throws the last failure away": {
      sources: { ...clean, [SWEEP]: clean[SWEEP].replace("work_last_failure", "title") },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "the Work page putting a card back at the ceiling": {
      sources: { ...clean, [CARDS]: "export async function handleUpdateWorkCard(ctx) { return run(sets.join(', ')); }" },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "a claim mistaken for a put-back (the scan's own first defect)": {
      sources: {
        ...clean,
        // If the WHERE clause were read as a write, this correct statement would be rejected.
        "src/worker/services/employeeWork.ts":
          "await db.prepare(\"UPDATE work_card SET state = 'OPEN' WHERE id = ?1 AND state = 'IN_PROGRESS'\").run();",
      },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "a service reopening a card and saying nothing about the count": {
      sources: {
        ...clean,
        "src/worker/services/blocks.ts": "await db.prepare(`UPDATE work_card SET state = 'OPEN', lease_until = NULL WHERE id = ?1`).run();",
      },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
    "a catalogue entry that ignores the failure it is handed": {
      sources: { ...clean, [BLOCKS]: "const CATALOGUE = { stopped_part_way: (f) => ({ needed: 'Say whether to try again.' }) };" },
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
    },
  };

  const cleanPackage = JSON.stringify({
    scripts: { "validate:spent-attempts": "node …", "validate:brief-ends-stated": "node …" },
  });
  const cleanCi = "- run: npm run validate:spent-attempts\n- run: npm run validate:brief-ends-stated";

  const ownership = {
    "a registered table whose guard is not a script at all": {
      sources: clean,
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
      packageJson: JSON.stringify({ scripts: { "validate:spent-attempts": "node …" } }),
      ci: cleanCi,
    },
    "a registered table whose guard has quietly dropped out of CI": {
      sources: clean,
      migrations: cleanMigrations,
      register: ATTEMPT_CAPPED,
      packageJson: cleanPackage,
      ci: "- run: npm run validate:spent-attempts",
    },
    "a register entry that names no guard at all": {
      sources: clean,
      migrations: cleanMigrations,
      register: [{ table: "somewhere_new" }],
      packageJson: cleanPackage,
      ci: cleanCi,
    },
  };

  const failures = [];
  const cleanResult = checkSources(clean, cleanMigrations, ATTEMPT_CAPPED, cleanPackage, cleanCi);
  if (cleanResult.violations.length > 0) {
    failures.push(`the clean fixture was rejected: ${cleanResult.violations.join("; ")}`);
  }
  if (cleanResult.checks === 0) failures.push("the clean fixture performed zero checks");
  if (cleanResult.putBacksExamined === 0) failures.push("the clean fixture examined zero put-back writes");
  for (const [name, fixture] of Object.entries(cases)) {
    const res = checkSources(fixture.sources, fixture.migrations, fixture.register, cleanPackage, cleanCi);
    if (res.violations.length === 0) failures.push(`NOT CAUGHT: ${name}`);
  }
  for (const [name, fixture] of Object.entries(ownership)) {
    const res = checkSources(fixture.sources, fixture.migrations, fixture.register, fixture.packageJson, fixture.ci);
    if (res.violations.length === 0) failures.push(`NOT CAUGHT: ${name}`);
  }

  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(
    `SELF-TEST PASSED: clean fixture passes; all ${Object.keys(cases).length + Object.keys(ownership).length} ` +
      "violating fixtures are caught, including a trigger guarding a different ceiling from the constant, a " +
      "settler that requires a lease, and a registered table whose guard has dropped out of CI.",
  );
  process.exit(0);
}

function readTree(dir, extensions) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (extensions.some((e) => entry.name.endsWith(e))) {
        out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
      }
    }
  };
  walk(dir);
  return out;
}

const sources = readTree(path.join(ROOT, "src"), [".ts", ".tsx"]);
if (Object.keys(sources).length === 0) {
  console.error("SPENT-ATTEMPTS SCAN FAILED — examined 0 sources under src/.");
  process.exit(1);
}
const migrationDir = path.join(ROOT, "migrations");
const migrations = {};
for (const name of readdirSync(migrationDir)) {
  if (name.endsWith(".sql")) migrations[name] = readFileSync(path.join(migrationDir, name), "utf8");
}
if (Object.keys(migrations).length === 0) {
  console.error("SPENT-ATTEMPTS SCAN FAILED — examined 0 migrations. The database half cannot be checked.");
  process.exit(1);
}

const packageJson = readFileSync(path.join(ROOT, "package.json"), "utf8");
const ci = readFileSync(path.join(ROOT, ".github", "workflows", "ci.yml"), "utf8");

const { violations, checks, putBacksExamined } = checkSources(sources, migrations, ATTEMPT_CAPPED, packageJson, ci);

if (checks === 0 || putBacksExamined === 0) {
  console.error(
    `SPENT-ATTEMPTS SCAN FAILED — performed ${checks} check(s) over ${putBacksExamined} put-back write(s).`,
  );
  console.error("Either the register is empty or every name in it was renamed. Both must fail loudly: a scan");
  console.error("that passes by finding nothing to check is the 'runs but inert' defect this repo keeps making.");
  process.exit(1);
}
if (violations.length > 0) {
  console.error("SPENT-ATTEMPTS SCAN FAILED — work can run out of attempts and still look like work:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nA row at its attempt ceiling in a status the picker still reads is unclaimable AND");
  console.error("unexplained: no reason, no doors, no nag. See migration 0194 and settleAbandonedCards.");
  process.exit(1);
}

console.log(
  `SPENT-ATTEMPTS SCAN PASSED: ${ATTEMPT_CAPPED.length} attempt-capped table(s), ${checks} check(s), ` +
    `${putBacksExamined} put-back write(s) across ${Object.keys(sources).length} sources and ` +
    `${Object.keys(migrations).length} migrations; the ceiling is one number in code and in SQL, the database ` +
    "refuses the dead state, the settler covers both shapes it can, and every put-back resets the allowance.",
);
