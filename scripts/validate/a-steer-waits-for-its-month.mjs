#!/usr/bin/env node
/**
 * a-steer-waits-for-its-month.mjs — `npm run validate:steer-waits`.
 *
 * ONE RULE: A ONE-OFF IS ACTED ON IMMEDIATELY; A STEER FOR A LATER MONTH IS NOT BUILT NOW, IS NOT
 * GUESSED AT FROM HER PROSE, AND REACHES THE PACKET IT WAS GIVEN FOR.
 *
 * ── What went wrong, 18 Sep 2026, reproduced before any of this was written ─────────────────────
 *
 * Both asks were the same ask. An ask on 18 September naming 2026-11 came back `201 queued:true`
 * with a work_card in state OPEN titled "Parker: build the November 2026 Room packet", and the
 * sweep would have built and emailed November's packet that afternoon. Operator: "a one off should
 * be delivered and acted upon immediately; asking for a specific topic or angle to next months
 * propoals should come when the month's proposal comes".
 *
 * ── Why a scan, when there are already tests ───────────────────────────────────────────────────
 *
 * The tests prove the behaviour of the code that exists. Three of the four failures this rule can
 * suffer are failures of SHAPE that a green test suite would not notice:
 *
 *   · a third stream, or a rewritten stage, reading the plan's steer directly and never loading
 *     hers — "a steer that has to be remembered at each stage is a steer that will be forgotten at
 *     one of them", and the forgotten one still passes every assertion about the other;
 *   · somebody replacing the refusal with a regex or a model reading her sentence, which is the
 *     approach that failed in the sibling system and which would look like an improvement in a diff;
 *   · the poll creeping back below hourly, or losing the zone the month boundary is read on;
 *   · the backstop being made quiet, which is how a broken request path stays broken for a month.
 *
 * WHAT IS CHECKED
 *   1 · THE CADENCE, replayed across every migration in order: the Rooms job is hourly or slower,
 *       and carries the zone its month boundary is read on.
 *   2 · THE ZONE IS READ. `runMonthlyRoomProposal` takes it and `deliveryMonth` uses it; jobs.ts
 *       hands the job's own row value in. A column nothing reads is a wish.
 *   3 · EVERY CONCEPTS PROMPT IN THE CHAIN TAKES ITS STEER FROM `steerForMonth`, both streams.
 *   4 · THE INTENT IS DECLARED, NOT INFERRED. `classifyAsk` reads a month and a declared value and
 *       nothing else — no prose field, no regex over her words.
 *   5 · THE DOOR FORKS BEFORE IT QUEUES, refuses rather than defaulting, and the STEER branch
 *       queues no draft.
 *   6 · THE BACKSTOP IS LOUD: a catch is not reported as a plain success.
 *
 * HARD-FAILS ON ZERO. Zero migrations, zero concepts-prompt sites, or a missing target function all
 * exit 1. A scan that examined nothing has proved nothing.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside the shipped shape, which must pass.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { effectiveSchedule, readMigrationsInOrder } from "./a-rare-lane-is-checked-daily.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ROOMS_FILE = path.join(ROOT, "src", "worker", "services", "roomPacket.ts");
const JOBS_FILE = path.join(ROOT, "src", "worker", "services", "jobs.ts");
const PLAN_FILE = path.join(ROOT, "src", "shared", "events", "monthlyPlan.ts");

const JOB_KEY = "monthly_room_proposal";
/** Hourly. The event path is the path; this is a net, and 96 casts a day to catch nothing is waste. */
const MIN_MINUTES = 60;
/** Her clock. "The 1st of the month prior" is a local-time boundary, not a Greenwich one. */
const CLOCK = "America/Chicago";

// ── 1 & 2 · The cadence, and the zone being read ───────────────────────────────────────────────

