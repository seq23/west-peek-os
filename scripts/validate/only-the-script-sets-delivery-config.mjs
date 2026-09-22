#!/usr/bin/env node
/**
 * only-the-script-sets-delivery-config.mjs — `npm run validate:delivery-config`.
 *
 * ONE ASSERTION: THE MODEL MAY NAME A DELIVERY VARIABLE. ONLY THE SCRIPT MAY SET ONE, ONLY ON THE
 * ALLOW-LIST, AND NO VALUE MAY REACH THE MODEL, THE CONSOLE, THE BUILD PROOF OR THE REPORT.
 *
 * WHAT WENT WRONG, 22 Sep 2026. "westpeek.ventures forms are down." Porter's plan declared a NAMED
 * STOP — "a Cloudflare secret cannot be read back, so Scooter or Sequoia must run `wrangler pages
 * secret put RESEND_API_KEY`" — for a key sitting in this repo's own vault, in a process already
 * running under `vault.mjs run --`. A coordinator did the whole job by hand in four minutes with
 * exactly the access the duty run already had. And Porter's BUILD report claimed in `decided_json`
 * that it had set EMAIL_FROM and LEAD_TO. It had not. Two defects, one shape: a boundary drawn in
 * prose, where the model both decides what is impossible and reports what it did.
 *
 * WHY A VALIDATOR AND NOT A LONGER PROMPT. The prompt is where the last version of this rule lived
 * ("never claim a check you did not run") and it did not stop the false claim, because nothing
 * failed when it was broken. What follows are the four ways this can rot, each one a check.
 *
 * WHAT IS CHECKED
 *   1 · THE LIST IS EXACTLY THE LIST. `scripts/duties/lib/pages-delivery.mjs` names those three
 *       Pages projects, those two plain variables and that one secret, and nothing else. A project
 *       or a variable added here has to be added deliberately, in a commit, against this pin.
 *   2 · THE GATE REFUSES EVERYTHING ELSE. The REAL `classify` and `readRequests` are run over
 *       off-list projects, off-list names, reserved names, empty strings and a well-formed request
 *       that mixes the two — and an off-list request must come back REFUSED and recorded, never
 *       dropped. A guard that silently ignores what it refuses teaches the next model nothing.
 *   3 · THE DUTY SCRIPT KEEPS NO SECOND LIST and performs the work itself. It imports the module,
 *       spells no project or variable name of its own, runs the secret through a spawn whose
 *       ARGUMENTS carry no value (the value goes to `child.stdin` and nowhere else), never builds a
 *       shell string out of one, and reaches the Cloudflare API with the vault's token rather than
 *       with anything the model wrote.
 *   4 · NO VALUE REACHES A READER. The build proof is assembled only from `applyPagesEnv`'s return,
 *       whose lines come from `proofLine` — a function with no value parameter. `renderContext`,
 *       which builds the model's prompt, reads nothing from the environment. Nothing in the
 *       delivery functions prints the value or interpolates it into a message.
 *   5 · THE PROMPT TELLS PORTER IT IS HIS. The prompt file says delivery config is never a named
 *       stop, names `pages_env` as the way to ask, and forbids claiming config was set.
 *
 * HARD-FAILS ON ZERO: zero projects, zero variables, zero checks performed, or a file it cannot
 * read exits 1. This scan going blind must look like a failure, not a clean board.
 *
 * `--self-test` plants each real defect — a fourth project on the list, a `classify` that says yes,
 * a duty script that puts the value on the command line, one that prints it, one that keeps its own
 * copy of a project name, a prompt with the named stop back in it — and requires every one to be
 * caught, alongside the shipped tree, which must pass.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";
import { CLOUDFLARE_ACCOUNT_ID, DELIVERY_VARS, PAGES_PROJECTS, PLAIN_VARS, SECRET_VARS, classify, proofLine, readRequests } from "../duties/lib/pages-delivery.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const DUTY = path.join(ROOT, "scripts", "duties", "web-property-change.mjs");
const PROMPT = path.join(ROOT, "scripts", "duties", "web-property-change-prompt.md");

/** THE PIN. Changing any of these is a deliberate act against this line, in a commit. */
const EXPECTED_PROJECTS = ["join-west-peek-main", "west-peek-ventures", "west-peek-productions"];
const EXPECTED_PLAIN = ["EMAIL_FROM", "LEAD_TO"];
const EXPECTED_SECRET = ["RESEND_API_KEY"];

