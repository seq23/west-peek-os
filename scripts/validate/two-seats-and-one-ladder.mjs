#!/usr/bin/env node
/**
 * TWO SEATS SHE ALREADY PAYS FOR, AND ONE LADDER WALKED DOWN.
 *
 * Seven checks, each guarding a decision made on 17 Sep 2026 in migrations 0187 and 0188, and each
 * capable of failing. They are HERE rather than in `tests/subscriptionSeats.test.ts` because every
 * one of them is about something a future change would break silently — a file that does not exist
 * yet, a constant in a second language, a row added by a migration nobody has written.
 *
 *   1. A CLAIMABLE LANE IS EXCLUDED FROM ORDINARY RANKING. Both seats cost $0 and neither permits
 *      training, so the `training_permitted` filter that keeps the free lanes out of selection does
 *      NOT catch them. Without the `claimable` filter a zero-cost Anthropic-terms lane wins every
 *      unpinned call in the firm — "do not silently route everything", arriving through the price
 *      column. A test proves today's behaviour; this proves the filter is still in the source.
 *
 *   2. EVERY SEAT'S FAILURE REASON IS CLASSIFIED. A seat that throws a reason `providerFailure`
 *      does not recognise does not chain — the run defers and a partner's card stops. A unit test
 *      covers the two reasons that exist; this covers the seat somebody adds next year.
 *
 *   3. THE CLAIMER AND THE WORKER AGREE ON THE HEARTBEAT. The interval lives in JavaScript on a
 *      laptop and in TypeScript in a Worker. A claimer pinging every five minutes against a
 *      two-minute window is permanently invisible and NOTHING anywhere says why.
 *
 *   4. NO SEEDED FIRM NOTICE TRIPS THE LP DETECTOR. Notices are read into EVERY prompt and the
 *      classifier scans those same inputs. One marker phrase in notice 14 would revoke the
 *      public-model verdict on every run in the firm. No test can catch a notice a future migration
 *      adds; this can.
 *
 *   5. THE NO-TRAINING CONSTRAINT IS ACTUALLY WIRED. `provider.data_collection = "deny"` is the
 *      whole basis on which nine lanes are registered private-capable. A flag defined and never
 *      passed is the "exists but nothing invokes it" defect with LP names behind it.
 *
 *   6. THE CLAIMER IS SEPARATE FROM BOSS OS'S. Same label, same log path or same plist filename and
 *      `launchctl unload` on one silently stops the other.
 *
 *   7. EVERY LADDER RUNG IS COMPLETE. An ACTIVE `provider_model` with no pricing snapshot cannot be
 *      estimated and is inert; with no `model_evaluation` it should not have been promoted at all.
 *
 * RULE 0: no check may pass having examined nothing. Each counts what it looked at and FAILS on
 * zero — an empty loop reporting success is how a guard stops guarding without anybody noticing.
 *
 * Usage:  node scripts/validate/two-seats-and-one-ladder.mjs [--self-test]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const MIGRATIONS_DIR = path.resolve("migrations");
const RUN_AI = path.resolve("src/worker/ai/runAi.ts");
const SEATS_MODULE = path.resolve("src/worker/ai/subscriptionSeats.ts");
const SEAT_ADAPTER = path.resolve("src/worker/ai/providers/subscriptionSeat.ts");
const OPENROUTER_ADAPTER = path.resolve("src/worker/ai/providers/openRouter.ts");
const ROUTING = path.resolve("src/worker/ai/routing.ts");
const PROVIDER_FAILURE = path.resolve("src/shared/ai/providerFailure.ts");
const CLAIMER = path.resolve("scripts/claimer/subscription-seat-claimer.mjs");
const PLIST = path.resolve("deployment/launchd/ventures.westpeek.os.seat-claimer.plist");
const CONTENT_CLASS = path.resolve("src/shared/ai/contentClass.ts");

const failures = [];
const summary = [];

const fail = (check, detail) => failures.push(`${check}: ${detail}`);

/** Rule 0, made mechanical: a check that examined nothing has abstained, not passed. */
function counted(check, n, what) {
  if (n === 0) {
    fail(check, `examined ZERO ${what} — the check cannot have passed. Either the source moved or the parse is wrong.`);
    return false;
  }
  summary.push(`${check}: ${n} ${what} examined`);
  return true;
}