export function auditCadence(schedule) {
  const bad = [];
  if (!schedule) {
    return [`${JOB_KEY}: no migration sets a schedule for it — this scan cannot see the job it governs`];
  }
  if (schedule.kind === "INTERVAL") {
    const mins = schedule.interval_minutes ?? 0;
    if (mins < MIN_MINUTES) {
      bad.push(
        `${JOB_KEY}: back on INTERVAL ${mins} minutes (${Math.round(1440 / Math.max(1, mins))} runs a day) in ` +
          `${schedule.file}. Asking for a Room opens Parker's card in the request path; this tick is a backstop ` +
          `and a backstop does not need ninety-six casts a day`,
      );
    }
  }
  if (schedule.kind === "ON_REQUEST") {
    bad.push(`${JOB_KEY}: moved to ON_REQUEST in ${schedule.file} — nothing would then mint the month's packets on the 1st`);
  }
  if (!schedule.daily_at_tz) {
    bad.push(
      `${JOB_KEY}: no daily_at_tz (${schedule.file}). "The 1st of the month prior" is a local-time boundary: read ` +
        `in UTC, 2026-10-01T00:30Z is 30 September on her clock and November's packets mint a day early`,
    );
  } else if (schedule.daily_at_tz !== CLOCK) {
    bad.push(`${JOB_KEY}: scheduled against ${schedule.daily_at_tz}, but the cadence was stated on ${CLOCK}`);
  }
  return bad;
}

