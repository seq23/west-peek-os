#!/usr/bin/env node
/**
 * partner-service-rules.mjs — `npm run validate:partner-service-rules` (6 Oct 2026).
 *
 * `docs/PARTNER_SERVICE_RULES.md` is the owner's full numbered list of what a partner may expect
 * from any employee working a card. A specification no code reads is a wish, so this reads it:
 *
 *   1 · every rule line is numbered, tagged ALL-KINDS or REPO-ONLY, quotes the owner, and names a
 *       code anchor `path#export`;
 *   2 · every anchor EXISTS — the file is in the tree and the export (a function, const, class,
 *       interface, type, or a markdown heading for a prompt file) is declared in it;
 *   3 · no card kind opts out of the shared block template: the only service that writes
 *       `state = 'BLOCKED'` is `services/blocks.ts` (the one block door), and every `blockCard(`
 *       call site imports it from there;
 *   4 · NO ALL-KINDS RULE IS PORTER-ONLY (0254, owner 6 Oct 2026: "make sure all ai agents who do work
 *       on work cards couldn't benefit from some of them"). A rule tagged ALL-KINDS and still marked
 *       `shared layer: follow-up` FAILS the build — "Porter-only: 0" is printed on every green run;
 *   5 · THE SHARED PROMPT FRAGMENT IS INCLUDED BY EVERY DUTY. `src/shared/work/partnerPractices.ts`
 *       carries one line per prompt-enforced rule; every ALL-KINDS rule anchored on
 *       `PARTNER_PRACTICES` must have its line there, and the fragment must reach: `steerFor` (so every
 *       chain the sweep dispatches — each of which must call `steerFor`), the general employee loop
 *       (`practices` into `buildStepPrompt`), and Porter's Mac duty (`practices` on the job, printed
 *       by `renderContext`). The fragment itself must be composed by `practicesForCard`;
 *   6 · EVERY KIND'S BLOCK IS THREE PARTS, CLEARED BY EMAIL (R7/R8): every reason in the block
 *       catalogue, rendered through `blockSentence`, reads "Waiting on: … Why: … To clear it by email:
 *       …" and contains none of `WAIT_TEXT_FORBIDDEN` ("on the card", "on the Work page", "ask
 *       Sequoia", an OS link); and the stale-block reminder composes from `blockWaitDetail`.
 *
 * Pass count = rules + files + catalogue reasons. Hard-fails on zero rules (Rule 0). `--self-test`
 * plants each failure and asserts it is caught.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";
import { loadTs } from "./lib/load-ts.mjs";

/** The shared stripper, under the name the scans-read-code guard looks for: product source is read without its comments. */
const stripComments = stripCommentsFor;

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DOC = "docs/PARTNER_SERVICE_RULES.md";
const BLOCK_DOOR = "src/worker/services/blocks.ts";

