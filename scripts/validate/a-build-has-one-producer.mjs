#!/usr/bin/env node
/**
 * a-build-has-one-producer.mjs — `npm run validate:artifacts`.
 *
 * ONE ASSERTION: A DASHBOARD, A DECK OR A DOCUMENT IS BUILT BY ONE PRODUCER, FROM THE RECORD ONLY,
 * WITH EVERY FIGURE CITED, AND WHAT SHE EXPORTS IS WHAT SHE SAW.
 *
 * WHAT THIS GUARDS (owner, 19 Sep 2026). "Build me a dashboard / deck / doc on demand … they need
 * to live where we would reuse them … Work cards solve this." Two doors — the live room's `build`
 * intent and an ARTIFACT work card — and one producer behind both (`services/artifacts.ts`). The
 * defect classes this repo keeps finding are all reachable from here: a second producer that
 * quietly grows its own SQL ("two components each keeping their own list"), a door that stops
 * calling the producer ("exists but nothing invokes it"), a figure in prose that no row backs, an
 * export that drifts from the page, a state nothing names. So every one is read from the code.
 *
 * WHAT IS CHECKED
 *   1 · ONE PRODUCER. `INSERT INTO artifact` and `INSERT INTO artifact_version` appear in
 *       services/artifacts.ts and in no other source file. `requestArtifactBuild` is defined once.
 *   2 · BOTH DOORS CALL IT. meetingRoom.ts calls `requestArtifactBuild(`; workSweep.ts's dispatch
 *       has an `ARTIFACT` arm that imports ./artifacts; `runArtifactCard` calls
 *       `requestArtifactBuild(`. The jobs tick calls `serveArtifactsOnTick`.
 *   3 · THE PLAN COMPILER IS THE ONLY QUERY SURFACE. In artifacts.ts the only `prepare(...)` whose
 *       argument is not a string literal is `prepare(compiled.sql)`, and `compileRecordQuery` is
 *       imported from the room's compiler and called exactly once.
 *   4 · EVERY FIGURE CITES ROWS. The real `checkCitations` (render.ts, loaded under esbuild) refuses
 *       three fixtures — an uncited number in prose, a panel with rows and no cites, a number with no
 *       panel — and passes a cited one. The producer calls `checkCitations(` before it writes a
 *       version, and never writes a version outside that call's reach.
 *   5 · EVERY KIND RENDERS IN-APP AND EXPORTS. For each of `ARTIFACT_KINDS`: a fixture of that kind
 *       goes through `slidesFor`/`documentFor` → `pptxBytes`/`docxBytes` → `textOfPptx`/`textOfDocx`,
 *       and every line the page would show is in the file, with the same set of figures. The
 *       ArtifactPage renders each kind by name, and index.ts serves both export routes.
 *   6 · EVERY STATE IS NAMED. `stateInWords` gives every `ARTIFACT_STATES` value a sentence that is
 *       not the enum itself.
 *
 * HARD-FAILS ON ZERO: zero kinds, zero states, zero fixtures, zero figures checked, zero doors,
 * zero prepare() calls read — each exits 1.
 *
 * `--self-test` plants each defect — a second producer, a door that no longer calls the producer,
 * a compiler call replaced by raw SQL, an export whose text drifts from the page, a state with no
 * words — and requires each to be caught, alongside the shipped source, which must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./lib/load-ts.mjs";
import { stripTsComments } from "./lib/strip-comments.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SRC = path.join(ROOT, "src");
const PRODUCER = path.join(SRC, "worker", "services", "artifacts.ts");
const ROOM = path.join(SRC, "worker", "services", "meetingRoom.ts");
const SWEEP = path.join(SRC, "worker", "services", "workSweep.ts");
const JOBS = path.join(SRC, "worker", "services", "jobs.ts");
const INDEX = path.join(SRC, "worker", "index.ts");
const PAGE = path.join(SRC, "client", "pages", "ArtifactPage.tsx");
const RENDER = path.join(SRC, "shared", "artifacts", "render.ts");
const SPEC = path.join(SRC, "shared", "artifacts", "artifact.ts");

function readTree(dir) {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(name)) out[path.relative(ROOT, full)] = stripTsComments(readFileSync(full, "utf8"));
    }
  };
  walk(dir);
  return out;
}

// ── 1 · one producer ──────────────────────────────────────────────────────────────────────────

export function checkOneProducer(tree) {
  const violations = [];
  let writers = 0;
  for (const [file, src] of Object.entries(tree)) {
    const n = (src.match(/INSERT\s+INTO\s+artifact(?:_version)?\b/gi) ?? []).length;
    if (n === 0) continue;
    writers += 1;
    if (!file.endsWith(path.join("services", "artifacts.ts"))) violations.push(`${file} writes the artifact table — a second producer; every build goes through services/artifacts.ts`);
  }
  const producer = tree[path.relative(ROOT, PRODUCER)] ?? "";
  const defs = (producer.match(/export async function requestArtifactBuild\b/g) ?? []).length;
  if (defs !== 1) violations.push(`requestArtifactBuild is defined ${defs} times in artifacts.ts; the door is one function`);
  return { violations, writers };
}

// ── 2 · both doors call it ────────────────────────────────────────────────────────────────────

export function checkDoors(roomSrc, sweepSrc, producerSrc, jobsSrc) {
  const violations = [];
  let doors = 0;
  if (/(?<![A-Za-z0-9_.])requestArtifactBuild\s*\(/.test(roomSrc)) doors += 1;
  else violations.push("meetingRoom.ts never calls requestArtifactBuild( — the room's build intent reaches no producer");
  const arm = /card\.kind === "ARTIFACT"[\s\S]{0,400}?await import\("\.\/artifacts"\)/.test(sweepSrc);
  if (arm) doors += 1;
  else violations.push('workSweep.ts has no `card.kind === "ARTIFACT"` arm importing ./artifacts — an ARTIFACT card would fall to the general loop');
  const runner = /export async function runArtifactCard\b[\s\S]*?requestArtifactBuild\s*\(/.test(producerSrc);
  if (!runner) violations.push("runArtifactCard does not call requestArtifactBuild( — the card door is not the same door");
  if (!/serveArtifactsOnTick\b/.test(jobsSrc)) violations.push("jobs.ts never calls serveArtifactsOnTick — a room build that needs a model would wait forever");
  return { violations, doors };
}

// ── 3 · the plan compiler is the only query surface ───────────────────────────────────────────

export function checkQuerySurface(producerSrc) {
  const violations = [];
  let prepares = 0;
  for (const m of producerSrc.matchAll(/\.prepare\(\s*([^)]*?)\s*\)/g)) {
    prepares += 1;
    const arg = m[1].trim();
    if (arg.startsWith('"') || arg.startsWith("`")) continue;
    if (arg === "compiled.sql") continue;
    violations.push(`artifacts.ts prepares \`${arg.slice(0, 40)}\` — a statement that is neither a literal nor the compiler's output`);
  }
  const compiled = (producerSrc.match(/\.prepare\(\s*compiled\.sql\s*\)/g) ?? []).length;
  if (compiled !== 1) violations.push(`artifacts.ts runs the compiler's SQL ${compiled} times; expected exactly one place (readPanels)`);
  if (!/import\s*\{[^}]*\bcompileRecordQuery\b[^}]*\}\s*from\s*"\.\.\/\.\.\/shared\/meetings\/roomQuery"/.test(producerSrc)) violations.push("artifacts.ts does not import compileRecordQuery from the room's compiler");
  const calls = (producerSrc.match(/(?<![A-Za-z0-9_.])compileRecordQuery\s*\(/g) ?? []).length;
  if (calls !== 1) violations.push(`compileRecordQuery is called ${calls} times in artifacts.ts; expected exactly one (readPanels)`);
  if (!/checkCitations\s*\(/.test(producerSrc)) violations.push("artifacts.ts never calls checkCitations( — a version could be written with an uncited figure");
  const insertAt = producerSrc.indexOf("INSERT INTO artifact_version");
  const checkAt = producerSrc.indexOf("checkCitations(");
  if (insertAt !== -1 && checkAt !== -1 && checkAt > insertAt) violations.push("artifacts.ts writes the version before it checks the citations");
  return { violations, prepares };
}

// ── 4–6 · the renderer, on fixtures ───────────────────────────────────────────────────────────

function fixture(kind) {
  const panel = {
    id: "p1", title: "Deals by status", chart: "bar", plan: { table: "investment_opportunity", group_by: "status", metric: { fn: "count" }, select: [], where: [], limit: 25, include_archived: false },
    table: "investment_opportunity", columns: ["status", "metric"], rows: [{ status: "DILIGENCE", metric: 2 }, { status: "NEW", metric: 1 }],
    cites: ["investment_opportunity:status=DILIGENCE", "investment_opportunity:status=NEW"], sql: "SELECT status, COUNT(*) AS metric FROM investment_opportunity", confidential: true, note: null,
  };
  const table = {
    id: "p2", title: "Companies", chart: "table", plan: { table: "canonical_company", select: ["canonical_name"], where: [], limit: 25, include_archived: false },
    table: "canonical_company", columns: ["id", "canonical_name"], rows: [{ id: "cc_1", canonical_name: "Sensori & Co" }], cites: ["canonical_company:cc_1"], sql: "SELECT id, canonical_name FROM canonical_company", confidential: false, note: null,
  };
  return {
    kind, title: `${kind} fixture <with & marks>`, brief: "x",
    about: { company_id: "cc_1", opportunity_id: null, meeting_id: null, fund_id: null, lp_record_id: null, label: "Sensori & Co" },
    built_by: "Wyatt", built_at: "2026-09-19T10:00:00Z", version_no: 3,
    summary: kind === "dashboard" ? null : "2 in diligence, 1 new.",
    panels: [panel, table],
    sections: kind === "dashboard" ? [] : [{ heading: "Where they sit", prose: "2 of the deals are in diligence; 1 is new.", panel_id: "p1" }],
    sources: [...panel.cites, ...table.cites],
  };
}

export function checkRenderer(render, spec, kinds, states) {
  const violations = [];
  let figures = 0;
  let fixtures = 0;
  // 4 · citations
  const cited = fixture("document");
  try {
    figures += render.checkCitations(cited).figures;
  } catch (err) {
    violations.push(`a fully cited fixture was refused: ${err.message}`);
  }
  const mustRefuse = [
    ["an uncited number in prose", { ...cited, sections: [{ heading: "x", prose: "There are 7 deals.", panel_id: "p1" }] }],
    ["a panel with rows and no cites", { ...cited, panels: [{ ...cited.panels[0], cites: [] }, cited.panels[1]] }],
    ["a number with no panel to cite", { ...cited, sections: [{ heading: "x", prose: "About 12 things.", panel_id: null }] }],
    ["a number in the summary no panel holds", { ...cited, summary: "There are 40 deals." }],
  ];
  for (const [what, bad] of mustRefuse) {
    let refused = false;
    try {
      render.checkCitations(bad);
    } catch (err) {
      refused = err instanceof render.UncitedFigure;
    }
    if (!refused) violations.push(`checkCitations did not refuse ${what}`);
  }
  // 5 · every kind renders and exports the same thing
  for (const kind of kinds) {
    fixtures += 1;
    const f = fixture(kind);
    const pageSlides = render.textOfSlides(render.slidesFor(f));
    const pageDoc = render.textOfDocument(render.documentFor(f));
    if (pageSlides.length < 4) violations.push(`${kind}: the deck derivation is too small to be a deck (${pageSlides.length} lines)`);
    const pptx = render.textOfPptx(render.pptxBytes(f)).flat();
    const docx = render.textOfDocx(render.docxBytes(f));
    for (const line of pageSlides) if (!pptx.includes(line)) violations.push(`${kind}: the .pptx is missing a line the page shows: "${line.slice(0, 60)}"`);
    for (const line of pageDoc) if (!docx.includes(line)) violations.push(`${kind}: the .docx is missing a line the page shows: "${line.slice(0, 60)}"`);
    const same = (a, b) => JSON.stringify([...new Set(render.figuresOf(a))].sort()) === JSON.stringify([...new Set(render.figuresOf(b))].sort());
    if (!same(pptx, pageSlides)) violations.push(`${kind}: the .pptx carries different figures from the page`);
    if (!same(docx, pageDoc)) violations.push(`${kind}: the .docx carries different figures from the page`);
    figures += render.figuresOf(pageSlides).length + render.figuresOf(pageDoc).length;
  }
  // 6 · every state named
  for (const state of states) {
    const words = spec.stateInWords({ state, stage: state === "BUILDING" ? "reading" : null, error_message: "a reason" });
    // Words, not the enum: "ready" is a word; "READY" printed back is not.
    if (!words || words === state || !/^[a-z]/.test(words)) violations.push(`state ${state} has no words`);
  }
  return { violations, figures, fixtures };
}

export function checkSurfaces(pageSrc, indexSrc, kinds) {
  const violations = [];
  for (const kind of kinds) {
    if (!new RegExp(`kind === "${kind}"`).test(pageSrc)) violations.push(`ArtifactPage.tsx has no branch for kind "${kind}" — it would render nothing for it`);
  }
  for (const route of ["/api/artifacts/:id/export.pptx", "/api/artifacts/:id/export.docx", "/api/artifacts/:id", "/api/artifacts"]) {
    if (!indexSrc.includes(`"${route}"`)) violations.push(`index.ts does not serve ${route}`);
  }
  if (!/Export \.pptx/.test(pageSrc) || !/Export \.docx/.test(pageSrc)) violations.push("ArtifactPage.tsx does not offer both exports");
  if (!/Refresh/.test(pageSrc) || !/Try again/.test(pageSrc) || !/Open the object/.test(pageSrc)) violations.push("ArtifactPage.tsx is missing Refresh, Try again or Open the object");
  return { violations };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };
  const tree = readTree(SRC);
  const producer = tree[path.relative(ROOT, PRODUCER)];
  const room = tree[path.relative(ROOT, ROOM)];
  const sweep = tree[path.relative(ROOT, SWEEP)];
  const jobs = tree[path.relative(ROOT, JOBS)];

  const one = checkOneProducer(tree);
  say(one.violations.length === 0 && one.writers === 1, `the shipped tree has one producer: ${one.violations.join("; ")}`);
  say(checkOneProducer({ ...tree, "src/worker/services/sneaky.ts": 'await env.WP_OS_DB.prepare("INSERT INTO artifact (id) VALUES (?1)").run();' }).violations.some((v) => /second producer/.test(v)), "a second file writing the artifact table is caught");

  const doors = checkDoors(room, sweep, producer, jobs);
  say(doors.violations.length === 0 && doors.doors === 2, `both doors call the producer: ${doors.violations.join("; ")}`);
  say(checkDoors(room.replace(/requestArtifactBuild\(/g, "openBuildSomehow("), sweep, producer, jobs).violations.some((v) => /meetingRoom\.ts never calls/.test(v)), "a room that stops calling the producer is caught");
  say(checkDoors(room, sweep.replace(/card\.kind === "ARTIFACT"/g, 'card.kind === "ARTEFACT"'), producer, jobs).violations.some((v) => /no `card\.kind === "ARTIFACT"` arm/.test(v)), "a sweep without the ARTIFACT arm is caught");
  say(checkDoors(room, sweep, producer, jobs.replace(/serveArtifactsOnTick/g, "serveNothing")).violations.some((v) => /jobs\.ts never calls/.test(v)), "a tick that never serves a build is caught");

  const surface = checkQuerySurface(producer);
  say(surface.violations.length === 0 && surface.prepares >= 10, `the compiler is the only query surface (${surface.prepares} prepare calls read): ${surface.violations.join("; ")}`);
  say(checkQuerySurface(producer.replace(".prepare(compiled.sql)", ".prepare(sqlFromTheModel)")).violations.some((v) => /neither a literal nor the compiler/.test(v)), "a statement from anywhere but the compiler is caught");
  say(checkQuerySurface(producer.replace("checkCitations(spec)", "noCheck(spec)")).violations.some((v) => /never calls checkCitations/.test(v)), "a producer that skips the citation check is caught");

  const render = await loadTs(RENDER);
  const spec = await loadTs(SPEC);
  const r = checkRenderer(render, spec, spec.ARTIFACT_KINDS, spec.ARTIFACT_STATES);
  say(r.violations.length === 0 && r.fixtures === spec.ARTIFACT_KINDS.length && r.figures > 0, `every kind renders and exports the same text and figures (${r.fixtures} kinds, ${r.figures} figures): ${r.violations.join("; ")}`);
  const drifting = { ...render, textOfPptx: (b) => render.textOfPptx(b).map((s) => s.map((l) => l.replace(/2/g, "9"))) };
  say(checkRenderer(drifting, spec, spec.ARTIFACT_KINDS, spec.ARTIFACT_STATES).violations.some((v) => /\.pptx carries different figures|\.pptx is missing/.test(v)), "an export whose figures drift from the page is caught");
  const lenient = { ...render, checkCitations: () => ({ figures: 1 }) };
  say(checkRenderer(lenient, spec, spec.ARTIFACT_KINDS, spec.ARTIFACT_STATES).violations.some((v) => /did not refuse/.test(v)), "a citation check that lets an uncited figure through is caught");
  const wordless = { ...spec, stateInWords: (s) => s.state };
  say(checkRenderer(render, wordless, spec.ARTIFACT_KINDS, spec.ARTIFACT_STATES).violations.some((v) => /has no words/.test(v)), "a state with no words is caught");

  const page = tree[path.relative(ROOT, PAGE)] ?? "";
  const index = tree[path.relative(ROOT, INDEX)];
  const s = checkSurfaces(page, index, spec.ARTIFACT_KINDS);
  say(s.violations.length === 0, `the page renders every kind and index.ts serves both exports: ${s.violations.join("; ")}`);
  say(checkSurfaces(page.replace('kind === "deck"', 'kind === "dek"'), index, spec.ARTIFACT_KINDS).violations.some((v) => /no branch for kind "deck"/.test(v)), "a page that cannot render a kind is caught");

  if (failed > 0) process.exit(1);
  console.log("SELF-TEST PASSED: a second producer, a door that stops calling it, a missing sweep arm, a tick that never serves, raw SQL beside the compiler, a skipped citation check, a drifting export, a lenient citation check, a wordless state and an unrenderable kind are each caught; the shipped source passes.");
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const tree = readTree(SRC);
  const producer = tree[path.relative(ROOT, PRODUCER)];
  if (!producer) {
    console.error("ARTIFACTS SCAN FAILED — src/worker/services/artifacts.ts is missing; there is no producer to read.");
    process.exit(1);
  }
  const render = await loadTs(RENDER);
  const spec = await loadTs(SPEC);
  const one = checkOneProducer(tree);
  const doors = checkDoors(tree[path.relative(ROOT, ROOM)], tree[path.relative(ROOT, SWEEP)], producer, tree[path.relative(ROOT, JOBS)]);
  const surface = checkQuerySurface(producer);
  const r = checkRenderer(render, spec, spec.ARTIFACT_KINDS, spec.ARTIFACT_STATES);
  const s = checkSurfaces(tree[path.relative(ROOT, PAGE)] ?? "", tree[path.relative(ROOT, INDEX)], spec.ARTIFACT_KINDS);

  const empty = [
    spec.ARTIFACT_KINDS.length === 0 && "found 0 artifact kinds",
    spec.ARTIFACT_STATES.length === 0 && "found 0 artifact states",
    one.writers === 0 && "found 0 files writing the artifact table",
    doors.doors === 0 && "found 0 doors calling the producer",
    surface.prepares === 0 && "read 0 prepare() calls in artifacts.ts",
    r.fixtures === 0 && "rendered 0 fixtures",
    r.figures === 0 && "checked 0 figures",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`ARTIFACTS SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }
  const violations = [...one.violations, ...doors.violations, ...surface.violations, ...r.violations, ...s.violations];
  if (violations.length > 0) {
    console.error("ARTIFACTS SCAN FAILED — a build could be made outside the one producer, from outside the record, uncited, or exported as something other than what the page shows:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    process.exit(1);
  }
  console.log(
    `ARTIFACTS SCAN PASSED: one producer (${one.writers} file writes the artifact table), ${doors.doors} doors call it and the tick serves it; ` +
      `${surface.prepares} prepare() calls read in artifacts.ts, the compiler's output the only non-literal; ${r.fixtures} kinds rendered, exported and read back with the same text and figures (${r.figures} figures); ` +
      `${spec.ARTIFACT_STATES.length} states each have words; the page renders every kind and both exports are served.`,
  );
}