function read(file) {
  const raw = readFileSync(file, "utf8");
  return { raw, stripped: stripCommentsFor(file, raw) };
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** 1 + 2 — the list, and the gate, exercised against the real functions. */
export function checkAllowList(list) {
  const v = [];
  if (!same([...list.projects], EXPECTED_PROJECTS)) v.push(`the Pages allow-list is ${JSON.stringify(list.projects)}, not the three West Peek projects ${JSON.stringify(EXPECTED_PROJECTS)}`);
  if (!same([...list.plain].sort(), [...EXPECTED_PLAIN].sort())) v.push(`the plain delivery variables are ${JSON.stringify(list.plain)}, not ${JSON.stringify(EXPECTED_PLAIN)}`);
  if (!same([...list.secret].sort(), [...EXPECTED_SECRET].sort())) v.push(`the delivery secrets are ${JSON.stringify(list.secret)}, not ${JSON.stringify(EXPECTED_SECRET)}`);
  if (!/^[0-9a-f]{32}$/.test(String(list.accountId ?? ""))) v.push("the Cloudflare account id on the allow-list is not an account id");
  // FROZEN AT RUNTIME TOO. An allow-list something can push onto is a suggestion.
  for (const [what, frozen] of [["the project list", Object.isFrozen(PAGES_PROJECTS)], ["the plain variables", Object.isFrozen(PLAIN_VARS)], ["the secrets", Object.isFrozen(SECRET_VARS)]]) {
    if (!frozen) v.push(`${what} is not frozen — an allow-list something can push onto is a suggestion`);
  }

  const offList = [
    ["westpeek-live", "EMAIL_FROM"],
    ["join-west-peek-main", "ANTHROPIC_API_KEY"],
    ["join-west-peek-main", "CLOUDFLARE_API_TOKEN"],
    ["", "LEAD_TO"],
    ["west-peek-ventures", ""],
    ["west-peek-ventures ", "LEAD_TO "],
  ];
  let refusals = 0;
  for (const [project, name] of offList) {
    const verdict = list.classify(project, name);
    // A trimmed pair that IS on the list is fine; anything genuinely off it must be refused.
    const onList = EXPECTED_PROJECTS.includes(project.trim()) && DELIVERY_VARS.includes(name.trim());
    if (onList) continue;
    if (verdict.ok) v.push(`classify("${project}", "${name}") says yes — the gate lets an off-list request through`);
    else refusals += 1;
  }
  if (refusals === 0) v.push("no off-list request was refused — the gate examined nothing");

  const mixed = list.readRequests([
    { project: "someone-elses-site", name: "EMAIL_FROM" },
    { project: "west-peek-ventures", name: "LEAD_TO" },
    { project: "west-peek-ventures", name: "TOTALLY_MADE_UP" },
  ]);
  if (mixed.allowed.length !== 1 || mixed.allowed[0]?.name !== "LEAD_TO") v.push(`readRequests let ${mixed.allowed.length} of three through; only the on-list one may pass`);
  if (mixed.refused.length !== 2) v.push("readRequests dropped an off-list request instead of recording it as refused");
  if (list.readRequests("everything").allowed.length !== 0) v.push("readRequests treats a non-list as a request");

  // A plain entry carries its value FROM THE LIST; a secret entry carries only the vault key's name.
  const plain = list.classify(EXPECTED_PROJECTS[0], EXPECTED_PLAIN[0]);
  if (plain.kind !== "plain" || typeof plain.value !== "string" || !plain.value) v.push("a plain variable does not carry the recorded value the script will write");
  const secret = list.classify(EXPECTED_PROJECTS[0], EXPECTED_SECRET[0]);
  if (secret.kind !== "secret" || "value" in secret) v.push("a delivery secret carries a value out of the allow-list — a secret's value may exist only in the vault-injected environment");

  const line = list.proofLine("west-peek-ventures", "RESEND_API_KEY", "set");
  if (!(line.includes("west-peek-ventures") && line.includes("RESEND_API_KEY") && line.includes("set"))) v.push("a proof line does not record the project, the variable name and the outcome");
  if (list.proofLine.length > 4) v.push("proofLine takes more than (project, name, outcome, why) — a fifth parameter is room for a value");
  if (!list.proofLine("x", "y", "anything-else").includes("failed")) v.push("proofLine accepts an outcome that is not one of the recorded outcomes");
  return { violations: v, examined: EXPECTED_PROJECTS.length * DELIVERY_VARS.length + offList.length };
}

/** 3 + 4 — what the duty script may and may not contain. */
export function checkDutyScript(duty, listNames) {
  const v = [];
  const s = duty.stripped;
  if (!/from\s+"\.\/lib\/pages-delivery\.mjs"/.test(s)) v.push("web-property-change.mjs does not import the delivery allow-list — a second list is the two-components-one-list defect");
  if (!/applyPagesEnv\s*\(/.test(s)) v.push("nothing in the duty script calls applyPagesEnv — the step exists but nothing invokes it");
  if (!/const\s+configLines\s*=\s*await\s+applyPagesEnv\(/.test(s)) v.push("the BUILD phase does not perform the delivery config itself");
  if (!/pages_env_proof:\s*configLines/.test(s)) v.push("the BUILD report does not carry what the script observed about delivery config");
  if (!/proof:\s*\[[^\]]*configLines/.test(s)) v.push("the build proof is not assembled from the script's own observation");

  /*
   * NO SECOND LIST. A project or a variable name spelled in the duty script's WORKING CODE is a
   * copy that can drift. The self-test at the foot of that file is exempt on purpose: it exercises
   * the gate, and exercising a gate means naming what is and is not on the far side of it.
   */
  const working = s.slice(0, s.indexOf("function selfTest()") > 0 ? s.indexOf("function selfTest()") : s.length);
  for (const name of listNames) {
    const re = new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    if (re.test(working)) v.push(`web-property-change.mjs spells "${name}" itself; the allow-list is the one place that names it`);
  }

  // THE SECRET NEVER BECOMES AN ARGUMENT OR A STRING.
  const spawnArgs = /spawn\(\s*"npx"\s*,\s*\[([^\]]*)\]/.exec(s);
  if (!spawnArgs) v.push("the delivery secret is not set by a spawn with an argument list — a shell string is where a value leaks");
  else if (/value|vaultKey|process\.env|\$\{(?!entry\.(name|project))/.test(spawnArgs[1])) v.push("the wrangler arguments interpolate something other than the project and the variable name");
  if (/pages secret put[^"'`\n]*\$\{/.test(s) || /sh"?\s*,\s*\[\s*"-c"/.test(s)) v.push("the duty script builds a shell command line for the secret — the value must go to stdin, never through a shell");
  if (!/child\.stdin\.end\(value\)/.test(s)) v.push("the secret's value does not go to the child's stdin");

  // NO VALUE REACHES A READER.
  const delivery = s.slice(s.indexOf("async function pagesEnvTypes"), s.indexOf("export async function run("));
  if (!delivery) v.push("the delivery functions could not be located in the duty script");
  for (const m of delivery.matchAll(/(?:console\.(?:log|error|warn)|progress\??\.?\(?)\s*\(([^)]*)\)/g)) {
    if (/\bvalue\b|body\.result|stdout|entry\.value|a\.value/.test(m[1])) v.push(`a delivery step prints something that can carry a value: ${m[0].slice(0, 80)}`);
  }
  if (/progress\?\.\(`[^`]*\$\{value/.test(delivery)) v.push("a delivery step interpolates the value into a progress line");
  if (/\bwhy\s*=\s*.*\bvalue\b/.test(delivery)) v.push("a delivery step puts the value in the reason it records");

  // THE PROMPT IS BUILT FROM THE JOB, NOT FROM THE ENVIRONMENT.
  const ctx = s.slice(s.indexOf("export function renderContext"), s.indexOf("async function sh("));
  if (!ctx) v.push("renderContext could not be located");
  else if (/process\.env|ctx\.env|\bvault\b/.test(ctx)) v.push("renderContext reads the environment — the model's prompt must be built only from the job");
  return { violations: v, examined: listNames.length + 6 };
}

/** 5 — the prompt tells Porter this is his, and forbids the false claim. */
export function checkPrompt(raw) {
  const v = [];
  // The prompt is prose that wraps; a rule split across two lines is the same rule.
  const text = raw.replace(/\s+/g, " ");
  const lower = text.toLowerCase();
  if (!/pages_env/.test(text)) v.push("the prompt never names `pages_env` — Porter has no way to ask");
  if (!/never a named stop|never be a named stop|is never a named stop/i.test(text)) v.push("the prompt does not tell Porter that delivery config is never a named stop");
  if (!/you may not claim any delivery config was set/i.test(text)) v.push("the prompt does not forbid claiming delivery config was set");
  if (/must run `wrangler pages secret put|ask (scooter|sequoia) to run `wrangler/i.test(text)) v.push("the prompt still tells Porter to hand `wrangler pages secret put` to a partner");
  if (!lower.includes("never put a value in `pages_env`") && !lower.includes("never put a value in pages_env")) v.push("the prompt does not forbid a value in the request");
  for (const name of [...EXPECTED_PROJECTS, ...EXPECTED_PLAIN, ...EXPECTED_SECRET]) {
    if (!raw.includes(name)) v.push(`the prompt does not name ${name}, so Porter cannot know it is on the list`);
  }
  return { violations: v, examined: EXPECTED_PROJECTS.length + DELIVERY_VARS.length + 5 };
}

const REAL_LIST = {
  projects: PAGES_PROJECTS,
  plain: Object.keys(PLAIN_VARS),
  secret: Object.keys(SECRET_VARS),
  accountId: CLOUDFLARE_ACCOUNT_ID,
  classify,
  readRequests,
  proofLine,
};

function runAll(list, duty, prompt) {
  const parts = [checkAllowList(list), checkDutyScript(duty, [...list.projects, ...list.plain, ...list.secret]), checkPrompt(prompt)];
  return {
    violations: parts.flatMap((p) => p.violations),
    examined: parts.reduce((n, p) => n + p.examined, 0),
  };
}

function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const duty = read(DUTY);
  const prompt = readFileSync(PROMPT, "utf8");
  const real = runAll(REAL_LIST, duty, prompt);
  say(real.violations.length === 0 && real.examined > 0, `the shipped tree passes (${real.examined} checks): ${real.violations.join("; ")}`);

  const widened = { ...REAL_LIST, projects: [...PAGES_PROJECTS, "westpeek-live"] };
  say(checkAllowList(widened).violations.some((x) => /Pages allow-list/.test(x)), "a fourth project quietly added to the allow-list is caught");

  const openGate = { ...REAL_LIST, classify: (p, n) => ({ ok: true, kind: "plain", project: p, name: n, value: "x", why: "sure" }) };
  say(checkAllowList(openGate).violations.some((x) => /lets an off-list request through/.test(x)), "a gate that says yes to anything is caught");

  const silent = { ...REAL_LIST, readRequests: (r) => ({ allowed: (Array.isArray(r) ? r : []).filter((e) => e.name === "LEAD_TO"), refused: [] }) };
  say(checkAllowList(silent).violations.some((x) => /dropped an off-list request/.test(x)), "a gate that drops refusals silently is caught");

  const valuedSecret = { ...REAL_LIST, classify: (p, n) => (n === "RESEND_API_KEY" ? { ok: true, kind: "secret", project: p, name: n, value: "re_live_x", why: "" } : classify(p, n)) };
  say(checkAllowList(valuedSecret).violations.some((x) => /carries a value out of the allow-list/.test(x)), "a secret value written into the allow-list is caught");

  const names = [...PAGES_PROJECTS, ...Object.keys(PLAIN_VARS), ...Object.keys(SECRET_VARS)];
  const onCommandLine = { raw: duty.raw, stripped: duty.stripped.replace('spawn("npx", ["wrangler", "pages", "secret", "put", entry.name, "--project-name", entry.project]', 'spawn("npx", ["wrangler", "pages", "secret", "put", entry.name, "--project-name", entry.project, value]') };
  say(checkDutyScript(onCommandLine, names).violations.some((x) => /interpolate|arguments/.test(x)), "the value put on wrangler's command line is caught");

  const shelled = { raw: duty.raw, stripped: duty.stripped.replace("child.stdin.end(value);", 'sh("sh", ["-c", `printf "%s" "${value}" | npx wrangler pages secret put ${entry.name}`]);') };
  say(checkDutyScript(shelled, names).violations.some((x) => /shell/.test(x)), "the value piped through a shell string is caught");

  const printed = { raw: duty.raw, stripped: duty.stripped.replace("child.stdin.end(value);", "console.log(value); child.stdin.end(value);") };
  say(checkDutyScript(printed, names).violations.some((x) => /prints something that can carry a value/.test(x)), "the value printed to the console is caught");

  const secondList = { raw: duty.raw, stripped: duty.stripped.replace("function selfTest()", 'const PROJECTS = ["west-peek-ventures"];\nfunction selfTest()') };
  say(checkDutyScript(secondList, names).violations.some((x) => /spells "west-peek-ventures" itself/.test(x)), "a second copy of a project name in the duty script is caught");

  const inert = { raw: duty.raw, stripped: duty.stripped.replace("const configLines = await applyPagesEnv(", "const configLines = []; void (") };
  say(checkDutyScript(inert, names).violations.some((x) => /does not perform the delivery config/.test(x)), "a BUILD phase that no longer performs the config is caught");

  const envInPrompt = { raw: duty.raw, stripped: duty.stripped.replace("export function renderContext(job, paths) {", "export function renderContext(job, paths) {\n  const t = process.env.RESEND_API_KEY;") };
  say(checkDutyScript(envInPrompt, names).violations.some((x) => /renderContext reads the environment/.test(x)), "a prompt builder that reads the environment is caught");

  const oldPrompt = prompt
    .replace(/- \*\*Delivery config is YOURS[\s\S]*?refused as refused\.\n/, "")
    .replace(/never a named stop/gi, "sometimes a named stop")
    .replace(/You may not claim any delivery config was set/i, "Say what you set");
  say(checkPrompt(oldPrompt).violations.length > 0, "a prompt that lets Porter declare a named stop, or claim config it did not set, is caught");

  say(checkPrompt("nothing at all").violations.length >= 3, "an empty prompt fails rather than passing on nothing");

  if (failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} case(s)`);
    process.exit(1);
  }
  console.log("SELF-TEST PASSED: every planted defect was caught and the shipped tree passes");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const duty = read(DUTY);
  const prompt = readFileSync(PROMPT, "utf8");
  const { violations, examined } = runAll(REAL_LIST, duty, prompt);
  if (PAGES_PROJECTS.length === 0 || DELIVERY_VARS.length === 0 || examined === 0) {
    console.error("DELIVERY CONFIG SCAN FAILED — it examined nothing. A scan that goes blind must look like a failure.");
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`DELIVERY CONFIG SCAN FAILED — ${violations.length} violation(s):`);
    for (const x of violations) console.error(`  · ${x}`);
    process.exit(1);
  }
  console.log(
    `DELIVERY CONFIG SCAN PASSED: ${PAGES_PROJECTS.length} project(s) × ${DELIVERY_VARS.length} variable(s), ` +
      `${examined} checks — the script sets them, the model only names them, and no value reaches the prompt, the console, the proof or the report.`,
  );
}
