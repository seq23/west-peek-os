#!/usr/bin/env node
/**
 * a-duty-has-an-executor.mjs — `npm run validate:duty-executor`.
 *
 * ONE ASSERTION: EVERY CARD KIND THAT RUNS ON HER MAC NAMES A SCRIPT THAT EXISTS AND CLAIMS THAT
 * KIND, AND EVERY SCRIPT THAT CLAIMS A KIND IS NAMED BY THE REGISTRY — AND THE SWEEP DISPATCHES IT.
 *
 * WHAT THIS GUARDS (owner, 20 Sep 2026, Plan A). A work card of a "local" kind is not worked by a
 * model call in the Worker; the Worker parks a LOCAL_JOB run and a claimer on the owner's Mac runs
 * the duty script for that kind. That is THREE lists that must agree — the TypeScript registry
 * (`src/shared/work/localJobs.ts`), the Mac claimer's allowlist
 * (`scripts/claimer/local-job-claimer.mjs`), and the duty scripts themselves
 * (`scripts/duties/*.mjs`, each declaring `card kind: <KIND>`) — plus the sweep, which must
 * dispatch the kind or the card sits OPEN forever. The idea is Boss OS's `validate:duty-delivery`
 * (a duty with no executor is "exists but nothing invokes it"); the code is this repo's own.
 *
 * WHAT IS CHECKED
 *   1 · Every `LOCAL_JOB_KINDS` entry names a `script` that exists and a `promptFile` that exists.
 *   2 · That script's header declares `card kind: <KIND>` for that exact kind, and exports `run`.
 *   3 · The claimer's `DUTIES` map has the same kind → script pair, no more and no fewer.
 *   4 · Every `scripts/duties/*.mjs` that declares a card kind is in the registry.
 *   5 · `services/workSweep.ts` dispatches every registered kind (`card.kind === <KIND>` or the
 *       exported constant) to a runner, so a card of that kind is never handed to the general loop.
 *   6 · The prompt file names every phase the registry declares.
 *
 * HARD-FAILS ON ZERO: zero registered kinds, or zero duty scripts, exits 1.
 *
 * `--self-test` plants: a registry kind whose script is missing; a script declaring a kind the
 * registry lacks; a claimer map missing the kind; a sweep with the dispatch removed; a prompt file
 * missing a phase — and requires each to be caught. The shipped tree must pass.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REGISTRY = path.join(ROOT, "src", "shared", "work", "localJobs.ts");
const CLAIMER = path.join(ROOT, "scripts", "claimer", "local-job-claimer.mjs");
const SWEEP = path.join(ROOT, "src", "worker", "services", "workSweep.ts");
const DUTIES_DIR = path.join(ROOT, "scripts", "duties");
const DOOR = path.join(ROOT, "src", "worker", "services", "dealIntake.ts");
const GENERAL = path.join(ROOT, "src", "worker", "services", "employeeWork.ts");
const BLOG = path.join(ROOT, "src", "shared", "intake", "blogHelp.ts");
const REINGEST = path.join(ROOT, "src", "worker", "services", "webPropertyChange.ts");
const BROWSER = path.join(ROOT, "src", "worker", "services", "browserTask.ts");
const POLICY = path.join(ROOT, "src", "shared", "browser", "taskPolicy.ts");
const INBOUND = path.join(ROOT, "src", "worker", "effects", "inboundEmail.ts");

const read = (p) => stripTsComments(readFileSync(p, "utf8"));
/** The duty header is prose ON PURPOSE — the declaration lives in the comment. DELIBERATELY DOES NOT STRIP COMMENTS for that one read. */
const readRaw = (p) => readFileSync(p, "utf8");

