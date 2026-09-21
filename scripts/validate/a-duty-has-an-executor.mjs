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
  return { violations, kinds: entries.length, scripts: Object.keys(dutyFiles).length };
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
  return { registry: read(REGISTRY), claimer: read(CLAIMER), sweep: read(SWEEP), dutyScripts, promptFiles };
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

  const noRun = check({ ...files, dutyScripts: { ...files.dutyScripts, [scriptRel]: { ...files.dutyScripts[scriptRel], stripped: files.dutyScripts[scriptRel].stripped.replace("export async function run(", "async function run(") } } });
  say(noRun.violations.some((v) => /exports no run\(job, ctx\)/.test(v)), "a duty script that no longer exports run() is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: six planted defects are each caught; the shipped tree passes.");
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const { violations, kinds, scripts } = check(loadFiles());
  if (kinds === 0 || scripts === 0) {
    console.error(`DUTY-EXECUTOR SCAN FAILED — examined ${kinds} registered kind(s) and ${scripts} duty script(s). An empty loop reporting success is the defect this repo calls Rule 0.`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error("DUTY-EXECUTOR SCAN FAILED — a duty and its executor disagree:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(`DUTY-EXECUTOR SCAN PASSED: ${kinds} local card kind(s) each name a script that exists, declares the kind, is in the Mac claimer's allowlist, is dispatched by the sweep, and has a prompt file with every phase; ${scripts} duty script(s) are all registered.`);
}
