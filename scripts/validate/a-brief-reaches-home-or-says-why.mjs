#!/usr/bin/env node
/**
 * validate:brief-lands — THE MORNING BRIEF LANE CANNOT EXIT WITHOUT EITHER A BRIEF OR A STATED
 * REASON REACHING HOME, AND THE BUTTON'S EVERY STATE IS A NAMED STATE ON THE ROW.
 *
 * ── WHAT HAPPENED, 19 Sep 2026 (a Saturday), CONFIRMED FROM PRODUCTION ─────────────────────────
 *
 *   1. No brief was owed: both partners' profiles carried `weekends = 0`, the column's default. The
 *      schedule skipped the day as configured and she woke to nothing. Migration 0211 turns weekends
 *      on; the code default follows.
 *   2. The button ran the write stage's model call INSIDE her HTTP request. The request was cut,
 *      the `ai_run` stayed RUNNING, the row stayed GENERATING under a lease, and the second press
 *      was told "Another run holds it". The button is now a request the clock serves on its next
 *      tick, and the panel polls the row's named state.
 *   3. The brief rode inside the fifteen-minute sweep job, one stage per run: 31–36 minutes a brief
 *      (measured, 15–17 Sep). The tick now serves it directly every minute.
 *
 * ── WHAT THIS VALIDATOR HOLDS, and it reads code rather than restating it ───────────────────────
 *
 *   A. THE TICK SERVES THE BRIEF in BOTH of `runDueJobs`' branches, and the sweep job's
 *      INTELLIGENCE branch contains no brief call at all.
 *   B. EVERY PATH THAT CLOSES A ROW `FAILED` WRITES `error_message` AND `retry_after` — read out of
 *      every SQL string in the service that sets `status = 'FAILED'`.
 *   C. `briefRunState` IS IMPORTED AND RUN over every status the schema's CHECK permits, at every
 *      attempt count, leased and unleased, requested and scheduled, fresh and stale, plus every
 *      no-row schedule variant. Every combination yields a kind, a sentence, a button label; only
 *      READY with sections may claim arrival; no column value leaks into her sentence.
 *   D. THE PANEL reads the status route, renders `data-testid="daily-brief-state"`, polls while
 *      moving, and takes the button's enabled state from the server — and the old stage loop that
 *      ran the model inside a request is gone.
 *   E. THE TWO STALE THRESHOLDS ARE ONE NUMBER: `STALE_AFTER_MINUTES` (the sweeper) is defined as
 *      `STALLED_AFTER_MINUTES` (the state).
 *   F. THE DECLARED OUTPUT is at or above the measured p90 of real briefs and under the wire
 *      ceiling; the write call leads on its routing pin (`leadOnPolicy: true`) and the router
 *      honours the flag in `freeFirstEligible`.
 *   G. WEEKENDS DEFAULT ON everywhere the profile is defaulted, and 0211 flips the stored rows.
 *   H. THE SENTINEL is wired: health.ts reads `BRIEF_SENTINEL_GRACE_MINUTES`.
 *   I. THE JOURNEY IS IN E2E: a spec drives the request → state → outcome through the browser.
 *
 * Hard-fails on zero statuses, zero SQL FAILED writers, zero panel surfaces, or an unreadable
 * module. `--self-test` restores each pre-fix shape and proves it is caught.
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const P = (...p) => path.join(ROOT, ...p);
const read = (p) => readFileSync(p, "utf8");

const FILES = {
  jobs: P("src/worker/services/jobs.ts"),
  service: P("src/worker/services/dailyIntelligence.ts"),
  state: P("src/shared/intelligence/briefRunState.ts"),
  panel: P("src/client/pages/DailyBriefPanel.tsx"),
  band: P("src/client/lib/briefBand.ts"),
  runAi: P("src/worker/ai/runAi.ts"),
  ceiling: P("src/worker/ai/providers/outputCeiling.ts"),
  health: P("src/worker/services/health.ts"),
  schema: P("migrations/0035_daily_intelligence_pipeline.sql"),
  m0211: P("migrations/0211_the_brief_arrives_every_morning.sql"),
  e2eDir: P("e2e"),
};

/**
 * MEASURED FROM PRODUCTION, 20 Aug – 17 Sep 2026: 51 accepted briefs written by claude-sonnet-5.
 * Output tokens min 8,669 · median 17,415 · p90 22,969 · max 27,536. The declaration must sit at or
 * above the p90; restating the p90 here is the one number this validator carries, because the
 * database it came from is not reachable from CI.
 */
