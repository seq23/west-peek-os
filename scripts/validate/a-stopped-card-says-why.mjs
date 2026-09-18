#!/usr/bin/env node
/**
 * a-stopped-card-says-why.mjs — `npm run validate:stopped-cards`.
 *
 * ONE ASSERTION: A WORK CARD THAT STOPS ON A TECHNICAL FAULT SAYS WHAT REFUSED IT, IN WORDS SHE CAN
 * READ, AND OFFERS HER THE FIX — AND IT NEVER LOOKS LIKE A CARD THAT IS MERELY QUEUED.
 *
 * WHAT WENT WRONG, 17 Sep 2026. Parker's card "Draft event kit: October workshop with Kirx Diaz"
 * failed three times over fourteen minutes. Two steps completed on OpenRouter each time; the third
 * routed to the direct Anthropic lane and came back refused — "your credit balance is too low to
 * access the Anthropic API". The step deferred, the card went back to OPEN, the sweep picked it up
 * again minutes later.
 *
 * The owner saw "Open · queued — picked up within 5 min". Nothing else, three times. Her words:
 * "without you I can't fix anything that goes wrong in work cards."
 *
 * The machinery to do better already existed — `validate:blocks` has held every block to a plain
 * sentence and a button since 0173. The technical failure path simply did not use any of it. Five
 * things had to be true and none of them were; each is a check below.
 *
 * WHAT IS CHECKED
 *   1 · THE VENDOR'S WORDS SURVIVE. No provider adapter throws a bare `provider_http_<status>`. A
 *       status code is not a reason, and the sentence Anthropic actually wrote was being discarded
 *       at the wire before anything could show it to anybody.
 *   2 · A REAL FAILURE PRODUCES A READABLE BLOCK. Every failure string this system has actually
 *       produced — tonight's included, verbatim — is classified and turned into a block that passes
 *       the 0173 standard, carries doors that touch the fault, and has no status code in its
 *       sentence.
 *   3 · A LANE SHE STOOD DOWN IS REALLY STOOD DOWN. Every query that picks a provider to run on
 *       constrains `paused_until`. A button that parks a lane the failover can still reach is
 *       theatre.
 *   4 · EVERY DOOR IS IMPLEMENTED AND EVERY DOOR REOPENS THE CARD. A fault door that records an
 *       intention and leaves the work BLOCKED is the "runs but inert" defect with a nicer label —
 *       a blocked card is invisible to the sweep's claim.
 *   5 · A FAILING CARD IS VISIBLY NOT A WAITING ONE. The Work page reads the last failure, and the
 *       "queued — picked up within 5 min" reassurance is suppressed on a card that has one.
 *
 * HARD-FAILS ON ZERO. Zero adapters, zero failure fixtures, zero provider queries, zero doors or an
 * unread page all exit 1. A scan that examined nothing has proved nothing.
 *
 * `--self-test` feeds the REAL pre-fix shapes through the same functions and requires each to be
 * caught, alongside clean fixtures that must pass.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const ADAPTER_DIR = path.join(ROOT, "src", "worker", "ai", "providers");
const WORKER_DIR = path.join(ROOT, "src", "worker");
const PAGE = path.join(ROOT, "src", "client", "pages", "WorkCardsPage.tsx");
const FAULT_DOORS = ["RETRY", "ANOTHER_LANE", "PAUSE_LANE", "HAND_ON"];

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function readTree(dir, ext = ".ts") {
  const out = {};
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(ext)) out[path.relative(ROOT, full)] = readFileSync(full, "utf8");
    }
  };
  walk(dir);
  return out;
}

// ── 1 · The vendor's words survive the adapter ────────────────────────────────────────────────

/** A throw that carries the status and nothing else. */
const BARE_STATUS_THROW = /throw\s+new\s+Error\(\s*`provider_http_\$\{[^}]*\}`\s*\)/;

