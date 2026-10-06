#!/usr/bin/env node
/**
 * any-repo-she-names-and-no-secret-shown.mjs — `npm run validate:open-repo-door` (6 Oct 2026).
 *
 * THE OWNER'S RULINGS, PINNED. "porter needs to work on anything sequoia or scooter send him …
 * any new repo we request is allowed"; "we should be able to email [secrets] and u should look
 * them up in the vault when necessary without approval"; "we need to reduce fails and blocks as
 * much as possible and if there is a block it needs to come with a plain english explanation …
 * and it should be able to be handled all over email"; "topbarz.xyz was not a cloudflare domain i
 * owned … can porter do that too?"
 *
 * Eight gates, each reading CODE (never prose), each hard-failing on zero items examined:
 *
 *   1 · THE REGISTRY IS SEEDED FROM THE ARRAY, AND THE SEED CANNOT MOVE. Migration 0253 inserts
 *       every `WEB_PROPERTIES` row (same host, same repo, ≥ 6 rows) and installs the immutability
 *       trigger; the Worker's registry writer guards every host/repo update with `seeded !== 1`.
 *   2 · A SECRET'S VALUE REACHES NO SINK. `secretHandoff.ts` binds only ciphertext, puts no `value`
 *       in any event payload, scrubs the .eml; the inbound door runs it BEFORE every other door and
 *       hands on the scrubbed text; the end-to-end test greps every sink.
 *   3 · THE RUNBOOK GENERATOR WRITES THE DEPLOY ROUTE IT WAS GIVEN, never a guess — run on fixtures.
 *   4 · OUTBOUND ATTACHMENTS ARE CAPPED at 10 MB at the transport and the composer links the rest.
 *   5 · A MISSING SECRET NEEDS A VAULT LOOKUP: the Worker refuses a report that names one without
 *       `vault_lookup.searched`; the duty attaches the lookup to every report.
 *   6 · EVERY PARTNER-FACING WAIT IS ONE OF THE TEMPLATE'S KINDS, in three parts, clearing by email:
 *       every `blockCard(` in the Porter runner composes its `detail` with `waitDetail(`; every kind
 *       renders waiting/why/clear with no OS link; the duty's `status: "blocked"` reasons address an
 *       engineer, never a partner; the prompt no longer tells the model to BLOCK with a question.
 *   7 · A HOST OUTSIDE HER ZONES PRODUCES A RECORD WITH TYPE, NAME AND TARGET read from Cloudflare's
 *       answer (`subdomain`), never a template; `recordProblem` refuses a hole or a placeholder.
 *   8 · A REGISTERED REPO WITH A README GETS A NON-EMPTY CONSTRAINTS REGISTER: the extractor finds
 *       the partner's standing rules in prose, and the registry writer stores them.
 *   9 · AN ABSENT `## Porter may run` IS DERIVED, NEVER A REFUSAL (owner, 6 Oct 2026: "shouldnt these
 *       agents be able to create scripts and do what is needed and be flexible?"). A planted RUNBOOK
 *       with no section plus a package.json with `load-x` and `sync-y` admits both and produces the
 *       section text; the generator and the fallback share `porterMayRunFrom`; the duty writes the
 *       section back, gates every run through `runRefusal` (production on the partner's words only),
 *       and no wait kind fires on "no script".
 *
 * `--self-test` plants each defect in a copy of the real sources and asserts it is caught.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

/** The shared stripper, under the name the scans-read-code guard looks for: product source is read without its comments. */
const stripComments = stripCommentsFor;
import { loadTs } from "./lib/load-ts.mjs";
import { admittedScripts, constraintsIn, deployRouteFrom, generateRunbook, porterMayRunFrom, productionAsked, withPorterMayRun } from "../duties/lib/runbook.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FILES = {
  registryTs: "src/shared/intake/webPropertyChange.ts",
  migration: "migrations/0253_porter_works_on_any_repo_a_partner_names.sql",
  registryService: "src/worker/services/webPropertyRegistry.ts",
  secret: "src/worker/services/secretHandoff.ts",
  inbound: "src/worker/effects/inboundEmail.ts",
  transport: "src/worker/effects/emailTransport.ts",
  resend: "src/worker/effects/resendClient.ts",
  files: "src/worker/services/workCardFiles.ts",
  runner: "src/worker/services/webPropertyChange.ts",
  duty: "scripts/duties/web-property-change.mjs",
  prompt: "scripts/duties/web-property-change-prompt.md",
  dns: "src/worker/services/dnsWaits.ts",
  test: "tests/openRepoDoor.test.ts",
  waitsTest: "tests/openRepoDoor.test.ts",
  runbookLib: "scripts/duties/lib/runbook.mjs",
};

