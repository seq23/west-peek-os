#!/usr/bin/env node
/**
 * a-brief-that-fails-says-so.mjs — `npm run validate:brief-arrives`.
 *
 * ONE ASSERTION, IN THREE PARTS: THE MORNING BRIEF CAN BE WRITTEN IN FULL, AND WHEN IT CANNOT BE,
 * THE PARTNER IS TOLD — NEVER LEFT WITH AN EMPTY CARD.
 *
 * WHAT WENT WRONG, 18 Sep 2026, 08:59 CT. Both partners' briefs failed. Hers was GENERATING and
 * his was FAILED, and Home rendered, for both, a masthead, a "Rebuild today's brief" button, the
 * line "2026-09-18 · 300 items → 283 events → 30 considered", and nothing else. Her words: "i also
 * do not have a breif for today. its some bug i guess from the 'hide the brief' button." It was not
 * the button. She had no way to know that, because the card said nothing at all.
 *
 * THE CHAIN, END TO END — three separate defects, none of which alone would have done it:
 *
 *   · On 17 Sep a 60-second deadline landed on every provider attempt. The brief asks for 8000
 *     output tokens and this repo says elsewhere that writing it is "one model call, ~3 min". No
 *     code linked those two numbers, so a deadline under a third of the stated duration read as a
 *     safe default. Every frontier attempt began aborting — four free lanes and claude-sonnet-5,
 *     every one TIMEOUT_OR_NETWORK.
 *   · The router did the right thing and failed over to the cheapest lane still answering, Workers
 *     AI. That adapter sent no `max_tokens`, so the platform applied its own default of 256.
 *     Every one of the eight runs that morning recorded output_tokens: exactly 256, the reply
 *     ending mid-word in the second section.
 *   · The brief's quality gate rejected all eight — "executive_summary carries no [n] citation;
 *     top_headlines carries no [n] citation; ... the markets_macro section is missing" — correctly,
 *     since the model was cut off before it could write any of it. The gate was right. It is not
 *     touched here.
 *   · And the panel, handed a row that existed and was not READY, rendered the counts and mapped
 *     over zero sections. The reason was on the row the whole time and was never read.
 *
 * WHAT IS CHECKED
 *   1 · NO REPLY IS CUT OFF BY A CEILING NOBODY CHOSE. Every adapter that speaks a model provider's
 *       wire protocol sends an explicit output ceiling, from the one shared constant — and that
 *       constant is at least the largest `expectedOutputTokens` any caller in this repo asks for.
 *       Both numbers are READ OUT OF THE SOURCE, so the callers and the ceiling cannot drift apart
 *       again. This catches Workers AI's 256 and `anthropic.ts`'s old hard-coded 4096 alike.
 *   2 · THE DEADLINE FITS THE WORK. `PROVIDER_TIMEOUT_MS` is at least as long as the largest ask
 *       takes to generate at a conservative floor rate, and still shorter than the stage lease that
 *       contains it — so a hung provider is still a failure the router acts on rather than a run
 *       that sits RUNNING for ever. Derived from the same largest ask as check 1, so a caller that
 *       asks for more raises the deadline it needs rather than silently timing out.
 *   3 · A BRIEF THAT DID NOT ARRIVE SAYS SO. `briefArrival` is IMPORTED AND RUN — not grepped —
 *       over every status `intelligence_report.status` accepts, read out of the migration that
 *       declares it. Exactly one status may report an arrival; every other must produce a sentence
 *       that says the brief is not there and a remedy, and must not leak the raw status code. Then
 *       the two surfaces are checked to actually call it: the panel renders a not-arrived notice
 *       driven by it, and the collapsed line defers to it rather than deciding for itself.
 *
 * HARD-FAILS ON ZERO. Zero adapters, zero callers, zero statuses, or either surface unread exits 1.
 * A scan that examined nothing has proved nothing — this repo calls that Rule 0.
 *
 * `--self-test` restores each real pre-fix shape — the ceiling-less Workers AI call, the 60s
 * deadline, the "any non-null row is an arrival" line, the panel with no not-arrived branch — and
 * requires every one of them to be caught, alongside clean fixtures that must pass.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTER_DIR = path.join(ROOT, "src", "worker", "ai", "providers");
const SERVICES_DIR = path.join(ROOT, "src", "worker", "services");
const CEILING_FILE = path.join(ADAPTER_DIR, "outputCeiling.ts");
const TIMEOUT_FILE = path.join(ADAPTER_DIR, "timeout.ts");
const BRIEF_SERVICE = path.join(SERVICES_DIR, "dailyIntelligence.ts");
const PANEL = path.join(ROOT, "src", "client", "pages", "DailyBriefPanel.tsx");
const COLLAPSE = path.join(ROOT, "src", "client", "lib", "briefCollapse.ts");
const STATE_MODULE = path.join(ROOT, "src", "client", "lib", "briefState.ts");
const SCHEMA = path.join(ROOT, "migrations", "0035_daily_intelligence_pipeline.sql");

/**
 * The slowest a frontier model may be assumed to write, in output tokens per second.
 *
 * Deliberately pessimistic. This is not a performance target, it is the floor the DEADLINE has to
 * respect: if the system asks for N tokens it must be willing to wait N / this for them. On
 * 18 Sep the deadline implied a required rate of 133 tok/s for the brief to survive, which no
 * model here sustains, so the brief could never have completed on any lane.
 */
