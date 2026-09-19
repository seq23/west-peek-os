#!/usr/bin/env node
/**
 * no-fireflies-import-door.mjs — `npm run validate:whisper-not-fireflies`.
 *
 * ONE ASSERTION: NO SURFACE OFFERS A FIREFLIES IMPORT, THE OLD ROUTE ANSWERS WITH THE NAMED REFUSAL,
 * AND THE TWO CAPTURE PATHS THAT REMAIN ARE SAID PLAINLY WHERE THE DOOR USED TO BE.
 *
 * WHAT THIS GUARDS (owner, 19 Sep 2026): "we will use Whisper in lieu of Fireflies — it's better."
 * The paste-or-upload import (operator, 22 Aug 2026) is retired. A meeting is written down two ways
 * and only two: the room's recording switch (this laptop's microphone → Nova-3, Whisper as the
 * fallback; a yes every session; live) and Google Meet's own transcription read in after the call.
 *
 *   1 · NO SURFACE OFFERS IT. No client source (comments stripped) emits `fireflies-text`,
 *       `fireflies-file`, `fireflies-submit` or `fireflies-import`, calls `/transcript/fireflies`,
 *       or renders a "Bring it in" control.
 *   2 · THE ROUTE REFUSES BY NAME (the 0198 precedent). `index.ts` maps
 *       `POST /api/meetings/:id/transcript/fireflies` to `handleFirefliesRetired` and to nothing
 *       else; the handler answers 410 `fireflies_import_retired` with the owner's words and the two
 *       paths; no `importFireflies(` exists in the Worker; the Worker never calls `parseFireflies(`.
 *   3 · THE PARSER STAYS ONLY WHILE SOMETHING RENDERS THROUGH IT. `meetTranscript.ts` imports
 *       `turnLine` from `firefliesTranscript.ts` — the Meet ingest's turn-line shape. If nothing
 *       imports the module any more it is dead and must go.
 *   4 · HER WORDS STAND WHERE THE CONTROL WAS. `MeetingsPage.tsx` emits `fireflies-retired`
 *       carrying the quote and naming both remaining paths.
 *   5 · THE GUIDE SAYS THE TWO PATHS AND NOT THE THIRD. No guide names "Bring it in" or a Fireflies
 *       act; the Meetings guide's rendered answer names the laptop microphone and Google's transcript.
 *   6 · THE REFUSAL IS TESTED. `tests/icStage.test.ts` asserts the 410 and the error name.
 *
 * HARD-FAILS ON ZERO: zero client files, zero guides, a missing route line — each exits 1.
 *
 * `--self-test` plants the door back (a paste box, a route to a real importer, a guide act, the
 * quote removed, the parser orphaned) and proves each is caught, then proves the shipped tree passes.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./lib/load-ts.mjs";
import { stripTsComments } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const CLIENT = path.join(ROOT, "src", "client");
const WORKER = path.join(ROOT, "src", "worker");
const SHARED = path.join(ROOT, "src", "shared");
const INDEX = path.join(WORKER, "index.ts");
const LIVE = path.join(WORKER, "services", "liveTranscription.ts");
const MEETINGS_PAGE = path.join(CLIENT, "pages", "MeetingsPage.tsx");
const REGISTRY = path.join(SHARED, "help", "pageGuide", "index.ts");
const RENDER = path.join(SHARED, "help", "pageGuide", "render.ts");
const IC_TEST = path.join(ROOT, "tests", "icStage.test.ts");

export const OWNER_WORDS = "we will use Whisper in lieu of Fireflies — it's better";
const DOOR_TESTIDS = ["fireflies-text", "fireflies-file", "fireflies-submit", "fireflies-import"];

function walk(dir, ext) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, ext));
    else if (ext.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

/** 1 · no surface offers it. `sources` is {relPath: strippedSource}. */
export function checkSurfaces(sources) {
  const v = [];
  for (const [name, src] of Object.entries(sources)) {
    for (const id of DOOR_TESTIDS) if (src.includes(`data-testid="${id}"`)) v.push(`${name} still emits ${id} — the Fireflies import door is back`);
    if (src.includes("/transcript/fireflies")) v.push(`${name} still calls /transcript/fireflies`);
    if (/>\s*(\{[^}]*\?\s*"[^"]*"\s*:\s*)?"?Bring it in"?\s*[}<]/.test(src) || src.includes('"Bring it in"') || /Bring it in\s*</.test(src)) v.push(`${name} still renders a "Bring it in" control`);
  }
  return v;
}

/** 2 · the route refuses by name, and no importer exists. */
export function checkRoute(indexSource, liveSource, workerSources) {
  const v = [];
  const routes = [...indexSource.matchAll(/\.post\("\/api\/meetings\/:id\/transcript\/fireflies",\s*(\w+)\)/g)].map((m) => m[1]);
  if (routes.length === 0) v.push("index.ts no longer answers POST /api/meetings/:id/transcript/fireflies — it must refuse by name, not 404");
  for (const h of routes) if (h !== "handleFirefliesRetired") v.push(`index.ts routes the Fireflies door to ${h}, not handleFirefliesRetired`);
  if (!/fireflies_import_retired/.test(liveSource)) v.push("liveTranscription.ts has no fireflies_import_retired refusal");
  if (!liveSource.includes(OWNER_WORDS)) v.push("the refusal does not carry the owner's words");
  if (!/status: 410/.test(liveSource)) v.push("the refusal is not a 410");
  if (!/laptop's microphone/.test(liveSource) || !/Google Meet's own transcription/.test(liveSource)) v.push("the refusal does not name the two remaining paths");
  for (const [name, src] of Object.entries(workerSources)) {
    if (/function importFireflies\(/.test(src)) v.push(`${name} still defines importFireflies`);
    if (/parseFireflies\(/.test(src)) v.push(`${name} still calls parseFireflies — the parser is a line shape, not a door`);
  }
  return v;
}

/** 3 · the parser stays only while something renders through it. */
export function checkParserUse(sharedSources) {
  const v = [];
  const users = Object.entries(sharedSources).filter(([name, src]) => !name.endsWith("firefliesTranscript.ts") && /from "\.\/firefliesTranscript"|firefliesTranscript"/.test(src));
  if (users.length === 0) v.push("nothing imports shared/meetings/firefliesTranscript.ts any more — the parser is dead and must be removed");
  return { violations: v, users: users.map(([n]) => n) };
}

/** 4 · her words stand where the control was. */
export function checkWords(pageSource) {
  const v = [];
  if (!pageSource.includes('data-testid="fireflies-retired"')) v.push("MeetingsPage.tsx has no fireflies-retired note where the import used to be");
  if (!pageSource.includes(OWNER_WORDS)) v.push("MeetingsPage.tsx does not carry the owner's words");
  if (!/recording switch above/.test(pageSource) || !/Google Meet's own transcription/.test(pageSource)) v.push("the note does not name both remaining paths");
  return v;
}

/** 5 · the guide says the two paths and not the third. */
export function checkGuides(registry, render) {
  const v = [];
  const guides = Object.values(registry.PAGE_GUIDES ?? {});
  for (const g of guides) {
    for (const a of g.acts ?? []) {
      if (a.label === "Bring it in" || /fireflies/i.test(`${a.label} ${a.does} ${a.then ?? ""}`)) v.push(`${g.navKey}: act "${a.label}" still offers a Fireflies import`);
    }
    for (const w of g.walkthroughs ?? []) for (const st of w.steps ?? []) if (/\*\*Bring it in\*\*/.test(st.do)) v.push(`${g.navKey}: the walkthrough still presses Bring it in`);
  }
  const meetings = registry.PAGE_GUIDES?.meetings;
  if (!meetings) v.push("no Meetings guide");
  else {
    const md = render.renderGuideAnswer(meetings);
    if (!/laptop('s)? microphone/.test(md)) v.push("the Meetings guide does not name the laptop microphone path");
    if (!/Google's (own )?transcript|Meet's own transcription/.test(md)) v.push("the Meetings guide does not name Google's transcript path");
    if (!/Fireflies exports are no longer brought in/.test(md)) v.push("the Meetings guide does not say Fireflies exports are no longer brought in");
  }
  return { violations: v, guides: guides.length };
}

/** 6 · the refusal is tested. */
export function checkTested(testSource) {
  const v = [];
  if (!/toBe\(410\)/.test(testSource) || !/fireflies_import_retired/.test(testSource)) v.push("tests/icStage.test.ts does not pin the 410 fireflies_import_retired refusal");
  return v;
}

function readStripped(p) {
  return stripTsComments(readFileSync(p, "utf8"));
}

function realInputs() {
  const clientSources = Object.fromEntries(walk(CLIENT, [".tsx", ".ts"]).map((p) => [path.relative(ROOT, p), readStripped(p)]));
  const workerSources = Object.fromEntries(walk(WORKER, [".ts"]).map((p) => [path.relative(ROOT, p), readStripped(p)]));
  const sharedSources = Object.fromEntries(walk(path.join(SHARED, "meetings"), [".ts"]).map((p) => [path.relative(ROOT, p), readStripped(p)]));
  return {
    clientSources,
    workerSources,
    sharedSources,
    indexSource: readStripped(INDEX),
    liveSource: readStripped(LIVE),
    pageSource: readStripped(MEETINGS_PAGE),
    testSource: readStripped(IC_TEST),
  };
}

function runAll(inp, registry, render) {
  const parser = checkParserUse(inp.sharedSources);
  const guides = checkGuides(registry, render);
  const violations = [
    ...checkSurfaces(inp.clientSources),
    ...checkRoute(inp.indexSource, inp.liveSource, inp.workerSources),
    ...parser.violations,
    ...checkWords(inp.pageSource),
    ...guides.violations,
    ...checkTested(inp.testSource),
  ];
  return { violations, clientFiles: Object.keys(inp.clientSources).length, guides: guides.guides, parserUsers: parser.users };
}

async function main() {
  const registry = await loadTs(REGISTRY);
  const render = await loadTs(RENDER);
  const inp = realInputs();
  const r = runAll(inp, registry, render);
  if (r.clientFiles === 0 || r.guides === 0) {
    console.error(`validate:whisper-not-fireflies — examined ${r.clientFiles} client files and ${r.guides} guides. Rule 0.`);
    process.exit(1);
  }
  if (r.violations.length > 0) {
    console.error(`validate:whisper-not-fireflies — ${r.violations.length} violation(s):`);
    for (const x of r.violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`validate:whisper-not-fireflies — ${r.clientFiles} client files offer no Fireflies import; the route answers 410 fireflies_import_retired in the owner's words; the parser is kept as a line shape by ${r.parserUsers.join(", ")}; ${r.guides} guides name only the two paths.`);
}

async function selfTest() {
  const registry = await loadTs(REGISTRY);
  const render = await loadTs(RENDER);
  const inp = realInputs();
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };

  say(checkSurfaces({ "x.tsx": '<textarea data-testid="fireflies-text" /><button data-testid="fireflies-submit">Bring it in</button>' }).length >= 2, "a paste box and a Bring it in button are caught");
  say(checkSurfaces({ "x.tsx": 'api(`/api/meetings/${id}/transcript/fireflies`, {})' }).length === 1, "a call to the old route is caught");
  say(checkRoute(inp.indexSource.replace("handleFirefliesRetired)", "handleImportFireflies)"), inp.liveSource, inp.workerSources).some((v) => /not handleFirefliesRetired/.test(v)), "a route back to a real importer is caught");
  say(checkRoute(inp.indexSource.replace(/\.post\("\/api\/meetings\/:id\/transcript\/fireflies",\s*\w+\)/, ""), inp.liveSource, inp.workerSources).some((v) => /must refuse by name, not 404/.test(v)), "a route that silently vanished is caught");
  say(checkRoute(inp.indexSource, inp.liveSource.replace("status: 410", "status: 404"), inp.workerSources).some((v) => /not a 410/.test(v)), "a refusal that is not a 410 is caught");
  say(checkRoute(inp.indexSource, inp.liveSource, { ...inp.workerSources, "src/worker/x.ts": "export async function importFireflies() { return parseFireflies(t); }" }).length >= 2, "an importer or a parser call in the Worker is caught");
  say(checkParserUse({ "src/shared/meetings/firefliesTranscript.ts": "export function turnLine() {}" }).violations.length === 1, "an orphaned parser is caught");
  say(checkParserUse(inp.sharedSources).users.includes("src/shared/meetings/meetTranscript.ts"), "meetTranscript.ts is the reason the parser stays");
  say(checkWords(inp.pageSource.replace(OWNER_WORDS, "")).length >= 1, "the quote removed from the page is caught");
  const ghostGuide = { PAGE_GUIDES: { ...registry.PAGE_GUIDES, meetings: { ...registry.PAGE_GUIDES.meetings, acts: [...registry.PAGE_GUIDES.meetings.acts, { label: "Bring it in", does: "brings in a Fireflies transcript." }] } } };
  say(checkGuides(ghostGuide, render).violations.some((v) => /still offers a Fireflies import/.test(v)), "a guide act offering the import is caught");
  say(checkTested("expect(res.status).toBe(201)").length === 1, "a test that no longer pins the 410 is caught");

  const shipped = runAll(inp, registry, render);
  say(shipped.violations.length === 0 && shipped.clientFiles > 0, `the shipped tree passes (${shipped.clientFiles} client files): ${shipped.violations.slice(0, 5).join("; ")}`);

  if (failed > 0) {
    console.error(`validate:whisper-not-fireflies --self-test: ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("validate:whisper-not-fireflies --self-test: every planted defect was caught.");
}

if (process.argv.includes("--self-test")) await selfTest();
else await main();