function read(rel) {
  const raw = readFileSync(path.join(ROOT, rel), "utf8");
  return { raw, stripped: stripComments(rel, raw) };
}

/** The host/repo pairs out of the TS array's source. */
export function seedPairsFromTs(source) {
  return [...source.matchAll(/\{\s*host:\s*"([^"]+)"[^}]*?repo:\s*"([^"]+)"/g)].map((m) => [m[1], m[2]]);
}
/** The host/repo pairs out of the migration's INSERT. */
export function seedPairsFromSql(source) {
  return [...source.matchAll(/\('wpr_[a-z0-9_]+',\s*'([^']+)',\s*'([^']+)'/g)].map((m) => [m[1], m[2]]);
}

// ── 1 · the seed ───────────────────────────────────────────────────────────────────────────────
export function checkSeed(ts, sql, service) {
  const v = [];
  const fromTs = seedPairsFromTs(ts);
  const fromSql = seedPairsFromSql(sql);
  if (fromTs.length < 6) v.push(`WEB_PROPERTIES has ${fromTs.length} rows; the seed needs at least six`);
  if (fromSql.length < 6) v.push(`migration 0253 seeds ${fromSql.length} rows; at least six are required`);
  for (const [host, repo] of fromTs) {
    const hit = fromSql.find((p) => p[0] === host);
    if (!hit) v.push(`${host} is in WEB_PROPERTIES but not in the migration's seed`);
    else if (hit[1] !== repo) v.push(`${host} is seeded to ${hit[1]} but the array says ${repo}`);
  }
  for (const [host] of fromSql) if (!fromTs.some((p) => p[0] === host)) v.push(`the migration seeds ${host}, which WEB_PROPERTIES does not list`);
  if (!/seeded\s+INTEGER NOT NULL DEFAULT 0/.test(sql)) v.push("the registry table has no `seeded` column");
  if (!/CREATE TRIGGER trg_web_property_registry_seeded_is_immutable[\s\S]*?RAISE\(ABORT/.test(sql)) v.push("no trigger refuses a change to a seeded host → repo binding");
  if (!/CREATE TRIGGER trg_web_property_registry_seeded_is_kept[\s\S]*?BEFORE DELETE/.test(sql)) v.push("no trigger refuses deleting a seeded row");
  // Every runtime write of host or repo is guarded by the seeded flag.
  for (const m of service.matchAll(/UPDATE web_property_registry SET (host|repo)[^`]*/g)) {
    const before = service.slice(Math.max(0, m.index - 400), m.index);
    if (!/seeded !== 1/.test(before)) v.push(`the registry writer updates ${m[1]} without checking seeded !== 1`);
  }
  if (!/requestedBy\.toLowerCase\(\)/.test(service)) v.push("the registry writer does not record the authenticated requester");
  return { violations: v, examined: fromTs.length + fromSql.length + 3 };
}

// ── 2 · no sink ─────────────────────────────────────────────────────────────────────────────────
export function checkSecretSinks(secret, inbound, test) {
  const v = [];
  if (!/INSERT INTO secret_handoff[\s\S]*?\.bind\([^)]*enc\.ciphertext/.test(secret)) v.push("secret_handoff is not written from the ciphertext");
  if (/INSERT INTO secret_handoff[\s\S]*?\.bind\([^)]*f\.value/.test(secret)) v.push("secret_handoff is bound to the plaintext value");
  for (const m of secret.matchAll(/appendEvent\(env,\s*\{[\s\S]*?payload:\s*\{([^}]*)\}/g)) {
    if (/\bvalue\b|f\.value|\bciphertext\b/.test(m[1])) v.push(`an event payload carries a value: ${m[1].trim().slice(0, 80)}`);
  }
  if (!/scrubSecretValues\(input\.raw, read\.values/.test(secret)) v.push("the door does not scrub every value (accepted and refused) from the text handed on");
  if (!/WP_OS_DOCUMENTS\.put\(input\.kept\.key, clean/.test(secret)) v.push("the stored .eml is not re-put scrubbed");
  if (!/secretDoorConfigured|cipherKey\(env\)/.test(secret)) v.push("the door does not fail closed without the key");
  // The door runs BEFORE the oversize branch, the follow-up join and the assignment, and replaces kept.text.
  const doorAt = inbound.indexOf("await secretDoor(env");
  const oversizeAt = inbound.indexOf("const partnerText = kept.text");
  const replyAt = inbound.indexOf("await handleIfReply(env");
  if (doorAt < 0) v.push("the inbound door never calls secretDoor");
  else {
    if (oversizeAt > 0 && doorAt > oversizeAt) v.push("secretDoor runs after the oversize branch reads the text");
    if (replyAt > 0 && doorAt > replyAt) v.push("secretDoor runs after a follow-up could join an open card with the value in it");
    if (!/\.text = door\.raw/.test(inbound)) v.push("the inbound door does not replace kept.text with the scrubbed text");
  }
  for (const sink of ["everyTextColumn", "everyEml", "carriesSecretValue", "secret_handoff", "api/secret-handoffs/pending"]) {
    if (!test.includes(sink)) v.push(`tests/openRepoDoor.test.ts no longer greps ${sink}`);
  }
  return { violations: v, examined: 9 };
}

// ── 3 · the generator ──────────────────────────────────────────────────────────────────────────
export function checkGenerator(gen = generateRunbook, route = deployRouteFrom) {
  const v = [];
  const pages = gen({ repo: "topbarz-voting", githubRepo: "seq23/topbarz-voting", pkg: { name: "topbarz-voting", scripts: { "deploy:production": "wrangler pages deploy public --project-name topbarz-voting", "load-beats": "node scripts/load-beats.mjs", test: "vitest run" } }, wrangler: { name: "topbarz-voting", pages_build_output_dir: "public", routes: [], envs: ["preview"], vars: [] }, sourceNames: ["env.RESEND_API_KEY", "env.GIPHY_API_KEY"], today: "2026-10-06" });
  if (!/## Deploy[\s\S]*`npm run deploy:production` \(package\.json: `wrangler pages deploy public --project-name topbarz-voting`\)/.test(pages.text)) v.push("the generator does not write the deploy script the package declares");
  if (!/## Porter may run[\s\S]*- `load-beats`/.test(pages.text)) v.push("the generator does not list a load- script under Porter may run");
  if (/## Porter may run[\s\S]*- `deploy:production`/.test(pages.text)) v.push("the generator lists a deploy script under Porter may run");
  if (!/## Secrets[\s\S]*- `GIPHY_API_KEY`[\s\S]*- `RESEND_API_KEY`/.test(pages.text)) v.push("the generator does not list the secret names the source reads");
  const worker = gen({ repo: "westpeek-live", githubRepo: "seq23/westpeek-live", pkg: { scripts: {} }, wrangler: { name: "westpeek-live", main: "src/index.ts", routes: ["westpeek.live/*"], envs: ["production"], vars: [] }, sourceNames: [], today: "2026-10-06" });
  if (!/## Deploy[\s\S]*Cloudflare Worker `westpeek-live` \(`src\/index\.ts`\) on westpeek\.live\/\*/.test(worker.text)) v.push("the generator does not write the Worker route the wrangler config declares");
  if (!/\(westpeek\.live\)/.test(worker.text)) v.push("the generator does not read the host from the routes");
  const none = gen({ repo: "plain", githubRepo: null, pkg: { scripts: { build: "x" } }, wrangler: null, sourceNames: [], today: "2026-10-06" });
  if (!/## Deploy[\s\S]*not declared/.test(none.text)) v.push("a repo with no deploy route gets something other than 'not declared'");
  if (/(?<!nothing is |never )\bguess(ed|ing)?\b/i.test(none.text + pages.text + worker.text)) v.push("the generator admits to guessing");
  if (route({ pkg: null, wrangler: null }).kind !== "none") v.push("deployRouteFrom invents a route from nothing");
  return { violations: v, examined: 9 };
}

// ── 4 · the cap ───────────────────────────────────────────────────────────────────────────────
export function checkCap(transport, resend, files) {
  const v = [];
  if (!/export const OUTBOUND_ATTACHMENTS_MAX_BYTES = 10 \* 1024 \* 1024/.test(transport)) v.push("the attachment cap is not 10 MB in emailTransport.ts");
  if (!/if \(attachmentsBytes\(payload\.attachments\) > OUTBOUND_ATTACHMENTS_MAX_BYTES\) \{\s*throw new Error/.test(resend)) v.push("the Resend transport does not refuse a set over the cap");
  if (!/outboundFilesFor\([^)]*cap = OUTBOUND_ATTACHMENTS_MAX_BYTES/.test(files)) v.push("the composer does not read the same cap");
  if (!/used \+ f\.bytes <= cap/.test(files)) v.push("the composer does not stop attaching at the cap");
  if (!/shared from Drive|on the card:/.test(files)) v.push("a file over the cap is not linked");
  return { violations: v, examined: 5 };
}

// ── 5 · a missing secret carries its lookup ───────────────────────────────────────────────────
export function checkLookup(runner, duty) {
  const v = [];
  if (!/report\.missing_secrets\.length && searched\.length === 0/.test(runner)) v.push("the runner accepts a missing secret without a vault lookup");
  if (!/reported a missing secret without a vault lookup/.test(runner)) v.push("the refusal does not say why");
  if (!/vault_lookup:\s*\{\s*searched: all\.lookup\.searched/.test(duty)) v.push("the duty does not attach the vault lookup to every report");
  if (!/vaultLookup\(wanted\)/.test(duty)) v.push("the duty does not look the vault up by name and vendor");
  if (!/vendor_url: vendorPageFor\(name\)/.test(duty)) v.push("a missing secret does not name where the partner can create one");
  return { violations: v, examined: 5 };
}

// ── 6 · every wait is a template kind ─────────────────────────────────────────────────────────
export function checkWaits(runner, duty, prompt, waits) {
  const v = [];
  // Every blockCard( in the runner: the 700 characters after it hold its reason, who and detail.
  const blocks = [...runner.matchAll(/blockCard\(env,\s*card,\s*\{/g)].map((m) => runner.slice(m.index, m.index + 700));
  if (blocks.length === 0) v.push("no blockCard( call found in the Porter runner — the scan examined nothing");
  for (const b of blocks) {
    const detail = /detail:\s*([\s\S]*?)(?:\n\s*\}\)|$)/.exec(b)?.[1] ?? "";
    const kind = /^\[?\s*waitDetail\("([A-Z_]+)"/.exec(detail.trim())?.[1];
    if (!kind) v.push(`a blockCard detail is not composed from waitDetail(): ${b.replace(/\s+/g, " ").slice(0, 120)}`);
    else if (!(kind in waits.PORTER_WAITS)) v.push(`blockCard uses an unknown wait kind ${kind}`);
    if (/who:\s*"SEQUOIA"/.test(b)) v.push("a block is addressed to Sequoia by name — it goes to the partner who asked");
  }
  for (const kind of Object.keys(waits.PORTER_WAITS)) {
    const w = waits.PORTER_WAITS[kind]({ what: "x", why: "a reason in a sentence", hosts: "a.com", searched: "X_KEY", at: "noon", record: { host: "h.example.com", type: "CNAME", name: "h", target: "p.pages.dev", liveAt: "https://p.pages.dev" } });
    if (!w.waiting?.trim() || !w.why?.trim() || !w.clear?.trim()) v.push(`${kind} is missing one of waiting / why / clear`);
    if (!/\breply\b|\bemail\b|^nothing/i.test(w.clear ?? "")) v.push(`${kind} does not clear by email: "${String(w.clear).slice(0, 60)}"`);
    const text = waits.waitDetail(kind, { what: "x" });
    for (const re of waits.WAIT_TEXT_FORBIDDEN) if (re.test(text)) v.push(`${kind} sends the partner into the OS: ${re}`);
  }
  // The duty's own stops address an engineer: a `blocked` reason that asks the partner something is a wait outside the template.
  for (const m of duty.matchAll(/status:\s*"blocked",\s*reason:\s*[`"]([^`"]*)[`"]/g)) {
    if (/reply|send me|which site|please|your call|approve/i.test(m[1])) v.push(`the duty script blocks with a question for the partner: "${m[1].slice(0, 80)}"`);
  }
  if (/BLOCK with a plain question|→ BLOCK/.test(prompt)) v.push("the prompt still tells the model to BLOCK with a question for the partner");
  if (/status:\s*"blocked",\s*reason:\s*[`"][^`"]*(no RUNBOOK\.md|not a West Peek property|Write one)/.test(duty)) v.push("'not a West Peek property' or 'write a RUNBOOK' is still a stop");
  if (!/needs_runs/.test(prompt)) v.push("the prompt does not tell the model how to ask for a RUNBOOK-named run");
  return { violations: v, examined: blocks.length + Object.keys(waits.PORTER_WAITS).length + 3 };
}

// ── 7 · the DNS record is read, not guessed ───────────────────────────────────────────────────
export function checkDns(duty, dns) {
  const v = [];
  if (!/record_target:\s*subdomain/.test(duty)) v.push("the duty's record target is not Cloudflare's own `subdomain`");
  if (!/const subdomain = String\(proj\.result\?\.subdomain/.test(duty)) v.push("the duty does not read the project's subdomain from the API answer");
  if (/record_target:\s*`\$\{project\}\.pages\.dev`/.test(duty)) v.push("the duty composes the CNAME target from a template — a guess");
  if (!/validation_data/.test(duty)) v.push("the duty never reads validation_data for a TXT record");
  if (!/export function recordProblem[\s\S]*?no name[\s\S]*?no target/.test(dns)) v.push("recordProblem does not refuse a record without name or target");
  if (!/placeholder/.test(dns)) v.push("recordProblem does not refuse a placeholder");
  if (!/const problem = recordProblem\(r\);\s*if \(problem\)/.test(dns)) v.push("recordDnsWaits emails without checking the record");
  if (!/DNS_RECHECK_MINUTES = 15/.test(dns) || !/DNS_WAIT_DAYS = 7/.test(dns)) v.push("the re-check is not every 15 minutes for 7 days");
  return { violations: v, examined: 8 };
}

// ── 8 · the constraints register ──────────────────────────────────────────────────────────────
export function checkConstraints(service, extract = constraintsIn) {
  const v = [];
  const found = extract([
    "# Top Barz voting\n\n## Rules\n- Scooter's own track is never in the vote.\n- Test data is preview-only; never load it to production.\n- Keys stay server-side.\n- Voter emails are private.\n- Do not ask for a login; send the target instead.\n\nRun `npm run dev` to start.",
  ]);
  if (found.length < 4) v.push(`the constraints extractor found ${found.length} rules in a README with five`);
  if (found.some((c) => /npm run dev/.test(c))) v.push("the extractor reads a command as a constraint");
  if (!/constraints_json = \?2/.test(service)) v.push("the registry writer does not store constraints");
  if (!/\[\.\.\.new Set\(\[\.\.\.have, \.\.\.facts\.constraints/.test(service)) v.push("the register does not merge — a later read could drop an earlier rule");
  return { violations: v, examined: found.length + 2 };
}

// ── 9 · an absent ## Porter may run is derived, and a missing script is written ─────────────────
export function checkAdmission(lib, duty, waits, fns = { admit: admittedScripts, from: porterMayRunFrom, gen: generateRunbook, write: withPorterMayRun, asked: productionAsked }) {
  const v = [];
  const pkg = { scripts: { "load-x": "node scripts/load-x.mjs", "sync-y": "node scripts/sync-y.mjs", "deploy:production": "wrangler pages deploy public", dev: "wrangler pages dev" } };
  const planted = "# RUNBOOK — planted\n\n## Load tracks\n\nRun the loader.\n\n## Secrets\n\n- `GIPHY_API_KEY`\n";
  const a = fns.admit(planted, pkg);
  if (!a?.names?.includes("load-x") || !a?.names?.includes("sync-y")) v.push(`a RUNBOOK with no ## Porter may run admits ${JSON.stringify(a?.names ?? [])}, not load-x and sync-y — the job would refuse every run`);
  if (a?.names?.some((n) => /deploy|^dev$/.test(n))) v.push("the derivation admits a deploy or a dev server");
  if (!a?.derived || !/## Porter may run[\s\S]*`load-x`[\s\S]*`sync-y`/.test(a?.section ?? "")) v.push("the derivation produces no ## Porter may run section text to write back");
  const written = a?.section ? fns.write(planted, a.section) : planted;
  if (fns.admit(written, { scripts: {} }).derived !== false || !/## Load tracks[\s\S]*## Porter may run[\s\S]*## Secrets/.test(written)) v.push("the written-back RUNBOOK does not read as the repo's own list (or lost a hand-written section)");
  const human = fns.admit("# R\n\n## Porter may run\n\n- `load-x`\n", pkg);
  if (human.derived || human.names.join() !== "load-x") v.push("a human's ## Porter may run list does not win over the derivation");
  const g = fns.gen({ repo: "r", githubRepo: null, pkg, wrangler: null, sourceNames: [], today: "2026-10-06" });
  if (!g.text.includes(fns.from(pkg).text)) v.push("the generator does not compose its ## Porter may run from porterMayRunFrom — two lists");
  if (!/export function generateRunbook[\s\S]*?porterMayRunFrom\(pkg\)/.test(lib) || !/export function admittedScripts[\s\S]*?porterMayRunFrom\(pkg, \{ derived: true \}\)/.test(lib)) v.push("the generator and the fallback do not both call porterMayRunFrom");
  if (/Nothing else is run for the model/.test(lib)) v.push("the RUNBOOK text still says nothing else is run for the model");
  if (!/const admitted = admittedScripts\(text, facts\.pkg\)/.test(duty) || !/withPorterMayRun\(text, admitted\.section\)/.test(duty)) v.push("the duty does not derive ## Porter may run and write it back into the RUNBOOK");
  if (!/mayRun: admitted\.names/.test(duty) || /mayRun: porterMayRun\(text\)/.test(duty)) v.push("the duty's run list is not the admitted list");
  if (!/const refusal = runRefusal\(/.test(duty) || !/productionAsked\(job\)/.test(duty) || !/admittedNowIn\(worktree/.test(duty)) v.push("applyRuns does not gate through runRefusal (admitted now, production on the partner's words)");
  if (fns.asked({ request: "add the new photos" }).ok) v.push("a production run is allowed without the partner's words");
  if (!fns.asked({ request: "load the photos to production" }).ok || !fns.asked({ request: "x", pr: { land_approved_at: "t" } }).ok) v.push("the partner's words (or their yes on the thread) do not open production");
  const kinds = Object.keys(waits?.PORTER_WAITS ?? {});
  for (const k of kinds) {
    const w = waits.PORTER_WAITS[k]({});
    if (/\bno script\b|not admitted|Porter may run|write a script/i.test(`${w.waiting} ${w.why} ${w.clear}`)) v.push(`wait kind ${k} fires on a missing script — a missing script is written, never waited on`);
  }
  if (kinds.some((k) => /SCRIPT|RUNBOOK|ADMIT/.test(k))) v.push("a wait kind is named for a script or the RUNBOOK");
  return { violations: v, examined: 12 + kinds.length };
}

function runAll(src, waits) {
  const parts = [
    checkSeed(src.registryTs.stripped, src.migration.raw, src.registryService.stripped),
    checkSecretSinks(src.secret.stripped, src.inbound.stripped, src.test.raw),
    checkGenerator(),
    checkCap(src.transport.stripped, src.resend.stripped, src.files.stripped),
    checkLookup(src.runner.stripped, src.duty.stripped),
    checkWaits(src.runner.stripped, src.duty.stripped, src.prompt.raw, waits),
    checkDns(src.duty.stripped, src.dns.stripped),
    checkConstraints(src.registryService.stripped),
    checkAdmission(src.runbookLib.raw, src.duty.stripped, waits),
  ];
  return { violations: parts.flatMap((p) => p.violations), examined: parts.reduce((n, p) => n + p.examined, 0) };
}

async function selfTest(src, waits) {
  let failed = 0;
  const say = (ok, name) => {
    console.log(`${ok ? "✓" : "✗"} ${name}`);
    if (!ok) failed += 1;
  };
  say(runAll(src, waits).violations.length === 0, "the shipped tree passes");
  say(checkSeed(src.registryTs.stripped, src.migration.raw.replace("'joinwestpeek.com', 'join-west-peek-main'", "'joinwestpeek.com', 'somewhere-else'"), src.registryService.stripped).violations.some((x) => /seeded to somewhere-else/.test(x)), "a seed that re-points a host is caught");
  say(checkSeed(src.registryTs.stripped, src.migration.raw.replace("CREATE TRIGGER trg_web_property_registry_seeded_is_immutable", "CREATE TRIGGER trg_other"), src.registryService.stripped).violations.some((x) => /no trigger refuses a change/.test(x)), "a missing immutability trigger is caught");
  say(checkSeed(src.registryTs.stripped, src.migration.raw, src.registryService.stripped.replace(/seeded !== 1/g, "true")).violations.some((x) => /without checking seeded/.test(x)), "a writer that re-points a seeded host is caught");
  say(checkSecretSinks(src.secret.stripped.replace("enc.ciphertext", "f.value"), src.inbound.stripped, src.test.raw).violations.length > 0, "a row bound to the plaintext is caught");
  say(checkSecretSinks(src.secret.stripped.replace("payload: { name: f.name, repo,", "payload: { name: f.name, value: f.value, repo,"), src.inbound.stripped, src.test.raw).violations.some((x) => /event payload carries a value/.test(x)), "an event carrying the value is caught");
  say(checkSecretSinks(src.secret.stripped, src.inbound.stripped.replace(".text = door.raw", ".text2 = door.raw"), src.test.raw).violations.some((x) => /does not replace kept\.text/.test(x)), "a door that hands on the unscrubbed text is caught");
  say(checkSecretSinks(src.secret.stripped, src.inbound.stripped, src.test.raw.replace(/everyEml/g, "nothing")).violations.some((x) => /no longer greps everyEml/.test(x)), "a test that stops grepping the .eml is caught");
  say(checkGenerator((input) => ({ text: generateRunbook(input).text.replace(/## Deploy[\s\S]*?## Porter may run/, "## Deploy\n\n- `wrangler deploy` (guessed)\n\n## Porter may run"), route: { kind: "guess" } })).violations.length > 0, "a generator that guesses the deploy route is caught");
  say(checkCap(src.transport.stripped.replace("10 * 1024 * 1024", "100 * 1024 * 1024"), src.resend.stripped, src.files.stripped).violations.some((x) => /not 10 MB/.test(x)), "a raised cap is caught");
  say(checkCap(src.transport.stripped, src.resend.stripped.replace("throw new Error(`refusing to send: attachments", "console.log(`sending anyway: attachments"), src.files.stripped).violations.some((x) => /does not refuse/.test(x)), "a transport that sends over the cap is caught");
  say(checkLookup(src.runner.stripped.replace("report.missing_secrets.length && searched.length === 0", "false"), src.duty.stripped).violations.some((x) => /without a vault lookup/.test(x)), "a runner that accepts a missing secret without a lookup is caught");
  say(checkLookup(src.runner.stripped, src.duty.stripped.replace("vault_lookup: { searched: all.lookup.searched", "vault_lookup: { searched: []")).violations.some((x) => /does not attach the vault lookup/.test(x)), "a duty that drops the lookup is caught");
  say(checkWaits(src.runner.stripped.replace('detail: waitDetail("HELD_BY_YOU", { what: said }).slice(0, 900),', 'detail: `You said no. Ask Sequoia on the card.`,'), src.duty.stripped, src.prompt.raw, waits).violations.some((x) => /not composed from waitDetail/.test(x)), "a block written outside the template is caught");
  say(checkWaits(src.runner.stripped.replace('who: whoFor(card),\n        detail: waitDetail("MAC_ASLEEP"', 'who: "SEQUOIA",\n        detail: waitDetail("MAC_ASLEEP"'), src.duty.stripped, src.prompt.raw, waits).violations.some((x) => /addressed to Sequoia/.test(x)), "a block addressed to Sequoia is caught");
  say(checkWaits(src.runner.stripped, src.duty.stripped.replace('status: "failed", reason: "the job names no target repo"', 'status: "blocked", reason: "which site? reply with one please"'), src.prompt.raw, waits).violations.some((x) => /blocks with a question for the partner/.test(x)), "a duty stop that questions the partner is caught");
  say(checkWaits(src.runner.stripped, src.duty.stripped, `${src.prompt.raw}\nBLOCK with a plain question ("send me the file").`, waits).violations.some((x) => /BLOCK with a question/.test(x)), "a prompt that tells the model to block with a question is caught");
  const brokenWaits = { ...waits, PORTER_WAITS: { ...waits.PORTER_WAITS, HELD_BY_YOU: () => ({ waiting: "you", why: "because", clear: "open the card on Home" }) } };
  say(checkWaits(src.runner.stripped, src.duty.stripped, src.prompt.raw, brokenWaits).violations.some((x) => /HELD_BY_YOU does not clear by email/.test(x)), "a kind that clears somewhere other than email is caught");
  say(checkDns(src.duty.stripped.replace("record_target: subdomain", "record_target: `${project}.pages.dev`"), src.dns.stripped).violations.some((x) => /guess|not Cloudflare's own/.test(x)), "a guessed CNAME target is caught");
  say(checkDns(src.duty.stripped, src.dns.stripped.replace("const problem = recordProblem(r);\n    if (problem)", "const problem = null;\n    if (problem)")).violations.some((x) => /emails without checking/.test(x)), "a record emailed unchecked is caught");
  say(checkConstraints(src.registryService.stripped, () => []).violations.some((x) => /found 0 rules/.test(x)), "an extractor that finds nothing is caught");
  say(checkConstraints(src.registryService.stripped.replace("constraints_json = ?2", "x = ?2")).violations.some((x) => /does not store constraints/.test(x)), "a registry that drops the constraints is caught");
  const fns = { admit: admittedScripts, from: porterMayRunFrom, gen: generateRunbook, write: withPorterMayRun, asked: productionAsked };
  say(checkAdmission(src.runbookLib.raw, src.duty.stripped, waits, { ...fns, admit: (t) => ({ names: [], derived: false, section: null }) }).violations.some((x) => /admits \[\]/.test(x)), "an absent section that refuses every run (the old [] ) is caught");
  say(checkAdmission(src.runbookLib.raw.replace("porterMayRunFrom(pkg, { derived: true })", "ownList(pkg)"), src.duty.stripped, waits).violations.some((x) => /both call porterMayRunFrom/.test(x)), "a fallback keeping its own list is caught");
  say(checkAdmission(src.runbookLib.raw, src.duty.stripped.replace("withPorterMayRun(text, admitted.section)", "text"), waits).violations.some((x) => /write it back/.test(x)), "a duty that derives but never writes the section back is caught");
  say(checkAdmission(src.runbookLib.raw, src.duty.stripped.replace("const refusal = runRefusal(", "const refusal = null && runRefusal("), waits).violations.some((x) => /runRefusal/.test(x)), "a run that skips the gate is caught");
  say(checkAdmission(src.runbookLib.raw, src.duty.stripped, waits, { ...fns, asked: () => ({ ok: true }) }).violations.some((x) => /without the partner's words/.test(x)), "production opened by the list instead of the partner's words is caught");
  say(checkAdmission(src.runbookLib.raw, src.duty.stripped, { ...waits, PORTER_WAITS: { ...waits.PORTER_WAITS, NO_SCRIPT: () => ({ waiting: "a script", why: "no script is admitted under Porter may run", clear: "reply go" }) } }).violations.some((x) => /NO_SCRIPT fires on a missing script/.test(x)), "a wait kind for 'no script' is caught");
  if (failed) {
    console.error(`OPEN-REPO-DOOR SELF-TEST FAILED: ${failed} fixture(s) were not caught`);
    process.exit(1);
  }
  console.log("OPEN-REPO-DOOR SELF-TEST PASSED");
}

async function main() {
  const src = Object.fromEntries(Object.entries(FILES).map(([k, rel]) => [k, read(rel)]));
  const waits = await loadTs(path.join(ROOT, "src/shared/work/porterWaits.ts"));
  if (process.argv.includes("--self-test")) return selfTest(src, waits);
  const { violations, examined } = runAll(src, waits);
  if (examined === 0) {
    console.error("OPEN-REPO-DOOR SCAN FAILED: nothing examined (Rule 0)");
    process.exit(1);
  }
  if (violations.length) {
    console.error("OPEN-REPO-DOOR SCAN FAILED — a door she opened on 6 Oct 2026 has narrowed, or a secret could show:");
    for (const x of violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`OPEN-REPO-DOOR SCAN PASSED: ${examined} items examined — the registry is seeded from the array and its seed cannot move by email; a secret's value is bound only as ciphertext, scrubbed from the .eml and the text every door reads, and the test greps every sink; the RUNBOOK generator writes the deploy route it was given; attachments are capped at 10 MB and the rest linked; a missing secret carries its vault lookup; every partner-facing wait is a template kind in three parts that clears by email; a host outside her zones gets a record read from Cloudflare's answer; a registered repo's README fills its constraints register; a RUNBOOK without ## Porter may run is derived from package.json by the one rule and written back, a missing script is written, and production runs on the partner's words only.`);
}

main().catch((err) => {
  console.error(`open-repo-door: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