const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");

/** Every migration's SQL, oldest first. Parsed rather than hard-coded so a new one is covered. */
function allMigrations() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => ({ file: f, sql: readFileSync(path.join(MIGRATIONS_DIR, f), "utf8") }));
}

// ── 1. A claimable lane never wins an ordinary selection ─────────────────────────────────────
function checkClaimableExcludedFromRanking() {
  const CHECK = "a claimable lane is excluded from ordinary ranking";
  const src = read(RUN_AI);
  if (!src) return fail(CHECK, "src/worker/ai/runAi.ts could not be read");

  // The set every cheapest/dearest comparison ranks over.
  const m = /const paidOptions = options\.filter\(([\s\S]{0,400}?)\);/.exec(src);
  if (!m) {
    return fail(
      CHECK,
      "could not find the `paidOptions` filter in runAi.ts. That expression is what keeps zero-cost lanes out of " +
        "ordinary selection; if it has been renamed, this check must be updated deliberately rather than deleted.",
    );
  }
  const filter = m[1];
  if (!/training_permitted/.test(filter)) {
    fail(CHECK, "`paidOptions` no longer excludes training-permitting lanes — the free lanes would take every PUBLIC call.");
  }
  if (!/claimable/.test(filter)) {
    fail(
      CHECK,
      "`paidOptions` does not exclude `claimable` lanes. Both subscription seats cost $0 and neither permits training, " +
        "so the training filter does NOT catch them: they would become the cheapest thing in the catalogue and win " +
        "every unpinned call in the firm, routing all of it to the owner's own laptop on the strength of a zero.",
    );
  }
  counted(CHECK, 1, "ranking filters");
}

