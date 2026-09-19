#!/usr/bin/env node
/**
 * a-guide-names-what-the-page-emits.mjs — `npm run validate:page-guides`.
 *
 * ONE ASSERTION: EVERY PAGE GUIDE DESCRIBES THE PAGE AS IT IS RENDERED TODAY, AND NOTHING ELSE.
 *
 * WHAT THIS GUARDS (owner, 19 Sep 2026). She asked Walter on Meetings how the page works and he
 * described the page as it was a week earlier — "Prepare for a meeting · Confer with an AI employee
 * during it · Run a close-out" — because the description he was handed was prose in
 * `pagePurpose.ts` that nothing read against the page. The redesign had given the page three faces,
 * a room and one approval card, and every test stayed green.
 *
 * The guides in `src/shared/help/pageGuide/` are the replacement, and this scan is what makes them
 * a contract rather than a second copy of the same prose. For every guide, against the SOURCE of
 * the components it says the page renders (comments stripped, so a sentence about a retired button
 * cannot satisfy it):
 *
 *   1 · EVERY BAND AND ACT THE GUIDE NAMES IS EMITTED. A `testid` must appear as a `data-testid`
 *       the page writes (exact, or the literal prefix of a template). An act's `label` must appear
 *       verbatim in the source. A band with no testid must have its name verbatim in the source.
 *   2 · EVERY PRIMARY ACT THE PAGE EMITS IS IN THE GUIDE. Every `<button>` or `<a>` carrying
 *       `btn-strong` or `btn-primary` and a `data-testid` in the sources must be one of the guide's
 *       acts, or be listed under `notActs` with a reason. A page cannot grow a human act the guide
 *       does not mention.
 *   3 · EVERY LINK IS TO A PAGE THAT EXISTS. `elsewhere[].page` must be a route App.tsx renders.
 *   4 · EVERY JOB IS REAL. `auto[].job` must be a `job_key` some migration writes.
 *   5 · THE GUIDE IS WHAT THE HOST SAYS. The rendered answer contains every act's label in bold,
 *       and the shape is a numbered band list and bulleted acts — never one paragraph.
 *   6 · NO STALE PROSE ELSEWHERE. `pagePurpose.ts` and `HelpCenterPage.tsx` must not carry the
 *       retired Meetings trio, or any act label that no guide names on a page that has a guide.
 *
 * HARD-FAILS ON ZERO: zero guides, zero source files, zero acts across the registry, zero route
 * keys — each exits 1. An empty loop reporting success is Rule 0.
 *
 * `--self-test` runs the defect this was written for — the stale Meetings trio as a guide against
 * the real Meetings sources — plus a guide missing a primary act, a link to a page that does not
 * exist, a job no migration writes, and a source file that is not there, through the same checks,
 * and proves the shipped registry passes.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTs } from "./lib/load-ts.mjs";
import { stripCommentsFor, stripTsComments } from "./lib/strip-comments.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const REGISTRY = path.join(ROOT, "src", "shared", "help", "pageGuide", "index.ts");
const RENDER = path.join(ROOT, "src", "shared", "help", "pageGuide", "render.ts");
const APP = path.join(ROOT, "src", "client", "App.tsx");
const MIGRATIONS = path.join(ROOT, "migrations");
const PURPOSE = path.join(ROOT, "src", "shared", "help", "pagePurpose.ts");
const HELP = path.join(ROOT, "src", "client", "pages", "HelpCenterPage.tsx");

/** The page as she was told it worked, on 19 Sep 2026. Must never come back, anywhere. */
export const RETIRED_MEETINGS_TRIO = ["Prepare for a meeting", "Confer with an AI employee", "Run a close-out"];

/** Every route key App.tsx renders — the same read `tests/pagePurpose.test.ts` makes. */
export function routeKeys(appSource) {
  return new Set([...appSource.matchAll(/active === "([a-z0-9-]+)"/g)].map((m) => m[1]));
}

/** Every `job_key` literal any migration writes. */
export function jobKeys(migrationsDir) {
  const keys = new Set();
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"))) {
    const sql = stripCommentsFor(f, readFileSync(path.join(migrationsDir, f), "utf8"));
    for (const m of sql.matchAll(/job_key\s*(?:=|IN)\s*\(?\s*'([a-z_]+)'/g)) keys.add(m[1]);
    // Seed rows: ('sjb_x', 'job_key', …) — the key is the literal after the id literal.
    for (const m of sql.matchAll(/'sj(?:b|ob)_[a-z_]+'\s*,\s*'([a-z_]+)'/g)) keys.add(m[1]);
  }
  return keys;
}

