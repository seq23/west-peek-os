#!/usr/bin/env node
/**
 * a-block-can-be-cleared.mjs — `npm run validate:blocks`.
 *
 * ONE ASSERTION: NO WORK CAN STOP WITHOUT TELLING THE OWNER WHAT STOPPED IT AND GIVING HER A WAY TO
 * ACT ON IT.
 *
 * WHAT WENT WRONG, 16 Sep 2026. Parker's October Workshop packet sat blocked with:
 *
 *   "Could not finish after 3 attempts. Last attempt: DISCOVER: the judgement pass failed: the
 *    judgement was routed to the search model. Decide what to do with it: reassign, rewrite the
 *    brief, or cancel."
 *
 * The operator: "i dont understand what he is blocked on and how to help him myself. the reasoning
 * sounds too technical." It never named the work (a workshop packet), it named three internal
 * things in eleven words, it offered three actions none of which would have helped, and there was
 * no button for any of them. Thirteen separate services each wrote their own version of that
 * sentence, so rewriting thirteen strings would have been true until somebody added a fourteenth.
 *
 * WHAT IS CHECKED
 *   1 · ONE FUNNEL. No worker source outside services/blocks.ts writes `state = 'BLOCKED'` on a
 *       work card. Everything goes through `blockCard`, which goes through the catalogue.
 *   2 · EVERY REASON IN THE CATALOGUE PASSES ITS OWN STANDARD — a `stopped` that is one finished
 *       sentence with no stack trace, error code, table or column name, function name or internal
 *       stage name in it; a `needed`; a named provider; and at least one way to act.
 *   3 · THE DATABASE REFUSES THE REST. Migration 0173 carries both triggers (insert and update),
 *       so a service that builds its SQL some way this scan cannot read is still stopped.
 *   4 · THE ACTION IS REAL. `answerBlock` puts the card back to OPEN and resets its attempts — a
 *       blocked card is invisible to the sweep's claim, so an answer that only records itself is
 *       the "runs but inert" defect with a text box on it.
 *
 * Comments and string-free prose are stripped before scanning, so the paragraphs above — and the
 * ones in blocks.ts quoting the old reason verbatim — cannot make the scan pass or fail.
 *
 * HARD-FAILS ON ZERO. Zero sources read, zero catalogue entries audited, or zero block-writing
 * sites found all exit 1: an empty loop reporting success is the defect class this repo calls
 * Rule 0.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside a clean fixture that must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const WORKER_DIR = path.join(ROOT, "src", "worker");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const FUNNEL = path.join("services", "blocks.ts");

/** Comments out, so prose quoting a bad reason cannot trip the scan. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".ts")) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

/**
 * 1 · Who WRITES BLOCKED on a work card — a WRITE, never a READ (22 Sep 2026).
 *
 * `state = 'BLOCKED'` is bare text that a SET clause and a WHERE clause are spelled identically:
 * `UPDATE work_card SET state = 'BLOCKED' …` and `… WHERE wc.state = 'BLOCKED'` differ only in
 * which keyword governs them, not in the substring this scan matched on. `STALE_REASON_SQL`
 * (notifications.ts) reads whether a card IS BLOCKED — `NOT EXISTS (SELECT 1 FROM work_card wc
 * WHERE wc.state = 'BLOCKED')` — to decide whether ITS OWN notice is stale, which is exactly the
 * comparison the funnel rule was never meant to reach: nothing there sets a card's state at all.
 * The un-narrowed regex flagged it anyway, which is a false alarm in the validator, not a new
 * bypass of the funnel — the scan's job is to find where BLOCKED gets WRITTEN.
 *
 * So a candidate only counts as a write when the nearest governing keyword before the match is
 * SET, not WHERE: a plain SQL assignment has no WHERE between its SET clause and the column it is
 * setting, while a comparison is reached only after a WHERE (or an AND chained from one).
 */
export function checkFunnel(sources) {
  const violations = [];
  let sites = 0;
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    // Any UPDATE/INSERT naming work_card and setting state to BLOCKED, however it is spaced.
    const candidates = src.matchAll(/work_card[\s\S]{0,400}?state\s*=\s*'BLOCKED'/g);
    const hits = [];
    for (const m of candidates) {
      const window = m[0];
      const lastSet = window.lastIndexOf("SET");
      const lastWhere = window.lastIndexOf("WHERE");
      // No SET governing it at all, or a WHERE sits between the SET and the match (so the match is
      // actually inside that WHERE's own comparison, not the SET clause it followed): not a write.
      if (lastSet === -1 || lastWhere > lastSet) continue;
      hits.push(window);
    }
    if (hits.length === 0) continue;
    sites += hits.length;
    if (!file.endsWith(FUNNEL)) {
      violations.push(`${file} sets a work card to BLOCKED directly (${hits.length} site(s)) — call blockCard() so the reason comes from the catalogue`);
    }
  }
  return { sites, violations };
}

