#!/usr/bin/env node
/**
 * AN ASK OF THE OWNER IS NEVER A TASK THE SYSTEM COULD DO (7 Oct 2026).
 *
 * Wyatt emailed Sequoia "a question — Deal-flow intake": forward the founder's email again, because
 * his card's tools could not open the stored message or put the company on the board. The message
 * was stored; the missing piece was an executor. Owner: "this friction should be fixed by you and
 * never happen again." This validator pins the four pieces that make it impossible:
 *
 *   1. GATE   — the employee loop's `blocked` branch runs `ownerAskRefusal` BEFORE any partner ask
 *               (`a_question_for_you`) is written, and no other file writes an employee's own
 *               model-written ask (`.needs`) as that reason without the gate.
 *   2. EXECUTORS — every action in `WORK_EXECUTORS` (shared/work/ownerAsk.ts) is a loop action
 *               (EMPLOYEE_ACTIONS) AND has a handler in employeeWork.ts. A capability on the map
 *               that nothing executes is "exists but nothing invokes it".
 *   3. FORWARDS — `readableMessage` decides by `isReplyMessage`, so a forward's original is kept.
 *   4. THE DOOR — an untagged forward whose original corroborates the company opens it in the
 *               funnel (`corroborated` in the inbound handler), and an ENGINEER stop never emails.
 *
 * `--self-test` breaks each piece in memory and proves the check goes red. Zero executors is a fail.
 * The behaviour (the real 7 Oct ask refused; legitimate asks allowed) is pinned in
 * tests/ownerAskGate.test.ts.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const F = {
  ownerAsk: "src/shared/work/ownerAsk.ts",
  loop: "src/shared/work/employeeLoop.ts",
  work: "src/worker/services/employeeWork.ts",
  intake: "src/worker/services/dealIntake.ts",
  inbound: "src/worker/effects/inboundEmail.ts",
  sweep: "src/worker/services/workSweep.ts",
};

function stripComments(source) {
  let out = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (m, lead) => lead + " ".repeat(m.length - lead.length));
  return out;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\./.test(name)) out.push(p);
  }
  return out;
}

/** The checks, over a map of file → source, so the self-test can hand in broken copies. */
export function check(src, otherWorkerFiles) {
  const problems = [];
  const work = stripComments(src.work);
  const loop = stripComments(src.loop);
  const ownerAsk = stripComments(src.ownerAsk);

  // 1. The gate precedes the partner ask in the blocked branch.
  const blockedAt = work.indexOf('if (d.action === "blocked")');
  if (blockedAt === -1) problems.push("employeeWork.ts has no blocked branch to gate");
  else {
    const gateAt = work.indexOf("ownerAskRefusal(", blockedAt);
    const askAt = work.indexOf('reason: "a_question_for_you"', blockedAt);
    if (gateAt === -1 || askAt === -1 || gateAt > askAt) problems.push("the blocked branch writes a partner ask without passing ownerAskRefusal first");
  }
  for (const [file, code] of otherWorkerFiles) {
    const c = stripComments(code);
    // A MODEL-WRITTEN ask (an employee's `.needs`) is what the gate governs. A runner's own fixed
    // wait for a partner's decision (Porter's "land it?" word) is a decision, which is hers.
    if (c.includes('reason: "a_question_for_you"') && /\.needs\b/.test(c) && !c.includes("ownerAskRefusal(")) {
      problems.push(`${file} writes an employee's own ask (a_question_for_you from .needs) without the owner-ask gate`);
    }
  }

  // 2. Every executor on the map is a loop action with a handler.
  const actions = [...ownerAsk.matchAll(/action:\s*"([a-z_]+)"/g)].map((m) => m[1]);
  if (actions.length === 0) problems.push("WORK_EXECUTORS lists no executor (zero items is a failure)");
  const loopActions = /EMPLOYEE_ACTIONS\s*=\s*\[([^\]]*)\]/.exec(loop)?.[1] ?? "";
  for (const a of actions) {
    if (!loopActions.includes(`"${a}"`)) problems.push(`executor action "${a}" is not in EMPLOYEE_ACTIONS`);
    if (!work.includes(`d.action === "${a}"`)) problems.push(`executor action "${a}" has no handler in employeeWork.ts`);
  }
  if (!work.includes("executorsFor(")) problems.push("employeeWork.ts never offers the executors a card's work calls for");

  // 3. Forwards keep their original.
  const rm = stripComments(src.intake).match(/export function readableMessage[\s\S]*?\n}/)?.[0] ?? "";
  if (!rm.includes("isReplyMessage(")) problems.push("readableMessage quote-strips without asking whether the message is a reply (a forward loses its original)");

  // 4. The door, and the ENGINEER stop.
  const inbound = stripComments(src.inbound);
  const untagged = inbound.indexOf("if (deal?.subjectUntagged)");
  if (untagged === -1 || !inbound.slice(untagged, untagged + 900).includes("deal.corroborated")) {
    problems.push("the inbound door refuses an untagged forward even when its original corroborates the company");
  }
  if (!/block_who === "ENGINEER"[\s\S]{0,200}return \{ emailed: null \}/.test(stripComments(src.sweep))) {
    problems.push("an ENGINEER stop can still reach a partner's inbox");
  }
  return problems;
}

