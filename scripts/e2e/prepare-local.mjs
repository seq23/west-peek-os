#!/usr/bin/env node
/**
 * Make `npm run e2e` re-runnable, and make a red run mean something.
 *
 * Every spec drives the SAME local D1 through one `wrangler dev`, so the isolation boundary is the
 * database, not the file — and several journeys assume a clean firm (no seeded companies, no prior
 * approval cards, no prior AI runs). `AGENTS.md` has always said so, but it said it as a *manual*
 * instruction: "rm -rf .wrangler before a full run". That left the repo's own documented entrypoint
 * non-idempotent — running `npm run e2e` twice in a row failed six specs the second time, with
 * assertion errors that look like product defects and are not.
 *
 * This script makes the precondition part of the command instead of part of the folklore. It:
 *   1. refuses to start while another Playwright run is in flight;
 *   2. stops anything still listening on the e2e port, so nothing holds the database open (and so
 *      Playwright can never silently reuse a server running an older build);
 *   3. deletes the local D1 and any previous Playwright artifacts;
 *   4. as `--verify-only`, checks afterwards that every migration actually landed.
 *
 * It touches only the local miniflare state and the configured port. It never weakens a spec: the
 * suite still has to pass on a firm that starts empty.
 */
import { execFileSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PORT = Number(process.env.WPOS_E2E_PORT ?? 8787);

/**
 * VERIFY THE SCHEMA — `--verify-only`, run AFTER the shell has applied the migrations.
 *
 * THE BUG THIS CATCHES was invisible and cost most of two days. `wrangler d1 migrations apply`
 * prints its plan and waits for confirmation; without a terminal it cannot ask, so it prints the
 * table of pending migrations and applies NOTHING — exit 0, nothing on stderr, and a list that
 * reads like a report of work done. `wrangler dev` then starts against a database with almost no
 * tables and 125 specs fail at once, which reads exactly like the product collapsing.
 *
 * Wrangler skips that prompt when it believes it is in CI, so `npm run e2e` sets `CI=true` on the
 * apply. The apply is done by the SHELL and not from here: spawned from node the process is killed
 * by a signal part-way through (status 143) whatever stdio it is given, and a migration killed
 * half-way is the very state this check exists to detect.
 *
 * This block runs FIRST and exits, before anything destructive below it — verifying the schema must
 * never be the thing that deletes it.
 *
 * A suite running against an unknown schema cannot tell you anything, and a green run is worthless
 * if a red one might mean nothing.
 */
if (process.argv.includes("--verify-only")) {
  const out = execFileSync("npx", ["wrangler", "d1", "migrations", "list", "WP_OS_DB", "--local"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (!/No migrations to apply/i.test(out)) {
    const pending = (out.match(/\d{4}_[a-z0-9_]+\.sql/gi) ?? []).length;
    console.error(
      `e2e prepare: the local database is NOT fully migrated — ${pending} migration(s) still pending.\n` +
        "Refusing to continue: `wrangler dev` would start anyway on a half-built schema and every " +
        "spec would fail against a database missing most of its tables, which looks like the product " +
        "collapsing and is not.",
    );
    process.exit(1);
  }
  console.log("e2e prepare: schema verified — every migration is applied.");
  process.exit(0);
}

/** PIDs listening on the e2e port. Scoped deliberately: nothing else is ever touched. */
function listenersOn(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    return [...new Set(out.split("\n").map((l) => l.trim()).filter(Boolean))];
  } catch {
    return []; // lsof exits non-zero when nothing matches
  }
}

function kill(pids) {
  for (const pid of pids) {
    try {
      process.kill(Number(pid), "SIGKILL");
    } catch {
      // already gone between listing and killing
    }
  }
}

const sleep = (seconds) => execFileSync("sleep", [String(seconds)]);

/**
 * The port is held by `workerd`, but `wrangler dev` SUPERVISES `workerd` and respawns it the moment
 * it dies. Killing the listener alone therefore never converges — it just restarts, still bound,
 * and Playwright's own server can never bind. The supervisor has to go first.
 *
 * The pattern is scoped to this repo's own `node_modules`, so a wrangler running for a different
 * project on the same machine is never touched, and it can never match this script (which does not
 * live under `node_modules`).
 */
function repoRuntimePids() {
  try {
    const out = execFileSync("pgrep", ["-f", `${ROOT}node_modules/.*(wrangler|workerd)`], { encoding: "utf8" });
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .filter((pid) => Number(pid) !== process.pid);
  } catch {
    return []; // pgrep exits non-zero when nothing matches
  }
}

/**
 * REFUSE TO START IF A RUN IS ALREADY IN FLIGHT.
 *
 * Everything below this point is destructive by design — it SIGKILLs the repo's wrangler and deletes
 * the local D1. That is correct when the previous run is over and wrong while one is going. Two runs
 * on one machine destroy each other: whichever starts second kills the first one's server and
 * database mid-suite, and the first reports a wall of `ECONNREFUSED` that looks exactly like a
 * product collapse. It cost most of a day on 22 Aug 2026 — one run reported 4 passed out of 129, and
 * the identical run immediately afterwards reported 129 of 129.
 *
 * Refusing here converts the worst failure mode — a mass of meaningless failures — into the mildest
 * one, a sentence saying wait.
 */
function runningSuites() {
  try {
    const out = execFileSync("pgrep", ["-f", `${ROOT}node_modules/.bin/playwright test`], { encoding: "utf8" });
    return out.split("\n").map((l) => l.trim()).filter(Boolean).filter((pid) => Number(pid) !== process.pid);
  } catch {
    return [];
  }
}

const inFlight = runningSuites();
if (inFlight.length > 0 && process.env.WPOS_E2E_FORCE !== "1") {
  console.error(
    `e2e prepare: a Playwright run is already in flight (pid ${inFlight.join(", ")}).\n` +
      "Starting now would SIGKILL its server and delete the database underneath it, and BOTH runs " +
      "would report failures that mean nothing. Wait for it to finish, or set WPOS_E2E_FORCE=1 if " +
      "you are certain that process is dead.",
  );
  process.exit(1);
}

let stopped = 0;
for (let pass = 0; pass < 5; pass += 1) {
  const supervisors = repoRuntimePids();
  const listeners = listenersOn(PORT);
  if (supervisors.length === 0 && listeners.length === 0) break;
  // Supervisors first, then whatever still holds the socket.
  kill(supervisors);
  sleep(0.3);
  kill(listenersOn(PORT));
  stopped += new Set([...supervisors, ...listeners]).size;
  sleep(0.5);
}

const stillBound = listenersOn(PORT);
if (stillBound.length > 0) {
  console.error(
    `e2e prepare: port ${PORT} is still held by pid(s) ${stillBound.join(", ")} and could not be released.\n` +
      `Stop that process, or run with WPOS_E2E_PORT set to a free port. Refusing to continue: the ` +
      `suite would otherwise hang waiting for a server that can never bind.`,
  );
  process.exit(1);
}
if (stopped) console.log(`e2e prepare: stopped ${stopped} stale listener(s) on port ${PORT}`);

for (const dir of [".wrangler", "test-results", "playwright-report"]) {
  const path = join(ROOT, dir);
  if (existsSync(path)) {
    rmSync(path, { recursive: true, force: true });
    console.log(`e2e prepare: removed ${dir}/`);
  }
}

console.log(`e2e prepare: local D1 reset; the suite will start from an empty firm on port ${PORT}.`);