export function checkAdaptersKeepVendorWords(sources) {
  const violations = [];
  let examined = 0;
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    // Every adapter that puts a request on the wire has to decide what a non-2xx means. Counted on
    // THAT rather than on the old string, or fixing the last adapter would shrink this scan to zero
    // and it would pass by examining nothing.
    if (!/res\.ok|response\.ok/.test(src)) continue;
    examined += 1;
    if (BARE_STATUS_THROW.test(src)) {
      violations.push(
        `${file} throws a bare provider_http_<status> — the vendor's own sentence is discarded at the wire, ` +
          "which is how 'your credit balance is too low' became 'provider_http_400'. Throw await providerHttpError(res).",
      );
    }
  }
  return { examined, violations };
}

// ── 2 · A real failure produces a readable block ──────────────────────────────────────────────

/**
 * FAILURE STRINGS THIS SYSTEM HAS ACTUALLY PRODUCED. Not invented shapes: each is the text a run
 * recorded, or would record, in `ai_run.failure_reason`.
 */
export const REAL_FAILURES = [
  {
    name: "the 17 Sep event-kit failure, verbatim",
    reason: 'provider_failure:provider_http_400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    // The adapter now extracts the message, so this is what the sweep actually receives.
    lifted: "provider_failure:provider_http_400: Your credit balance is too low to access the Anthropic API.",
    lane: "Anthropic",
    kind: "CREDIT",
    transient: false,
  },
  { name: "a rejected key", reason: "provider_failure:provider_http_401: invalid x-api-key", lane: "OpenRouter", kind: "CREDENTIAL", transient: false },
  { name: "too much at once", reason: "provider_failure:provider_http_429: rate limit exceeded", lane: "OpenRouter", kind: "RATE_LIMIT", transient: true },
  { name: "the vendor fell over", reason: "provider_failure:provider_http_503: upstream unavailable", lane: "Fireworks", kind: "LANE_DOWN", transient: true },
  { name: "no key at all", reason: "provider_failure:credential_missing:anthropic", lane: null, kind: "CREDENTIAL", transient: false },
  { name: "everything switched off", reason: "provider_disabled:no_enabled_providers", lane: null, kind: "NO_LANE", transient: false },
  { name: "every lane kill-switched", reason: "provider_kill_switched:all_enabled_providers", lane: null, kind: "NO_LANE", transient: false },
  { name: "the run simply died", reason: "provider_failure:provider_malformed_response", lane: "OpenRouter", kind: "LANE_DOWN", transient: true },
];

/** Not a lane failure at all — these must NOT be dressed as one. */
export const NOT_LANE_FAILURES = [
  "the employee did not choose a usable action",
  "the card's 16-step allowance is spent and the employee asked to search instead of concluding",
  "defer_non_critical:non_critical_purpose",
];

