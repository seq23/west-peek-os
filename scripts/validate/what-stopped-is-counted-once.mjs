#!/usr/bin/env node
/**
 * WHAT STOPPED IS COUNTED ONCE, AND THE POSTURE ON SCREEN IS THE ONE THAT ROUTES.
 *
 * Two defects found on 18 Sep 2026, both on the single line the owner reads first:
 *
 *   "$0.1768 of $2.5 cap · NORMAL/FRONTIER · 2 blocked run(s)"
 *
 *   1. NORMAL/FRONTIER was `budget_policy.cost_mode` + `privacy_mode`. `cost_mode` is DERIVED from
 *      the spend lever by runAi and never read back; `privacy_mode` is about privacy. Neither is
 *      the posture the router was in — MODERATE lever, CAUTIOUS gradient, free-first already on.
 *   2. "2 blocked run(s)" came from a hand-typed list of five statuses that omitted
 *      PREFLIGHT_BLOCKED (every named stop the spend lever raises) and FAILED, while the Cockpit
 *      counted "anything not committed". Same words, two populations.
 *
 * A comment saying "keep these in step" is a wish. This reads the CHECK constraint out of the
 * migration and fails the build when the status list in code drifts from the schema, and fails the
 * build when a surface hand-types a status list or prints cost_mode as a posture.
 *
 * HARD-FAILS ON ZERO. If it cannot find the constraint, or finds no surface to check, that is a
 * failure and not a pass — an empty loop is the defect this repo has shipped twice.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { stripCommentsFor } from "./lib/strip-comments.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const SCHEMA = join(ROOT, "migrations/0004_ai_cost_privacy.sql");
const SPEND = join(ROOT, "src/worker/ai/spend.ts");
/** Every surface that puts a stopped-run count or a spend posture on a screen. */
const SURFACES = [
  "src/worker/services/mpHome.ts",
  "src/worker/services/costCenter.ts",
  "src/client/pages/HomePage.tsx",
];
/** A reason the server computes and no screen renders is the same defect wearing different clothes. */
const REASON_PRODUCER = "src/worker/services/providerRouter.ts";
const REASON_CONSUMER = "src/client/pages/AiOpsPage.tsx";

const failures = [];
let checked = 0;

function fail(msg) {
  failures.push(msg);
}

/** The statuses `ai_run.status` may hold, read from the migration that declares them. */
function statusesFromSchema(sql) {
  const m = /ai_run\b[\s\S]*?status\s+TEXT NOT NULL\s*CHECK \(status IN \(([^)]*)\)\)/.exec(sql);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^'|'$/g, "")).filter(Boolean);
}

