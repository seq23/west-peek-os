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
 *   4 · a rule marked `shared layer: follow-up` is counted and printed, so the gap between "law for
 *       Porter" and "law for everyone" is on every build log.
 *
 * Pass count = rules. Hard-fails on zero rules (Rule 0). `--self-test` plants a dead anchor, an
 * untagged rule, a duplicate number and a second block writer, and asserts each is caught.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

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

export function runAll(markdown, files, readText) {
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
  return { rules, violations, allKinds, repoOnly, followUp, examined: rules.length + writers.examined };
}

function selfTest() {
  const markdown = readFileSync(path.join(ROOT, DOC), "utf8");
  const files = serviceFiles();
  let failed = 0;
  const say = (ok, name) => {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failed += 1;
  };
  say(runAll(markdown, files).violations.length === 0, "the shipped document and tree pass");
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

function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const markdown = readFileSync(path.join(ROOT, DOC), "utf8");
  const out = runAll(markdown, serviceFiles());
  if (out.rules.length === 0) {
    console.error(`PARTNER-SERVICE-RULES SCAN FAILED: ${DOC} has no rules (Rule 0)`);
    process.exit(1);
  }
  if (out.violations.length) {
    console.error("PARTNER-SERVICE-RULES SCAN FAILED — a rule has lost its code, or a kind opted out of the shared block door:");
    for (const x of out.violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`PARTNER-SERVICE-RULES SCAN PASSED: ${out.rules.length} rules, every anchor present — all-kinds rules: ${out.allKinds.length} (${out.allKinds.length - out.followUp.length} at the shared layer, ${out.followUp.length} still law for Porter only: ${out.followUp.map((r) => `R${r.n}`).join(", ") || "none"}); repo-only: ${out.repoOnly.length}; ${out.examined} items examined.`);
}

main();