/** kind → { script, promptFile, phases[] } out of the registry's source text. */
export function registryEntries(src) {
  const out = [];
  const block = src.match(/LOCAL_JOB_KINDS[\s\S]*?=\s*\[([\s\S]*?)\n\];/);
  if (!block) return out;
  for (const entry of block[1].split(/\n\s*\{\n/).slice(1).map((e) => `{\n${e}`)) {
    const kind = entry.match(/kind:\s*([A-Z_]+_KIND|"[A-Z_]+")/)?.[1];
    const script = entry.match(/script:\s*"([^"]+)"/)?.[1];
    const promptFile = entry.match(/promptFile:\s*"([^"]+)"/)?.[1];
    const phases = [...entry.matchAll(/^\s{6}([A-Z]+):\s*\{\s*model:/gm)].map((m) => m[1]);
    if (!kind) continue;
    // A constant reference resolves through its declaration in the same file.
    const literal = kind.startsWith('"') ? kind.slice(1, -1) : src.match(new RegExp(`${kind}\\s*=\\s*"([A-Z_]+)"`))?.[1] ?? kind;
    out.push({ kind: literal, script: script ?? null, promptFile: promptFile ?? null, phases });
  }
  return out;
}

/** kind → script out of the claimer's DUTIES map. */
export function claimerDuties(src) {
  const block = src.match(/DUTIES\s*=\s*\{([\s\S]*?)\};/);
  if (!block) return {};
  return Object.fromEntries([...block[1].matchAll(/([A-Z_]+):\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]));
}

/** The kind a duty script declares in its header, or null. */
export function declaredKind(rawSource) {
  return rawSource.match(/card kind:\s*([A-Z_]+)/)?.[1] ?? null;
}

/**
 * THE DOOR AND THE GENERAL LOOP (21 Sep 2026, Scooter's second email; d · updated 22 Sep 2026, 0226):
 *   a · the web-property parse runs BEFORE the blog parse in openAssignmentCard, and the blog
 *       parser yields to a site feature (SITE_FEATURE) before it matches "newsletter";
 *   d · every message is stored as .eml ONCE, unconditionally, at the entry (`keepTheMessage` in
 *       `inboundEmail.ts`) — not gated on attachments, and not minted a second time by
 *       `openAssignmentCard`, which only ever reads the key it is handed;
 *   f · the general runner hands a chief of staff's web-property card to Porter before any loop step;
 *   c · the re-read door cancels live duplicates before the door runs and returns the card it created.
 */