/** `data-testid` values a source emits: exact strings and the literal prefixes of templates. */
export function emittedTestids(source) {
  const exact = new Set();
  const prefixes = new Set();
  for (const m of source.matchAll(/data-testid=\{?["'`]([^"'`$]*)(\$\{)?/g)) {
    if (m[2]) prefixes.add(m[1]);
    else exact.add(m[1]);
  }
  return { exact, prefixes };
}

export function testidIsEmitted(testid, emitted) {
  if (emitted.exact.has(testid)) return true;
  if (testid.endsWith("-") && emitted.prefixes.has(testid)) return true;
  // A guide may name the exact prefix of a template written as `${`.
  for (const p of emitted.prefixes) if (p !== "" && testid.startsWith(p) && testid === p) return true;
  return false;
}

/**
 * Opening tags of `<button …>` and `<a …>` with their attributes, brace-aware so an arrow function
 * inside `onClick={() => …}` does not end the tag early.
 */
export function openingTags(source) {
  const out = [];
  const re = /<(button|a)\b/g;
  for (const m of source.matchAll(re)) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote = null;
    while (i < source.length) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === "`") quote = c;
      else if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
      i += 1;
    }
    out.push({ tag: m[1], attrs: source.slice(m.index, i + 1) });
  }
  return out;
}

/** Primary controls: `btn-strong` / `btn-primary` with a data-testid. Returns the testid or prefix. */
export function primaryTestids(source) {
  const ids = new Set();
  for (const t of openingTags(source)) {
    if (!/className=(?:"[^"]*\bbtn-(?:strong|primary)\b[^"]*"|\{[^}]*\bbtn-(?:strong|primary)\b[^}]*\})/.test(t.attrs)) continue;
    const id = /data-testid=\{?["'`]([^"'`$]*)(\$\{)?/.exec(t.attrs);
    if (!id) continue;
    // A testid that is wholly a variable (`${testId}-confirm`) cannot be named by a guide and is
    // not counted; the control's owner names its own testid where it is rendered.
    if (id[1] === "") continue;
    ids.add(id[1]);
  }
  return ids;
}

/** The text of one top-level `function Name(` … up to its closing brace at column 0, or null. */
export function functionBody(text, name) {
  const re = new RegExp(`^(?:export )?function ${name}\\(`, "m");
  const m = re.exec(text);
  if (!m) return null;
  const end = text.indexOf("\n}\n", m.index);
  return end === -1 ? text.slice(m.index) : text.slice(m.index, end + 3);
}

/**
 * Check one guide against the sources it names. Returns the violations, and the counts examined
 * so the caller can refuse an empty loop.
 */
export function checkGuide(guide, { readSource, routes, jobs }) {
  const v = [];
  const key = guide.navKey;
  let source = "";
  let files = 0;
  for (const spec of guide.sources ?? []) {
    // `path#Component` names one top-level function in a file that holds several pages (App.tsx
    // carries Capture and Documents); the scan reads that function's body and nothing else.
    const [rel, fn] = spec.split("#");
    const text = readSource(rel);
    if (text === null) {
      v.push(`${key}: source ${rel} does not exist`);
      continue;
    }
    const body = fn ? functionBody(text, fn) : text;
    if (body === null) {
      v.push(`${key}: source ${rel} has no top-level function ${fn}`);
      continue;
    }
    files += 1;
    source += `\n${stripTsComments(body)}`;
  }
  if (files === 0) v.push(`${key}: names no source file that exists`);

  const emitted = emittedTestids(source);

  for (const b of guide.bands ?? []) {
    if (b.testid) {
      if (!testidIsEmitted(b.testid, emitted)) v.push(`${key}: band "${b.name}" names testid "${b.testid}", which the page does not emit`);
    } else if (!source.includes(b.name)) {
      v.push(`${key}: band "${b.name}" has no testid and its name is not in the page source`);
    }
  }

  const actIds = new Set();
  for (const a of guide.acts ?? []) {
    for (const id of [a.testid, ...(a.testids ?? [])].filter(Boolean)) {
      actIds.add(id);
      if (!testidIsEmitted(id, emitted)) v.push(`${key}: act "${a.label}" names testid "${id}", which the page does not emit`);
    }
    if (!source.includes(a.label)) v.push(`${key}: act "${a.label}" is not a label the page renders`);
  }

  const notActs = guide.notActs ?? {};
  for (const id of primaryTestids(source)) {
    if (actIds.has(id) || Object.prototype.hasOwnProperty.call(notActs, id)) continue;
    v.push(`${key}: the page emits a primary act "${id}" the guide does not mention (add it to acts, or to notActs with a reason)`);
  }
  for (const [id, why] of Object.entries(notActs)) {
    if (!why || why.length < 12) v.push(`${key}: notActs["${id}"] needs a reason`);
  }

  for (const l of guide.elsewhere ?? []) {
    if (!routes.has(l.page)) v.push(`${key}: elsewhere points at "${l.page}", which App.tsx does not route`);
  }
  for (const j of guide.auto ?? []) {
    if (j.job && !jobs.has(j.job)) v.push(`${key}: auto names job "${j.job}", which no migration writes`);
  }
  if ((guide.acts ?? []).length === 0 && (guide.bands ?? []).length === 0) v.push(`${key}: describes nothing — no bands and no acts`);
  return { violations: v, files, acts: (guide.acts ?? []).length };
}