export const MEASURED_P90_OUTPUT_TOKENS = 22_969;

// ── A · the tick serves the brief; the sweep job does not ─────────────────────────────────────

export function checkTickServesBrief(jobsSrc) {
  const violations = [];
  let examined = 0;
  const body = stripComments(jobsSrc);
  const fn = (name) => {
    const at = body.indexOf(`export async function ${name}(`);
    if (at < 0) return null;
    const next = body.indexOf("\nexport ", at + 10);
    return body.slice(at, next < 0 ? undefined : next);
  };
  for (const name of ["runDueJobs", "runDueJobsAll"]) {
    examined += 1;
    const src = fn(name);
    if (!src) { violations.push(`jobs.ts has no ${name}`); continue; }
    if (!/await serveBriefOnTick\(env, now, results\)/.test(src)) {
      violations.push(`${name} does not serve the brief before its jobs — a tick that owes a brief must build it, every minute`);
    }
  }
  examined += 1;
  const intel = body.indexOf('if (job.kind === "INTELLIGENCE") {');
  if (intel < 0) violations.push("jobs.ts has no INTELLIGENCE job branch");
  else {
    const branch = body.slice(intel, body.indexOf("\n  if (job.kind ===", intel + 10));
    if (/runBriefTick|briefsOwedToday|serveBrief\(/.test(branch)) {
      violations.push("the sweep job builds the brief again — one stage per fifteen-minute run is how a brief took 31–36 minutes and a press waited for the quarter-hour");
    }
  }
  return { violations, examined };
}

// ── B · every FAILED writer states why and when ───────────────────────────────────────────────

export function checkEveryFailureIsStated(serviceSrc) {
  const violations = [];
  const sqls = [...serviceSrc.matchAll(/`([^`]*status = 'FAILED'[^`]*)`/g)].map((m) => m[1]).filter((s) => /UPDATE intelligence_report/.test(s));
  const examined = sqls.length;
  for (const sql of sqls) {
    const head = sql.replace(/\s+/g, " ").slice(0, 90);
    if (!/error_message/.test(sql)) violations.push(`a FAILED writer records no reason: ${head}…`);
    if (!/retry_after/.test(sql)) violations.push(`a FAILED writer records no retry time: ${head}…`);
  }
  return { violations, examined };
}

// ── C · the state function, RUN ───────────────────────────────────────────────────────────────

export function statusesFromSchema(schemaSrc) {
  // Anchored to intelligence_report's own status column: the first CHECK (status IN …) in this
  // migration belongs to tracked_narrative.
  const m = schemaSrc.match(/status\s+TEXT NOT NULL DEFAULT 'QUEUED'\s+CHECK \(status IN \(([^)]+)\)\)/);
  return m ? [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]) : [];
}