const RULE = /^- R(\d+) \[(ALL-KINDS|REPO-ONLY)\] (.+?) — owner: (.+?) — anchor: `([^`]+)`(.*)$/;

/** The rules out of the document. */
export function parseRules(markdown) {
  const rules = [];
  const problems = [];
  for (const line of String(markdown).split(/\r?\n/)) {
    if (!line.startsWith("- R")) continue;
    const m = RULE.exec(line);
    if (!m) {
      problems.push(`a rule line does not match the shape: ${line.slice(0, 90)}`);
      continue;
    }
    const [, n, tag, text, owner, anchor, rest] = m;
    const [file, exportName] = anchor.split("#");
    rules.push({ n: Number(n), tag, text, owner, file, exportName: exportName ?? "", followUp: /shared layer: follow-up/.test(rest ?? "") });
  }
  const seen = new Set();
  for (const r of rules) {
    if (seen.has(r.n)) problems.push(`R${r.n} appears twice`);
    seen.add(r.n);
    if (!r.exportName) problems.push(`R${r.n} names no export in its anchor`);
    if (r.text.length < 20) problems.push(`R${r.n} is too short to be a rule`);
  }
  return { rules, problems };
}

/** Does the file declare the export (or, for a markdown file, the heading)? */
export function anchorExists(file, exportName, readText = (rel) => (existsSync(path.join(ROOT, rel)) ? readFileSync(path.join(ROOT, rel), "utf8") : null)) {
  const text = readText(file);
  if (text === null) return { ok: false, why: `${file} is not in the tree` };
  if (/\.md$/.test(file)) {
    return /^#{1,6}\s+(.+)$/m.test(text) && new RegExp(`^#{1,6}\\s+${exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "m").test(text) ? { ok: true } : { ok: false, why: `${file} has no heading "${exportName}"` };
  }
  const esc = exportName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declared = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class|interface|type|enum)\\s+${esc}\\b`, "m").test(text) || new RegExp(`^export\\s*\\{[^}]*\\b${esc}\\b[^}]*\\}`, "m").test(text);
  return declared ? { ok: true } : { ok: false, why: `${file} does not export ${exportName}` };
}

/** Every service file that writes a BLOCKED state or calls blockCard, and whether it is the one door. */
export function checkBlockWriters(files) {
  const v = [];
  let examined = 0;
  for (const [rel, source] of Object.entries(files)) {
    examined += 1;
    const s = stripComments(rel, source);
    // A WRITE of the state (UPDATE … SET … 'BLOCKED', or an INSERT with it) — a WHERE that reads it is not a write.
    if (rel !== BLOCK_DOOR && (/UPDATE\s+work_card\s+SET(?:(?!WHERE|`|;)[\s\S])*state\s*=\s*'BLOCKED'/i.test(s) || /INSERT INTO work_card(?:(?!`|;)[\s\S])*'BLOCKED'/i.test(s))) {
      v.push(`${rel} writes state = 'BLOCKED' itself — a kind opting out of the shared block template`);
    }
    if (rel !== BLOCK_DOOR && /\bblockCard\(/.test(s) && !/import \{[^}]*\bblockCard\b[^}]*\} from "\.\/blocks"/.test(s) && !/import \{[^}]*\bblockCard\b[^}]*\} from "\.\.\/services\/blocks"/.test(s)) {
      v.push(`${rel} calls blockCard without importing it from services/blocks.ts`);
    }
  }
  if (examined === 0) v.push("no service files examined (Rule 0)");
  return { violations: v, examined };
}

function serviceFiles() {
  const dir = path.join(ROOT, "src/worker/services");
  const out = {};
  for (const name of readdirSync(dir)) if (/\.ts$/.test(name)) out[`src/worker/services/${name}`] = readFileSync(path.join(dir, name), "utf8");
  return out;
}

/** The runner modules the sweep dispatches by kind: `(await import("./x")).runY` in workSweep.ts. */
export function dispatchedRunners(sweepSource) {
  return [...new Set([...String(sweepSource).matchAll(/\(await import\("\.\/([A-Za-z]+)"\)\)\.run[A-Za-z]+/g)].map((m) => `src/worker/services/${m[1]}.ts`))];
}

/** Where the shared fragment must be included — each a file and a needle in its code (comments stripped). */
export const INCLUSIONS = [
  { file: "src/worker/services/partnerConstraints.ts", needle: "partnerPracticesBlock(", why: "practicesForCard composes the shared fragment" },
  { file: "src/worker/services/instruction.ts", needle: "practicesForCard(", why: "steerFor appends the fragment to every chain's steer text" },
  { file: "src/worker/services/employeeWork.ts", needle: "practices: await practicesForCard(", why: "the general employee loop carries the fragment" },
  { file: "src/shared/work/employeeLoop.ts", needle: "ctx.practices", why: "buildStepPrompt prints the fragment" },
  { file: "src/worker/services/webPropertyChange.ts", needle: "practices: await practicesForCard(", why: "Porter's job carries the fragment to the Mac" },
  { file: "scripts/duties/web-property-change.mjs", needle: "job.practices", why: "renderContext prints the fragment into Porter's prompt" },
  { file: "src/worker/services/blocks.ts", needle: "blockWaitDetail(", why: "the stale-block reminder is three parts" },
  { file: "src/shared/work/blocks.ts", needle: "blockWaitDetail(", why: "blockSentence is three parts for every kind" },
  { file: "src/worker/services/emailThread.ts", needle: "blockReplyDoor(", why: "an email reply's words take the door the block email offers" },
  { file: "src/worker/services/workSweep.ts", needle: "deferDatedItems(", why: "every kind's dated deferred lines become cards" },
  { file: "src/worker/services/dealIntake.ts", needle: "recordDriveWatches(", why: "the door records the Drive folders an ask names" },
  { file: "scripts/claimer/local-job-claimer.mjs", needle: "await checkDriveWatches()", why: "the Mac's heartbeat maps the watched folders" },
];

/**
 * Checks 4–6. `texts` is { rel: source }, `practices` the PARTNER_PRACTICES array, `catalogue` an array
 * of { reason, sentence } rendered through blockSentence, `forbidden` WAIT_TEXT_FORBIDDEN.
 */
export function checkSharedLayer(rules, { texts, practices, catalogue, forbidden }) {
  const v = [];
  let examined = 0;
  const allKinds = rules.filter((r) => r.tag === "ALL-KINDS");
  for (const r of allKinds) if (r.followUp) v.push(`R${r.n} [ALL-KINDS] is still Porter-only ("shared layer: follow-up") — lift it to the shared layer`);
  const inFragment = new Set((practices ?? []).map((p) => p.rule));
  for (const r of rules) {
    if (r.exportName === "PARTNER_PRACTICES" && !inFragment.has(`R${r.n}`)) v.push(`R${r.n} is anchored on the shared prompt fragment but PARTNER_PRACTICES has no line for it`);
  }
  for (const p of practices ?? []) {
    const r = rules.find((x) => `R${x.n}` === p.rule);
    if (!r) v.push(`PARTNER_PRACTICES carries ${p.rule}, which the rules document does not list`);
    else if (r.tag !== "ALL-KINDS") v.push(`PARTNER_PRACTICES carries ${p.rule}, which is REPO-ONLY — a repo rule does not belong in every employee's prompt`);
  }
  if (!practices || practices.length === 0) v.push("PARTNER_PRACTICES is empty (Rule 0)");
  const code = (rel) => (texts[rel] === undefined ? null : stripComments(rel, texts[rel]));
  for (const inc of INCLUSIONS) {
    examined += 1;
    const c = code(inc.file);
    if (c === null) v.push(`${inc.file} is not in the tree (${inc.why})`);
    else if (!c.includes(inc.needle)) v.push(`${inc.file} does not include the shared layer: ${inc.why} (looked for \`${inc.needle}\`)`);
  }
  const runners = dispatchedRunners(code("src/worker/services/workSweep.ts") ?? "").filter((f) => !f.endsWith("/webPropertyChange.ts"));
  if (runners.length < 5) v.push(`only ${runners.length} runner(s) found in the sweep's dispatch — the scan cannot see the kinds (Rule 0)`);
  for (const f of runners) {
    examined += 1;
    const c = code(f);
    if (c === null) v.push(`${f} is dispatched by the sweep but is not in the tree`);
    else if (!c.includes("steerFor(")) v.push(`${f} is dispatched by the sweep but never calls steerFor — its prompts miss the shared partner practices`);
  }
  if (!catalogue || catalogue.length === 0) v.push("no block reasons rendered (Rule 0)");
  for (const { reason, sentence } of catalogue ?? []) {
    examined += 1;
    if (!/^Waiting on: .+[.?!] Why: .+[.?!] To clear it by email: .+[.?!]/s.test(sentence)) v.push(`block "${reason}" is not three parts: ${sentence.slice(0, 120)}`);
    for (const re of forbidden ?? []) if (re.test(sentence)) v.push(`block "${reason}" sends the partner somewhere other than their inbox (${re}): ${sentence.slice(0, 120)}`);
  }
  return { violations: v, examined, runners };
}

