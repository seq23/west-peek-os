#!/usr/bin/env node
/**
 * a-seat-search-needs-proof.mjs — `npm run validate:seat-search-proof`.
 *
 * ONE RULE: A SUBSCRIPTION SEAT MAY ANSWER A LIVE-WEB-SEARCH CALL ONLY IF IT SAID IT CAN SEARCH, AND ITS
 * ANSWER IS BELIEVED ONLY WITH SEARCHES COUNTED IN THE CLI'S OWN RECORD.
 *
 * ── Why a scan, when there are tests (1 Oct 2026) ──────────────────────────────────────────────
 *
 * Parker's November Room stopped because a search call was never offered to a seat. The fix lets a seat
 * serve one, and a seat that answers a search call WITHOUT searching is the worst failure this system has
 * had before (14 Sep 2026: a general model's "I have no web access" taken as a finding). The tests prove the
 * code that exists. What a green suite does not notice is the SHAPE of the guard being worn away:
 *
 *   · the proof check in `reportRun` deleted "because the claimer already checks";
 *   · the claim query handing a search row to a claimer that never declared "web_search";
 *   · a NEW search call site written the old way (`run.model !== SEARCH_MODEL`), which would quietly
 *     reject every seat answer — or, worse, get "fixed" by dropping the model check altogether;
 *   · the router offering a seat a search call on the strength of anything but the declared capability;
 *   · the claimer reporting a search answer without having counted anything.
 *
 * WHAT IS CHECKED (each is one function, and `--self-test` feeds each its own failing fixture)
 *   1 · the migration adds the three columns the rule rests on;
 *   2 · `reportRun` refuses a search row below SEARCH_MIN_EVENTS;
 *   3 · `claimRun` excludes search rows unless the claimer said it can search;
 *   4 · no search call site compares `run.model` to SEARCH_MODEL directly — they use `servedBySearchLane`;
 *   5 · the router's search-seat set requires an AWAKE seat that DECLARED the capability;
 *   6 · the adapter refuses to park a search row on a seat that did not declare it;
 *   7 · the claimer declares the capability, counts events, and reports the count.
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
/** Source with comments blanked: a sentence explaining the old pattern must not look like the old pattern. */
const read = (...p) => {
  const file = path.join(ROOT, ...p);
  return stripCommentsFor(file, readFileSync(file, "utf8"));
};

function body(src, marker) {
  const at = src.indexOf(marker);
  if (at < 0) return null;
  // up to the next top-level function/export declaration
  const rest = src.slice(at + marker.length);
  const end = rest.search(/\n(?:export )?(?:async )?function |\nexport (?:const|interface) /);
  return end < 0 ? rest : rest.slice(0, end);
}

export function auditMigration(sql) {
  const bad = [];
  for (const col of ["needs_search", "search_events", "search_queries_json"]) {
    if (!new RegExp(`ADD COLUMN ${col}\\b`).test(sql ?? "")) bad.push(`migration 0246 no longer adds subscription_seat_run.${col}`);
  }
  return bad;
}

export function auditReport(seatsSrc) {
  const fn = body(seatsSrc, "export async function reportRun(");
  if (!fn) return ["reportRun could not be located in src/worker/ai/subscriptionSeats.ts — this scan lost its target"];
  const bad = [];
  if (!/SEARCH_MIN_EVENTS/.test(fn)) bad.push("reportRun no longer compares counted search events with SEARCH_MIN_EVENTS — a search row would be believed on the model's word");
  if (!/needs_search\s*===\s*1/.test(fn)) bad.push("reportRun does not branch on needs_search, so the proof rule is not applied to search rows only");
  if (!/const ok = hasOutput && !unproven/.test(fn)) bad.push("reportRun no longer makes an unproven search answer a failure (`ok = hasOutput && !unproven`)");
  return bad;
}

export function auditClaim(seatsSrc) {
  const fn = body(seatsSrc, "export async function claimRun(");
  if (!fn) return ["claimRun could not be located — this scan lost its target"];
  const bad = [];
  if (!/canSearch\s*=\s*false/.test(fn)) bad.push("claimRun's canSearch no longer defaults to false — a claimer that says nothing would be handed search rows");
  if (!/needs_search = 0/.test(fn) || !/canSearch\s*\?/.test(fn)) bad.push("claimRun no longer excludes search rows unless the claimer said it can search");
  return bad;
}