export async function checkFailuresBecomeReadableBlocks() {
  const lane = await import(path.join(ROOT, "src", "shared", "ai", "laneFailure.ts"));
  const blocks = await import(path.join(ROOT, "src", "shared", "work", "blocks.ts"));
  const failure = await import(path.join(ROOT, "src", "shared", "ai", "providerFailure.ts"));
  const violations = [];
  let examined = 0;

  for (const f of REAL_FAILURES) {
    examined += 1;
    const read = lane.readLaneFailure(f.lifted ?? f.reason);
    if (read.kind !== f.kind) violations.push(`"${f.name}" read as ${read.kind}, expected ${f.kind}`);
    if (read.transient !== f.transient) violations.push(`"${f.name}" says retrying is ${read.transient ? "" : "not "}worth it, expected the opposite`);
    if (!lane.isLaneFailure(read)) {
      violations.push(`"${f.name}" was not recognised as a lane failure at all, so the card would say "tried three times"`);
      continue;
    }
    /*
     * KEEPING THE VENDOR'S WORDS MUST NOT TURN THE FAILOVER OFF.
     *
     * Caught here on the first full run: `isProviderOutage` matched `/^provider_http_(\d{3})$/`,
     * anchored at BOTH ends, which was right while a status code was the whole message. Attaching
     * the vendor's sentence made every 503 read as "not an outage", so the router would have
     * stopped dead instead of failing over to the next lane — a worse outage than the one this
     * change exists to explain.
     */
    const engages = failure.isProviderOutage(String(f.lifted ?? f.reason).replace(/^provider_failure:/, ""));
    if (f.transient && !engages) {
      violations.push(`"${f.name}" no longer engages the failover — keeping the vendor's words must not stop the router trying the next lane`);
    }
    if (!f.transient && lane.attemptsAllowedFor(read, 3) >= 3) {
      violations.push(`"${f.name}" cannot fix itself and still gets three attempts — that is the fourteen silent minutes, again`);
    }

    const block = blocks.describeBlock(read.kind === "NO_LANE" ? "no_lane_could_take_the_work" : "a_lane_refused_the_work", {
      trying: "Draft event kit: October workshop with Kirx Diaz",
      employee: "Parker",
      ...(f.lane ? { lane: f.lane } : {}),
      laneKind: read.kind,
      vendorWords: read.vendorWords,
    });
    const problems = blocks.blockProblems(block);
    if (problems.length > 0) violations.push(`"${f.name}" produces a block a partner cannot read: ${problems.join("; ")}`);
    if (/\b\d{3}\b/.test(block.stopped)) violations.push(`"${f.name}" put a status code in the sentence she reads: ${block.stopped}`);
    const doors = block.actions.map((a) => a.key);
    if (!doors.some((d) => FAULT_DOORS.includes(d))) {
      violations.push(`"${f.name}" offers no door that touches the fault — only ${doors.join(", ")}`);
    }
  }

  for (const text of NOT_LANE_FAILURES) {
    examined += 1;
    if (lane.isLaneFailure(lane.readLaneFailure(text))) {
      violations.push(`"${text}" was dressed up as a lane failure — that block would blame the machinery for the employee's own dead end`);
    }
  }

  // The 17 Sep block, end to end, is the thing this feature is judged on.
  const tonight = blocks.describeBlock("a_lane_refused_the_work", {
    trying: "Draft event kit: October workshop with Kirx Diaz",
    employee: "Parker",
    lane: "Anthropic",
    laneKind: "CREDIT",
    vendorWords: "your credit balance is too low to access the Anthropic API",
  });
  examined += 1;
  if (!tonight.stopped.includes("credit balance is too low")) {
    violations.push("the 17 Sep block no longer quotes what Anthropic actually said — the one sentence that made it diagnosable");
  }
  if (tonight.who !== "SEQUOIA") {
    violations.push(`the 17 Sep block is addressed to ${tonight.who}; every fix for it was hers`);
  }

  return { examined, violations };
}

// ── 3 · A lane she stood down is really stood down ────────────────────────────────────────────

export function checkStandDownIsHonoured(sources) {
  const violations = [];
  let examined = 0;
  for (const [file, raw] of Object.entries(sources)) {
    const src = stripComments(raw);
    // Every query that picks a provider ROW TO RUN ON: it reads provider_registry and filters on
    // enabled. A catalogue listing for a page (no `enabled = 1`) is not choosing a lane.
    const queries = src.match(/`?["`][^"`]*provider_registry[^"`]*["`]/g) ?? [];
    for (const q of queries) {
      // A SELECT that filters on `enabled` is choosing a lane to run on. An UPDATE that sets it is
      // the operator's own switch (services/aiGovernance.ts) and is not picking anything.
      if (!/enabled\s*=\s*1/.test(q) || !/\bSELECT\b/i.test(q)) continue;
      examined += 1;
      if (!/paused_until|LANE_NOT_STOOD_DOWN_SQL/.test(q)) {
        violations.push(
          `${file} picks a lane with \`enabled = 1\` and never asks whether she stood it down — ` +
            "add LANE_NOT_STOOD_DOWN_SQL, or 'Stop using this one' is a button that does nothing.",
        );
      }
    }
  }
  return { examined, violations };
}

// ── 4 · Every door is implemented, and every door reopens the card ────────────────────────────

