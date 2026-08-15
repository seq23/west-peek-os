#!/usr/bin/env node
/**
 * Make `npm run e2e` re-runnable.
 *
 * Every spec drives the SAME local D1 through one `wrangler dev`, so the isolation boundary is the
 * database, not the file — and several journeys assume a clean firm (no seeded companies, no prior
 * approval cards, no prior AI runs). `AGENTS.md` has always said so, but it said it as a *manual*
 * instruction: "rm -rf .wrangler before a full run". That left the repo's own documented entrypoint
 * non-idempotent — running `npm run e2e` twice in a row failed six specs the second time, with
 * assertion errors that look like product defects and are not.
 *
 * This script makes the precondition part of the command instead of part of the folklore. It:
 *   1. stops anything still listening on the e2e port, so nothing holds the database open (and so
 *      Playwright can never silently reuse a server running an older build);
 *   2. deletes the local D1 and any previous Playwright artifacts.
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