export function auditZoneIsRead(roomsSrc, jobsSrc) {
  const bad = [];
  const start = roomsSrc.indexOf("function runMonthlyRoomProposal");
  if (start < 0) return ["runMonthlyRoomProposal could not be located in roomPacket.ts — this scan lost its target"];
  const signature = roomsSrc.slice(start, roomsSrc.indexOf("{", start));
  const body = functionBody(roomsSrc, "function runMonthlyRoomProposal") ?? "";
  if (!/tz\??\s*:\s*string \| null/.test(signature)) {
    bad.push("runMonthlyRoomProposal does not take a zone, so the job's stored zone can reach nothing");
  }
  if (!/deliveryMonth\(\s*now\s*,\s*tz\s*\)/.test(body)) {
    bad.push("runMonthlyRoomProposal computes its delivery month without the zone — the column is stored and ignored");
  }
  if (!/runMonthlyRoomProposal\([^;]*job\.daily_at_tz/s.test(jobsSrc)) {
    bad.push("jobs.ts does not hand the job row's daily_at_tz to runMonthlyRoomProposal, so the zone never leaves the table");
  }
  return bad;
}

// ── 3 · Every concepts prompt takes its steer from one place ───────────────────────────────────

/**
 * The concepts-prompt call sites, and the binding each passes as its `steer`.
 *
 * Deliberately a scan for the PROMPT BUILDER rather than for a stage name: a new stream would add a
 * `buildXConceptsPrompt` and this finds it without anybody remembering to add it to a list. That is
 * the whole failure mode — a list somebody has to remember to update is the second copy of a rule.
 */
export function conceptsPromptSites(src) {
  const sites = [];
  for (const m of src.matchAll(/build(\w*)ConceptsPrompt\(\{([^}]*)\}/gs)) {
    const args = m[2];
    /*
     * `steer: roomSteer` AND the shorthand `steer` are the same thing at the call site, and the
     * Workshop stream uses the shorthand. A scan that only understood the long form read the
     * Workshop prompt as having no steer at all — a false positive that would have been "fixed" by
     * loosening the rule.
     */
    const long = /(^|[,\s])steer\s*:\s*([A-Za-z0-9_.]+)/.exec(args);
    const short = /(^|[,\s])steer\s*(,|$)/.exec(args);
    sites.push({ builder: `build${m[1]}ConceptsPrompt`, steerBinding: long ? long[2] : short ? "steer" : null });
  }
  return sites;
}

export function auditSteerRouting(src) {
  const bad = [];
  const sites = conceptsPromptSites(src);
  if (sites.length < 2) {
    return [
      `found ${sites.length} concepts-prompt site(s) in roomPacket.ts; there are two streams (Room and Workshop) ` +
        `and a scan that sees fewer has lost its target rather than found a clean file`,
    ];
  }
  /* The bindings that a `steerForMonth(...)` result was unpacked into, in this file. */
  const fromSteerForMonth = new Set();
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*await\s+steerForMonth\(/g)) fromSteerForMonth.add(`${m[1]}.text`);
  for (const m of src.matchAll(/const\s+(\w+)\s*=\s*(\w+)\.text\s*;/g)) {
    if (fromSteerForMonth.has(`${m[2]}.text`)) fromSteerForMonth.add(m[1]);
  }
  for (const site of sites) {
    if (!site.steerBinding) {
      bad.push(`${site.builder} is built with no steer at all — whatever she said for that month reaches nothing`);
      continue;
    }
    if (!fromSteerForMonth.has(site.steerBinding)) {
      bad.push(
        `${site.builder} takes its steer from \`${site.steerBinding}\`, which is not a steerForMonth result. ` +
          `That is the plan's standing steer alone: every instruction she recorded for that month is dropped`,
      );
    }
  }
  if (!/markDelivered\(/.test(src)) {
    bad.push("nothing marks a steer as having reached a packet, so the board can never stop saying she is owed it");
  }
  return bad;
}

// ── 4 & 5 · Declared, not inferred; and the fork happens before the queue ──────────────────────

/** Fields that would mean a classifier is reading her prose to decide what she meant. */
const PROSE_FIELDS = ["audience", "notes", "words", "brief", "prompt", "text"];

/**
 * A function's body, brace-matched.
 *
 * FOUR NAIVE VERSIONS WERE WRONG AND EACH FAILED SILENTLY BY PASSING:
 *   · slice to the next `\n}` — misses a body whose closing brace is indented, and every fixture
 *     written in a template literal is indented;
 *   · slice to the next `export` — swallows the doc comment of whatever comes next, and the comment
 *     below `classifyAsk` is about steers and contains the very words this scan searches for;
 *   · brace-match from the FIRST `{` — that is `Promise<{ generated: boolean … }>` on one function
 *     and the destructured parameter type `input: {` on another, so the scan read a type annotation
 *     and reported the body as not doing what the body does;
 *   · take the LAST balanced group before the next `export` — the next `export` can be several
 *     declarations away, and this scan then read `const briefSchema = z.object({ … })` as the body
 *     of `runMonthlyRoomProposal`. It reported a true rule as broken, which is the better direction
 *     to fail in but is still a scan measuring the wrong text.
 *
 * SO: match the parameter list's parentheses, then take the first `{` after it that OPENS A LINE'S
 * WORTH OF BODY (followed by a newline). A return type's brace — `Promise<{ generated` — is
 * followed by a space, and a parameter type's brace is inside the parentheses.
 */
export function functionBody(src, signature) {
  const start = src.indexOf(signature);
  if (start < 0) return null;
  const openParen = src.indexOf("(", start);
  if (openParen < 0) return null;
  let parens = 0;
  let closeParen = -1;
  for (let i = openParen; i < src.length; i += 1) {
    if (src[i] === "(") parens += 1;
    else if (src[i] === ")") {
      parens -= 1;
      if (parens === 0) { closeParen = i; break; }
    }
  }
  if (closeParen < 0) return null;
  const open = src.slice(closeParen).search(/\{\s*\n/);
  if (open < 0) return null;
  const from = closeParen + open;
  let depth = 0;
  for (let i = from; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(from, i + 1);
    }
  }
  return null;
}

export function auditNoProseClassifier(planSrc) {
  const bad = [];
  const body = functionBody(planSrc, "function classifyAsk");
  if (body === null) return ["classifyAsk could not be located in monthlyPlan.ts — this scan lost its target"];
  for (const field of PROSE_FIELDS) {
    if (new RegExp(`\\b${field}\\b`).test(body)) {
      bad.push(
        `classifyAsk reads \`${field}\`. Which kind of ask this is must be DECLARED: a regex or a model reading ` +
          `her sentence was tried in the sibling system and failed, and being wrong here silently delivers ` +
          `November's topic today`,
      );
    }
  }
  if (/new RegExp|\.match\(|\.test\(/.test(body)) {
    bad.push("classifyAsk pattern-matches. The only inference allowed here is a calendar comparison");
  }
  if (!/deliveryMonth\(/.test(body)) {
    bad.push("classifyAsk does not compare against the month being delivered, so it cannot know which asks are ambiguous");
  }
  return bad;
}

export function auditDoor(roomsSrc) {
  const bad = [];
  const body = functionBody(roomsSrc, "function handleGeneratePacket");
  if (body === null) return ["handleGeneratePacket could not be located in roomPacket.ts — this scan lost its target"];
  if (!/classifyAsk\(/.test(body)) {
    bad.push("the door never classifies the ask, so a one-off and a steer are the same request again");
  }
  if (!/intent_required/.test(body)) {
    bad.push("the door has no refusal: an ambiguous ask must ask, because a wrong default builds November's Room in September");
  }
  const fork = body.indexOf('ask.intent === "STEER"');
  const queue = body.indexOf("queueDraft(ctx.env, actor, { month: b.month");
  if (fork < 0) bad.push("the door has no STEER branch");
  else if (queue >= 0 && fork > queue) {
    bad.push("the door queues the draft BEFORE it forks on intent — a steer becomes a thing Parker builds");
  }
  return bad;
}

// ── 6 · The backstop says when it catches something ────────────────────────────────────────────

export function auditBackstopIsLoud(roomsSrc, jobsSrc) {
  const bad = [];
  if (!/backstopCaught/.test(roomsSrc)) {
    bad.push("the Rooms job cannot report that its backstop caught a miss, so a broken request path looks like a working poll");
  }
  if (!/backstopCaught\s*\?\s*"FAILED"/.test(jobsSrc)) {
    bad.push(
      "jobs.ts reports a backstop catch as a plain success. The card gets opened either way, but a run that " +
        "quietly repairs a defect in the request path is how the defect survives a month of green graphs",
    );
  }
  if (!/notifyPartners\(/.test(roomsSrc)) {
    bad.push("nothing tells a person when the backstop catches something; a run summary is not a person seeing it");
  }
  return bad;
}

// ── Self-test ──────────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const failures = [];
  const expect = (what, cond) => {
    if (!cond) failures.push(what);
  };

  const roomsSrc = readFileSync(ROOMS_FILE, "utf8");
  const jobsSrc = readFileSync(JOBS_FILE, "utf8");
  const planSrc = readFileSync(PLAN_FILE, "utf8");

  // 1 · THE REAL PRE-FIX CADENCE: 0166's `interval_minutes = 15`, no zone.
  const preFix = [
    { file: "0161.sql", sql: `UPDATE scheduled_job SET schedule_kind = 'INTERVAL', interval_minutes = 30 WHERE job_key = 'monthly_room_proposal';` },
    { file: "0166.sql", sql: `UPDATE scheduled_job SET interval_minutes = 15 WHERE job_key = 'monthly_room_proposal';` },
  ];
  expect(
    "the shipped fifteen-minute poll is caught",
    auditCadence(effectiveSchedule(preFix, JOB_KEY)).some((m) => m.includes("INTERVAL 15")),
  );
  expect(
    "the missing zone is caught",
    auditCadence(effectiveSchedule(preFix, JOB_KEY)).some((m) => m.includes("no daily_at_tz")),
  );

  // 2 · The shipped fix passes.
  const fixed = [
    ...preFix,
    { file: "0194.sql", sql: `UPDATE scheduled_job SET schedule_kind = 'INTERVAL', interval_minutes = 60, daily_at_tz = 'America/Chicago' WHERE job_key = 'monthly_room_proposal';` },
  ];
  expect("the shipped fix passes", auditCadence(effectiveSchedule(fixed, JOB_KEY)).length === 0);

  // 3 · A later migration creeping it back under an hour.
  const regressed = [
    ...fixed,
    { file: "0201.sql", sql: `UPDATE scheduled_job SET interval_minutes = 5 WHERE job_key = 'monthly_room_proposal';` },
  ];
  expect("a later migration speeding the poll back up is caught", auditCadence(effectiveSchedule(regressed, JOB_KEY)).length > 0);

  // 4 · A job no migration mentions must fail rather than pass vacuously.
  expect("an unseen job is a failure, not a pass", auditCadence(effectiveSchedule([], JOB_KEY)).length > 0);

  // 5 · The zone stored and then ignored — the shape that would look fixed and behave exactly as before.
  const blindRooms = "export async function runMonthlyRoomProposal(env, actor, now) {\n const month = deliveryMonth(now);\n}";
  expect(
    "a job that ignores its stored zone is caught",
    auditZoneIsRead(blindRooms, jobsSrc).some((m) => m.includes("stored and ignored")),
  );
  expect(
    "a jobs.ts that never passes the zone is caught",
    auditZoneIsRead(roomsSrc, "runMonthlyRoomProposal(env, actor, now.toISOString());").some((m) => m.includes("never leaves the table")),
  );

  // 6 · THE REAL PRE-FIX ROUTING: the steer read straight off `topicFor`, hers dropped.
  const preFixRouting = `
    const { topic, setBy, steer: roomSteer } = topicFor(m, "ROOM", null);
    const prompt = buildConceptsPrompt({ month: m, topic, setBy, steer: roomSteer, brief });
    const p2 = buildWorkshopConceptsPrompt({ month: m, topic, set, setBy, steer, brief });
    markDelivered();
  `;
  expect(
    "a concepts prompt fed from the plan's steer alone is caught",
    auditSteerRouting(preFixRouting).some((m) => m.includes("not a steerForMonth result")),
  );
  expect("the shipped routing passes", auditSteerRouting(roomsSrc).length === 0);
  expect(
    "a concepts prompt with no steer at all is caught",
    auditSteerRouting(`buildConceptsPrompt({ month: m, topic });\nbuildWorkshopConceptsPrompt({ month: m });\nmarkDelivered();`).some((m) =>
      m.includes("no steer at all"),
    ),
  );
  expect("a file with one stream's prompt missing hard-fails", auditSteerRouting("buildConceptsPrompt({ steer: x })").length > 0);

  // 7 · The classifier that reads her prose — the approach this design refuses.
  const guessing = `export function classifyAsk(input) {
    if (/next month/i.test(input.audience)) return { intent: "STEER" };
    return { intent: "NOW" };
  }`;
  expect(
    "a classifier reading her prose is caught",
    auditNoProseClassifier(guessing).some((m) => m.includes("audience")),
  );
  expect("a classifier that pattern-matches is caught", auditNoProseClassifier(guessing).some((m) => m.includes("pattern-matches")));
  expect("the shipped classifier passes", auditNoProseClassifier(planSrc).length === 0);

  // 8 · THE REAL PRE-FIX DOOR: queue first, no fork, no refusal.
  const preFixDoor = `export async function handleGeneratePacket(ctx) {
      draft = await queueDraft(ctx.env, actor, { month: b.month, brief, origin: "PARTNER_BRIEF" });
      return json({ packet: draft });
  }
export async function handleListPackets(ctx) {}`;
  expect("a door that never classifies is caught", auditDoor(preFixDoor).some((m) => m.includes("never classifies")));
  expect("a door with no refusal is caught", auditDoor(preFixDoor).some((m) => m.includes("no refusal")));
  expect("the shipped door passes", auditDoor(roomsSrc).length === 0);

  // 9 · A quiet backstop.
  expect(
    "a backstop reported as a plain success is caught",
    auditBackstopIsLoud(roomsSrc, 'status: "SUCCEEDED",').some((m) => m.includes("plain success")),
  );
  expect(
    "a job that cannot even report a catch is caught",
    auditBackstopIsLoud("nothing here", jobsSrc).some((m) => m.includes("looks like a working poll")),
  );
  expect("the shipped backstop passes", auditBackstopIsLoud(roomsSrc, jobsSrc).length === 0);

  if (failures.length > 0) {
    console.error("STEER-WAITS SELF-TEST FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    "STEER-WAITS SELF-TEST PASSED (18 fixtures, including the shipped 15-minute poll, the plan-steer-only routing " +
      "and a regex classifier over her prose)",
  );
}

function main() {
  if (process.argv.includes("--self-test")) return selfTest();

  const migrations = readMigrationsInOrder();
  if (migrations.length === 0) {
    console.error("STEER-WAITS SCAN FAILED — read zero migrations. Rule 0.");
    process.exit(1);
  }
  const roomsSrc = readFileSync(ROOMS_FILE, "utf8");
  const jobsSrc = readFileSync(JOBS_FILE, "utf8");
  const planSrc = readFileSync(PLAN_FILE, "utf8");

  const sites = conceptsPromptSites(roomsSrc);
  const violations = [
    ...auditCadence(effectiveSchedule(migrations, JOB_KEY)),
    ...auditZoneIsRead(roomsSrc, jobsSrc),
    ...auditSteerRouting(roomsSrc),
    ...auditNoProseClassifier(planSrc),
    ...auditDoor(roomsSrc),
    ...auditBackstopIsLoud(roomsSrc, jobsSrc),
  ];

  if (violations.length > 0) {
    console.error("STEER-WAITS SCAN FAILED — a steer would be built today, guessed at, or dropped before its month:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error(
      "\nOperator, 18 Sep 2026: \"if i make an ask of Parker for next month's proposal or ask for a one-off\n" +
        "that is 2 diff things: a one off should be delivered and acted upon immediately; asking for a\n" +
        "specific topic or angle to next months propoals should come when the month's proposal comes\".",
    );
    process.exit(1);
  }

  console.log(
    `STEER-WAITS SCAN PASSED: the Rooms job is hourly on ${CLOCK} as replayed across ${migrations.length} migrations ` +
      `and its zone is read; ${sites.length} concepts prompt(s) take their steer from steerForMonth; the ask is ` +
      `declared rather than inferred and the door refuses instead of guessing; the backstop reports its catches.`,
  );
}

// Runs only as an entrypoint, so the scan can be imported by a test or a sibling scan without firing.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
