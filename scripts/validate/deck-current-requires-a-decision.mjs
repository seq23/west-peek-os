#!/usr/bin/env node
/**
 * deck-current-requires-a-decision.mjs — `npm run validate:deck-decision`.
 *
 * ONE ASSERTION: NO CODE PATH CAN MAKE A DECK VERSION CURRENT WITHOUT AN EXPLICIT HUMAN DECISION.
 *
 * `deck_version` holds the document West Peek shows limited partners. Which row is CURRENT is not a
 * detail of the record, it IS the answer to "what do we send" — so writing that value is a decision,
 * not a side effect of storing a file.
 *
 * WHAT WENT WRONG, 9 Sep 2026, and why a comment was not enough to stop it. `recordDeckVersion`
 * inserted `origin === "UPLOADED" ? "CURRENT" : "PROPOSED"` and then superseded whatever was current.
 * The reasoning read plausibly — an upload is "what the firm actually sent" — and it made RECORDING
 * a PDF indistinguishable from CHOOSING it. Preston's rebuild job cannot attach its own render (the
 * build script runs on the operator's Mac, not in the Worker), so the coordinator uploaded the render
 * to supply the missing file, and that upload silently displaced the operator's Canva deck as the
 * firm's LP document. A second upload meant to undo it made a third copy of a PDF already on the
 * record. Two junk rows and a wrong current deck, from someone only trying to attach a file. See
 * migration 0155.
 *
 * The system already held the right rule for a BUILT version — Preston may write one and may not
 * decide it goes out. Uploads skipped the gate. This scan is what stops the gate being skipped again
 * by anything, however reasonable the next reason sounds.
 *
 * WHAT IS CHECKED
 *   1 · `recordDeckVersion` — the one function every new version passes through — contains no
 *       CURRENT literal at all. Every version arrives PROPOSED whatever its provenance.
 *   2 · Every write of `state = 'CURRENT'` on deck_version in worker code lives inside a function on
 *       the human-decision allowlist (today: `handleDecideDeck`, and nothing else).
 *   3 · Each of those functions actually holds the human gate — a refusal when `actor.type` is not
 *       HUMAN — so being on the allowlist is earned rather than asserted.
 *   4 · A MIGRATION may set CURRENT (0155 is exactly that, correcting a displaced deck), but only
 *       while naming the human who decided: the same statement must set `approved_by`. A migration
 *       that promotes a version with nobody's name on it is the same defect wearing SQL.
 *
 * Comments are stripped before scanning, so the prose above — and the prose in deck.ts explaining
 * all of this — cannot make the scan pass or fail.
 *
 * HARD-FAILS ON ZERO. A scan that examined no files, found no CURRENT-writing site, or read no
 * migration exits 1. An empty loop reporting success is the defect class this repo names Rule 0.
 *
 * `--self-test` feeds the REAL pre-fix source through the same functions and requires it to be
 * caught, alongside a clean fixture that must pass.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER_DIR = path.join(ROOT, "src", "worker");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

/**
 * The functions permitted to write CURRENT, each with the reason.
 *
 * ADDING A NAME HERE MUST BE A DELIBERATE ACT. That is the point of the list: the pre-fix defect was
 * not a typo, it was a plausible-sounding sentence in a code comment. A reviewer adding an entry has
 * to say who the human is and where they decide.
 */
const HUMAN_DECISION_FUNCTIONS = new Map([
  [
    "handleDecideDeck",
    "POST /api/deck/versions/:id/decide — refuses a non-HUMAN actor outright, then records approved_by and approved_at",
  ],
]);