export function runAll(markdown, files, readText, shared) {
  const { rules, problems } = parseRules(markdown);
  const violations = [...problems];
  for (const r of rules) {
    const a = anchorExists(r.file, r.exportName, readText);
    if (!a.ok) violations.push(`R${r.n} [${r.tag}] anchor missing: ${a.why}`);
  }
  const writers = checkBlockWriters(files);
  violations.push(...writers.violations);
  const allKinds = rules.filter((r) => r.tag === "ALL-KINDS");
  const repoOnly = rules.filter((r) => r.tag === "REPO-ONLY");
  const followUp = allKinds.filter((r) => r.followUp);
  const layer = shared ? checkSharedLayer(rules, shared) : { violations: [], examined: 0, runners: [] };
  violations.push(...layer.violations);
  return { rules, violations, allKinds, repoOnly, followUp, runners: layer.runners, examined: rules.length + writers.examined + layer.examined };
}

/** The tree's sources for every inclusion and every dispatched runner. */
function sharedTexts() {
  const out = {};
  const read = (rel) => {
    const abs = path.join(ROOT, rel);
    if (existsSync(abs)) out[rel] = readFileSync(abs, "utf8");
  };
  for (const inc of INCLUSIONS) read(inc.file);
  read("src/worker/services/workSweep.ts");
  for (const f of dispatchedRunners(out["src/worker/services/workSweep.ts"] ?? "")) read(f);
  return out;
}