export function checkEveryStateSaysSomething(briefRunState, statuses, MAX) {
  const violations = [];
  let examined = 0;
  const now = new Date("2026-09-19T13:41:00.000Z");
  const exp = { usualSeconds: 264, slowSeconds: 313, measuredFrom: 30 };
  const on = { enabled: true, weekendOff: false, nextStartAt: "2026-09-20T10:15:00.000Z", earliestStartLocal: "06:15" };
  const judge = (label, s, row) => {
    examined += 1;
    if (!s || typeof s.kind !== "string" || !s.kind) violations.push(`${label}: no kind`);
    if (!s || typeof s.line !== "string" || s.line.trim().length < 20) violations.push(`${label}: no sentence`);
    if (!s || !s.button || typeof s.button.label !== "string" || s.button.label.trim().length < 3) violations.push(`${label}: no button label`);
    if (s && /\b(GATHERING|RANKING|GENERATING|VERIFYING|QUEUED)\b/.test(s.line)) violations.push(`${label}: a status code leaked into her sentence`);
    if (s && s.arrived && !(row && row.status === "READY" && (row.section_count ?? 0) > 0)) violations.push(`${label}: claims a brief arrived without READY and sections`);
    if (s && row && row.status === "READY" && (row.section_count ?? 0) > 0 && !s.arrived) violations.push(`${label}: a READY brief with sections is not an arrival`);
  };
  for (const status of statuses) {
    for (const attempts of [1, 2, MAX, MAX + 1]) {
      for (const leased of [false, true]) for (const requested of [false, true]) for (const stale of [false, true]) {
        const row = {
          status, report_date: "2026-09-19", attempts,
          started_at: "2026-09-19T13:39:40.000Z", stage_at: stale ? "2026-09-19T12:30:00.000Z" : "2026-09-19T13:40:30.000Z",
          stage_lease_until: leased ? "2026-09-19T13:59:00.000Z" : null,
          completed_at: status === "READY" || status === "FAILED" ? "2026-09-19T13:41:00.000Z" : null,
          requested_at: requested ? "2026-09-19T13:39:40.000Z" : null, requested_by: requested ? "fu_x" : null,
          retry_after: status === "FAILED" && attempts < MAX ? "2026-09-19T14:01:00.000Z" : null,
          error_code: status === "FAILED" ? "incomplete" : null,
          error_message: status === "FAILED" ? "the brief was rejected twice: a section is missing" : null,
          section_count: status === "READY" ? 11 : 0,
        };
        let s;
        try { s = briefRunState(row, on, exp, now, "America/New_York"); } catch (err) { violations.push(`${status} a=${attempts}: threw ${err.message}`); examined += 1; continue; }
        judge(`${status} attempts=${attempts} leased=${leased} requested=${requested} stale=${stale}`, s, row);
      }
    }
  }
  // READY with nothing to read is not an arrival either.
  judge("READY with zero sections", briefRunState({ status: "READY", report_date: "2026-09-19", attempts: 1, started_at: null, stage_at: null, stage_lease_until: null, completed_at: now.toISOString(), section_count: 0 }, on, exp, now), { status: "READY", section_count: 0 });
  for (const sched of [on, { ...on, enabled: false }, { ...on, weekendOff: true }, { ...on, nextStartAt: null }]) {
    judge(`no row · ${JSON.stringify(sched)}`, briefRunState(null, sched, exp, now, "America/New_York"), null);
  }
  return { violations, examined };
}

// ── D · the panel reads the named state and owns nothing ──────────────────────────────────────

export function checkPanelReadsTheRow(panelSrc, bandSrc) {
  const violations = [];
  let examined = 0;
  const body = stripComments(panelSrc);
  examined += 1;
  if (!/"\/api\/daily-intelligence\/status"/.test(body)) violations.push("DailyBriefPanel does not read the status route");
  examined += 1;
  if (!panelSrc.includes('data-testid="daily-brief-state"')) violations.push("DailyBriefPanel renders no named state");
  examined += 1;
  if (!/POLL_EVERY_MS/.test(body) || !/setInterval/.test(body)) violations.push("DailyBriefPanel does not poll the row while it moves");
  examined += 1;
  if (!/disabled=\{!run \|\| !run\.button\.enabled\}/.test(body)) violations.push("the button's enabled state is not taken from the server's named state");
  examined += 1;
  if (/STAGE_WORDS|for \(let i = 0; i < 6; i\+\+\)/.test(body)) violations.push("the old stage loop is back — the model call runs inside her request again");
  examined += 1;
  if (!/pressOutcomeLine\(res\)/.test(body)) violations.push("what the press says is not taken from the server's answer");
  examined += 1;
  const band = stripComments(bandSrc);
  if (!/MOVING_KINDS/.test(band) || !/toneClassFor/.test(band)) violations.push("briefBand.ts does not define the moving kinds and the tones");
  return { violations, examined };
}

// ── E · one stale number ──────────────────────────────────────────────────────────────────────

export function checkOneStaleNumber(serviceSrc) {
  const examined = 1;
  return {
    examined,
    violations: /export const STALE_AFTER_MINUTES = STALLED_AFTER_MINUTES;/.test(serviceSrc)
      ? []
      : ["STALE_AFTER_MINUTES is not defined as the state module's STALLED_AFTER_MINUTES — the sweeper and the card can disagree about 'stopped'"],
  };
}

// ── F · the declared output and the lead lane ─────────────────────────────────────────────────