/** A refusal keyed on the actor being human. Both spellings of the quote, and either comparison. */
const HUMAN_GATE = /actor\.type\s*!==?\s*["']HUMAN["']|actor\.type\s*===?\s*["']HUMAN["']/;

/** Any CURRENT string literal in code. */
const CURRENT_LITERAL = /["']CURRENT["']/;

/**
 * Strip comments while preserving line count, so line numbers still identify the offending code and
 * documentation can never decide the outcome.
 */
export function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
  return out;
}

/**
 * Which top-level function a line belongs to, or null outside every function.
 *
 * Deliberately crude and deliberately CLOSED: anything the walker cannot attribute to a named
 * function reports as null and is therefore a violation, rather than being waved through. A scan
 * that fails open on code it cannot parse is not a scan.
 */
function functionAtLine(lines, index) {
  for (let i = index; i >= 0; i -= 1) {
    const m = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_$]+)/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

/** Violations in a map of { relativePath: source } of TypeScript. Also returns what it examined. */
export function checkWorkerSources(sources) {
  const violations = [];
  let currentWriteSites = 0;
  let sawRecordDeckVersion = false;

  for (const [file, raw] of Object.entries(sources)) {
    if (!raw.includes("deck_version")) continue;
    const code = stripComments(raw);
    const lines = code.split("\n");

    // 1 · recordDeckVersion carries no CURRENT literal anywhere in its body.
    const start = code.indexOf("export async function recordDeckVersion");
    if (start !== -1) {
      sawRecordDeckVersion = true;
      const after = code.indexOf("\nexport ", start + 1);
      const body = code.slice(start, after === -1 ? code.length : after);
      if (CURRENT_LITERAL.test(body)) {
        violations.push(
          `${file}: recordDeckVersion contains a CURRENT literal. Every version — uploaded or built — ` +
            `must arrive PROPOSED; recording a deck is not choosing it.`,
        );
      }
      if (!/["']PROPOSED["']/.test(body)) {
        violations.push(
          `${file}: recordDeckVersion never binds PROPOSED. It is the only state a new version may ` +
            `be inserted with, so its absence means the state is coming from somewhere unchecked.`,
        );
      }
    }

    // 2 · Every CURRENT-writing site is inside an allowlisted human-decision function.
    lines.forEach((line, i) => {
      if (!CURRENT_LITERAL.test(line)) return;
      // Reads are not decisions: comparing a row's state, or filtering a list, writes nothing.
      const writes = /state\s*=\s*['"]CURRENT['"]/.test(line) || /,\s*["']CURRENT["']/.test(line) || /["']CURRENT["']\s*,/.test(line);
      if (!writes) return;
      currentWriteSites += 1;
      const fn = functionAtLine(lines, i);
      if (!fn || !HUMAN_DECISION_FUNCTIONS.has(fn)) {
        violations.push(
          `${file}:${i + 1}: writes CURRENT from ${fn ? `${fn}()` : "outside any named function"}, which is ` +
            `not a human-decision path. Only ${[...HUMAN_DECISION_FUNCTIONS.keys()].join(", ")} may make a deck current.`,
        );
      }
    });

    // 3 · The allowlisted functions really do refuse a non-human actor.
    for (const [name] of HUMAN_DECISION_FUNCTIONS) {
      const at = code.indexOf(`export async function ${name}`);
      if (at === -1) continue;
      const after = code.indexOf("\nexport ", at + 1);
      const body = code.slice(at, after === -1 ? code.length : after);
      if (!HUMAN_GATE.test(body)) {
        violations.push(
          `${file}: ${name}() is on the human-decision allowlist but no longer refuses a non-HUMAN ` +
            `actor. The allowlist is earned by that check, not by the name.`,
        );
      }
    }
  }

  if (!sawRecordDeckVersion) {
    violations.push(
      "recordDeckVersion was not found in any scanned source. Every new deck version passes through " +
        "it; if it has moved or been renamed, this scan is no longer guarding the path it exists for.",
    );
  }

  return { violations, currentWriteSites };
}

/** Violations in a map of { file: sql }. A migration may promote a version; it may not do so anonymously. */
export function checkMigrations(sources) {
  const violations = [];
  let promotions = 0;
  for (const [file, sql] of Object.entries(sources)) {
    if (!/deck_version/.test(sql)) continue;
    // Statement-by-statement, so an approved_by elsewhere in the file cannot cover a bare promotion.
    for (const statement of sql.split(";")) {
      if (!/UPDATE\s+deck_version/i.test(statement)) continue;
      if (!/state\s*=\s*'CURRENT'/i.test(statement)) continue;
      promotions += 1;
      if (!/approved_by\s*=/i.test(statement)) {
        violations.push(
          `${file}: a statement sets deck_version.state = 'CURRENT' without setting approved_by. ` +
            `A migration may correct which deck is current — that is what 0155 does — but it must ` +
            `name the human whose decision it is.`,
        );
      }
    }
  }
  return { violations, promotions };
}

// ── self-test ─────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];

  const cleanDeck = [
    "export async function recordDeckVersion(env, actor, input) {",
    '  await db.prepare("INSERT INTO deck_version (state) VALUES (?1)").bind("PROPOSED").run();',
    "}",
    "export async function handleDecideDeck(ctx) {",
    '  if (actor.type !== "HUMAN") return json({ error: "forbidden" }, { status: 403 });',
    "  await db.prepare(\"UPDATE deck_version SET state = 'SUPERSEDED' WHERE state = 'CURRENT'\").run();",
    "  await db.prepare(\"UPDATE deck_version SET state = 'CURRENT', approved_by = ?2 WHERE id = ?1\").run();",
    "}",
  ].join("\n");
  const clean = { "src/worker/services/deck.ts": cleanDeck };
  if (checkWorkerSources(clean).violations.length !== 0) failures.push("clean worker fixture was flagged");
  if (checkWorkerSources(clean).currentWriteSites === 0) failures.push("clean fixture found no CURRENT write site to attribute");

  const cases = {
    // The ACTUAL pre-fix line, verbatim. This is the regression that cost the LP deck.
    "an upload makes itself current (the 9 Sep defect, verbatim)": {
      "src/worker/services/deck.ts": cleanDeck.replace(
        '.bind("PROPOSED")',
        '.bind(input.origin === "UPLOADED" ? "CURRENT" : "PROPOSED")',
      ),
    },
    "a new helper promotes a version outside the decision handler": {
      "src/worker/services/deck.ts": cleanDeck,
      "src/worker/services/publish.ts": [
        "export async function publishDeck(env, id) {",
        "  await db.prepare(\"UPDATE deck_version SET state = 'CURRENT' WHERE id = ?1\").run();",
        "}",
      ].join("\n"),
    },
    "the decision handler stops refusing non-humans": {
      "src/worker/services/deck.ts": cleanDeck.replace('if (actor.type !== "HUMAN")', "if (false)"),
    },
    "a comment cannot substitute for the gate": {
      "src/worker/services/deck.ts": cleanDeck.replace(
        'if (actor.type !== "HUMAN") return json({ error: "forbidden" }, { status: 403 });',
        '// actor.type !== "HUMAN" is refused elsewhere',
      ),
    },
    "recordDeckVersion no longer binds PROPOSED": {
      "src/worker/services/deck.ts": cleanDeck.replace('.bind("PROPOSED")', ".bind(state)"),
    },
    "recordDeckVersion has vanished, so nothing is guarded": {
      "src/worker/services/other.ts": "export async function unrelated() { return 1; } // deck_version",
    },
  };
  for (const [name, files] of Object.entries(cases)) {
    if (checkWorkerSources(files).violations.length === 0) failures.push(`violating worker fixture NOT caught: ${name}`);
  }

  const cleanMigration = {
    "0155.sql": "UPDATE deck_version SET state = 'CURRENT', approved_by = 'fu_sequoia_taylor' WHERE id = 'x';",
  };
  if (checkMigrations(cleanMigration).violations.length !== 0) failures.push("clean migration fixture was flagged");
  if (checkMigrations(cleanMigration).promotions !== 1) failures.push("clean migration fixture found no promotion");
  const anonymous = { "0156.sql": "UPDATE deck_version SET state = 'CURRENT' WHERE id = 'x';" };
  if (checkMigrations(anonymous).violations.length === 0) failures.push("violating migration fixture NOT caught: anonymous promotion");

  return failures;
}

// ── real tree ─────────────────────────────────────────────────────────────────────────────────

function readTree(dir, ext) {
  const out = {};
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

if (process.argv.includes("--self-test")) {
  const failures = selfTest();
  if (failures.length > 0) {
    console.error("SELF-TEST FAILED:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: clean fixtures pass; all 6 worker regressions and the anonymous migration promotion are caught.");
  process.exit(0);
}

const worker = readTree(WORKER_DIR, ".ts");
const migrations = readTree(MIGRATIONS_DIR, ".sql");

if (Object.keys(worker).length === 0) {
  console.error(`DECK DECISION SCAN FAILED — examined 0 worker sources under ${path.relative(ROOT, WORKER_DIR)}.`);
  process.exit(1);
}
if (Object.keys(migrations).length === 0) {
  console.error(`DECK DECISION SCAN FAILED — examined 0 migrations under ${path.relative(ROOT, MIGRATIONS_DIR)}.`);
  process.exit(1);
}

const w = checkWorkerSources(worker);
const m = checkMigrations(migrations);

// The empty-loop guard that matters most. If no code anywhere writes CURRENT, this scan proved
// nothing — the value is being set somewhere it cannot see, or the table has been reworked and the
// guard needs rewriting rather than quietly congratulating itself.
if (w.currentWriteSites === 0) {
  console.error("DECK DECISION SCAN FAILED — found 0 sites where worker code writes deck_version CURRENT.");
  console.error("A deck has to become current somehow. Zero sites means this scan is looking in the wrong");
  console.error("place, not that the rule is satisfied.");
  process.exit(1);
}
if (m.promotions === 0) {
  console.error("DECK DECISION SCAN FAILED — found 0 migration statements promoting a deck version.");
  console.error("Migration 0155 restores v2 as the current deck; if no such statement is visible, this");
  console.error("scan is not reading the migrations it claims to check.");
  process.exit(1);
}

const violations = [...w.violations, ...m.violations];
if (violations.length > 0) {
  console.error("DECK DECISION SCAN FAILED — a deck can be made current without a human deciding:");
  for (const v of violations) console.error(`  ✗ ${v}`);
  console.error("\nRecording a version and deciding it is the one that goes to limited partners are");
  console.error("DIFFERENT ACTS. Everything that writes a version inserts PROPOSED; a human moves it to");
  console.error("CURRENT through handleDecideDeck, which refuses any non-human actor. Migration 0155 is");
  console.error("what the previous shortcut cost.");
  process.exit(1);
}

console.log(
  `DECK DECISION SCAN PASSED: ${w.currentWriteSites} CURRENT-writing site(s) across ` +
    `${Object.keys(worker).length} worker sources, all inside handleDecideDeck behind its human gate; ` +
    `recordDeckVersion inserts PROPOSED only; ${m.promotions} migration promotion(s) across ` +
    `${Object.keys(migrations).length} migrations, each naming the human who decided.`,
);