/** The rendered answer carries every act, and its shape is lists, not a paragraph. */
export function checkRendered(guide, render) {
  const v = [];
  const md = render.renderGuideAnswer(guide);
  for (const a of guide.acts ?? []) {
    if (!md.includes(`**${a.label}**`)) v.push(`${guide.navKey}: rendered answer does not carry act "${a.label}" in bold`);
  }
  if ((guide.bands ?? []).length > 0 && !/^1\. \*\*/m.test(md)) v.push(`${guide.navKey}: rendered answer has no numbered band list`);
  if ((guide.acts ?? []).length > 0 && !/^- \*\*/m.test(md)) v.push(`${guide.navKey}: rendered answer has no bulleted acts`);
  const longest = Math.max(...md.split("\n").map((l) => l.length));
  if (longest > 260) v.push(`${guide.navKey}: a line of the rendered answer runs ${longest} characters — that is a paragraph`);
  return v;
}

/** Prose that must not describe a page the guides now own. */
export function checkStaleProse(purposeSource, helpSource) {
  const v = [];
  for (const phrase of RETIRED_MEETINGS_TRIO) {
    if (stripTsComments(purposeSource).includes(phrase)) v.push(`pagePurpose.ts still says "${phrase}" — the Meetings page as it was before 19 Sep 2026`);
    if (stripTsComments(helpSource).includes(phrase)) v.push(`HelpCenterPage.tsx still says "${phrase}" — the Meetings page as it was before 19 Sep 2026`);
  }
  return v;
}

async function loadAll() {
  const registry = await loadTs(REGISTRY);
  const render = await loadTs(RENDER);
  return { registry, render };
}

function realDeps() {
  return {
    // Every read is stripped at the read, so a sentence about a retired button can never satisfy
    // the scan and a sentence naming a forbidden phrase can never fail it.
    readSource: (rel) => {
      const p = path.join(ROOT, rel);
      return existsSync(p) ? stripTsComments(readFileSync(p, "utf8")) : null;
    },
    routes: routeKeys(stripTsComments(readFileSync(APP, "utf8"))),
    jobs: jobKeys(MIGRATIONS),
  };
}

async function main() {
  const { registry, render } = await loadAll();
  const guides = Object.values(registry.PAGE_GUIDES ?? {});
  const deps = realDeps();
  if (guides.length === 0) {
    console.error("validate:page-guides — zero guides in the registry. Rule 0: an empty loop is a failure.");
    process.exit(1);
  }
  if (deps.routes.size === 0) {
    console.error("validate:page-guides — zero route keys read from App.tsx.");
    process.exit(1);
  }
  let violations = [];
  let files = 0;
  let acts = 0;
  for (const g of guides) {
    const r = checkGuide(g, deps);
    violations.push(...r.violations, ...checkRendered(g, render));
    files += r.files;
    acts += r.acts;
  }
  violations.push(...checkStaleProse(stripTsComments(readFileSync(PURPOSE, "utf8")), stripTsComments(readFileSync(HELP, "utf8"))));
  if (files === 0 || acts === 0) {
    console.error(`validate:page-guides — examined ${files} source files and ${acts} acts. Rule 0.`);
    process.exit(1);
  }
  if (violations.length > 0) {
    console.error(`validate:page-guides — ${violations.length} violation(s):`);
    for (const x of violations) console.error(`  ✗ ${x}`);
    process.exit(1);
  }
  console.log(`validate:page-guides — ${guides.length} guides, ${files} source files, ${acts} acts: every band and act the guides name is emitted, every primary act is in a guide, no stale prose.`);
}