/** 2 · The catalogue, audited through the module that the worker itself uses. */
export async function checkCatalogue() {
  const mod = await import(path.join(ROOT, "src", "shared", "work", "blocks.ts"));
  const audited = mod.auditCatalogue();
  const violations = audited
    .filter((a) => a.problems.length > 0)
    .map((a) => `block reason "${a.reason}" is not fit for a partner to read: ${a.problems.join("; ")}`);
  return { audited: audited.length, reasons: mod.BLOCK_REASONS.length, violations };
}

/** 3 · The database's own refusal, which does not depend on this scan being able to read the SQL. */
export function checkTriggers(migrations) {
  const violations = [];
  const all = Object.values(migrations).join("\n");
  for (const trigger of ["work_card_block_must_be_readable_insert", "work_card_block_must_be_readable_update"]) {
    if (!all.includes(trigger)) violations.push(`migration trigger ${trigger} is missing — the database would accept a block with no reason`);
  }
  for (const column of ["block_stopped", "block_needed", "block_who", "block_actions_json"]) {
    if (!new RegExp(`NEW\\.${column}`).test(all)) violations.push(`no trigger checks ${column} — a block could land without it`);
  }
  /*
   * 5 · A BLOCKED CARD ALWAYS HAS A REMINDER (0255, 9 Oct 2026). Scooter's spam card was re-opened by a
   * wrongly recorded answer with block_nag_at wiped; put back to BLOCKED by hand, it would never have
   * rung. Both triggers must exist AND must be the repairing kind: on a BLOCKED row with a NULL reminder,
   * set one. A trigger by the right name that does not set block_nag_at guards nothing.
   */
  for (const trigger of ["work_card_blocked_keeps_its_nag_update", "work_card_blocked_keeps_its_nag_insert"]) {
    const at = all.indexOf(`CREATE TRIGGER IF NOT EXISTS ${trigger}`);
    if (at === -1) {
      violations.push(`migration trigger ${trigger} is missing — a BLOCKED card could be left with no reminder (block_nag_at NULL)`);
      continue;
    }
    const body = all.slice(at, all.indexOf("END;", at));
    if (!/NEW\.state\s*=\s*'BLOCKED'/.test(body) || !/NEW\.block_nag_at\s+IS\s+NULL/i.test(body) || !/SET\s+block_nag_at\s*=/i.test(body)) {
      violations.push(`migration trigger ${trigger} does not set block_nag_at on a BLOCKED card that has none — it guards nothing`);
    }
  }
  return { violations };
}