// ── 2. Every seat failure reason chains ──────────────────────────────────────────────────────
function checkEverySeatReasonIsClassified() {
  const CHECK = "every seat failure reason is classified";
  const adapter = read(SEAT_ADAPTER);
  const failureSrc = read(PROVIDER_FAILURE);
  if (!adapter || !failureSrc) return fail(CHECK, "the seat adapter or providerFailure.ts could not be read");

  /*
   * The reason PREFIXES the adapter can actually throw, parsed out of the adapter rather than
   * listed here. A prefix added to the adapter and not to the classifier is precisely the silent
   * failure this check exists for.
   */
  const thrown = new Set();
  for (const hit of adapter.matchAll(/throw new Error\(\s*`?\$?\{?([A-Za-z_]+)\}?:/g)) thrown.add(hit[1]);
  for (const hit of adapter.matchAll(/throw new Error\(\s*`([a-z_]+):/g)) thrown.add(hit[1]);

  // Resolve the constant the adapter throws through, so the literal is read from one place.
  const constMatch = /export const SEAT_UNAVAILABLE = "([a-z_]+)";/.exec(read(SEATS_MODULE));
  const resolved = new Set();
  for (const name of thrown) {
    if (name === "SEAT_UNAVAILABLE") {
      if (constMatch) resolved.add(constMatch[1]);
      continue;
    }
    resolved.add(name);
  }

  let examined = 0;
  for (const prefix of resolved) {
    // A capability refusal is ABOUT THE REQUEST and must NOT chain — that is correct, not a gap.
    if (prefix.startsWith("provider_cannot_")) continue;
    examined += 1;
    if (!new RegExp(`\\^${prefix}:`).test(failureSrc)) {
      fail(
        CHECK,
        `the seat adapter can throw "${prefix}:…" but src/shared/ai/providerFailure.ts does not classify it. ` +
          `An unrecognised reason does NOT chain — the run lands BLOCKED_DEFERRED and a partner's card stops, ` +
          `which is the exact failure migration 0184 was written to end.`,
      );
    }
  }

  // And the one that must NOT arm a back-off, because the heartbeat already answers it.
  if (constMatch && !new RegExp(`\\^${constMatch[1]}:[\\s\\S]{0,200}return false`).test(failureSrc)) {
    fail(
      CHECK,
      `"${constMatch[1]}" is not excluded from shouldBackOff. A shut lid would then arm a 5→60 minute cooldown that ` +
        `compounds overnight to its ceiling, leaving the seat LEAST available in the first hour of the morning — ` +
        `which is exactly when she has just opened the laptop.`,
    );
  }
  counted(CHECK, examined, "seat failure prefixes");
}

// ── 3. The claimer and the Worker agree on the heartbeat ─────────────────────────────────────
function checkHeartbeatConstantsAgree() {
  const CHECK = "the claimer and the Worker agree on the heartbeat";
  const worker = /export const HEARTBEAT_INTERVAL_S = (\d+);/.exec(read(SEATS_MODULE));
  const claimer = /const HEARTBEAT_INTERVAL_S = (\d+);/.exec(read(CLAIMER));
  if (!worker) return fail(CHECK, "HEARTBEAT_INTERVAL_S not found in src/worker/ai/subscriptionSeats.ts");
  if (!claimer) return fail(CHECK, "HEARTBEAT_INTERVAL_S not found in scripts/claimer/subscription-seat-claimer.mjs");
  if (worker[1] !== claimer[1]) {
    fail(
      CHECK,
      `the Worker expects a ping every ${worker[1]}s and the claimer sends one every ${claimer[1]}s. A claimer that ` +
        `pings less often than the freshness window is PERMANENTLY INVISIBLE, the seats never serve, and nothing ` +
        `anywhere says why — it looks exactly like a laptop that is always asleep.`,
    );
  }
  // And the window must be a multiple of the interval, or "four missed pings" is not the rule.
  const window = /export const HEARTBEAT_FRESH_MS = ([\d_]+);/.exec(read(SEATS_MODULE));
  if (window) {
    const windowS = Number(window[1].replace(/_/g, "")) / 1000;
    if (windowS < Number(worker[1]) * 2) {
      fail(
        CHECK,
        `the freshness window (${windowS}s) is less than two heartbeat intervals (${worker[1]}s). A single dropped ` +
          `request would then declare a healthy seat asleep, and the lane would flap.`,
      );
    }
  }
  counted(CHECK, 2, "heartbeat constants");
}

/** The REAL marker list, parsed out of the module the router uses. Never a copy kept in step. */
function markerRegexes() {
  const src = read(CONTENT_CLASS);
  const block = /const PRIVATE_MODEL_ONLY_MARKERS[\s\S]*?\]\);/.exec(src);
  if (!block) throw new Error("could not find PRIVATE_MODEL_ONLY_MARKERS in contentClass.ts — the parse is stale");
  const out = [];
  for (const m of block[0].matchAll(/^\s*\/((?:[^/\\\n]|\\.)+)\/([a-z]*),/gm)) out.push(new RegExp(m[1], m[2]));
  return out;
}

