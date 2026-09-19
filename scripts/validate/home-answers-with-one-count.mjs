#!/usr/bin/env node
/**
 * home-answers-with-one-count.mjs — `npm run validate:home`.
 *
 * HOME, REBUILT (design/HOME_DESIGN.md, approved 19 Sep 2026). The audit found 13 things on the
 * old Home; the five critical ones were all of one shape: two components each keeping their own
 * count, or a control that reached nothing. This validator pins the rebuilt page to the rules the
 * design states, by READING THE SOURCE — a design document no code reads is a wish.
 *
 * WHAT IS CHECKED
 *   1 · ONE COUNT. The masthead's answer and the Waiting pill are the same number: HomePage builds
 *       `counts` once, the pill renders `needsHer(counts)`, and the answer is `answerLine(counts)`
 *       on the SAME identifier. Two counts on one page is the contradiction the audit opened with.
 *   2 · THE BRIEF IS NEVER TWICE. The Arrived band mounts DeliverableList with
 *       `excludeKind="daily_brief"`, and the server honours `exclude_kind` with a `NOT IN` clause —
 *       both halves, or the prop is decoration.
 *   3 · NO BULK APPROVE. Nothing on Home approves in a batch: no `approve-many`, no "Approve
 *       selected", and the approval card's checkbox under select-many is `disabled`. A
 *       human-reserved action is decided one at a time (the owner's pick, 19 Sep).
 *   4 · THE BRIEF BAND NEVER MENTIONS A CLOCK. `briefRunState` exports no `scheduled`/`off` kind,
 *       and neither the panel nor the band carries a typed duration ("4–5 minutes", "at 7:05")
 *       outside a comment — the "usually" figure is `usualSeconds`, measured from rows.
 *   5 · THE RAIL NEVER OPENS EMPTY. HomePage resolves the remembered chip through
 *       `effectiveFilter(...)` with the live counts, never reads the stored value straight.
 *   6 · ONE ORANGE CONTROL. `btn-primary` appears in PreviewApprovals exactly once ("Approve and
 *       send") and nowhere in HomePage, DailyBriefPanel or DeliverableList.
 *   7 · THE REMOVALS HAVE HOMES. The Private layer is its own route (`PrivateLayerPage` mounted in
 *       App under key `private`, linked from Home's foot), and Home carries no Questions band.
 *   8 · EVERY TESTID THE E2E SPEC DRIVES EXISTS. Every `getByTestId("…")` literal and every
 *       `home-…-${…}` prefix in `e2e/home-overhaul.spec.ts` is declared in HomePage,
 *       DeliverableList or DailyBriefPanel — a journey that clicks a control that is not there is
 *       a journey that skips.
 *
 * HARD-FAILS ON ZERO: zero testids read from the spec, zero `btn-primary` in PreviewApprovals, or an
 * unreadable file exits 1. `--self-test` restores each pre-fix shape and requires it caught.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const FILES = {
  home: "src/client/pages/HomePage.tsx",
  list: "src/client/pages/DeliverableList.tsx",
  panel: "src/client/pages/DailyBriefPanel.tsx",
  band: "src/client/lib/briefBand.ts",
  runState: "src/shared/intelligence/briefRunState.ts",
  preview: "src/client/pages/PreviewApprovals.tsx",
  app: "src/client/App.tsx",
  service: "src/worker/services/deliverables.ts",
  spec: "e2e/home-overhaul.spec.ts",
};

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export function checkHome(f) {
  const problems = [];
  const home = stripComments(f.home);

  // 1 · one count
  const pillM = /data-testid="home-waiting-pill">\{(\w+)\}/.exec(home);
  const countM = pillM && new RegExp(`const ${pillM[1]} = needsHer\\((\\w+)\\)`).exec(home);
  const answerM = /const answer = answerLineFor\((\w+)\)/.exec(home);
  if (!pillM) problems.push("Home: the Waiting pill does not render a named count");
  else if (!countM) problems.push(`Home: \`${pillM[1]}\` is not \`needsHer(counts)\` — the pill has its own count`);
  if (!answerM) problems.push("Home: the answer line is not `answerLineFor(counts)`");
  if (countM && answerM && countM[1] !== answerM[1]) problems.push(`Home: the pill counts \`${countM[1]}\` and the answer counts \`${answerM[1]}\` — two counts on one page`);
  if (!/data-testid="home-answer"/.test(home)) problems.push("Home: no answer line (home-answer)");

  // 2 · the brief never twice
  if (!/excludeKind="daily_brief"/.test(home)) problems.push("Home: Arrived mounts DeliverableList without excludeKind=\"daily_brief\"");
  const svc = stripComments(f.service);
  if (!/searchParams\.get\("exclude_kind"\)/.test(svc) || !/kind NOT IN \(/.test(svc)) problems.push("deliverables.ts: `exclude_kind` is not read into a `kind NOT IN (...)` clause — the prop is decoration");
  if (!/excludeKind/.test(stripComments(f.list))) problems.push("DeliverableList: excludeKind prop is not read");

  // 3 · no bulk approve
  if (/approve-many|approve_many|Approve selected|approveSelected/i.test(home)) problems.push("Home: a bulk approve exists");
  if (!/<input type="checkbox" disabled aria-describedby="home-approvals-one-at-a-time"/.test(home)) problems.push("Home: the approval card's checkbox under select-many is not disabled");

  // 4 · no clock
  const kinds = new Set([...stripComments(f.runState).matchAll(/kind: "(\w+)"/g)].map((m) => m[1]));
  if (kinds.size === 0) problems.push("briefRunState: no kinds read");
  for (const k of ["scheduled", "off", "sleeping"]) if (kinds.has(k)) problems.push(`briefRunState: exports a clock-shaped kind \`${k}\``);
  for (const [name, src] of [["DailyBriefPanel", f.panel], ["briefBand", f.band], ["HomePage", f.home]]) {
    const code = stripComments(src);
    const typed = /\d+\s*[–-]\s*\d+\s*min|usually\s+\d+|at 7:\d\d|7 AM|07:00|every (?:weekday|morning)/i.exec(code);
    if (typed) problems.push(`${name}: a typed clock or duration in code: "${typed[0]}"`);
  }
  if (!/usualSeconds/.test(stripComments(f.panel))) problems.push("DailyBriefPanel: the 'usually' figure is not usualSeconds");

  // 5 · rail never empty
  if (!/effectiveFilter\(chosen \?\? remembered, \{/.test(home)) problems.push("Home: the rail does not resolve through effectiveFilter(chosen ?? remembered, counts)");

  // 6 · one orange
  const orange = (src) => (stripComments(src).match(/className="btn-primary/g) ?? []).length;
  if (orange(f.preview) !== 1) problems.push(`PreviewApprovals: ${orange(f.preview)} btn-primary (want exactly 1, Approve and send)`);
  for (const [name, src] of [["HomePage", f.home], ["DailyBriefPanel", f.panel], ["DeliverableList", f.list]]) {
    if (orange(src) > 0) problems.push(`${name}: carries ${orange(src)} btn-primary — Home has one orange control`);
  }

  // 7 · removals have homes
  const app = stripComments(f.app);
  if (!/active === "private" && <PrivateLayerPage/.test(app)) problems.push("App: the Private layer is not its own route");
  if (!/data-testid="home-private-link"/.test(home)) problems.push("Home: no foot link to the Private layer");
  if (/home-questions|<QuestionsBand|Questions for you/.test(home)) problems.push("Home: a Questions band is still on the page");

  // 8 · every testid the spec drives exists
  const spec = f.spec;
  const literal = [...spec.matchAll(/getByTestId\("([^"]+)"\)/g)].map((m) => m[1]);
  const prefixes = [...spec.matchAll(/getByTestId\(`([a-z-]+-)\$\{/g)].map((m) => m[1]);
  if (literal.length + prefixes.length === 0) problems.push("spec: zero testids read — nothing checked");
  const declared = [f.home, f.list, f.panel].join("\n");
  const known = new Set([...declared.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]));
  const knownPrefixes = [...declared.matchAll(/data-testid=\{`([a-z-]+-)\$\{/g)].map((m) => m[1]);
  for (const id of new Set(literal)) {
    if (known.has(id)) continue;
    // `home-rail-${key}` renders home-rail-all/waiting/arrived/quiet.
    if (knownPrefixes.some((p) => id.startsWith(p))) continue;
    problems.push(`spec drives \`${id}\` and nothing declares it`);
  }
  for (const p of new Set(prefixes)) if (!knownPrefixes.includes(p)) problems.push(`spec drives \`${p}\${…}\` and nothing declares it`);

  return { problems, counted: { testids: literal.length + prefixes.length, kinds: kinds.size } };
}

function read() {
  const out = {};
  for (const [k, rel] of Object.entries(FILES)) {
    try { out[k] = readFileSync(path.join(ROOT, rel), "utf8"); } catch { console.error(`✗ cannot read ${rel}`); process.exit(1); }
  }
  return out;
}

function selfTest() {
  const clean = read();
  const base = checkHome(clean);
  if (base.problems.length) { console.error("✗ self-test: clean tree must pass first\n  " + base.problems.join("\n  ")); process.exit(1); }
  const cases = [
    ["pill with its own count", { home: clean.home.replace('data-testid="home-waiting-pill">{waitingCount}', 'data-testid="home-waiting-pill">{decisions}') }, /own count|two counts/],
    ["answer on a different counts object", { home: clean.home.replace("const answer = answerLineFor(counts)", "const answer = answerLineFor(counts2)") }, /two counts/],
    ["brief in Arrived", { home: clean.home.replace('excludeKind="daily_brief"', "") }, /excludeKind/],
    ["exclude_kind ignored by the server", { service: clean.service.replace("kind NOT IN (", "kind IN (") }, /decoration/],
    ["bulk approve", { home: clean.home.replace("home-waiting-quiet-selected", "home-approve-many") }, /bulk approve/],
    ["approval checkbox enabled", { home: clean.home.replace('<input type="checkbox" disabled aria-describedby="home-approvals-one-at-a-time"', '<input type="checkbox" aria-describedby="home-approvals-one-at-a-time"') }, /not disabled/],
    ["a scheduled kind", { runState: clean.runState + '\nconst x = { kind: "scheduled" };' }, /clock-shaped/],
    ["a typed duration in the panel", { panel: clean.panel.replace("usualSeconds", "usualSeconds /* */") .replace(/return \(/, 'const typed = "usually 4–5 min"; return (') }, /typed clock/],
    ["rail reads the stored value straight", { home: clean.home.replace("effectiveFilter(chosen ?? remembered, {", "((chosen ?? remembered) ?? \"all\") || effectiveFilter(chosen, {") }, /effectiveFilter/],
    ["a second orange", { home: clean.home.replace('className="btn-strong" disabled={arrivedSelect.size === 0}', 'className="btn-primary" disabled={arrivedSelect.size === 0}') }, /one orange/],
    ["private layer inline again", { app: clean.app.replace('active === "private" && <PrivateLayerPage', 'active === "privatex" && <PrivateLayerPage') }, /own route/],
    ["spec drives a control nobody declares", { spec: clean.spec + '\n// x\nvoid page.getByTestId("home-nothing-here");' }, /nothing declares/],
    ["spec reads nothing", { spec: "export {};" }, /zero testids/],
  ];
  let failed = 0;
  for (const [name, patch, want] of cases) {
    const r = checkHome({ ...clean, ...patch });
    const hit = r.problems.some((p) => want.test(p));
    console.log(`${hit ? "✓" : "✗"} self-test catches: ${name}`);
    if (!hit) { failed++; console.log("    got: " + (r.problems.join(" | ") || "(nothing)")); }
  }
  if (failed) process.exit(1);
  console.log("✓ self-test: 13 pre-fix shapes caught, clean tree passes");
}

if (process.argv.includes("--self-test")) selfTest();
else {
  const r = checkHome(read());
  if (r.counted.testids === 0 || r.counted.kinds === 0) { console.error("✗ examined zero items"); process.exit(1); }
  if (r.problems.length) { console.error("✗ validate:home\n  " + r.problems.join("\n  ")); process.exit(1); }
  console.log(`✓ validate:home — one count, brief once, no bulk approve, no clock, rail never empty, one orange, removals housed, ${r.counted.testids} spec testids declared`);
}