const TOKENS_PER_SECOND_FLOOR = 50;

function read(file) {
  return readFileSync(file, "utf8");
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

// ── 1 · No reply is cut off by a ceiling nobody chose ──────────────────────────────────────────

/**
 * The largest reply any caller in this repo asks for, read out of the callers themselves.
 *
 * This is the number the ceiling and the deadline must both respect. Reading it rather than
 * restating it is the whole point: `outputCeiling.ts` saying 16384 proves nothing on its own, and a
 * caller raising its ask to 20000 must break something rather than start silently truncating.
 */
export function largestAsk(sources) {
  let largest = 0;
  let examined = 0;
  for (const raw of Object.values(sources)) {
    for (const m of stripComments(raw).matchAll(/expectedOutputTokens:\s*([0-9_]+)/g)) {
      examined += 1;
      largest = Math.max(largest, Number(m[1].replace(/_/g, "")));
    }
  }
  return { largest, examined };
}

/** The value of the shared ceiling constant, read out of the module that declares it. */
export function declaredCeiling(src) {
  const m = /PROVIDER_MAX_OUTPUT_TOKENS\s*=\s*([0-9_]+)/.exec(stripComments(src));
  return m ? Number(m[1].replace(/_/g, "")) : null;
}

/**
 * An adapter speaks a model provider's wire protocol if it builds a request payload carrying a
 * message/content array. That is what separates the lanes a completion can land on from the local
 * mock, the transcription adapter and the internal specialist service, which have their own shapes
 * and no token ceiling to set.
 */
function speaksToAModel(src) {
  const body = stripComments(src);
  if (!/complete\s*\(\s*req/.test(body)) return false;
  return /\b(messages|contents|input)\s*:\s*\[/.test(body);
}

/**
 * Every way an adapter may name the ceiling on the wire, and what the VALUE is allowed to be.
 *
 * ── WIDENED ONCE, AND ONLY TO SOMETHING STRICTER (18 Sep 2026) ────────────────────────────────
 *
 * This required the value to be `PROVIDER_MAX_OUTPUT_TOKENS` verbatim, which was exactly right
 * when the only alternative was a provider default of 256 or a hard-coded 4096. It also meant the
 * catalogue ceiling was the ONLY thing any caller could ever be given: a 400-token classification
 * and an 8000-token brief asked the provider for the same 16,384, so `expectedOutputTokens` — the
 * figure the caller actually declares, and which prices the run — still reached no adapter, and no
 * deadline could be sized to the work.
 *
 * The per-call form is now accepted, and the acceptance is NARROWER than the old rule rather than
 * wider: the per-call value must be wrapped in `Math.min(…, PROVIDER_MAX_OUTPUT_TOKENS)`, so a
 * caller can lower its own ceiling and can never raise it past the catalogue. A bare
 * `req.maxOutputTokens` is refused below, which the old pattern would have had nothing to say
 * about. The constant remains the ceiling; it is no longer also the floor.
 */
const CEILING_VALUE = String.raw`(?:PROVIDER_MAX_OUTPUT_TOKENS\b|Math\.min\(\s*req\.maxOutputTokens\s*\?\?\s*PROVIDER_MAX_OUTPUT_TOKENS\s*,\s*PROVIDER_MAX_OUTPUT_TOKENS\s*\))`;
const CEILING_KEYS = new RegExp(String.raw`\b(max_tokens|max_output_tokens|maxOutputTokens)\s*:\s*` + CEILING_VALUE);
/** A per-call ceiling anywhere in the ceiling position. Legal only in the capped form above. */
const PER_CALL_CEILING = new RegExp(String.raw`\b(max_tokens|max_output_tokens|maxOutputTokens)\s*:\s*[^\n]*req\.maxOutputTokens`);

export function checkAdaptersSetACeiling(sources) {
  const violations = [];
  let examined = 0;
  for (const [file, raw] of Object.entries(sources)) {
    if (!speaksToAModel(raw)) continue;
    examined += 1;
    const body = stripComments(raw);
    if (PER_CALL_CEILING.test(body) && !CEILING_KEYS.test(body)) {
      violations.push(
        `${file} sends this caller's own output ceiling without capping it at PROVIDER_MAX_OUTPUT_TOKENS — ` +
          "a caller could ask for more than the catalogue allows, and the shared ceiling would stop meaning anything",
      );
      continue;
    }
    if (!CEILING_KEYS.test(body)) {
      violations.push(
        `${file} sends a completion with no explicit output ceiling from the shared constant — ` +
          "the provider's own default decides how long the reply may be (Workers AI's is 256 tokens)",
      );
      continue;
    }
    // A LITERAL BESIDE THE WIRE IS THE SAME DEFECT WITH A NICER FACE. `anthropic.ts` carried its own
    // 4096, below what the brief asks for, and nothing linked it to any caller.
    const literal = /\b(max_tokens|max_output_tokens|maxOutputTokens)\s*:\s*[0-9]/.exec(body);
    if (literal) {
      violations.push(`${file} hard-codes an output ceiling (${literal[0].trim()}) instead of importing the shared one`);
    }
  }
  return { violations, examined };
}

// ── 2 · The deadline fits the work ─────────────────────────────────────────────────────────────

export function declaredTimeoutMs(src) {
  const m = /PROVIDER_TIMEOUT_MS\s*=\s*([0-9_]+)/.exec(stripComments(src));
  return m ? Number(m[1].replace(/_/g, "")) : null;
}

export function declaredStageLeaseMinutes(src) {
  const m = /STAGE_LEASE_MINUTES\s*=\s*([0-9_]+)/.exec(stripComments(src));
  return m ? Number(m[1].replace(/_/g, "")) : null;
}

export function checkDeadlineFitsTheWork({ timeoutMs, largestAskTokens, stageLeaseMinutes }) {
  const violations = [];
  if (timeoutMs === null) return { violations: ["PROVIDER_TIMEOUT_MS could not be read"], examined: 0 };
  if (stageLeaseMinutes === null) return { violations: ["STAGE_LEASE_MINUTES could not be read"], examined: 0 };

  const neededMs = Math.ceil((largestAskTokens / TOKENS_PER_SECOND_FLOOR) * 1000);
  if (timeoutMs < neededMs) {
    violations.push(
      `PROVIDER_TIMEOUT_MS is ${timeoutMs}ms, but the largest reply this repo asks for is ` +
        `${largestAskTokens} tokens, which needs at least ${neededMs}ms at ${TOKENS_PER_SECOND_FLOOR} tok/s. ` +
        "Every attempt at that call aborts, and the router fails over to whatever is cheap and fast — " +
        "which on 18 Sep 2026 meant a lane that truncated both partners' briefs at 256 tokens.",
    );
  }
  const leaseMs = stageLeaseMinutes * 60_000;
  if (timeoutMs >= leaseMs) {
    violations.push(
      `PROVIDER_TIMEOUT_MS (${timeoutMs}ms) is not shorter than the stage lease that contains it ` +
        `(STAGE_LEASE_MINUTES ${stageLeaseMinutes} = ${leaseMs}ms). A provider that hangs would outlive ` +
        "its own lease, and 'timeout' would go back to being a failure mode this system can describe " +
        "and cannot produce.",
    );
  }
  return { violations, examined: 2 };
}

// ── 3 · A brief that did not arrive says so ────────────────────────────────────────────────────

/**
 * Every status the database accepts, read from the migration that declares the constraint.
 *
 * ANCHORED TO THE TABLE, and that is not fussiness. Written as a bare search for the first
 * `CHECK (status IN (...))` in the file, this read `tracked_narrative`'s ACTIVE/RESOLVED/DORMANT
 * three tables earlier and reported a confident pass having tested none of the brief's statuses.
 * A zero-guard would not have caught it — three is not zero. So the table is named, and the result
 * must contain the two statuses this whole check is about or it is treated as unread.
 */
export function statusesFromSchema(sql) {
  const table = /CREATE TABLE IF NOT EXISTS intelligence_report\s*\(([\s\S]*?)\n\);/.exec(sql);
  if (!table) return [];
  const m = /CHECK \(status IN \(([^)]*)\)\)/.exec(table[1]);
  if (!m) return [];
  const list = m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
  // The list must be the one we think it is. A constraint read off the wrong table is worse than
  // none: it passes.
  if (!list.includes("READY") || !list.includes("FAILED")) return [];
  return list;
}

/**
 * THE REAL FUNCTION, RUN — not read. `briefArrival` is imported and driven over every status the
 * schema permits. A grep would pass on a function that returns the right shape and the wrong answer.
 */
export function checkEveryStatusSaysSomething(briefArrival, statuses) {
  const violations = [];
  let examined = 0;
  for (const status of statuses) {
    examined += 1;
    const row = { status, report_date: "2026-09-18", completed_at: null, error_code: null, error_message: null };
    // Sections present, so the status is the only thing separating these cases.
    const a = briefArrival(row, 7);
    if (typeof a?.line !== "string" || a.line.trim().length === 0) {
      violations.push(`status ${status} produces no sentence at all — a silent card is the 18 Sep defect`);
      continue;
    }
    if (a.line.includes(status)) {
      violations.push(`status ${status} leaks the raw column value into the sentence she reads`);
    }
    if (status === "READY") {
      if (a.arrived !== true) violations.push("a READY report with sections is not reported as arrived");
      continue;
    }
    if (a.arrived === true) {
      violations.push(`status ${status} claims a brief arrived when none did`);
    }
    if (!/not arrive|still being built|no brief|held back/i.test(a.line)) {
      violations.push(`status ${status} does not say the brief is not there: "${a.line}"`);
    }
    if (!a.remedy) {
      violations.push(`status ${status} leaves her with nothing to do about it`);
    }
  }

  // THE TWO SHAPES THAT ACTUALLY HAPPENED, verbatim off the production rows.
  const why = "the brief was rejected twice: executive_summary carries no [n] citation";
  const failed = briefArrival(
    { status: "FAILED", report_date: "2026-09-18", completed_at: null, error_code: "incomplete", error_message: why },
    0,
  );
  examined += 1;
  if (!failed.line.includes(why)) {
    violations.push("a FAILED brief does not show the reason the pipeline already wrote on the row");
  }
  // READY IS NECESSARY AND NOT SUFFICIENT: every section held back is an empty card by another route.
  const emptyReady = briefArrival(
    { status: "READY", report_date: "2026-09-18", completed_at: "2026-09-18T12:40:06.505Z", error_message: null },
    0,
  );
  examined += 1;
  if (emptyReady.arrived !== false) {
    violations.push("a READY report with zero sections is reported as an arrival — that is an empty card");
  }
  return { violations, examined };
}

/** And both surfaces must actually call it, rather than deciding for themselves. */
export function checkSurfacesUseIt({ panel, collapse }) {
  const violations = [];
  let examined = 0;

  examined += 1;
  const panelBody = stripComments(panel);
  if (!/briefArrival\(\s*report\s*,\s*sections\.length\s*\)/.test(panelBody)) {
    violations.push("DailyBriefPanel does not compute the arrival from the report and the sections on screen");
  }
  if (!panel.includes('data-testid="daily-brief-not-arrived"')) {
    violations.push(
      "DailyBriefPanel has no not-arrived notice. A report row that is not READY renders the masthead, " +
        "the counts and zero sections — which is exactly the empty card both partners saw on 18 Sep 2026",
    );
  }
  if (!/report && !arrival\.arrived/.test(panelBody)) {
    violations.push("DailyBriefPanel's not-arrived notice is not driven by the arrival, so it cannot be right in every state");
  }
  if (!/error_message:\s*string \| null/.test(panelBody)) {
    violations.push("DailyBriefPanel does not declare error_message, so the reason on the row cannot reach the screen");
  }

  examined += 1;
  const collapseBody = stripComments(collapse);
  if (!/briefArrival\(/.test(collapseBody)) {
    violations.push(
      "collapsedBriefLine decides for itself whether a brief arrived. It used to call any non-null row " +
        "an arrival, which told both partners their brief had arrived on a morning neither had one",
    );
  }
  return { violations, examined };
}

// ── Self-test ──────────────────────────────────────────────────────────────────────────────────

/** The real pre-fix Workers AI call — no ceiling anywhere near the wire. */
const PREFIX_WORKERS_AI = `
export function createWorkersAiAdapter(options) {
  return { async complete(req) {
    const result = await options.binding.run(model, {
      messages: [ { role: "system", content: req.purpose }, { role: "user", content: req.inputs.join("") } ],
    });
    return { text: generatedText(result) };
  } };
}`;

/** The real pre-fix anthropic call — its own number, linked to nothing. */
const PREFIX_ANTHROPIC = `
export function createAnthropicAdapter(options) {
  return { async complete(req) {
    const res = await doFetch(url, { body: JSON.stringify({
      model, max_tokens: 4096,
      messages: [{ role: "user", content }],
    }) });
  } };
}`;

const CLEAN_ADAPTER = `
export function createCleanAdapter(options) {
  return { async complete(req) {
    const res = await doFetch(url, { body: JSON.stringify({
      model, max_tokens: PROVIDER_MAX_OUTPUT_TOKENS,
      messages: [{ role: "user", content }],
    }) });
  } };
}`;

/** Not a model lane: the internal specialist service. Must not be demanded a ceiling. */
const NOT_A_MODEL_LANE = `
export function createSpecialistAdapter(options) {
  return { async complete(req) {
    const res = await doFetch(url, { body: JSON.stringify({ model: req.model, purpose: req.purpose, inputs: req.inputs }) });
  } };
}`;

/** The real pre-fix collapsed line: any non-null row is an arrival. */
function prefixBriefArrival(report, sectionCount) {
  if (!report) return { arrived: false, tone: "working", line: "No brief has been built for today yet.", remedy: null };
  return { arrived: true, tone: "arrived", line: `${report.report_date} — today's brief arrived.`, remedy: null };
}

async function selfTest() {
  let failed = 0;
  const say = (ok, what) => {
    if (!ok) {
      console.error(`SELF-TEST FAILED — ${what}`);
      failed += 1;
    }
  };

  // 1 · ceilings
  const prefix = checkAdaptersSetACeiling({ "workersAi.ts": PREFIX_WORKERS_AI });
  say(prefix.examined === 1, "the real pre-fix Workers AI adapter was not even examined");
  say(prefix.violations.length > 0, "the real pre-fix Workers AI adapter — no ceiling at all, 256 tokens — passed");

  const anth = checkAdaptersSetACeiling({ "anthropic.ts": PREFIX_ANTHROPIC });
  say(anth.violations.length > 0, "the real pre-fix anthropic adapter — its own 4096, below the brief's 8000 ask — passed");

  const clean = checkAdaptersSetACeiling({ "clean.ts": CLEAN_ADAPTER });
  say(clean.examined === 1 && clean.violations.length === 0, `a correct adapter was rejected: ${clean.violations.join("; ")}`);

  const notALane = checkAdaptersSetACeiling({ "specialist.ts": NOT_A_MODEL_LANE });
  say(notALane.examined === 0, "an adapter that speaks no model wire protocol was demanded a token ceiling");

  // largestAsk reads the callers, and ignores a number inside a comment.
  const asks = largestAsk({ "a.ts": "budgetContext: { expectedOutputTokens: 8000 }", "b.ts": "expectedOutputTokens: 1_200" });
  say(asks.largest === 8000 && asks.examined === 2, `largestAsk read ${asks.largest} from ${asks.examined} callers, expected 8000 from 2`);
  const commented = largestAsk({ "c.ts": "/* expectedOutputTokens: 99999 */ expectedOutputTokens: 600" });
  say(commented.largest === 600, "a number written only in a comment was counted as a caller's ask");

  // A ceiling below the largest ask must fail.
  say(declaredCeiling("export const PROVIDER_MAX_OUTPUT_TOKENS = 4_096;") === 4096, "the ceiling constant could not be read");

  // 2 · deadline. The REAL 18 Sep numbers: 60s against an 8000-token ask.
  const wasBroken = checkDeadlineFitsTheWork({ timeoutMs: 60_000, largestAskTokens: 8000, stageLeaseMinutes: 10 });
  say(wasBroken.violations.length > 0, "the real 18 Sep deadline — 60s for an 8000-token brief — passed");
  const nowFine = checkDeadlineFitsTheWork({ timeoutMs: 180_000, largestAskTokens: 8000, stageLeaseMinutes: 10 });
  say(nowFine.violations.length === 0, `the shipped deadline was rejected: ${nowFine.violations.join("; ")}`);
  // And it may not outgrow the lease that contains it.
  const tooLong = checkDeadlineFitsTheWork({ timeoutMs: 900_000, largestAskTokens: 8000, stageLeaseMinutes: 10 });
  say(tooLong.violations.length > 0, "a deadline longer than its own stage lease passed");

  // 3 · a brief that did not arrive says so
  const statuses = statusesFromSchema(read(SCHEMA));
  say(statuses.length > 1, `read ${statuses.length} statuses out of the schema`);
  const preFix = checkEveryStatusSaysSomething(prefixBriefArrival, statuses);
  say(preFix.violations.length > 0, "the real pre-fix line — any non-null row is an arrival — passed over every status");

  const { briefArrival } = await import(pathToFileUrl(STATE_MODULE));
  const shipped = checkEveryStatusSaysSomething(briefArrival, statuses);
  say(shipped.violations.length === 0, `the shipped briefArrival does not pass its own standard: ${shipped.violations.join("; ")}`);

  // The real pre-fix panel: no not-arrived branch at all.
  const brokenPanel = checkSurfacesUseIt({
    panel: "const report = state.data?.report ?? null;\n{shown.map((s) => renderSection(s))}",
    collapse: "return `${s.report.report_date} — today's brief arrived`;",
  });
  say(brokenPanel.violations.length >= 2, "the real pre-fix panel and collapsed line passed");

  if (failed > 0) process.exit(1);
  console.log(
    `SELF-TEST PASSED: the real pre-fix Workers AI call, the pre-fix 4096 literal, the 60s deadline, the ` +
      `"any row is an arrival" line and the panel with no not-arrived branch are each caught; ` +
      `${shipped.examined} shipped status outcomes and a correct adapter each pass.`,
  );
}

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}

// ── Run ────────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const adapters = Object.fromEntries(
    readdirSync(ADAPTER_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => [path.join("src/worker/ai/providers", f), read(path.join(ADAPTER_DIR, f))]),
  );
  const services = Object.fromEntries(
    readdirSync(SERVICES_DIR)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => [f, read(path.join(SERVICES_DIR, f))]),
  );

  const asks = largestAsk(services);
  const ceiling = declaredCeiling(read(CEILING_FILE));
  const ceilings = checkAdaptersSetACeiling(adapters);
  const deadline = checkDeadlineFitsTheWork({
    timeoutMs: declaredTimeoutMs(read(TIMEOUT_FILE)),
    largestAskTokens: asks.largest,
    stageLeaseMinutes: declaredStageLeaseMinutes(read(BRIEF_SERVICE)),
  });
  const statuses = statusesFromSchema(read(SCHEMA));
  const { briefArrival } = await import(pathToFileUrl(STATE_MODULE));
  const says = checkEveryStatusSaysSomething(briefArrival, statuses);
  const surfaces = checkSurfacesUseIt({ panel: read(PANEL), collapse: read(COLLAPSE) });

  // THE EMPTY-LOOP GUARDS. Every one counts something that must exist: this firm calls model
  // providers, its callers ask for replies of a stated size, its briefs have statuses, and two
  // surfaces show them.
  const empty = [
    ceilings.examined === 0 && `examined 0 model-lane adapters under ${path.relative(ROOT, ADAPTER_DIR)}`,
    asks.examined === 0 && "found 0 callers declaring how long a reply they expect",
    deadline.examined === 0 && "could not read the deadline or the stage lease it must fit inside",
    statuses.length === 0 && "read 0 report statuses out of the schema",
    says.examined === 0 && "ran briefArrival over 0 statuses",
    surfaces.examined === 0 && "read neither the panel nor the collapsed line",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`BRIEF-ARRIVES SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [...ceilings.violations, ...deadline.violations, ...says.violations, ...surfaces.violations];
  if (ceiling === null) {
    violations.push("the shared output ceiling could not be read from outputCeiling.ts");
  } else if (ceiling < asks.largest) {
    violations.push(
      `PROVIDER_MAX_OUTPUT_TOKENS is ${ceiling}, below the largest reply a caller asks for (${asks.largest}). ` +
        "That caller's reply is truncated, and a truncated reply fails its own quality gate for missing " +
        "everything it was cut off before writing.",
    );
  }

  if (violations.length > 0) {
    console.error("BRIEF-ARRIVES SCAN FAILED — a brief could be cut off, or fail without saying so:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nOn 18 Sep 2026 both partners opened Home to a header, a button, '300 items → 283 events → 30");
    console.error("considered', and no brief and no explanation. The reason was on the row the whole time.");
    process.exit(1);
  }

  console.log(
    `BRIEF-ARRIVES SCAN PASSED: ${ceilings.examined} model-lane adapter(s) send an explicit output ceiling of ` +
      `${ceiling}, at or above the largest of ${asks.examined} caller ask(s) (${asks.largest} tokens); the ` +
      `provider deadline fits that ask and still sits inside its stage lease; briefArrival was run over ` +
      `${says.examined} status outcome(s) and only a READY brief with sections claims to have arrived; both ` +
      "surfaces read it.",
  );
}