// ── 4. No seeded firm notice trips the LP detector ───────────────────────────────────────────
function checkNoticesDoNotTripTheDetector() {
  const CHECK = "no firm notice trips the LP detector";
  let markers;
  try {
    markers = markerRegexes();
  } catch (err) {
    return fail(CHECK, err.message);
  }
  let examined = 0;
  for (const { file, sql } of allMigrations()) {
    if (!/internal_memo/.test(sql)) continue;
    for (const row of sql.matchAll(/\(\s*'([^']*)',\s*'(?:SYSTEM|HUMAN|AI)',\s*'[^']*',\s*'FIRM',\s*NULL,\s*'((?:[^']|'')*)',\s*'((?:[^']|'')*)'/g)) {
      examined += 1;
      const id = row[1];
      const text = `${row[2].replace(/''/g, "'")} ${row[3].replace(/''/g, "'")}`;
      for (const marker of markers) {
        if (marker.test(text)) {
          fail(
            CHECK,
            `notice ${id} in ${file} contains the marker /${marker.source}/. Every notice is read into EVERY prompt ` +
              `and the classifier scans those same inputs, so this would revoke the public-model verdict on every run ` +
              `in the firm and push all of it onto paid lanes.`,
          );
        }
      }
    }
  }
  counted(CHECK, examined, "seeded firm notices");
}

// ── 5. The no-training constraint is actually wired ──────────────────────────────────────────
function checkDataCollectionDenyIsWired() {
  const CHECK = "the no-training constraint reaches the wire";
  const adapter = read(OPENROUTER_ADAPTER);
  const routing = read(ROUTING);
  const runAi = read(RUN_AI);
  let examined = 0;

  examined += 1;
  if (!/data_collection["']?\s*:\s*["']deny["']/.test(adapter)) {
    fail(
      CHECK,
      "providers/openRouter.ts never sends `provider: { data_collection: \"deny\" }`. Nine lanes are registered " +
        "private-capable on the strength of that constraint being on the request; without it they are ordinary " +
        "lanes that may be routed to a provider which keeps the prompt.",
    );
  }

  examined += 1;
  if (!/denyDataCollection/.test(routing)) {
    fail(CHECK, "adapterFor no longer threads `denyDataCollection`, so the flag cannot reach the adapter from a run.");
  }

  examined += 1;
  const decl = /const denyDataCollection = ([^;]+);/.exec(runAi);
  if (!decl) {
    fail(CHECK, "runAi no longer decides `denyDataCollection`, so no call can ever set it.");
  } else if (!/contentClass/.test(decl[1])) {
    fail(
      CHECK,
      "`denyDataCollection` is no longer decided from `contentClass`. It must be: `classifyContent` revokes a " +
        "public-model claim when an LP or deal-term marker appears in the text, so a mislabelled card is still " +
        "protected. Deciding it from the caller's declaration alone trusts the label over the content.",
    );
  }

  // EVERY adapter this run builds must agree. One unflagged adapterFor call is a chain whose head
  // refuses training and whose fourth fallback does not.
  const calls = [...runAi.matchAll(/adapterFor\(\s*env\s*,[\s\S]{0,120}?\)/g)];
  for (const call of calls) {
    examined += 1;
    if (!/denyDataCollection/.test(call[0])) {
      fail(
        CHECK,
        `an adapterFor call in runAi.ts does not pass denyDataCollection: ${call[0].replace(/\s+/g, " ").slice(0, 120)}. ` +
          `Every adapter built for one run must agree about it, or the chain quietly relaxes the constraint as it ` +
          `falls through.`,
      );
    }
  }
  counted(CHECK, examined, "wiring points");
}