/** 4 · The answer actually puts the work back in the queue. */
export function checkAnswerReopens(sources) {
  const violations = [];
  const src = stripComments(sources[path.join("src", "worker", "services", "blocks.ts")] ?? "");
  if (!src) return { violations: ["services/blocks.ts was not read — the scan cannot see the unblock path"] };
  const answer = src.slice(src.indexOf("export async function answerBlock"));
  if (!/state\s*=\s*'OPEN'/.test(answer)) violations.push("answerBlock never returns a card to OPEN — the sweep only claims OPEN and IN_PROGRESS, so the answer would never be read");
  if (!/work_attempts\s*=\s*0/.test(answer)) violations.push("answerBlock never resets work_attempts — a card at its attempt cap is not claimable however it is answered");
  if (!/work_card_note/.test(answer)) violations.push("answerBlock leaves no note — the employee loop reads notes, not columns, so the answer would not reach the prompt");
  return { violations };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

const SELF_TEST = {
  "the real pre-fix workSweep": {
    sources: {
      "src/worker/services/workSweep.ts": `
        const why = \`Could not finish after 3 attempts. Last attempt: \${detail}.\`;
        await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = ?2 WHERE id = ?1").bind(card.id, why).run();
      `,
    },
    expect: /sets a work card to BLOCKED directly/,
  },
  "a block written in a comment is NOT a violation": {
    sources: {
      "src/worker/services/notes.ts": `
        // Once upon a time this did: UPDATE work_card SET state = 'BLOCKED' WHERE id = ?1
        const x = 1;
      `,
      "src/worker/services/blocks.ts": "UPDATE work_card SET state = 'BLOCKED'",
    },
    expect: null,
  },
  /*
   * THE REAL FALSE ALARM (22 Sep 2026). `STALE_REASON_SQL` in notifications.ts asks whether a
   * card IS BLOCKED so it can retire ITS OWN notice — a READ, never a write — and the un-narrowed
   * scan flagged it anyway because `state = 'BLOCKED'` reads identically whether it follows SET or
   * WHERE. This is the exact shape that regressed the validator; it must stay clean.
   */
  "a read-only WHERE comparison is NOT a violation": {
    sources: {
      "src/worker/services/notifications.ts": `
        const STALE_REASON_SQL = \`CASE
          WHEN n.object_type = 'work_card' AND NOT EXISTS (
                 SELECT 1 FROM work_card wc
                  WHERE wc.id = n.object_id
                    AND wc.state = 'BLOCKED')
            THEN 'RESOLVED'
          ELSE NULL
        END\`;
      `,
    },
    expect: null,
  },
  "an answer that only records itself": {
    answerSources: {
      "src/worker/services/blocks.ts": `
        export async function answerBlock(env, id, who, input) {
          await env.WP_OS_DB.prepare("UPDATE work_card SET block_answer = ?2 WHERE id = ?1").bind(id, input.text).run();
        }
      `,
    },
    expect: /never returns a card to OPEN/,
  },
  "migrations with no trigger": {
    migrations: { "0001.sql": "ALTER TABLE work_card ADD COLUMN block_stopped TEXT;" },
    expect: /work_card_block_must_be_readable_insert is missing/,
  },
  "no reminder guard (the 9 Oct 2026 shape)": {
    migrations: { "0001.sql": "ALTER TABLE work_card ADD COLUMN block_stopped TEXT;" },
    expect: /work_card_blocked_keeps_its_nag_update is missing/,
  },
  "a reminder guard that repairs nothing": {
    migrations: {
      "0255.sql":
        "CREATE TRIGGER IF NOT EXISTS work_card_blocked_keeps_its_nag_update AFTER UPDATE ON work_card WHEN NEW.state = 'BLOCKED' AND NEW.block_nag_at IS NULL BEGIN SELECT 1; END;\n" +
        "CREATE TRIGGER IF NOT EXISTS work_card_blocked_keeps_its_nag_insert AFTER INSERT ON work_card WHEN NEW.state = 'BLOCKED' AND NEW.block_nag_at IS NULL BEGIN UPDATE work_card SET block_nag_at = 'x' WHERE id = NEW.id; END;",
    },
    expect: /work_card_blocked_keeps_its_nag_update does not set block_nag_at/,
  },
};

async function selfTest() {
  let failed = 0;
  for (const [name, c] of Object.entries(SELF_TEST)) {
    const found = [
      ...(c.sources ? checkFunnel(c.sources).violations : []),
      ...(c.answerSources ? checkAnswerReopens(c.answerSources).violations : []),
      ...(c.migrations ? checkTriggers(c.migrations).violations : []),
    ];
    const caught = c.expect === null ? found.length === 0 : found.some((v) => c.expect.test(v));
    if (!caught) {
      console.error(`SELF-TEST FAILED — "${name}": expected ${c.expect ?? "no violation"}, got ${JSON.stringify(found)}`);
      failed += 1;
    }
  }
  // The clean fixture: the catalogue as it actually ships must pass.
  const cat = await checkCatalogue();
  if (cat.violations.length > 0) {
    console.error(`SELF-TEST FAILED — the shipped catalogue does not pass its own standard: ${cat.violations.join("; ")}`);
    failed += 1;
  }
  if (failed > 0) process.exit(1);
  console.log(`SELF-TEST PASSED: ${Object.keys(SELF_TEST).length} fixtures behave as stated; the shipped catalogue passes.`);
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const sources = readTree(WORKER_DIR);
  const migrations = Object.fromEntries(
    readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .map((f) => [f, readFileSync(path.join(MIGRATIONS_DIR, f), "utf8")]),
  );

  if (Object.keys(sources).length === 0) {
    console.error(`BLOCK SCAN FAILED — examined 0 worker sources under ${path.relative(ROOT, WORKER_DIR)}.`);
    process.exit(1);
  }
  if (Object.keys(migrations).length === 0) {
    console.error(`BLOCK SCAN FAILED — examined 0 migrations under ${path.relative(ROOT, MIGRATIONS_DIR)}.`);
    process.exit(1);
  }

  const funnel = checkFunnel(sources);
  const catalogue = await checkCatalogue();
  const triggers = checkTriggers(migrations);
  const answer = checkAnswerReopens(sources);

  // THE EMPTY-LOOP GUARDS. Work stops sometimes; a scan that finds nowhere it can stop is looking
  // in the wrong place, not proving the rule.
  if (funnel.sites === 0) {
    console.error("BLOCK SCAN FAILED — found 0 sites where worker code blocks a work card.");
    console.error("Something has to be able to stop work. Zero means this scan is reading the wrong tree.");
    process.exit(1);
  }
  if (catalogue.audited === 0 || catalogue.audited !== catalogue.reasons) {
    console.error(`BLOCK SCAN FAILED — audited ${catalogue.audited} catalogue entries against ${catalogue.reasons} declared reasons.`);
    process.exit(1);
  }

  const violations = [...funnel.violations, ...catalogue.violations, ...triggers.violations, ...answer.violations];
  if (violations.length > 0) {
    console.error("BLOCK SCAN FAILED — work can stop in a way the owner cannot read or act on:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nA block is four sentences and at least one door: what the employee was trying to do, what");
    console.error("stopped them in one plain sentence, what would clear it, and who can provide that. The");
    console.error("catalogue in src/shared/work/blocks.ts is the only place those sentences are written, and");
    console.error("services/blocks.ts is the only path that writes the state. See migration 0173.");
    process.exit(1);
  }

  console.log(
    `BLOCK SCAN PASSED: ${funnel.sites} block-writing site(s) across ${Object.keys(sources).length} worker ` +
      `sources, all inside services/blocks.ts; ${catalogue.audited} catalogue reason(s) each carrying a plain ` +
      `sentence, a named provider and a way to act; both database triggers and both reminder guards present across ` +
      `${Object.keys(migrations).length} migrations; an answer reopens the card and reaches the employee.`,
  );
}