async function loadShared() {
  const practices = await loadTs(path.join(ROOT, "src/shared/work/partnerPractices.ts"));
  const blocks = await loadTs(path.join(ROOT, "src/shared/work/blocks.ts"));
  const waits = await loadTs(path.join(ROOT, "src/shared/work/porterWaits.ts"));
  const facts = { trying: "Build the October 2026 Workshop packet", employee: "Parker", url: "https://example.com/a-page" };
  const catalogue = blocks.BLOCK_REASONS.map((reason) => ({ reason, sentence: blocks.blockSentence(blocks.describeBlock(reason, facts)) }));
  return { texts: sharedTexts(), practices: practices.PARTNER_PRACTICES, catalogue, forbidden: waits.WAIT_TEXT_FORBIDDEN };
}

async function selfTest() {
  const markdown = readFileSync(path.join(ROOT, DOC), "utf8");
  const files = serviceFiles();
  const shared = await loadShared();
  let failed = 0;
  const say = (ok, name) => {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failed += 1;
  };
  say(runAll(markdown, files, undefined, shared).violations.length === 0, "the shipped document and tree pass, shared layer included");
  say(runAll(markdown.replace(/(- R13 \[ALL-KINDS\] .*?`)$/m, "$1; shared layer: follow-up"), files, undefined, shared).violations.some((x) => /R13 \[ALL-KINDS\] is still Porter-only/.test(x)), "an ALL-KINDS rule marked Porter-only fails the build");
  say(runAll(markdown, files, undefined, { ...shared, practices: shared.practices.filter((p) => p.rule !== "R16") }).violations.some((x) => /R16 is anchored on the shared prompt fragment/.test(x)), "a prompt-enforced rule missing from the fragment is caught");
  say(runAll(markdown, files, undefined, { ...shared, practices: [...shared.practices, { rule: "R29", line: "x" }] }).violations.some((x) => /R29, which is REPO-ONLY/.test(x)), "a REPO-ONLY rule in every employee's prompt is caught");
  say(runAll(markdown, files, undefined, { ...shared, texts: { ...shared.texts, "src/worker/services/instruction.ts": shared.texts["src/worker/services/instruction.ts"].replace(/practicesForCard\(/g, "nothing(") } }).violations.some((x) => /instruction\.ts does not include the shared layer/.test(x)), "steerFor dropping the fragment is caught");
  say(runAll(markdown, files, undefined, { ...shared, texts: { ...shared.texts, "scripts/duties/web-property-change.mjs": shared.texts["scripts/duties/web-property-change.mjs"].replace(/job\.practices/g, "job.nothing") } }).violations.some((x) => /web-property-change\.mjs does not include/.test(x)), "Porter's prompt dropping the fragment is caught");
  say(runAll(markdown, files, undefined, { ...shared, texts: { ...shared.texts, "src/worker/services/blogHelp.ts": shared.texts["src/worker/services/blogHelp.ts"].replace(/steerFor\(/g, "steerNot(") } }).violations.some((x) => /blogHelp\.ts is dispatched by the sweep but never calls steerFor/.test(x)), "a dispatched runner that skips steerFor is caught");
  say(runAll(markdown, files, undefined, { ...shared, catalogue: [...shared.catalogue, { reason: "rogue", sentence: "Stopped. What would clear it: answer it on the Work page." }] }).violations.some((x) => /block "rogue" is not three parts/.test(x)) , "a block that is not three parts is caught");
  say(runAll(markdown, files, undefined, { ...shared, catalogue: [{ reason: "rogue2", sentence: "Waiting on: x. Why: y. To clear it by email: answer it on the card." }] }).violations.some((x) => /block "rogue2" sends the partner somewhere/.test(x)), "a block that points into the OS is caught");
  say(runAll(markdown, files, undefined, { ...shared, catalogue: [] }).violations.some((x) => /no block reasons rendered/.test(x)), "an empty catalogue fails (Rule 0)");
  say(runAll(markdown.replace("src/worker/services/secretHandoff.ts#secretDoor", "src/worker/services/secretHandoff.ts#secretDoorThatIsGone"), files).violations.some((x) => /R3 .*anchor missing/.test(x)), "a dead export in an anchor is caught");
  say(runAll(markdown.replace("src/shared/intake/dueTime.ts#dueTimeIn", "src/shared/intake/nope.ts#dueTimeIn"), files).violations.some((x) => /not in the tree/.test(x)), "a missing file in an anchor is caught");
  say(runAll(markdown.replace("- R12 [ALL-KINDS]", "- R12 "), files).violations.some((x) => /does not match the shape/.test(x)), "an untagged rule is caught");
  say(runAll(markdown.replace("- R13 [ALL-KINDS]", "- R12 [ALL-KINDS]"), files).violations.some((x) => /appears twice/.test(x)), "a duplicate rule number is caught");
  say(runAll(markdown, { ...files, "src/worker/services/rogue.ts": "export async function stop(env, id) { await env.WP_OS_DB.prepare(\"UPDATE work_card SET state = 'BLOCKED' WHERE id = ?1\").bind(id).run(); }" }).violations.some((x) => /opting out of the shared block template/.test(x)), "a service writing BLOCKED itself is caught");
  say(runAll(markdown, { ...files, "src/worker/services/rogue2.ts": "async function f(env, card) { return blockCard(env, card, { reason: 'x' }); }" }).violations.some((x) => /without importing it from services\/blocks/.test(x)), "a blockCard call that bypasses the door's import is caught");
  say(runAll("# nothing\n", files).rules.length === 0, "an empty document yields zero rules (and the scan fails on it)");
  if (failed) {
    console.error(`PARTNER-SERVICE-RULES SELF-TEST FAILED: ${failed}`);
    process.exit(1);
  }
  console.log("PARTNER-SERVICE-RULES SELF-TEST PASSED");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const markdown = readFileSync(path.join(ROOT, DOC), "utf8");
  const out = runAll(markdown, serviceFiles(), undefined, await loadShared());
  if (out.rules.length === 0) {
    console.error(`PARTNER-SERVICE-RULES SCAN FAILED: ${DOC} has no rules (Rule 0)`);
    process.exit(1);
  }
  if (out.violations.length) {
    console.error("PARTNER-SERVICE-RULES SCAN FAILED — a rule has lost its code, an ALL-KINDS rule is Porter-only, or a duty dropped the shared layer:");
    for (const x of out.violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`PARTNER-SERVICE-RULES SCAN PASSED: ${out.rules.length} rules, every anchor present — all-kinds rules: ${out.allKinds.length} (shared layer: ${out.allKinds.length - out.followUp.length}, Porter-only: ${out.followUp.length}); repo-only: ${out.repoOnly.length}; the shared practices reach ${out.runners.length} dispatched runners + the general loop + Porter's duty; ${out.examined} items examined.`);
}

main();