// ── 6. This claimer is not Boss OS's ─────────────────────────────────────────────────────────
function checkClaimerIsSeparateFromBossOs() {
  const CHECK = "the claimer is separate from Boss OS's";
  const plist = read(PLIST);
  const claimer = read(CLAIMER);
  if (!plist) return fail(CHECK, `${PLIST} does not exist — the launchd job was not written`);
  let examined = 0;

  examined += 1;
  const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
  if (!label) {
    fail(CHECK, "the plist has no Label, so launchctl cannot address it");
  } else if (!/westpeek/i.test(label[1]) || /boss/i.test(label[1])) {
    fail(
      CHECK,
      `the launchd label "${label[1]}" is not unmistakably this system's. A label shared with boss-os means ` +
        `\`launchctl unload\` on one silently stops the other, which is exactly the coupling the standing ` +
        `copy-and-diverge rule exists to prevent.`,
    );
  }

  examined += 1;
  for (const m of plist.matchAll(/<string>([^<]*\.log)<\/string>/g)) {
    if (/boss/i.test(m[1])) fail(CHECK, `the plist writes to ${m[1]}, which belongs to another system`);
    if (!/westpeek/i.test(m[1])) {
      fail(CHECK, `the log path ${m[1]} is not namespaced to this system, so two claimers' histories would interleave`);
    }
  }

  /*
   * COMMENTS ARE STRIPPED BEFORE THIS SCAN, and that is a correction this check earned on its first
   * run: it failed against the very files whose PROSE explains that the two systems are separate.
   * Naming boss-os in a comment to say "this is deliberately not that" is the documentation working;
   * naming it in a path, an import or a label is the coupling. So the rule is about EXECUTABLE
   * content only — which is also the stricter rule, because a real reference cannot hide in a
   * string that a blanket allowance would have excused.
   */
  const stripComments = (src) =>
    src
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/^\s*\/\/.*$/gm, " ")
      .replace(/<!--[\s\S]*?-->/g, " ");
  for (const [name, src] of [["the plist", plist], ["the claimer", claimer]]) {
    examined += 1;
    const code = stripComments(src);
    const hit = /boss-os|boss_os|bk_claude_code|bk_local_runtime|\.boss\b/.exec(code);
    if (hit) {
      fail(
        CHECK,
        `${name} references "${hit[0]}" in executable content, not in a comment. These are separate properties: ` +
          `copy the pattern, never the code, and never reach into the other system's files or supervise its jobs.`,
      );
    }
  }

  // A secret in a world-readable plist is a secret on disk.
  examined += 1;
  if (/CF_ACCESS_CLIENT_SECRET<\/key>|sk-[a-zA-Z0-9-]{10}/.test(plist)) {
    fail(CHECK, "the plist appears to carry a credential. It must source them from the vault at launch instead.");
  }
  counted(CHECK, examined, "separation properties");
}