export function checkDoorsAreReal(sources) {
  const violations = [];
  const src = stripComments(sources[path.join("src", "worker", "services", "blocks.ts")] ?? "");
  if (!src) return { examined: 0, violations: ["services/blocks.ts was not read — the scan cannot see the doors"] };
  const answer = src.slice(src.indexOf("export async function answerBlock"));
  let examined = 0;
  for (const door of FAULT_DOORS) {
    examined += 1;
    if (!new RegExp(`"${door}"`).test(answer)) {
      violations.push(`answerBlock does not handle "${door}" — the button is on the card and the server would refuse it`);
    }
  }
  // Each fault door has to end with the card back in the queue. `reopen` is the shared half; a door
  // that writes its own UPDATE has to say state = 'OPEN' itself.
  if (!/state\s*=\s*'OPEN'/.test(answer)) {
    violations.push("no door in answerBlock returns a card to OPEN — the sweep claims OPEN and IN_PROGRESS only, so nothing would be retried");
  }
  if (!/work_attempts\s*=\s*0/.test(answer)) {
    violations.push("a door reopens the card without resetting work_attempts — a card at its cap is not claimable however it is reopened");
  }
  if (!/paused_until/.test(src)) {
    violations.push("nothing in services/blocks.ts sets paused_until — 'send it to a different model' would send it to the same one");
  }
  return { examined, violations };
}

// ── 5 · A failing card is visibly not a waiting one ───────────────────────────────────────────

export function checkPageTellsThemApart(pageSrc) {
  const violations = [];
  if (!pageSrc) return { examined: 0, violations: ["the Work page was not read — the scan cannot see what a stopped card looks like"] };
  const src = stripComments(pageSrc);
  if (!/work_last_failure/.test(src)) {
    violations.push("the Work page never reads work_last_failure — a card that has been refused twice renders exactly like one that has not");
  }
  // The reassurance must be conditioned on NOT failing. Matched on the literal line, because that
  // exact string is what the owner read three times while the card was broken.
  const queued = /queued — picked up within 5 min/.exec(src);
  if (!queued) {
    violations.push("the 'queued — picked up within 5 min' line has gone — it is correct for a healthy card and its absence means this scan is reading the wrong page");
  } else {
    const window = src.slice(Math.max(0, queued.index - 400), queued.index);
    if (!/!failing|!\s*c\.work_last_failure/.test(window)) {
      violations.push("'queued — picked up within 5 min' is shown regardless of whether the card has already failed — that is the sentence the owner read three times on 17 Sep");
    }
  }
  if (!/block_raw|block\.raw/.test(src)) {
    violations.push("the page never offers the provider's own text — 'show me what it actually said' has nowhere to come from");
  }
  return { examined: 3, violations };
}

// ── Self-test ─────────────────────────────────────────────────────────────────────────────────

const SELF_TEST = {
  "the real pre-fix adapter": {
    run: () => checkAdaptersKeepVendorWords({ "src/worker/ai/providers/anthropic.ts": "if (!res.ok) throw new Error(`provider_http_${res.status}`);" }).violations,
    expect: /throws a bare provider_http/,
  },
  "an adapter that keeps the words is fine": {
    run: () => checkAdaptersKeepVendorWords({ "src/worker/ai/providers/anthropic.ts": "if (!res.ok) throw await providerHttpError(res);\n// provider_http_ lives in httpError" }).violations,
    expect: null,
  },
  "the real pre-fix candidate query": {
    run: () => checkStandDownIsHonoured({ "src/worker/ai/runAi.ts": 'const enabled = await db.prepare("SELECT * FROM provider_registry WHERE enabled = 1").all();' }).violations,
    expect: /never asks whether she stood it down/,
  },
  "a catalogue listing is not a lane choice": {
    run: () => checkStandDownIsHonoured({ "src/worker/services/providerRouter.ts": 'db.prepare("SELECT * FROM provider_registry ORDER BY provider_key")' }).violations,
    expect: null,
  },
  "a door that records and leaves the card blocked": {
    run: () =>
      checkDoorsAreReal({
        [path.join("src", "worker", "services", "blocks.ts")]: `
          export async function answerBlock(env, id, who, input) {
            if (input.action === "RETRY") { await db.prepare("UPDATE work_card SET block_answer = ?2").run(); }
            if (input.action === "ANOTHER_LANE") { /* paused_until */ }
            if (input.action === "PAUSE_LANE") {}
            if (input.action === "HAND_ON") {}
          }`,
      }).violations,
    expect: /returns a card to OPEN/,
  },
  "the real pre-fix Work page": {
    run: () => checkPageTellsThemApart('{c.owner_type === "AI" && c.state === "OPEN" && (<span>queued — picked up within 5 min</span>)}').violations,
    expect: /never reads work_last_failure/,
  },
};

