#!/usr/bin/env node
/**
 * a-finished-card-files-its-work.mjs — `npm run validate:card-files-work`.
 *
 * ONE ASSERTION: A WORK CARD CANNOT REACH DONE WITHOUT PROOF THAT SOMETHING EXISTS.
 *
 * WHAT WENT WRONG. The owner asked for a one-off: Parker drafts an event kit for an October
 * workshop with Kirx Diaz, previewed to her before it goes to Scooter. Parker did the work — five
 * COMPLETED `ai_run` rows on a free reasoning lane at $0, the last carrying a genuinely complete
 * kit: three angles, a recommendation with reasoning, a run of show with an on-screen column, a
 * discussion guide, social drafts. Then:
 *
 *     work_card         state = DONE, work_attempts = 1
 *     deliverable       NO row
 *     work_packet       0 rows
 *     preview_approval  0 rows
 *     email to her      none
 *
 * The generic employee loop's `done` branch was `appendFinding` followed by `state = 'DONE'`. A
 * finding is a bullet appended to `work_card.description` and truncated at 8,000 characters, on a
 * card that is now closed and off every list a person looks at. The kit was in that bullet and
 * nowhere else, and she had been told it would be emailed to her.
 *
 * THAT IS RULE 0 — "no stage may exit 0 having done nothing" — on the single piece of work the
 * owner most wanted that day.
 *
 * WHAT IS CHECKED, AND WHY IT IS STRUCTURE RATHER THAN A SEARCH FOR THE BUG
 *
 *   1 · EVERY `state = 'DONE'` IN `employeeWork.ts` IS INSIDE `closeCard`. Exactly one statement in
 *       the file may close a card. A rule enforced at each closing site is a rule the third site,
 *       written next month, will not know about — and there were already two sites, one correct
 *       (a handover) and one the bug.
 *
 *   2 · `closeCard` TAKES A `CloseProof`. The type has two constructors, `FILED` and `HANDED_ON`,
 *       and each demands the id of something that now exists. A boolean `filed: true` would have
 *       been satisfied by a caller that passed `true` and filed nothing, which is the same defect
 *       one layer up.
 *
 *   3 · EVERY CALL TO `closeCard` PASSES ONE OF THE TWO REAL SHAPES. A call site is read and its
 *       proof argument matched; anything else fails.
 *
 *   4 · THE `done` BRANCH FILES BEFORE IT CLOSES. `fileFinishedWork` must be called, and its result
 *       must be what `closeCard` is given. Filing after closing would leave the window this
 *       validator exists to shut.
 *
 *   5 · `fileFinishedWork` DOES NOT SWALLOW. Every other `deliver()` caller in the repo wraps it in
 *       a try/catch so a filing failure cannot take down the brief or packet it belongs to. Here
 *       the filing IS the work product, so the failure must propagate and leave the card open. A
 *       try/catch around the `deliver()` call in that function is the defect wearing a hat, and it
 *       fails here.
 *
 * HARD-FAILS ON ZERO: zero `DONE` writes found, zero `closeCard` calls found, or the source file
 * missing each exit 1. An empty loop reporting success is Rule 0, and a validator that passes
 * because a refactor renamed the thing it looks for is the failure mode this repo keeps hitting.
 *
 * `--self-test` feeds the REAL pre-fix source shapes through the same functions and requires every
 * one to be caught, alongside the real current file, which must pass.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const TARGET = path.join(ROOT, "src", "worker", "services", "employeeWork.ts");

/** Strip line and block comments so a sentence ABOUT the bug is never mistaken for the bug. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** The body of a named function, by brace matching from its declaration. */
function functionBody(src, name) {
  const decl = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!decl) return null;
  const open = src.indexOf("{", decl.index + decl[0].length);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return null;
}