/** The exported list in spend.ts. */
function statusesFromCode(ts) {
  const m = /export const AI_RUN_STATUSES = \[([\s\S]*?)\] as const;/.exec(ts);
  if (!m) return null;
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

export function check({ schemaSql, spendTs, surfaces, reasonProducer, reasonConsumer }) {
  const problems = [];
  let examined = 0;

  const fromSchema = statusesFromSchema(schemaSql);
  if (!fromSchema || fromSchema.length === 0) {
    problems.push("could not read the ai_run status CHECK constraint out of the migration — this check cannot pass without it");
    return { problems, examined };
  }
  examined += 1;

  const fromCode = statusesFromCode(spendTs);
  if (!fromCode || fromCode.length === 0) {
    problems.push("AI_RUN_STATUSES is missing from src/worker/ai/spend.ts — nothing derives the stopped-run population");
    return { problems, examined };
  }
  examined += 1;

  const missing = fromSchema.filter((s) => !fromCode.includes(s));
  const extra = fromCode.filter((s) => !fromSchema.includes(s));
  if (missing.length > 0) {
    problems.push(
      `the schema declares ${missing.join(", ")} but AI_RUN_STATUSES does not list ${missing.length === 1 ? "it" : "them"} — ` +
        `a run in that state would be counted by nobody`,
    );
  }
  if (extra.length > 0) problems.push(`AI_RUN_STATUSES lists ${extra.join(", ")}, which the schema does not allow`);

  // STOPPED must be derived, never typed out. A second hand-written list is the defect itself.
  if (!/STOPPED_RUN_STATUSES[\s\S]{0,200}AI_RUN_STATUSES\.filter/.test(spendTs)) {
    problems.push("STOPPED_RUN_STATUSES must be derived from AI_RUN_STATUSES by filtering out the committed ones, not written out");
  }
  examined += 1;

  for (const [path, source] of Object.entries(surfaces)) {
    examined += 1;
    // No surface may hand-type a status list of its own.
    if (/status\s+IN\s*\(\s*'(?:PREFLIGHT_BLOCKED|BUDGET_BLOCKED|EGRESS_BLOCKED|KILL_SWITCHED|PROVIDER_DISABLED|BLOCKED_DEFERRED|FAILED)'/.test(source)) {
      problems.push(`${path} hand-types a stopped-run status list; it must call stoppedRuns() so both screens count one population`);
    }
    // No surface may print cost_mode as the firm's spending posture.
    if (/\$\{s\("cost_mode"\)\}/.test(source) || /policy\.cost_mode\s*,\s*\n\s*\/\/\s*posture/i.test(source)) {
      problems.push(`${path} prints budget_policy.cost_mode as the firm's posture; cost_mode is derived from the lever and never read back`);
    }
  }
  /*
   * A REASON NOTHING RENDERS IS NOT A REASON. `unavailable_reason` sat in the provider-catalogue
   * payload from the day it was written and no page printed it, so a lane deliberately stood down
   * for an empty account looked exactly like one nobody had switched on yet.
   */
  if (reasonProducer !== undefined || reasonConsumer !== undefined) {
    examined += 1;
    if (!/unavailable_reason:/.test(reasonProducer ?? "")) {
      problems.push("providerRouter.ts no longer computes unavailable_reason; a lane that cannot serve would say nothing");
    }
    examined += 1;
    if (!/unavailable_reason/.test(reasonConsumer ?? "")) {
      problems.push(
        "AiOpsPage.tsx does not render unavailable_reason — the Cockpit would show a stood-down lane as DISABLED beside a green 'configured' badge and no cause",
      );
    }
  }
  return { problems, examined };
}

function run() {
  if (!existsSync(SCHEMA)) {
    fail(`missing ${SCHEMA}`);
  } else {
    const surfaces = {};
    for (const rel of SURFACES) {
      const p = join(ROOT, rel);
      if (!existsSync(p)) {
        fail(`missing surface ${rel} — this check names the screens that show these numbers and cannot skip one`);
        continue;
      }
      surfaces[rel] = stripCommentsFor(p, readFileSync(p, "utf8"));
    }
    const { problems, examined } = check({
      schemaSql: stripCommentsFor(SCHEMA, readFileSync(SCHEMA, "utf8")),
      spendTs: stripCommentsFor(SPEND, readFileSync(SPEND, "utf8")),
      surfaces,
      reasonProducer: stripCommentsFor(join(ROOT, REASON_PRODUCER), readFileSync(join(ROOT, REASON_PRODUCER), "utf8")),
      reasonConsumer: stripCommentsFor(join(ROOT, REASON_CONSUMER), readFileSync(join(ROOT, REASON_CONSUMER), "utf8")),
    });
    checked = examined;
    for (const p of problems) fail(p);
  }

  if (checked === 0) {
    console.error("what-stopped-is-counted-once: examined ZERO items. An empty loop is a failure, not a pass.");
    process.exit(1);
  }
  if (failures.length > 0) {
    console.error(`what-stopped-is-counted-once: ${failures.length} problem(s) across ${checked} checked item(s)`);
    for (const f of failures) console.error(`  · ${f}`);
    process.exit(1);
  }
  console.log(`what-stopped-is-counted-once: OK — ${checked} item(s) checked; the status list, the derivation and ${SURFACES.length} surface(s) agree.`);
}

function selfTest() {
  const good = {
    schemaSql: stripCommentsFor(SCHEMA, readFileSync(SCHEMA, "utf8")),
    spendTs: stripCommentsFor(SPEND, readFileSync(SPEND, "utf8")),
    surfaces: Object.fromEntries(SURFACES.map((r) => [r, stripCommentsFor(join(ROOT, r), readFileSync(join(ROOT, r), "utf8"))])),
    reasonProducer: stripCommentsFor(join(ROOT, REASON_PRODUCER), readFileSync(join(ROOT, REASON_PRODUCER), "utf8")),
    reasonConsumer: stripCommentsFor(join(ROOT, REASON_CONSUMER), readFileSync(join(ROOT, REASON_CONSUMER), "utf8")),
  };
  const clean = check(good);
  if (clean.problems.length > 0) {
    console.error("self-test: the live tree should be clean but is not:", clean.problems);
    process.exit(1);
  }
  if (clean.examined === 0) {
    console.error("self-test: the live tree examined zero items");
    process.exit(1);
  }

  // NEGATIVE PROOF 1 — a status the schema has and the code does not.
  const brokenList = check({
    ...good,
    spendTs: good.spendTs.replace('  "PREFLIGHT_BLOCKED",\n', ""),
  });
  if (!brokenList.problems.some((p) => p.includes("PREFLIGHT_BLOCKED"))) {
    console.error("self-test: dropping PREFLIGHT_BLOCKED from AI_RUN_STATUSES did not fail");
    process.exit(1);
  }

  // NEGATIVE PROOF 2 — the old hand-typed status list on Home.
  const brokenHome = check({
    ...good,
    surfaces: {
      ...good.surfaces,
      "src/worker/services/mpHome.ts":
        good.surfaces["src/worker/services/mpHome.ts"] +
        "\n// status IN ('BUDGET_BLOCKED','KILL_SWITCHED','PROVIDER_DISABLED','EGRESS_BLOCKED','BLOCKED_DEFERRED')\n",
    },
  });
  if (!brokenHome.problems.some((p) => p.includes("hand-types"))) {
    console.error("self-test: a hand-typed status list on Home did not fail");
    process.exit(1);
  }

  // NEGATIVE PROOF 3 — cost_mode printed as the posture, exactly as it was.
  const brokenPosture = check({
    ...good,
    surfaces: {
      ...good.surfaces,
      "src/client/pages/HomePage.tsx":
        good.surfaces["src/client/pages/HomePage.tsx"] + '\nconst x = `${s("cost_mode")}/${s("privacy_mode")}`;\n',
    },
  });
  if (!brokenPosture.problems.some((p) => p.includes("cost_mode"))) {
    console.error("self-test: printing cost_mode as the posture did not fail");
    process.exit(1);
  }

  // NEGATIVE PROOF 4 — zero items must never read as a pass.
  const empty = check({ schemaSql: "-- nothing here", spendTs: good.spendTs, surfaces: {} });
  if (empty.problems.length === 0) {
    console.error("self-test: an unreadable schema passed; a check that examines nothing must fail");
    process.exit(1);
  }

  // NEGATIVE PROOF 5 — the Cockpit stops rendering the reason the server computed.
  const brokenReason = check({ ...good, reasonConsumer: good.reasonConsumer.replaceAll("unavailable_reason", "x_reason") });
  if (!brokenReason.problems.some((p) => p.includes("does not render unavailable_reason"))) {
    console.error("self-test: a Cockpit that drops unavailable_reason did not fail");
    process.exit(1);
  }

  console.log("what-stopped-is-counted-once --self-test: OK — clean tree passes; 5 broken states each fail.");
}

if (process.argv.includes("--self-test")) selfTest();
else run();