export function auditCallSites(files) {
  const bad = [];
  for (const [file, src] of files) {
    if (/\.model\s*!==\s*SEARCH_MODEL/.test(src)) {
      bad.push(`${file}: compares run.model !== SEARCH_MODEL directly — use servedBySearchLane(run.model), or a seat's proven search answer is rejected`);
    }
  }
  return bad;
}

export function auditRouter(runAiSrc) {
  const bad = [];
  const m = /const searchSeatKeys = new Set\(([^;]*)\);/.exec(runAiSrc);
  if (!m) return ["runAi.ts no longer defines searchSeatKeys — the router's rule for which seat may serve a search call is gone"];
  if (!/a\.available/.test(m[1]) || !/canSearch\s*===\s*true/.test(m[1])) bad.push("searchSeatKeys no longer requires an AWAKE seat whose claimer DECLARED the search capability");
  if (!/const searchOnSeat = requiresSearch && searchSeatKeys\.size > 0/.test(runAiSrc)) bad.push("a search call's seat eligibility no longer rests on searchSeatKeys");
  if (!/needsSearch:\s*requiresSearch/.test(runAiSrc)) bad.push("the seat adapter is no longer told a call is a search call, so it would park an ordinary row and wait for an answer with no proof");
  return bad;
}

export function auditAdapter(adapterSrc) {
  const bad = [];
  if (!/needsSearch,\s*\n?\s*\}\)/.test(adapterSrc) && !/needsSearch\s*,/.test(adapterSrc)) bad.push("the seat adapter does not pass needsSearch to parkRun");
  if (!/needsSearch\s*&&\s*!availability\.canSearch/.test(adapterSrc)) bad.push("the seat adapter no longer refuses to park a search row on a seat that did not declare the capability");
  return bad;
}

export function auditClaimer(src) {
  const bad = [];
  if (!/const BASE_CAPABILITIES = \["web_search"\]/.test(src)) bad.push("the claimer no longer declares web_search in its capabilities");
  if (!/parseCodexSearch|parseClaudeSearch/.test(src) || !/searchOutcome\(/.test(src)) bad.push("the claimer no longer counts searches from the CLI's event stream");
  if (!/search_events:/.test(src)) bad.push("the claimer no longer reports search_events with a search answer");
  if (!/can_search:/.test(src)) bad.push("the claimer no longer tells the claim route it can search");
  return bad;
}

/*
 * ── THE SAME RULE FOR FILES (0249) ───────────────────────────────────────────────────────────
 * A seat may be handed a picture or a deck only when the claimer on that Mac DECLARED it can read one, and it
 * declares that only from the proof its own probe wrote. Each guard below is one place that rule could be worn away.
 */
export function auditAttachmentMigration(sql) {
  const bad = [];
  for (const col of ["attachments_json", "attachments_cleared_at"]) {
    if (!new RegExp(`ADD COLUMN ${col}\\b`).test(sql ?? "")) bad.push(`migration 0249 no longer adds subscription_seat_run.${col}`);
  }
  return bad;
}

export function auditAttachmentClaim(seatsSrc) {
  const bad = [];
  const fn = body(seatsSrc, "export async function claimRun(");
  if (!fn) return ["claimRun was not found"];
  if (!/deviceMayReadRunFiles\(env, deviceId, c\.seat, c\.attachments_json\)/.test(fn)) bad.push("claimRun no longer judges a run's files against the claiming device's own stored capabilities for the run's seat");
  if (/can_read_attachments|canReadAttachments/.test(fn)) bad.push("claimRun trusts a flag in the claim request for files instead of the device's stored capabilities");
  const check = body(seatsSrc, "async function deviceMayReadRunFiles(");
  if (!check || !/refs\.every\(\(r\) => capabilitiesAllow\(row\?\.capabilities_json, seat, r\.kind\)\)/.test(check)) bad.push("the file check no longer requires EVERY kind of file in the run, for this seat, on this device");
  return bad;
}

export function auditAttachmentRouter(runAiSrc) {
  const bad = [];
  if (!/fileKinds\.every\(\(k\) => a\.canRead\?\.\[k\] === true\)/.test(runAiSrc)) bad.push("the router no longer requires a seat to have PROVEN every kind of file the call carries");
  if (!/\(!hasFiles \|\| fileSeatKeys\.size > 0\)/.test(runAiSrc)) bad.push("a call carrying files is no longer kept off the seats unless one of them proved it can read them");
  return bad;
}

export function auditAttachmentAdapter(adapterSrc) {
  const bad = [];
  if (!/wantsImages && availability\.canRead\?\.image !== true/.test(adapterSrc)) bad.push("the seat adapter no longer refuses a picture for a seat that did not prove it can see one");
  if (!/wantsDocuments && availability\.canRead\?\.document !== true/.test(adapterSrc)) bad.push("the seat adapter no longer refuses a document for a seat that did not prove it can read one");
  if (!/attachmentRefusal\(files\)/.test(adapterSrc)) bad.push("the seat adapter no longer applies the size and type bounds before parking a file");
  return bad;
}

export function auditAttachmentClaimer(src) {
  const bad = [];
  if (!/capabilitiesFromProof\(readProof\(\)\)/.test(src)) bad.push("the claimer no longer takes its file capabilities from the probe's proof file");
  if (!/missingCapability\(seat, carried, capabilities\)/.test(src)) bad.push("the claimer no longer refuses a run whose files it has not proved it can read");
  if (/read_(image|document):/.test(src.replace(/c\.startsWith\("read_(image|document):"\)/g, ""))) bad.push("the claimer names a file capability itself instead of taking it from the proof file");
  return bad;
}

function srcFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...srcFiles(p));
    else if (/\.ts$/.test(e.name)) out.push(p);
  }
  return out;
}

