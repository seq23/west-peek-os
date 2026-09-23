#!/usr/bin/env node
/**
 * cc-partners-only.mjs — `npm run validate:cc-partners-only`.
 *
 * ONE ASSERTION: A CC REACHES ONLY A PARTNER, ONLY BECAUSE THE PARTNER WHO ASKED SAID SO, AND ONLY
 * ON FINISHED WORK (owner, 23 Sep 2026: "yes add cc support"; migration 0239).
 *
 * A cc is a new way for an email to reach an address, so it is held to everything a To already is.
 * Each check is a different failure if it drifts:
 *
 *   1 · ONE WRITER. `work_card.cc_emails` is set in `services/ccPartners.ts` (from the requester's
 *       own words), copied from the source card by `assignCard` (a hand-off), and frozen onto a filed
 *       preview through `ccList` — nowhere else. A fourth writer is a cc nobody asked for.
 *   2 · ONLY THE REQUESTER. `recordCcFrom` compares the authenticated writer with the card's
 *       requester before it writes, and resolves names through `resolveCc`.
 *   3 · PARTNERS BY THE REGISTRY. `resolveCc` resolves through `partnerByEmail` / `partnerByName`
 *       and nothing else; `ccList` drops any stored address `partnerByEmail` does not know.
 *   4 · THE SEND REFUSES A STRANGER. `sendPartnerEmail` checks every cc against ASSIGNING_PARTNERS
 *       before any transport is called; `assertPreviewLane` counts `payload.cc` as recipients; the
 *       approved send reads its cc through `ccList`.
 *   5 · FINISHED WORK ONLY. `sendOrPreview` reads the card's cc only under `input.finished`.
 *
 * `--self-test` plants each drift and requires it caught; the shipped source must pass.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const F = {
  shared: path.join(ROOT, "src", "shared", "work", "ccPartners.ts"),
  service: path.join(ROOT, "src", "worker", "services", "ccPartners.ts"),
  exec: path.join(ROOT, "src", "worker", "services", "execEmail.ts"),
  preview: path.join(ROOT, "src", "worker", "services", "previewApproval.ts"),
  transport: path.join(ROOT, "src", "worker", "effects", "emailTransport.ts"),
  employeeWork: path.join(ROOT, "src", "worker", "services", "employeeWork.ts"),
};
const SRC_DIR = path.join(ROOT, "src");

function body(src, name) {
  const start = src.indexOf(name);
  if (start < 0) return null;
  const open = src.indexOf("{\n", start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}" && --depth === 0) return src.slice(open, i + 1);
  }
  return null;
}

async function allSources() {
  const { readdirSync, statSync } = await import("node:fs");
  const out = {};
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = path.join(dir, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.tsx?$/.test(n)) out[path.relative(ROOT, p)] = stripTsComments(readFileSync(p, "utf8"));
    }
  };
  walk(SRC_DIR);
  return out;
}

export function check(src, all) {
  const v = [];
  let examined = 0;
  // 1 · ONE WRITER
  const WRITE = /SET[^;`"]*\bcc_emails\s*=|INSERT INTO (?:work_card|preview_approval)\b[^;]*\bcc_emails\b/g;
  const allowed = new Set([path.join("src", "worker", "services", "ccPartners.ts"), path.join("src", "worker", "services", "employeeWork.ts"), path.join("src", "worker", "services", "previewApproval.ts")]);
  for (const [file, text] of Object.entries(all)) {
    examined += 1;
    if ((text.match(WRITE) ?? []).length > 0 && !allowed.has(file)) v.push(`${file} writes cc_emails — only ccPartners.ts (the requester's words), assignCard (a hand-off) and filePreview (frozen) may`);
  }
  if (!/cc_emails = COALESCE\(\(SELECT cc_emails FROM work_card WHERE id = \?3\), '\[\]'\)/.test(src.employeeWork)) v.push("assignCard no longer copies cc_emails only from the source card");
  if (!/JSON\.stringify\(ccList\(/.test(src.preview)) v.push("filePreview freezes a cc that did not pass through ccList");
  // 2 · ONLY THE REQUESTER
  const rec = body(src.service, "export async function recordCcFrom(");
  if (!rec) v.push("recordCcFrom() is gone");
  else {
    examined += 1;
    if (!/const allowed = Boolean\(requester\) && requester!\.email === writer;/.test(rec)) v.push("recordCcFrom() no longer checks the writer is the card's requester");
    const allowAt = rec.indexOf("if (!allowed");
    const writeAt = rec.indexOf("UPDATE work_card SET cc_emails");
    if (allowAt < 0 || writeAt < 0 || allowAt > writeAt) v.push("recordCcFrom() writes before it refuses a writer who is not the requester");
    if (!/resolveCc\(tokens, writer\)/.test(rec)) v.push("recordCcFrom() does not resolve through resolveCc");
  }
  // 3 · PARTNERS BY THE REGISTRY
  const res = body(src.shared, "export function resolveCc(");
  const list = body(src.shared, "export function ccList(");
  if (!res || !list) v.push("resolveCc() or ccList() is gone");
  else {
    examined += 1;
    if (!/partnerByEmail\(t\) : partnerByName\(t\)/.test(res)) v.push("resolveCc() resolves a cc some other way than the partner registry");
    if (!/if \(!p\) \{\s*refused\.push/.test(res)) v.push("resolveCc() does not refuse a name the registry does not know");
    if (!/\.filter\(\(a\) => partnerByEmail\(a\) !== null\)/.test(list)) v.push("ccList() no longer drops stored addresses that are not partners");
  }
  // 4 · THE SEND
  const door = body(src.exec, "export async function sendPartnerEmail(");
  if (!door) v.push("sendPartnerEmail() is gone");
  else {
    examined += 1;
    const refuseAt = door.search(/const strangerCc = cc\.find\(\(a\) => !ASSIGNING_PARTNERS\.includes\(a\)\);\s*if \(strangerCc\) \{\s*return \{ sent: false/);
    const sendAt = door.indexOf("await transport(");
    if (refuseAt < 0) v.push("sendPartnerEmail() does not refuse a cc that is not a partner");
    else if (sendAt >= 0 && refuseAt > sendAt) v.push("sendPartnerEmail() checks the cc after the transport");
  }
  const lane = body(src.transport, "export function assertPreviewLane(");
  if (!lane || !/\.\.\.\(payload\.cc \?\? \[\]\)/.test(lane)) v.push("assertPreviewLane() does not count a cc as a recipient — an outsider in Cc would pass the lane");
  else examined += 1;
  const approved = body(src.preview, "async function sendApproved(");
  if (!approved || !/ccList\(row\.cc_emails\)/.test(approved)) v.push("sendApproved() reads its cc without ccList");
  // 5 · FINISHED ONLY
  // recipientsFor() is the ONE place To + Cc are computed; sendOrPreview() asks it and nothing else.
  const rf = body(src.preview, "export async function recipientsFor(");
  const sop = body(src.preview, "export async function sendOrPreview(");
  if (!rf || !/const cc = input\.finished \? \(await ccOfCard\(env, input\.workCardId\)\)/.test(rf)) v.push("recipientsFor() copies the card's cc on something other than finished work");
  else if (!sop || !/const \{ to, cc \} = await recipientsFor\(env, input\);/.test(sop) || /ccOfCard\(/.test(sop)) v.push("sendOrPreview() computes its recipients somewhere other than recipientsFor() — two lists of who hears it");
  else examined += 1;
  return { violations: v, examined };
}

async function load() {
  const src = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, stripTsComments(readFileSync(p, "utf8"))]));
  return { src, all: await allSources() };
}

async function selfTest() {
  const { src, all } = await load();
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const real = check(src, all);
  say(real.violations.length === 0 && real.examined > 5, `shipped source passes (${real.examined} examined): ${real.violations.join("; ")}`);
  const caught = (patch, allPatch, re, what) => say(check({ ...src, ...patch }, { ...all, ...allPatch }).violations.some((x) => re.test(x)), what);
  caught({}, { "src/worker/services/blogHelp.ts": 'await env.WP_OS_DB.prepare("UPDATE work_card SET cc_emails = ?2 WHERE id = ?1")' }, /blogHelp\.ts writes cc_emails/, "a fourth writer is caught");
  caught({ service: src.service.replace("const allowed = Boolean(requester) && requester!.email === writer;", "const allowed = true;") }, {}, /requester/, "a cc from anyone is caught");
  caught({ shared: src.shared.replace("partnerByEmail(t) : partnerByName(t)", "partnerByEmail(t) ?? { email: t } : partnerByName(t)") }, {}, /registry/, "a cc resolved outside the registry is caught");
  caught({ shared: src.shared.replace(".filter((a) => partnerByEmail(a) !== null)", "") }, {}, /drops stored addresses/, "a stored list that can widen is caught");
  caught({ exec: src.exec.replace("if (strangerCc) {", "if (false) {") }, {}, /refuse a cc/, "a send that takes a stranger's cc is caught");
  caught({ transport: src.transport.replace("...(payload.cc ?? [])", "") }, {}, /count a cc/, "a lane blind to cc is caught");
  caught({ preview: src.preview.replace("const cc = input.finished ? (await ccOfCard(env, input.workCardId))", "const cc = (await ccOfCard(env, input.workCardId))") }, {}, /finished work/, "a cc on every notice is caught");
  caught({ preview: src.preview.replace("const { to, cc } = await recipientsFor(env, input);", "const to = input.to.trim().toLowerCase(); const cc = await ccOfCard(env, input.workCardId);") }, {}, /two lists of who hears it/, "a second recipient list in sendOrPreview is caught");
  caught({ preview: src.preview.replace("ccList(row.cc_emails)", "JSON.parse(row.cc_emails ?? \"[]\")") }, {}, /sendApproved/, "an approved send reading raw cc is caught");
  caught({ employeeWork: src.employeeWork.replace("cc_emails = COALESCE((SELECT cc_emails FROM work_card WHERE id = ?3), '[]')", "cc_emails = ?4") }, {}, /assignCard/, "a hand-off that invents a cc is caught");
  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: ten planted defects are each caught; the shipped source passes.");
}

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const { src, all } = await load();
  const { violations, examined } = check(src, all);
  if (examined === 0) {
    console.error("CC SCAN FAILED — examined nothing (Rule 0).");
    process.exit(1);
  }
  if (violations.length) {
    console.error("CC SCAN FAILED — a cc could reach someone it should not:");
    for (const x of violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`CC SCAN PASSED: ${examined} checks — one writer, only the requester, partners by the registry, the send and the lane refuse a stranger, finished work only.`);
}