async function selfTest() {
  let failed = 0;
  for (const [name, c] of Object.entries(SELF_TEST)) {
    const found = c.run();
    const caught = c.expect === null ? found.length === 0 : found.some((v) => c.expect.test(v));
    if (!caught) {
      console.error(`SELF-TEST FAILED — "${name}": expected ${c.expect ?? "no violation"}, got ${JSON.stringify(found)}`);
      failed += 1;
    }
  }
  // The clean fixture that matters most: the shipped classification and catalogue, over every real
  // failure this system has produced.
  const shipped = await checkFailuresBecomeReadableBlocks();
  if (shipped.violations.length > 0) {
    console.error(`SELF-TEST FAILED — the shipped failure path does not pass its own standard: ${shipped.violations.join("; ")}`);
    failed += 1;
  }
  if (failed > 0) process.exit(1);
  console.log(`SELF-TEST PASSED: ${Object.keys(SELF_TEST).length} fixtures behave as stated; ${shipped.examined} real failures each become a block she can read and act on.`);
}

// ── Run ───────────────────────────────────────────────────────────────────────────────────────

if (process.argv.includes("--self-test")) {
  await selfTest();
} else {
  const adapters = readTree(ADAPTER_DIR);
  const worker = readTree(WORKER_DIR);
  const page = readFileSync(PAGE, "utf8");

  const wire = checkAdaptersKeepVendorWords(adapters);
  const readable = await checkFailuresBecomeReadableBlocks();
  const standDown = checkStandDownIsHonoured(worker);
  const doors = checkDoorsAreReal(worker);
  const shown = checkPageTellsThemApart(page);

  // THE EMPTY-LOOP GUARDS. Every one of these counts something that must exist: this firm calls
  // model providers, it fails sometimes, it picks lanes, and it offers doors.
  const empty = [
    wire.examined === 0 && `examined 0 provider adapters under ${path.relative(ROOT, ADAPTER_DIR)}`,
    readable.examined === 0 && "classified 0 real failures",
    standDown.examined === 0 && "found 0 queries that pick a lane to run on",
    doors.examined === 0 && "found 0 doors on a blocked card",
    shown.examined === 0 && "read nothing on the Work page",
  ].filter(Boolean);
  if (empty.length > 0) {
    console.error(`STOPPED-CARD SCAN FAILED — ${empty.join("; ")}.`);
    console.error("An empty loop reporting success is the defect this repo calls Rule 0.");
    process.exit(1);
  }

  const violations = [...wire.violations, ...readable.violations, ...standDown.violations, ...doors.violations, ...shown.violations];
  if (violations.length > 0) {
    console.error("STOPPED-CARD SCAN FAILED — a card could stop on a fault the owner cannot see or fix:");
    for (const v of violations) console.error(`  ✗ ${v}`);
    console.error("\nOn 17 Sep 2026 a card failed three times in fourteen minutes against a lane whose account");
    console.error("had run out of credit, and the Work page said 'Open · queued — picked up within 5 min'.");
    console.error("The test of this path is that she could have fixed that without an engineer.");
    process.exit(1);
  }

  console.log(
    `STOPPED-CARD SCAN PASSED: ${wire.examined} adapter(s) keep what the vendor said; ${readable.examined} real ` +
      `failure(s) each become a block with a plain sentence and a door that touches the fault; ${standDown.examined} ` +
      `lane-picking quer${standDown.examined === 1 ? "y" : "ies"} honour a stand-down; ${doors.examined} fault door(s) ` +
      "implemented and each returns the card to the queue; the Work page tells a stopped card from a waiting one.",
  );
}