function audit() {
  const seats = read("src", "worker", "ai", "subscriptionSeats.ts");
  const files = srcFiles(path.join(ROOT, "src", "worker")).map((f) => [path.relative(ROOT, f), stripCommentsFor(f, readFileSync(f, "utf8"))]);
  return [
    ...auditMigration(read("migrations", "0246_a_seat_can_search_the_web.sql")),
    ...auditReport(seats),
    ...auditClaim(seats),
    ...auditCallSites(files),
    ...auditRouter(read("src", "worker", "ai", "runAi.ts")),
    ...auditAdapter(read("src", "worker", "ai", "providers", "subscriptionSeat.ts")),
    ...auditClaimer(read("scripts", "claimer", "subscription-seat-claimer.mjs")),
    ...auditAttachmentMigration(read("migrations", "0249_a_seat_can_be_handed_a_file.sql")),
    ...auditAttachmentClaim(seats),
    ...auditAttachmentRouter(read("src", "worker", "ai", "runAi.ts")),
    ...auditAttachmentAdapter(read("src", "worker", "ai", "providers", "subscriptionSeat.ts")),
    ...auditAttachmentClaimer(read("scripts", "claimer", "subscription-seat-claimer.mjs")),
  ];
}

function selfTest() {
  const seats = read("src", "worker", "ai", "subscriptionSeats.ts");
  const runAi = read("src", "worker", "ai", "runAi.ts");
  const adapter = read("src", "worker", "ai", "providers", "subscriptionSeat.ts");
  const claimer = read("scripts", "claimer", "subscription-seat-claimer.mjs");
  const sql = read("migrations", "0246_a_seat_can_search_the_web.sql");
  const cases = [
    ["the real sources pass", () => audit().length === 0],
    ["a migration without search_events is caught", () => auditMigration(sql.replace("search_events", "x")).length > 0],
    ["a reportRun that drops the proof comparison is caught", () => auditReport(seats.replace(/SEARCH_MIN_EVENTS/g, "0")).length > 0],
    ["a reportRun that accepts an unproven answer is caught", () => auditReport(seats.replace("const ok = hasOutput && !unproven", "const ok = hasOutput")).length > 0],
    ["a claimRun that hands search rows to anyone is caught", () => auditClaim(seats.replace('${canSearch ? "" : " AND needs_search = 0"}', "")).length > 0],
    ["a claimRun whose canSearch defaults to true is caught", () => auditClaim(seats.replace("canSearch = false", "canSearch = true")).length > 0],
    ["a new call site written the old way is caught", () => auditCallSites([["src/worker/services/x.ts", "if (run.model !== SEARCH_MODEL) return;"]]).length > 0],
    ["a call site using the shared check passes", () => auditCallSites([["src/worker/services/x.ts", "if (!servedBySearchLane(run.model)) return;"]]).length === 0],
    ["a router that offers a seat a search call without the declared capability is caught", () => auditRouter(runAi.replace("a.available && a.canSearch === true", "a.available")).length > 0],
    ["a router that forgets to tell the adapter it is a search call is caught", () => auditRouter(runAi.replace("needsSearch: requiresSearch", "")).length > 0],
    ["an adapter that parks a search row on a seat that cannot search is caught", () => auditAdapter(adapter.replace("needsSearch && !availability.canSearch", "false")).length > 0],
    ["a claimer that stops declaring the capability is caught", () => auditClaimer(claimer.replace('const BASE_CAPABILITIES = ["web_search"]', "const BASE_CAPABILITIES = []")).length > 0],
    ["a claimer that stops counting searches is caught", () => auditClaimer(claimer.replace(/searchOutcome\(/g, "x(")).length > 0],
    ["a migration without attachments_json is caught", () => auditAttachmentMigration(read("migrations", "0249_a_seat_can_be_handed_a_file.sql").replace("attachments_json", "x")).length > 0],
    ["a claimRun that stops checking the device's capabilities for files is caught", () => auditAttachmentClaim(seats.replace("deviceMayReadRunFiles(env, deviceId, c.seat, c.attachments_json)", "true")).length > 0],
    ["a file check that needs only SOME kind, not every kind, is caught", () => auditAttachmentClaim(seats.replace("refs.every((r) => capabilitiesAllow(", "refs.some((r) => capabilitiesAllow(")).length > 0],
    ["a router that offers files to a seat without proof is caught", () => auditAttachmentRouter(runAi.replaceAll("fileKinds.every((k) => a.canRead?.[k] === true)", "true")).length > 0],
    ["a router that lets files reach the seats whatever was proved is caught", () => auditAttachmentRouter(runAi.replaceAll("(!hasFiles || fileSeatKeys.size > 0)", "true")).length > 0],
    ["an adapter that parks a picture for a seat that cannot see is caught", () => auditAttachmentAdapter(adapter.replace("wantsImages && availability.canRead?.image !== true", "false")).length > 0],
    ["an adapter that skips the size bounds is caught", () => auditAttachmentAdapter(adapter.replace("attachmentRefusal(files)", "null")).length > 0],
    ["a claimer that stops reading its capabilities from the proof file is caught", () => auditAttachmentClaimer(claimer.replace("capabilitiesFromProof(readProof())", "[]")).length > 0],
    ["a claimer that runs files it has not proved it can read is caught", () => auditAttachmentClaimer(claimer.replace("missingCapability(seat, carried, capabilities)", "null")).length > 0],
    ["a claimer that hard-codes a file capability is caught", () => auditAttachmentClaimer(`${claimer}\nconst X = ["read_image:codex"];`).length > 0],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try { ok = fn() === true; } catch { ok = false; }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (failed > 0) { console.error(`SEAT-SEARCH SELF-TEST FAILED: ${failed} of ${cases.length}`); process.exit(1); }
  console.log(`SEAT-SEARCH SELF-TEST PASSED (${cases.length} fixtures)`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) selfTest();
  else {
    const bad = audit();
    if (bad.length > 0) {
      console.error("SEAT-SEARCH SCAN FAILED — a seat could answer a web search without proof it searched:");
      for (const b of bad) console.error(`  ✗ ${b}`);
      process.exit(1);
    }
    console.log("SEAT-SEARCH SCAN PASSED: a seat serves a search call only if its claimer declared web_search, the Worker records the answer only with counted search events, and every call site uses the shared check.");
  }
}