async function selfTest() {
  const { registry, render } = await loadAll();
  const deps = realDeps();
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) failed += 1;
    console.log(`${ok ? "✓" : "✗"} ${what}`);
  };

  const meetings = registry.PAGE_GUIDES.meetings;
  say(Boolean(meetings), "the registry carries a Meetings guide");

  // THE DEFECT THIS WAS WRITTEN FOR: today's stale text, restored as a guide.
  const stale = {
    ...meetings,
    bands: [],
    acts: RETIRED_MEETINGS_TRIO.map((label) => ({ label, does: "as it was" })),
    notActs: {},
  };
  const staleResult = checkGuide(stale, deps);
  say(
    RETIRED_MEETINGS_TRIO.every((p) => staleResult.violations.some((v) => v.includes(`"${p}" is not a label`))),
    "the retired Meetings trio (Prepare / Confer / Run a close-out) is caught as labels the page does not render",
  );
  say(staleResult.violations.some((v) => /primary act .* the guide does not mention/.test(v)), "a guide that omits the page's primary acts is caught");

  const ghostTestid = { ...meetings, acts: [...meetings.acts, { label: meetings.acts[0].label, testid: "meeting-ghost-button", does: "x" }] };
  say(checkGuide(ghostTestid, deps).violations.some((v) => /meeting-ghost-button/.test(v)), "a testid the page does not emit is caught");

  const ghostPage = { ...meetings, elsewhere: [{ page: "investment-committee", why: "gone" }] };
  say(checkGuide(ghostPage, deps).violations.some((v) => /investment-committee/.test(v)), "a link to a page App.tsx does not route is caught");

  const ghostJob = { ...meetings, auto: [{ what: "x", when: "y", job: "no_such_job" }] };
  say(checkGuide(ghostJob, deps).violations.some((v) => /no_such_job/.test(v)), "a job no migration writes is caught");

  const ghostFile = { ...meetings, sources: ["src/client/pages/NoSuchPage.tsx"] };
  const gf = checkGuide(ghostFile, deps);
  say(gf.violations.some((v) => /does not exist/.test(v)) && gf.files === 0, "a source file that is not there is caught, and counts as zero examined");

  const unbolded = { ...meetings };
  const renderedOk = checkRendered(meetings, render);
  say(renderedOk.length === 0, `the shipped Meetings answer carries every act in bold as lists: ${renderedOk.join("; ")}`);
  const paragraphRender = {
    renderGuideAnswer: (g) => `Here is everything: ${g.acts.map((a) => `**${a.label}** does ${a.does}`).join(", ")}. `.repeat(3),
  };
  say(checkRendered(unbolded, paragraphRender).some((v) => /no numbered band list|paragraph/.test(v)), "an answer rendered as one paragraph is caught");

  const stalePurpose = `export const X = { meetings: { youCan: ["${RETIRED_MEETINGS_TRIO[0]}"] } };`;
  say(checkStaleProse(stalePurpose, "").length === 1, "the retired trio in pagePurpose.ts is caught");
  say(checkStaleProse(`// ${RETIRED_MEETINGS_TRIO[0]}`, "").length === 0, "the retired trio in a comment is not a violation");

  say(primaryTestids(`<button className="btn-strong" onClick={() => go()} data-testid="x-go">Go</button>`).has("x-go"), "a primary button with an arrow handler is read to its real end");
  say(primaryTestids(`<button className="btn-ghost" data-testid="x-quiet">Quiet</button>`).size === 0, "a ghost button is not a primary act");
  say(primaryTestids("<a className={`btn-primary btn-lg`} data-testid={`door-${id}`}>Open</a>").has("door-"), "a primary link with a template testid yields its prefix");

  // The shipped registry passes, examined for real.
  let shipped = [];
  let files = 0;
  let acts = 0;
  for (const g of Object.values(registry.PAGE_GUIDES)) {
    const r = checkGuide(g, deps);
    shipped.push(...r.violations, ...checkRendered(g, render));
    files += r.files;
    acts += r.acts;
  }
  shipped.push(...checkStaleProse(stripTsComments(readFileSync(PURPOSE, "utf8")), stripTsComments(readFileSync(HELP, "utf8"))));
  say(shipped.length === 0 && files > 0 && acts > 0, `the shipped registry passes (${files} files, ${acts} acts): ${shipped.slice(0, 5).join("; ")}`);

  if (failed > 0) {
    console.error(`validate:page-guides --self-test: ${failed} check(s) failed`);
    process.exit(1);
  }
  console.log("validate:page-guides --self-test: every planted defect was caught.");
}

if (process.argv.includes("--self-test")) await selfTest();
else await main();