function load() {
  const src = Object.fromEntries(Object.entries(F).map(([k, f]) => [k, readFileSync(path.join(ROOT, f), "utf8")]));
  const others = walk(path.join(ROOT, "src", "worker"))
    .filter((p) => !p.endsWith(path.join("services", "employeeWork.ts")))
    .map((p) => [path.relative(ROOT, p), readFileSync(p, "utf8")]);
  return { src, others };
}

if (process.argv.includes("--self-test")) {
  const { src, others } = load();
  const base = check(src, others);
  if (base.length) {
    console.error("self-test: the real tree must pass first:\n  " + base.join("\n  "));
    process.exit(1);
  }
  const breaks = [
    ["gate removed", { ...src, work: src.work.replace("ownerAskRefusal({", "noGate({") }, others],
    ["executor not a loop action", { ...src, loop: src.loop.replace('"open_in_funnel", ', "") }, others],
    ["executor has no handler", { ...src, work: src.work.replace('d.action === "open_in_funnel"', 'd.action === "nothing"') }, others],
    ["zero executors", { ...src, ownerAsk: src.ownerAsk.replace(/action:\s*"open_in_funnel"/, 'act: "x"') }, others],
    ["forward quote-stripped", { ...src, intake: src.intake.replace("!isReplyMessage(headers)", "false") }, others],
    ["corroborated forward refused", { ...src, inbound: src.inbound.replace(/else if \(deal\.corroborated\)/, "else if (false)").replace(/deal\.corroborated/g, "deal.nope") }, others],
    ["engineer stop emails", { ...src, sweep: src.sweep.replace('block_who === "ENGINEER"', 'block_who === "NOBODY"') }, others],
    ["ungated ask elsewhere", src, [...others, ["src/worker/services/fake.ts", 'await blockCard(env, card, { reason: "a_question_for_you", detail: decision.needs });']]],
  ];
  let failed = 0;
  for (const [name, s, o] of breaks) {
    const p = check(s, o);
    if (p.length === 0) {
      console.error(`self-test: breaking "${name}" did NOT turn the check red`);
      failed += 1;
    }
  }
  if (failed) process.exit(1);
  console.log(`owner-ask-gate self-test: ${breaks.length}/${breaks.length} breaks caught`);
} else {
  const { src, others } = load();
  const problems = check(src, others);
  if (problems.length) {
    console.error("owner-ask gate:\n  " + problems.join("\n  "));
    process.exit(1);
  }
  console.log("owner-ask gate: the blocked branch is gated, every executor is wired, forwards keep their original, ENGINEER stops stay off partner email");
}