export function checkDeclaredOutput(serviceSrc, ceilingSrc, runAiSrc) {
  const violations = [];
  let examined = 0;
  examined += 1;
  const decl = serviceSrc.match(/export const BRIEF_EXPECTED_OUTPUT_TOKENS = ([\d_]+);/);
  const ceil = ceilingSrc.match(/PROVIDER_MAX_OUTPUT_TOKENS\s*=\s*([\d_]+)/);
  if (!decl) violations.push("dailyIntelligence.ts declares no BRIEF_EXPECTED_OUTPUT_TOKENS");
  else {
    const n = Number(decl[1].replace(/_/g, ""));
    if (n < MEASURED_P90_OUTPUT_TOKENS) violations.push(`the brief declares ${n} output tokens; production's p90 is ${MEASURED_P90_OUTPUT_TOKENS} — the estimate understates the cost`);
    if (ceil && n >= Number(ceil[1].replace(/_/g, ""))) violations.push(`the brief declares ${n}, at or above the wire ceiling ${ceil[1]}`);
  }
  examined += 1;
  if (!/expectedOutputTokens: BRIEF_EXPECTED_OUTPUT_TOKENS/.test(serviceSrc)) violations.push("the write call does not pass the declared constant");
  examined += 1;
  if (!/leadOnPolicy: true/.test(serviceSrc)) violations.push("the write call does not lead on its routing pin — thirteen free-lane attempts wrote zero briefs");
  examined += 1;
  const eligible = stripComments(runAiSrc).match(/const freeFirstEligible =([\s\S]*?);/);
  if (!eligible || !/leadOnPolicy/.test(eligible[1])) violations.push("runAi's free-first eligibility does not honour leadOnPolicy");
  return { violations, examined };
}

// ── G · weekends default on ───────────────────────────────────────────────────────────────────

export function checkWeekendsDefaultOn(serviceSrc, healthSrc, m0211Src) {
  const violations = [];
  let examined = 0;
  for (const [name, src] of [["dailyIntelligence.ts", serviceSrc], ["health.ts", healthSrc]]) {
    const zeros = (src.match(/COALESCE\(p\.weekends,\s*0\)/g) ?? []).length;
    const ones = (src.match(/COALESCE\(p\.weekends,\s*1\)/g) ?? []).length;
    examined += ones + zeros;
    if (zeros > 0) violations.push(`${name} still defaults weekends OFF in ${zeros} query(ies)`);
  }
  examined += 1;
  if (/weekends: 0, enabled: 1/.test(serviceSrc)) violations.push("loadProfile's fallback profile still turns weekends off");
  examined += 1;
  if (!/UPDATE partner_intelligence_profile SET weekends = 1/.test(m0211Src)) violations.push("0211 does not turn weekends on for the stored profiles");
  for (const col of ["requested_at", "requested_by", "retry_after"]) {
    examined += 1;
    if (!new RegExp(`ADD COLUMN ${col} TEXT`).test(m0211Src)) violations.push(`0211 does not add ${col}`);
  }
  return { violations, examined };
}

// ── H · the sentinel ──────────────────────────────────────────────────────────────────────────

export function checkSentinel(healthSrc) {
  const body = stripComments(healthSrc);
  const violations = [];
  if (!/BRIEF_SENTINEL_GRACE_MINUTES/.test(body)) violations.push("health.ts does not read the sentinel grace");
  if (!/no brief and no explanation/.test(healthSrc)) violations.push("health.ts has no 'no brief and no explanation' reading");
  return { violations, examined: 2 };
}

// ── I · the journey is driven in a browser ────────────────────────────────────────────────────