export function checkDoor(files) {
  const violations = [];
  let examined = 0;
  const open = files.door.slice(files.door.indexOf("export async function openAssignmentCard("));
  if (!open.length) violations.push("openAssignmentCard() is gone");
  else {
    examined += 1;
    // 0253: the door hands the parse the registry it just read; the order against the blog parse is what is pinned.
    const web = Math.max(open.indexOf("parseWebPropertyAsk(input.subject, written)"), open.indexOf("parseWebPropertyAsk(input.subject, written, registry)"));
    const blog = open.indexOf("parseBlogAsk(input.subject, written)");
    if (web < 0 || blog < 0) violations.push("openAssignmentCard() no longer parses both the web-property ask and the blog ask from the written text");
    else if (web > blog) violations.push("openAssignmentCard() parses blog help BEFORE the web-property ask — 'newsletter signup on the site' would become a blog outline");
    /*
     * EVERY MESSAGE IS STORED ONCE, AT THE ENTRY (22 Sep 2026, 0226). `openAssignmentCard` used to
     * gate its own `.eml` store on `input.raw.trim().length > 0` — a second, per-door copy of the
     * "keep the message" job, and the shape that took a month to fix everywhere it existed. The job
     * moved to `keepTheMessage()` in `inboundEmail.ts`, which runs before any door and keeps every
     * message unconditionally; a door that goes back to minting its own key is the same defect
     * again, one door at a time.
     */
    if (/env\.WP_OS_DOCUMENTS\s*\.\s*put\s*\(/.test(open)) {
      violations.push("openAssignmentCard() stores its own .eml — the store is keepTheMessage()'s job now, at the entry, before any door; a second minting site is the 'two components each keeping their own list' shape this repo names");
    }
    const emlKeyParamAt = open.indexOf("limits: readonly string[];");
    if (emlKeyParamAt < 0 || !/emlKey:\s*string\s*\|\s*null;/.test(open.slice(emlKeyParamAt, emlKeyParamAt + 1000))) {
      violations.push("openAssignmentCard() no longer requires emlKey from its caller (a required, non-optional param) — a call that forgot to pass one would silently carry no stored copy");
    }
  }
  const blog = files.blog;
  examined += 1;
  const site = blog.indexOf("if (SITE_FEATURE.test(text)) return null;");
  const ctx = blog.indexOf("if (!BLOG_CONTEXT.test(text)) return null;");
  if (site < 0) violations.push("parseBlogAsk() has no SITE_FEATURE yield — a newsletter signup form reads as blog help");
  else if (ctx >= 0 && site > ctx) violations.push("parseBlogAsk() tests BLOG_CONTEXT before SITE_FEATURE — 'newsletter' wins over 'signup form'");
  const general = files.general.slice(files.general.indexOf("export async function workCard("));
  examined += 1;
  const guard = general.indexOf("/chief of staff/i.test(employee.role)");
  const loop = general.indexOf("for (let step = 1; step <= runSteps; step++)");
  if (guard < 0) violations.push("workCard() no longer hands a chief of staff's web-property card to Porter — the general loop would browse it and email the partner a permission block");
  else if (loop >= 0 && guard > loop) violations.push("workCard()'s chief-of-staff guard sits after the general loop — too late");
  if (guard >= 0 && !/isWebPropertyChange\(ask\)[\s\S]{0,600}assignCard\(/.test(general.slice(guard, guard + 2500))) violations.push("workCard()'s chief-of-staff guard does not hand the card on through assignCard");
  // A PLAIN READ NEVER WAITS FOR A HUMAN (owner, 21 Sep 2026), and paying/logging in still does.
  examined += 1;
  const reqTask = files.browser.slice(files.browser.indexOf("export async function requestTask("));
  if (!/const plainRead = isPlainRead\(/.test(reqTask) || !/if \(plainRead\) preApproved = true;/.test(reqTask)) violations.push("requestTask() no longer pre-approves a plain read — every AI look at a public page would block and email the partner");
  if (!/payment_mode !== "NONE"\) return false;/.test(files.policy)) violations.push("isPlainRead() no longer refuses a paid task — a purchase could run unapproved");
  if (!/log \?in/.test(files.policy) || !/submit/.test(files.policy) || !/purchase/.test(files.policy)) violations.push("isPlainRead()'s NOT_A_READ no longer names login, submit and purchase");
  /*
   * A PARTNER'S REQUEST IS READ AT ANY SIZE — and read ONCE. The first version tee'd the raw stream
   * (one branch to R2, one to text) and hung production for 110 s at 14 ms of CPU on 21 Sep 2026:
   * workerd's tee lets the unread branch's backpressure stall the source. So the pin is the shape
   * that cannot deadlock: the bytes are buffered with arrayBuffer(), the text is decoded from that
   * buffer, and no tee() exists anywhere in the file.
   *
   * HOISTED 22 Sep 2026 (0226): the buffer-once read used to live INSIDE the oversize branch, behind
   * its own locally-computed `partnerAuthority`; both are now `keepTheMessage()`'s, called once
   * before any branch, so the check follows the read to where it actually happens rather than
   * pinning to a branch it moved out of.
   */
  examined += 1;
  const keeperStart = files.inbound.indexOf("async function keepTheMessage(");
  const keeperEnd = keeperStart < 0 ? -1 : files.inbound.indexOf("\nasync function handleInboundEmailOnce(", keeperStart);
  const keeper = keeperStart < 0 ? "" : files.inbound.slice(keeperStart, keeperEnd < 0 ? keeperStart + 6000 : keeperEnd);
  if (!/new Response\(message\.raw\)\.arrayBuffer\(\)/.test(keeper) || !/new TextDecoder\(\)\.decode\(buffered\)/.test(keeper)) {
    violations.push("keepTheMessage() no longer buffers the message once with arrayBuffer() and decodes THAT SAME buffer — a second read of message.raw is how the 21 Sep deadlock happened");
  }
  if (/\.tee\(\)/.test(files.inbound)) violations.push("inboundEmail.ts tees the raw stream — that is the deadlock that hung the Worker on 21 Sep 2026 (R2 branch waits on an unread text branch)");
  const oversizeStart = files.inbound.indexOf("if (message.rawSize > MAX_BODY_BYTES) {");
  const oversize = oversizeStart < 0 ? "" : files.inbound.slice(oversizeStart, oversizeStart + 9000);
  if (!/authority\.isAssignment && partnerText !== null/.test(oversize) || oversize.indexOf("openAssignmentCard(") < 0) violations.push("the oversize branch no longer opens an authenticated partner's request as an assignment from the buffered text — a photo attached makes the request 'too large to read' again");
  const re = files.reingest.slice(files.reingest.indexOf("export async function handleReingestStoredEmail("));
  examined += 1;
  const cancel = re.indexOf("state = 'CANCELLED'");
  const door = re.indexOf("handleInboundEmail(");
  if (cancel < 0 || door < 0 || cancel > door) violations.push("handleReingestStoredEmail() does not cancel the live duplicates BEFORE the door runs — the new assignment would be joined into the old card and nothing created");
  if (!/created_at >= \?2/.test(re) || /ORDER BY created_at DESC LIMIT 1"\)\.first/.test(re.slice(0, re.indexOf("appendEvent")))) violations.push("handleReingestStoredEmail() returns 'the newest card of the kind' instead of the card this read created");
  return { violations, examined };
}

export function check(files) {
  const violations = [];
  const entries = registryEntries(files.registry);
  const duties = claimerDuties(files.claimer);
  const dutyFiles = files.dutyScripts; // { relPath: { raw, stripped } }

  for (const e of entries) {
    if (!e.script) {
      violations.push(`registry kind ${e.kind} names no script — a duty with no executor is "exists but nothing invokes it"`);
      continue;
    }
    const script = dutyFiles[e.script];
    if (!script) violations.push(`registry kind ${e.kind} names ${e.script}, which does not exist under scripts/duties/`);
    else {
      const declared = declaredKind(script.raw);
      if (declared !== e.kind) violations.push(`${e.script} declares card kind ${declared ?? "(none)"}, but the registry maps it to ${e.kind}`);
      if (!/export\s+async\s+function\s+run\s*\(/.test(script.stripped)) violations.push(`${e.script} exports no run(job, ctx) — the claimer would import it and find nothing to call`);
    }
    if (!e.promptFile) violations.push(`registry kind ${e.kind} names no prompt file`);
    else if (!files.promptFiles[e.promptFile]) violations.push(`registry kind ${e.kind} names ${e.promptFile}, which does not exist`);
    else {
      for (const phase of e.phases) {
        if (!files.promptFiles[e.promptFile].includes(`## Phase ${phase}`)) violations.push(`${e.promptFile} has no "## Phase ${phase}" section, but the registry declares that phase for ${e.kind}`);
      }
    }
    // THE ASSETS REACH THE MODEL (21 Sep 2026): the payload type declares `attachments` and `request`, the
    // script renders ATTACHMENTS: and REQUEST, and the prompt tells Porter what they are.
    if (script) {
      for (const field of ["ATTACHMENTS:", "DRIVE_FOLDERS:", "REQUEST ("]) {
        if (!script.stripped.includes(field)) violations.push(`${e.script} does not render ${field} in the job context — an asset the partner sent would never reach Porter`);
      }
    }
    if (!/attachments:\s*Array</.test(files.registry) || !/request:\s*string/.test(files.registry)) violations.push("the registry's LocalJobPayload no longer declares `request` and `attachments` — the Worker could park a job without the specification or its assets");
    if (e.promptFile && files.promptFiles[e.promptFile] && !/ATTACHMENTS/.test(files.promptFiles[e.promptFile])) violations.push(`${e.promptFile} never mentions ATTACHMENTS — Porter is not told the files are assets of the request`);
    // HER SEAT, NEVER A KEY (21 Sep 2026): the claude spawn never passes process.env straight through.
    if (script) {
      // 29 Sep 2026: the Codex fallback spawns a SECOND model process in the same worktree, so it is held to the same rule.
      const spawns = [...script.stripped.matchAll(/spawn\(\s*"(?:claude|codex)"[\s\S]*?\}\s*\)/g)].map((m) => m[0]);
      if (!spawns.some((sp) => /spawn\(\s*"claude"/.test(sp))) violations.push(`${e.script} never spawns claude — the phase could not run`);
      for (const sp of spawns) {
        const who = /spawn\(\s*"codex"/.test(sp) ? "codex" : "claude";
        if (/env:\s*process\.env\b/.test(sp)) violations.push(`${e.script} spawns ${who} with env: process.env — the vault's API key would take precedence over her seat and bill the API`);
        if (!/env:\s*claudeChildEnv\(/.test(sp)) violations.push(`${e.script} spawns ${who} without claudeChildEnv() — the model would see the vault and her API key`);
      }
      // 23 Sep 2026: the strip is the vault's own list of names, through ONE shared helper; a local copy is a second list.
      if (!/import\s*\{[^}]*\bclaudeChildEnv\b[^}]*\}\s*from\s*"\.\.\/lib\/vault-env\.mjs"/.test(script.stripped)) violations.push(`${e.script} does not import claudeChildEnv from scripts/lib/vault-env.mjs — the strip must come from the one shared helper`);
      if (/function\s+claudeChildEnv\b/.test(script.stripped)) violations.push(`${e.script} defines its own claudeChildEnv — a second list; import the shared helper`);
    }
    if (duties[e.kind] !== e.script) violations.push(`the Mac claimer's DUTIES maps ${e.kind} → ${duties[e.kind] ?? "(nothing)"}, but the registry says ${e.script}`);
    const dispatched = new RegExp(`card\\.kind\\s*===\\s*(?:"${e.kind}"|${e.kind}_KIND)`).test(files.sweep);
    if (!dispatched) violations.push(`services/workSweep.ts never dispatches card.kind === ${e.kind} — a card of that kind would fall to the general loop or sit OPEN forever`);
  }
  for (const kind of Object.keys(duties)) {
    if (!entries.some((e) => e.kind === kind)) violations.push(`the Mac claimer runs ${kind}, which the registry does not know — the Worker would never park it`);
  }
  for (const [rel, f] of Object.entries(dutyFiles)) {
    const declared = declaredKind(f.raw);
    if (!declared) {
      violations.push(`${rel} declares no "card kind: <KIND>" in its header`);
      continue;
    }
    if (!entries.some((e) => e.kind === declared)) violations.push(`${rel} declares card kind ${declared}, which the registry does not know`);
  }
  const door = files.door ? checkDoor(files) : { violations: [], examined: 0 };
  violations.push(...door.violations);
  return { violations, kinds: entries.length, scripts: Object.keys(dutyFiles).length, doorGates: door.examined };
}

function loadFiles() {
  const dutyScripts = {};
  const promptFiles = {};
  if (existsSync(DUTIES_DIR)) {
    for (const name of readdirSync(DUTIES_DIR)) {
      const rel = `scripts/duties/${name}`;
      const abs = path.join(DUTIES_DIR, name);
      if (name.endsWith(".mjs")) dutyScripts[rel] = { raw: readRaw(abs), stripped: read(abs) };
      else if (name.endsWith(".md")) promptFiles[rel] = readRaw(abs);
    }
  }
  return { registry: read(REGISTRY), claimer: read(CLAIMER), sweep: read(SWEEP), dutyScripts, promptFiles, door: read(DOOR), general: read(GENERAL), blog: read(BLOG), reingest: read(REINGEST), browser: read(BROWSER), policy: read(POLICY), inbound: read(INBOUND) };
}

function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const files = loadFiles();
  const real = check(files);
  say(real.violations.length === 0 && real.kinds > 0 && real.scripts > 0, `shipped tree passes (${real.kinds} kind(s), ${real.scripts} script(s)): ${real.violations.join("; ")}`);

  const scriptRel = Object.keys(files.dutyScripts)[0];
  const missingScript = check({ ...files, registry: files.registry.replace(scriptRel, "scripts/duties/nope.mjs") });
  say(missingScript.violations.some((v) => /does not exist under scripts\/duties/.test(v)), "a registry kind whose script is missing is caught");

  const strangerScript = check({ ...files, dutyScripts: { ...files.dutyScripts, "scripts/duties/stranger.mjs": { raw: "// card kind: STRANGER_KIND\nexport async function run() {}", stripped: "export async function run() {}" } } });
  say(strangerScript.violations.some((v) => /STRANGER_KIND, which the registry does not know/.test(v)), "a duty script declaring an unregistered kind is caught");

  const claimerMissing = check({ ...files, claimer: files.claimer.replace(/WEB_PROPERTY_CHANGE:\s*"[^"]+",?/, "") });
  say(claimerMissing.violations.some((v) => /claimer's DUTIES maps WEB_PROPERTY_CHANGE → \(nothing\)/.test(v)), "a claimer map missing the kind is caught");

  const noDispatch = check({ ...files, sweep: files.sweep.replace(/card\.kind === WEB_PROPERTY_CHANGE_KIND/g, "card.kind === 'SOMETHING_ELSE'") });
  say(noDispatch.violations.some((v) => /never dispatches card\.kind === WEB_PROPERTY_CHANGE/.test(v)), "a sweep that no longer dispatches the kind is caught");

  const promptRel = Object.keys(files.promptFiles)[0];
  const noPhase = check({ ...files, promptFiles: { ...files.promptFiles, [promptRel]: files.promptFiles[promptRel].replace("## Phase LAND", "## Landing") } });
  say(noPhase.violations.some((v) => /no "## Phase LAND" section/.test(v)), "a prompt file missing a declared phase is caught");

  const noAttachments = check({ ...files, dutyScripts: { ...files.dutyScripts, [scriptRel]: { ...files.dutyScripts[scriptRel], stripped: files.dutyScripts[scriptRel].stripped.replace(/ATTACHMENTS:/g, "FILES:") } } });
  say(noAttachments.violations.some((v) => /does not render ATTACHMENTS:/.test(v)), "a duty script that drops ATTACHMENTS: from the context is caught");
  const noPayloadField = check({ ...files, registry: files.registry.replace(/attachments:\s*Array</, "files: Array<") });
  say(noPayloadField.violations.some((v) => /no longer declares/.test(v)), "a payload without `attachments` is caught");
  const rawEnv = check({ ...files, dutyScripts: { ...files.dutyScripts, [scriptRel]: { ...files.dutyScripts[scriptRel], stripped: files.dutyScripts[scriptRel].stripped.replace("env: claudeChildEnv(process.env, (names) => (withheld = names))", "env: process.env") } } });
  say(rawEnv.violations.some((v) => /env: process\.env/.test(v)), "a model spawn that passes process.env straight through (the vault's API key) is caught");
  // Each CLI on its own: the first occurrence in the script is now the Codex spawn, the LAST is Claude's.
  const envCall = "env: claudeChildEnv(process.env, (names) => (withheld = names))";
  const stripped0 = files.dutyScripts[scriptRel].stripped;
  const lastAt = stripped0.lastIndexOf(envCall);
  const rawClaude = lastAt < 0 ? null : check({ ...files, dutyScripts: { ...files.dutyScripts, [scriptRel]: { ...files.dutyScripts[scriptRel], stripped: `${stripped0.slice(0, lastAt)}env: process.env${stripped0.slice(lastAt + envCall.length)}` } } });
  say(rawClaude !== null && rawClaude.violations.some((v) => /spawns claude with env: process\.env/.test(v)), "a claude spawn that passes process.env straight through is caught");
  say(rawEnv.violations.some((v) => /spawns codex with env: process\.env/.test(v)), "a codex spawn that passes process.env straight through is caught");
  const noStrip = check({ ...files, dutyScripts: { ...files.dutyScripts, [scriptRel]: { ...files.dutyScripts[scriptRel], stripped: files.dutyScripts[scriptRel].stripped.replace(/import \{[^}]*claudeChildEnv[^}]*\} from "\.\.\/lib\/vault-env\.mjs";/, "const VAULT_INJECTED_VAR = 'X'; const strippedNote = String; const envForRepoRun = (b) => b; const vaultLookup = () => ({}); function claudeChildEnv(b) { return { ...b }; }") } } });
  say(noStrip.violations.some((v) => /does not import claudeChildEnv/.test(v)) && noStrip.violations.some((v) => /defines its own claudeChildEnv/.test(v)), "a duty script with its own env copy instead of the shared vault strip is caught");
  const blogFirst = check({ ...files, door: files.door.replace("const web = parseWebPropertyAsk(input.subject, written, registry);", "const web0 = parseBlogAsk(input.subject, written); const web = parseWebPropertyAsk(input.subject, written, registry);") });
  say(blogFirst.violations.some((v) => /parses blog help BEFORE/.test(v)), "a door that reads blog help before the web-property ask is caught");
  const emlMinted = check({ ...files, door: files.door.replace("const emlKey = input.emlKey;", "let emlKey = input.emlKey;\n  if (!emlKey && env.WP_OS_DOCUMENTS) { emlKey = `inbound-email/${crypto.randomUUID()}.eml`; env.WP_OS_DOCUMENTS.put(emlKey, input.raw); }") });
  say(emlMinted.violations.some((v) => /stores its own \.eml/.test(v)), "a door that mints and stores its own copy of the message again is caught");
  const emlOptionalAt = files.door.indexOf("limits: readonly string[];");
  const emlOptional = check({ ...files, door: files.door.slice(0, emlOptionalAt) + files.door.slice(emlOptionalAt).replace("emlKey: string | null;", "emlKey?: string | null;") });
  say(emlOptional.violations.some((v) => /no longer requires emlKey/.test(v)), "a door whose emlKey becomes optional again is caught");
  const noSiteYield = check({ ...files, blog: files.blog.replace("if (SITE_FEATURE.test(text)) return null;", "") });
  say(noSiteYield.violations.some((v) => /no SITE_FEATURE yield/.test(v)), "a blog parser that no longer yields to a site feature is caught");
  const noGuard = check({ ...files, general: files.general.replace("/chief of staff/i.test(employee.role)", "false && /cos/i.test(employee.role)") });
  say(noGuard.violations.some((v) => /no longer hands a chief of staff's web-property card/.test(v)), "a general loop that would browse a chief's website change is caught");
  const cancelAfter = check({ ...files, reingest: files.reingest.replace("state = 'CANCELLED', next_action = ?2, block_nag_at = NULL, lease_until = NULL,", "state = 'CANCELLED_LATER', next_action = ?2,") });
  say(cancelAfter.violations.some((v) => /cancel the live duplicates BEFORE/.test(v)), "a re-read that no longer cancels the live duplicate first is caught");
  const readsWait = check({ ...files, browser: files.browser.replace("if (plainRead) preApproved = true;", "if (plainRead && false) preApproved = true;") });
  say(readsWait.violations.some((v) => /no longer pre-approves a plain read/.test(v)), "a browser gate that makes a plain read wait for a human is caught");
  const paidReads = check({ ...files, policy: files.policy.replace('if (req.payment_mode !== "NONE") return false;', "") });
  say(paidReads.violations.some((v) => /no longer refuses a paid task/.test(v)), "a plain-read rule that lets a paid task through is caught");
  const tooLarge = check({ ...files, inbound: files.inbound.replace("authority.isAssignment && partnerText", "false && partnerText") });
  say(tooLarge.violations.some((v) => /too large to read/.test(v)), "an oversize branch that no longer reads a partner's request is caught");
  const rebuffered = check({ ...files, inbound: files.inbound.replace("text = new TextDecoder().decode(buffered);", "text = new TextDecoder().decode(new Uint8Array(await new Response(message.raw).arrayBuffer()));") });
  say(rebuffered.violations.some((v) => /decodes THAT SAME buffer/.test(v)), "keepTheMessage() reading message.raw a second time to decode text is caught");
  const noRun = check({ ...files, dutyScripts: { ...files.dutyScripts, [scriptRel]: { ...files.dutyScripts[scriptRel], stripped: files.dutyScripts[scriptRel].stripped.replace("export async function run(", "async function run(") } } });
  say(noRun.violations.some((v) => /exports no run\(job, ctx\)/.test(v)), "a duty script that no longer exports run() is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: twenty planted defects are each caught; the shipped tree passes.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const { violations, kinds, scripts, doorGates } = check(loadFiles());
  if (kinds === 0 || scripts === 0 || !doorGates) {
    console.error(`DUTY-EXECUTOR SCAN FAILED — examined ${kinds} registered kind(s) and ${scripts} duty script(s). An empty loop reporting success is the defect this repo calls Rule 0.`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("DUTY-EXECUTOR SCAN FAILED — a duty and its executor disagree:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(`DUTY-EXECUTOR SCAN PASSED: ${doorGates} door gate(s) hold (web before blog, site features are not blog help, every partner .eml kept, a chief never browses a site change, a plain read never waits for a human, a partner's request is read at any size, a re-read supersedes); ${kinds} local card kind(s) each name a script that exists, declares the kind, is in the Mac claimer's allowlist, is dispatched by the sweep, and has a prompt file with every phase; ${scripts} duty script(s) are all registered.`);
}