export function auditSource(rawSrc) {
  const problems = [];
  const src = stripComments(rawSrc);

  // ── 1 · every DONE write lives in closeCard ──────────────────────────────────────────────────
  const doneWrites = [...src.matchAll(/state\s*=\s*'DONE'/g)];
  const closeBody = functionBody(src, "closeCard");

  if (!closeBody) {
    problems.push("closeCard() is missing: there is no single gated statement that closes a card.");
  }

  const doneInClose = closeBody ? [...closeBody.matchAll(/state\s*=\s*'DONE'/g)].length : 0;
  if (doneWrites.length !== doneInClose) {
    problems.push(
      `${doneWrites.length} statement(s) set state = 'DONE' but only ${doneInClose} are inside closeCard(). ` +
        "A card may be closed from exactly one place, or the rule is one a future site will not know about.",
    );
  }

  // ── 2 · closeCard demands a proof ────────────────────────────────────────────────────────────
  const sig = /function\s+closeCard\s*\([^)]*proof\s*:\s*CloseProof/.test(src);
  if (!sig) {
    problems.push("closeCard() does not take a `proof: CloseProof`. A close with no proof is a close with no artifact.");
  }

  // ── 3 · every call passes a real shape ───────────────────────────────────────────────────────
  const calls = [...src.matchAll(/closeCard\s*\(\s*env\s*,\s*card\s*,\s*(\{[^}]*\})/g)];
  if (calls.length === 0) {
    problems.push("ZERO closeCard() call sites found. Nothing closes a card, or the call shape changed and this check went blind.");
  }
  for (const c of calls) {
    const arg = c[1];
    const filed = /closed:\s*"FILED"/.test(arg) && /deliverableId:/.test(arg);
    const handed = /closed:\s*"HANDED_ON"/.test(arg) && /toCardId:/.test(arg);
    if (!filed && !handed) {
      problems.push(`A closeCard() call passes a proof that is neither FILED (with a deliverableId) nor HANDED_ON (with a toCardId): ${arg.replace(/\s+/g, " ")}`);
    }
  }

  // ── 4 · the done branch files, and files FIRST ───────────────────────────────────────────────
  const apply = functionBody(src, "applyDecision");
  if (!apply) {
    problems.push("applyDecision() is missing: the branch that finishes a card cannot be checked.");
  } else {
    const fileAt = apply.indexOf("fileFinishedWork(");
    const filedClose = apply.search(/closeCard\s*\(\s*env\s*,\s*card\s*,\s*\{\s*closed:\s*"FILED"/);
    if (fileAt === -1) {
      problems.push("applyDecision() never calls fileFinishedWork(). A card that finishes files nothing, which is the October event kit defect exactly.");
    } else if (filedClose === -1) {
      problems.push("applyDecision() files work but never closes against it with a FILED proof.");
    } else if (fileAt > filedClose) {
      problems.push("applyDecision() closes the card BEFORE filing its work. Filing must happen first, or a filing failure still leaves a closed card with nothing behind it.");
    }
  }

  // ── 5 · filing does not swallow ──────────────────────────────────────────────────────────────
  const fileBody = functionBody(src, "fileFinishedWork");
  if (!fileBody) {
    problems.push("fileFinishedWork() is missing.");
  } else if (/\btry\s*\{/.test(fileBody)) {
    problems.push(
      "fileFinishedWork() wraps its filing in a try/catch. Every other deliver() caller may swallow; this one may not — " +
        "here the filing IS the work product, and a swallowed failure closes the card with nothing behind it.",
    );
  }

  return { problems, examined: { doneWrites: doneWrites.length, closeCalls: calls.length } };
}

// ── THE REAL PRE-FIX SHAPES, for --self-test ───────────────────────────────────────────────────

const GOOD = `
async function closeCard(env: Env, card: CardRow, proof: CloseProof): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(card.id).run();
}
async function fileFinishedWork(env, actor, card, finding, name) {
  const delivered = await deliver(env, actor, { kind: WORK_RESULT_KIND });
  return { deliverableId: delivered.id, recipient: {} };
}
async function applyDecision(env, ctx, card, d, step) {
  if (d.action === "assign") {
    await closeCard(env, card, { closed: "HANDED_ON", toCardId: handed.cardId });
    return { step, action: "assigned", detail: "" };
  }
  const filed = await fileFinishedWork(env, actor, card, d.finding!, employeeName);
  await closeCard(env, card, { closed: "FILED", deliverableId: filed.deliverableId });
  return { step, action: "done", detail: "" };
}
`;

/** Exactly what stood in employeeWork.ts before this fix. */
const PRE_FIX = `
async function applyDecision(env, ctx, card, d, step) {
  if (d.action === "assign") {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(card.id).run();
    return { step, action: "assigned", detail: "" };
  }
  await appendFinding(env, card, d.finding!);
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(card.id).run();
  return { step, action: "done", detail: "" };
}
`;

const CLOSES_BEFORE_FILING = GOOD.replace(
  `  const filed = await fileFinishedWork(env, actor, card, d.finding!, employeeName);
  await closeCard(env, card, { closed: "FILED", deliverableId: filed.deliverableId });`,
  `  await closeCard(env, card, { closed: "FILED", deliverableId: "dlv_later" });
  const filed = await fileFinishedWork(env, actor, card, d.finding!, employeeName);`,
);

const SWALLOWS = GOOD.replace(
  `  const delivered = await deliver(env, actor, { kind: WORK_RESULT_KIND });
  return { deliverableId: delivered.id, recipient: {} };`,
  `  try {
    const delivered = await deliver(env, actor, { kind: WORK_RESULT_KIND });
    return { deliverableId: delivered.id, recipient: {} };
  } catch { return { deliverableId: "", recipient: {} }; }`,
);

const UNGATED_EXTRA_CLOSE = GOOD.replace(
  `  return { step, action: "done", detail: "" };`,
  `  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(card.id).run();
  return { step, action: "done", detail: "" };`,
);

const BOOLEAN_PROOF = GOOD.replace("proof: CloseProof", "proof: boolean");

const COMMENT_ONLY = `
// This file used to do: UPDATE work_card SET state = 'DONE' with nothing filed.
/* The done branch was appendFinding then state = 'DONE'. */
${GOOD}
`;

function selfTest() {
  const cases = [
    ["a clean file", GOOD, false],
    ["the real pre-fix source", PRE_FIX, true],
    ["closing before filing", CLOSES_BEFORE_FILING, true],
    ["a filing that swallows", SWALLOWS, true],
    ["a second, ungated DONE write", UNGATED_EXTRA_CLOSE, true],
    ["a boolean instead of a CloseProof", BOOLEAN_PROOF, true],
    ["prose about the bug, in comments", COMMENT_ONLY, false],
  ];
  let bad = 0;
  for (const [name, src, shouldFail] of cases) {
    const { problems } = auditSource(src);
    const failed = problems.length > 0;
    if (failed !== shouldFail) {
      bad += 1;
      console.error(`  ✗ self-test "${name}": expected ${shouldFail ? "a failure" : "a pass"}, got ${failed ? "a failure" : "a pass"}`);
      for (const p of problems) console.error(`      ${p}`);
    } else {
      console.log(`  ✓ self-test "${name}"`);
    }
  }
  if (bad > 0) {
    console.error(`\na-finished-card-files-its-work: ${bad} self-test(s) failed.`);
    process.exit(1);
  }
  console.log(`a-finished-card-files-its-work --self-test: ${cases.length} cases, all as expected.`);
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  if (!existsSync(TARGET)) {
    console.error(`a-finished-card-files-its-work: ${path.relative(ROOT, TARGET)} does not exist. Nothing examined.`);
    process.exit(1);
  }

  const { problems, examined } = auditSource(readFileSync(TARGET, "utf8"));

  // HARD-FAIL ON ZERO. A file with no DONE writes and no closeCard calls is a file this validator
  // no longer understands, not a file that passes.
  if (examined.doneWrites === 0 || examined.closeCalls === 0) {
    console.error(
      `a-finished-card-files-its-work: examined ZERO items (${examined.doneWrites} DONE writes, ${examined.closeCalls} closeCard calls). ` +
        "Either the closing path moved or this check went blind. Passing on an empty loop is Rule 0.",
    );
    process.exit(1);
  }

  if (problems.length > 0) {
    console.error("a-finished-card-files-its-work: a card can reach DONE without its work reaching anybody.\n");
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error("\nSee src/shared/work/finishedWork.ts for what this exists to prevent.");
    process.exit(1);
  }

  console.log(
    `a-finished-card-files-its-work: OK — ${examined.doneWrites} DONE write(s), all inside closeCard(); ` +
      `${examined.closeCalls} close(s), every one carrying proof of something that exists.`,
  );
}

main();