export function checkJourneyIsE2e(specs) {
  const hits = Object.entries(specs).filter(([, src]) => src.includes("daily-brief-state") && src.includes("/api/daily-intelligence/generate"));
  return { examined: Object.keys(specs).length, violations: hits.length > 0 ? [] : ["no e2e spec drives the button → named state → outcome journey"] };
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Bundle a TS module (it has relative imports without extensions) and import the result. */
async function importTs(file) {
  const dir = mkdtempSync(path.join(tmpdir(), "brief-lands-"));
  const out = path.join(dir, "mod.mjs");
  execFileSync(P("node_modules/.bin/esbuild"), [file, "--bundle", "--format=esm", "--platform=neutral", `--outfile=${out}`, "--log-level=silent"], { stdio: "inherit" });
  const mod = await import(new URL(`file://${out}`).href);
  return { mod, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function listSpecs() {
  return Object.fromEntries(readdirSync(FILES.e2eDir).filter((f) => f.endsWith(".spec.ts")).map((f) => [f, read(path.join(FILES.e2eDir, f))]));
}

// ── run ───────────────────────────────────────────────────────────────────────────────────────

async function run() {
  const src = Object.fromEntries(Object.entries(FILES).filter(([k]) => k !== "e2eDir").map(([k, p]) => [k, read(p)]));
  const statuses = statusesFromSchema(src.schema);
  if (statuses.length === 0) fail("read zero statuses out of migration 0035 — nothing was tested");
  const { mod, cleanup } = await importTs(FILES.state);
  const { mod: term, cleanup: cleanup2 } = await importTs(P("src/shared/intelligence/briefTerminality.ts"));
  let results;
  try {
    results = [
      ["A tick serves the brief", checkTickServesBrief(src.jobs)],
      ["B every FAILED writer states why and when", checkEveryFailureIsStated(src.service)],
      ["C every state says something", checkEveryStateSaysSomething(mod.briefRunState, statuses, term.MAX_BRIEF_ATTEMPTS)],
      ["D the panel reads the row", checkPanelReadsTheRow(src.panel, src.band)],
      ["E one stale number", checkOneStaleNumber(src.service)],
      ["F declared output and lead lane", checkDeclaredOutput(src.service, src.ceiling, src.runAi)],
      ["G weekends default on", checkWeekendsDefaultOn(src.service, src.health, src.m0211)],
      ["H the sentinel", checkSentinel(src.health)],
      ["I the journey is in e2e", checkJourneyIsE2e(listSpecs())],
    ];
  } finally { cleanup(); cleanup2(); }
  const violations = results.flatMap(([name, r]) => r.violations.map((v) => `${name}: ${v}`));
  const examined = results.reduce((n, [, r]) => n + r.examined, 0);
  for (const [name, r] of results) if (r.examined === 0) violations.push(`${name}: examined nothing — a check that reads zero items proves nothing`);
  if (violations.length > 0) fail(`BRIEF LANDS FAILED (${violations.length}):\n  - ${violations.join("\n  - ")}`);
  console.log(
    `BRIEF LANDS PASSED: ${examined} items examined — the tick serves the brief in both branches and the sweep job does not; ` +
      `${results[1][1].examined} FAILED writers each record a reason and a retry time; ${results[2][1].examined} row/schedule states each carry a kind, a sentence and a button; ` +
      `the panel polls the row's named state; one stale number; the write call declares ≥ ${MEASURED_P90_OUTPUT_TOKENS} tokens and leads on its pin; weekends default on; the sentinel and the e2e journey are wired.`,
  );
}

function fail(msg) { console.error(msg); process.exit(1); }

async function selfTest() {
  const say = (ok, what) => { if (!ok) fail(`SELF-TEST FAILED: ${what}`); };
  const src = Object.fromEntries(Object.entries(FILES).filter(([k]) => k !== "e2eDir").map(([k, p]) => [k, read(p)]));

  // A · the real pre-fix jobs.ts: the brief inside the INTELLIGENCE branch, no serve on the tick.
  const preJobs = src.jobs
    .replace(/await serveBriefOnTick\(env, now, results\);\n/g, "")
    .replace('if (job.kind === "INTELLIGENCE") {', 'if (job.kind === "INTELLIGENCE") {\n    const { runBriefTick, briefsOwedToday } = await import("./dailyIntelligence");\n    if (trigger === "SCHEDULED" && (await briefsOwedToday(env, now))) { const step = await runBriefTick(env, actor, now); }');
  const a = checkTickServesBrief(preJobs);
  say(a.violations.length >= 3, `the pre-fix jobs.ts passed: ${a.violations.join("; ")}`);
  say(checkTickServesBrief(src.jobs).violations.length === 0, "the shipped jobs.ts fails A");

  // B · a FAILED writer that forgets the reason.
  const b = checkEveryFailureIsStated("const x = `UPDATE intelligence_report SET status = 'FAILED', completed_at = strftime('now') WHERE id = ?1`;");
  say(b.examined === 1 && b.violations.length === 2, "a FAILED writer with no reason and no retry time passed");
  say(checkEveryFailureIsStated(src.service).violations.length === 0 && checkEveryFailureIsStated(src.service).examined >= 3, "the shipped service fails B or has fewer than three FAILED writers");

  // C · a state function with a silent branch — the real pre-fix panel logic: any non-null row is "a brief".
  const statuses = statusesFromSchema(src.schema);
  say(statuses.length === 7, `read ${statuses.length} statuses, expected 7`);
  const preState = (row) => (row ? { kind: "arrived", arrived: true, line: `${row.report_date} — today's brief arrived.`, button: { label: "Rebuild", enabled: true } } : { kind: "", arrived: false, line: "", button: { label: "", enabled: true } });
  const c = checkEveryStateSaysSomething(preState, statuses, 3);
  say(c.violations.length > 50, `the pre-fix 'any row is an arrival' state passed over ${c.examined} combinations`);
  const { mod, cleanup } = await importTs(FILES.state);
  const { mod: term, cleanup: cleanup2 } = await importTs(P("src/shared/intelligence/briefTerminality.ts"));
  try {
    const shipped = checkEveryStateSaysSomething(mod.briefRunState, statuses, term.MAX_BRIEF_ATTEMPTS);
    say(shipped.violations.length === 0 && shipped.examined > 200, `the shipped briefRunState fails C: ${shipped.violations.slice(0, 3).join("; ")}`);
  } finally { cleanup(); cleanup2(); }

  // D · the real pre-fix panel: a six-iteration stage loop, no status route, the button disabled by a local flag.
  const prePanel = `async function generate() { for (let i = 0; i < 6; i++) { const res = await api("/api/daily-intelligence/generate", { method: "POST", body: {} }); setMessage(STAGE_WORDS[res.data?.stage ?? ""]); } }\n<button disabled={busy} data-testid="daily-brief-generate">`;
  const d = checkPanelReadsTheRow(prePanel, "export const x = 1;");
  say(d.violations.length >= 5, `the pre-fix panel passed: ${d.violations.join("; ")}`);
  say(checkPanelReadsTheRow(src.panel, src.band).violations.length === 0, `the shipped panel fails D: ${checkPanelReadsTheRow(src.panel, src.band).violations.join("; ")}`);

  // E · two stale numbers.
  say(checkOneStaleNumber("export const STALE_AFTER_MINUTES = 30;").violations.length === 1, "a hand-typed STALE_AFTER_MINUTES passed");

  // F · the real pre-fix declaration: 8000, no lead flag, a router that does not read it.
  const preService = src.service.replace(/export const BRIEF_EXPECTED_OUTPUT_TOKENS = [\d_]+;/, "export const BRIEF_EXPECTED_OUTPUT_TOKENS = 8_000;").replace(/leadOnPolicy: true,/, "");
  const preRunAi = src.runAi.replace(/\n\s*input\.budgetContext\?\.leadOnPolicy !== true &&/, "");
  const f = checkDeclaredOutput(preService, src.ceiling, preRunAi);
  say(f.violations.length >= 3, `the pre-fix 8000/no-lead/no-flag shape passed: ${f.violations.join("; ")}`);
  say(checkDeclaredOutput(src.service, src.ceiling, src.runAi).violations.length === 0, "the shipped declaration fails F");
  const tooHigh = checkDeclaredOutput(src.service.replace(/export const BRIEF_EXPECTED_OUTPUT_TOKENS = [\d_]+;/, "export const BRIEF_EXPECTED_OUTPUT_TOKENS = 40_000;"), src.ceiling, src.runAi);
  say(tooHigh.violations.length === 1, "a declaration above the wire ceiling passed");

  // G · the pre-fix default: weekends off.
  const g = checkWeekendsDefaultOn(src.service.replace(/COALESCE\(p\.weekends, 1\)/g, "COALESCE(p.weekends, 0)").replace("weekends: 1, enabled: 1", "weekends: 0, enabled: 1"), src.health, "-- nothing");
  say(g.violations.length >= 6, `the weekday-only default passed: ${g.violations.join("; ")}`);
  say(checkWeekendsDefaultOn(src.service, src.health, src.m0211).violations.length === 0, "the shipped defaults fail G");

  // H · no sentinel.
  say(checkSentinel("const checks = [];").violations.length === 2, "a health board with no sentinel passed");
  // I · no journey.
  say(checkJourneyIsE2e({ "x.spec.ts": "test('nothing')" }).violations.length === 1, "an e2e suite with no brief journey passed");
  say(checkJourneyIsE2e(listSpecs()).violations.length === 0, "the shipped e2e suite has no brief journey");

  console.log("SELF-TEST PASSED: the sweep-job brief branch, a reasonless FAILED writer, the 'any row is an arrival' state, the six-iteration button loop, two stale numbers, the 8000-token declaration without a lead flag, the weekday-only default, a board with no sentinel and a suite with no journey are each caught; every shipped module passes.");
}

if (process.argv.includes("--self-test")) await selfTest();
else await run();