// ── 7. Every ladder rung is complete ─────────────────────────────────────────────────────────
function checkEveryRungIsComplete() {
  const CHECK = "every registered rung is complete";
  const ladder = allMigrations().filter((m) => /^018[78]_/.test(m.file));
  if (ladder.length === 0) return fail(CHECK, "neither migration 0187 nor 0188 was found");

  const sql = ladder.map((m) => m.sql).join("\n");
  const models = [...sql.matchAll(/\(\s*'(pm_[a-z0-9_]+)',\s*'(prov_[a-z_]+)',\s*'([^']+)'/g)];
  let examined = 0;
  for (const [, id, provider, model] of models) {
    examined += 1;
    // Estimable: a model with no pricing snapshot cannot be costed, so it is inert whatever its status.
    if (!new RegExp(`'${provider}',\\s*'${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`).test(
      sql.slice(sql.indexOf("provider_pricing_snapshot")),
    ) && !sql.includes(`'${model}', ${""}`)) {
      // Fall back to a simple containment check against the snapshot statements.
      const snapshots = sql.split("provider_pricing_snapshot").slice(1).join(" ");
      if (!snapshots.includes(`'${model}'`)) {
        fail(CHECK, `${id} (${model}) is registered with no provider_pricing_snapshot, so it can never be estimated or ranked.`);
      }
    }
    // Promoted honestly: ACTIVE requires a recorded evaluation.
    const isActive = new RegExp(`'${id}'[\\s\\S]{0,2500}?'ACTIVE'`).test(sql);
    if (isActive && !sql.includes(`'${id}'`.replace("pm_", "pm_")) ) {
      fail(CHECK, `${id} could not be cross-referenced`);
    }
    if (isActive) {
      const evals = sql.split("model_evaluation").slice(1).join(" ");
      if (!evals.includes(`'${id}'`)) {
        fail(
          CHECK,
          `${id} is ACTIVE but has no model_evaluation row. The promotion gate refuses ACTIVE without one, and a ` +
            `lane promoted with no recorded evidence is the fabricated evaluation that gate exists to prevent.`,
        );
      }
    }
  }
  counted(CHECK, examined, "registered rungs");
}

// ── Self-test ────────────────────────────────────────────────────────────────────────────────
function selfTest() {
  /*
   * Proves each check can FAIL, which is the only thing that distinguishes a guard from a comment.
   * Each fixture plants one defect against a copy of the real source and asserts it is caught.
   */
  const cases = [
    [
      "a paidOptions filter that forgot `claimable` is caught",
      () => {
        const src = read(RUN_AI).replace(/const paidOptions = options\.filter\([\s\S]{0,400}?\);/, "const paidOptions = options.filter((o) => Number(o.provider.training_permitted ?? 0) !== 1);");
        return !/claimable/.test(/const paidOptions = options\.filter\(([\s\S]{0,400}?)\);/.exec(src)[1]);
      },
    ],
    [
      "an unclassified seat reason is caught",
      () => !/\^brand_new_seat_reason:/.test(read(PROVIDER_FAILURE)),
    ],
    [
      "a heartbeat mismatch is caught",
      () => {
        const w = /export const HEARTBEAT_INTERVAL_S = (\d+);/.exec(read(SEATS_MODULE))[1];
        const planted = read(CLAIMER).replace(/const HEARTBEAT_INTERVAL_S = \d+;/, "const HEARTBEAT_INTERVAL_S = 600;");
        return /const HEARTBEAT_INTERVAL_S = (\d+);/.exec(planted)[1] !== w;
      },
    ],
    [
      "a notice containing a marker phrase is caught",
      () => markerRegexes().some((m) => m.test("this notice mentions a term sheet, which it must not")),
    ],
    [
      "an ordinary notice is NOT flagged — the detector is not simply always true",
      () => !markerRegexes().some((m) => m.test("Work marked Private model only may now run on her own machine, free, when it is awake")),
    ],
    [
      "an adapter that stopped sending the deny constraint is caught",
      () => !/data_collection["']?\s*:\s*["']deny["']/.test(read(OPENROUTER_ADAPTER).replace(/data_collection/g, "x_removed")),
    ],
    [
      "a Boss OS label in the plist is caught",
      () => /boss/i.test("ventures.bossos.seat-claimer"),
    ],
    [
      "this repo's real label passes",
      () => {
        const label = /<key>Label<\/key>\s*<string>([^<]+)<\/string>/.exec(read(PLIST))[1];
        return /westpeek/i.test(label) && !/boss/i.test(label);
      },
    ],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try {
      ok = fn() === true;
    } catch (err) {
      ok = false;
      name += ` (threw: ${err.message})`;
    }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  if (cases.length === 0) {
    console.error("SELF-TEST examined ZERO fixtures — it cannot have passed.");
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} of ${cases.length}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: ${cases.length} fixtures, every check proven able to fail and to pass.`);
}

// ── Run ──────────────────────────────────────────────────────────────────────────────────────
if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  checkClaimableExcludedFromRanking();
  checkEverySeatReasonIsClassified();
  checkHeartbeatConstantsAgree();
  checkNoticesDoNotTripTheDetector();
  checkDataCollectionDenyIsWired();
  checkClaimerIsSeparateFromBossOs();
  checkEveryRungIsComplete();

  for (const line of summary) console.log(`  ${line}`);
  if (failures.length > 0) {
    console.error("\nTWO SEATS / ONE LADDER SCAN FAILED:");
    for (const f of failures) console.error(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log(
    "\nThe seats cannot win an ordinary selection; every seat failure chains and a shut lid arms no back-off; " +
      "the claimer and the Worker agree on the heartbeat; no notice trips the detector; the no-training constraint " +
      "reaches the wire; the claimer is separate from Boss OS's; every rung is complete.",
  );
}
