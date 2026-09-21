#!/usr/bin/env node
/**
 * THE CLAIMER — one process, both subscription seats, on the owner's own Mac.
 *
 *   node scripts/claimer/subscription-seat-claimer.mjs            run until killed
 *   node scripts/claimer/subscription-seat-claimer.mjs --once     one cycle, then exit
 *   node scripts/claimer/subscription-seat-claimer.mjs --doctor   check the machine, run nothing
 *   node scripts/claimer/subscription-seat-claimer.mjs --self-test no network, no seats, pure logic
 *
 * ── WHY ONE PROCESS FOR TWO SEATS, rather than two ───────────────────────────────────────────
 *
 * Asked and answered deliberately, because the opposite choice is defensible.
 *
 * The argument FOR two processes is isolation: Claude Code hanging cannot then stall Codex. That is
 * a real risk and it is handled HERE INSTEAD, by never letting a seat's work block the loop — each
 * run is spawned with a hard timeout and killed, and the heartbeat is written before and after
 * rather than only at the end. A hung child cannot stop the ping, so the seat that is healthy
 * stays visible.
 *
 * The arguments FOR one process are three, and together they win:
 *
 *   1. ONE HEARTBEAT ROUND TRIP says both seats are awake. Two processes would each ping, and the
 *      two pings would drift — and the first symptom of drift is a seat that reads asleep while its
 *      claimer is running perfectly.
 *   2. ONE PLACE WHERE CAPACITY IS SHARED. Both seats draw on subscriptions the owner also uses
 *      interactively. A single process running one run at a time is a real, simple throttle. Two
 *      processes would need a lock between them to say the same thing.
 *   3. ONE THING TO INSTALL, ONE LABEL TO UNLOAD, ONE LOG TO READ. The operational surface the
 *      owner actually touches is halved.
 *
 * ── AND IT IS SEPARATE FROM BOSS OS'S CLAIMER, ABSOLUTELY ────────────────────────────────────
 *
 * Different repository, different script, different launchd label, different log path, different
 * endpoint. Nothing here imports, extends, reads or writes anything belonging to `boss-os`. The two
 * systems are separate properties and a stall in one must never take the other down — which is
 * exactly what sharing a claimer would arrange.
 *
 * ── WHAT THIS PROCESS MAY AND MAY NOT DO ─────────────────────────────────────────────────────
 *
 * It may: say it is awake, take a run the router already parked, run it locally, report the answer.
 * It may NOT create work, choose a model, widen a label, or decide anything about cost or privacy.
 * Every one of those was settled by the router before the run was parked. This is a pair of hands.
 */

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const ARGS = new Set(process.argv.slice(2));
const ONCE = ARGS.has("--once");
const DOCTOR = ARGS.has("--doctor");
const SELF_TEST = ARGS.has("--self-test");

/** Must match HEARTBEAT_INTERVAL_S in src/worker/ai/subscriptionSeats.ts. Asserted at startup. */
const HEARTBEAT_INTERVAL_S = 30;

/**
 * How long a single local run may take before it is killed and reported as a failure.
 *
 * Deliberately SHORTER than the router's own ninety-second wait would suggest is needed, and that
 * is not a mistake: a run the router has already given up on is work nobody will read, so spending
 * four more minutes of her subscription on it is pure waste. The router's wait and this timeout are
 * both bounded and the smaller one is the one that matters.
 */
const RUN_TIMEOUT_MS = 150_000;

/** Both seats, and how to invoke each one headlessly. */
const SEATS = {
  claude_code: {
    bin: "claude",
    displayName: "Claude Code",
    /*
     * `-p` is print mode: read the prompt, answer, exit. Without it the CLI opens an interactive
     * session and a launchd job with no terminal hangs for ever.
     */
    args: (prompt) => ["-p", prompt],
  },
  codex: {
    bin: "codex",
    displayName: "Codex CLI",
    /*
     * TWO FLAGS THAT ARE NOT OPTIONAL, both found the hard way:
     *
     *   --skip-git-repo-check   without it, `codex exec` REFUSES to run outside a git repository
     *                           and resets the working directory on the way out. A launchd job
     *                           starting in `/` hits this every time.
     *   --sandbox read-only     this is answering a question, not editing a repository. Read-only
     *                           is the correct authority for that and it is also the reason this
     *                           process can be trusted to run unattended.
     *
     * stdin is redirected to /dev/null by the spawn below for the same class of reason: without it
     * the CLI blocks waiting to be typed at, which under launchd is indistinguishable from a hang.
     */
    args: (prompt) => ["exec", "--sandbox", "read-only", "--skip-git-repo-check", prompt],
  },
};

/**
 * ── THE LOUD LINE THAT IS NOT A FAILURE ──────────────────────────────────────────────────────
 *
 * `codex exec` prints, to stderr, on a perfectly successful run:
 *
 *     ERROR: failed to refresh available models: unknown variant `max`
 *
 * It is cosmetic — the generation completes and the answer is correct — and it is the single most
 * likely thing to make a future reader's parser declare every Codex run a failure. So the rule here
 * is stated positively rather than by filtering: SUCCESS IS DECIDED BY EXIT CODE AND BY WHETHER
 * ANY ANSWER CAME BACK ON STDOUT. Nothing on stderr can fail a run on its own, and stderr is kept
 * and reported only when there is no answer to report instead.
 */
function looksLikeKnownNoise(stderr) {
  return /failed to refresh available models/i.test(stderr);
}

/**
 * The answer, out of a CLI's stdout.
 *
 * Both tools may print progress, banners or a reasoning trace before the answer. The convention
 * both follow is that the ANSWER IS LAST, so the last non-empty block is taken rather than the
 * whole stream — but the whole stream is returned when there is only one block, which is the
 * ordinary case and must not be mangled by a clever parser.
 */
export function extractAnswer(stdout) {
  const trimmed = (stdout ?? "").replace(/\r/g, "").trim();
  if (!trimmed) return "";
  const blocks = trimmed.split(/\n{2,}/).map((b) => b.trim()).filter((b) => b.length > 0);
  if (blocks.length <= 1) return trimmed;
  return blocks[blocks.length - 1];
}

/** The environment a seat runs in: every ANTHROPIC_* / CLAUDE_* auth variable removed. */
export function seatEnv(base) {
  const out = {};
  for (const [k, v] of Object.entries(base ?? {})) {
    if (/^ANTHROPIC_/i.test(k) || /^CLAUDE_(API|AUTH|CODE_OAUTH|OAUTH|TOKEN)/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

/** Is a seat's CLI actually on this machine? A seat we cannot run must never be claimed for. */
async function seatInstalled(seat) {
  try {
    await execFileAsync("command", ["-v", SEATS[seat].bin], { shell: "/bin/sh" });
    return true;
  } catch {
    try {
      await execFileAsync("/bin/sh", ["-c", `command -v ${SEATS[seat].bin}`]);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * IS THE CODEX SEAT STILL ON THE SUBSCRIPTION?
 *
 * Checked at startup rather than assumed, and this is a money question rather than a tidiness one.
 * `~/.codex/auth.json` records `auth_mode`. If that ever becomes `apikey` — a re-login, an env var,
 * a tool that helpfully "fixed" the config — the CLI starts billing the API per token while this
 * system goes on recording the lane at $0. A lane that silently costs money while reporting free is
 * worse than a lane that is down.
 */
export function codexOnSubscription(authJsonText) {
  try {
    const parsed = JSON.parse(authJsonText);
    return parsed.auth_mode === "chatgpt";
  } catch {
    return false;
  }
}

function codexSeatUsable() {
  const p = path.join(homedir(), ".codex", "auth.json");
  if (!existsSync(p)) return { ok: false, why: "~/.codex/auth.json does not exist — the Codex CLI is not signed in" };
  let text = "";
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return { ok: false, why: "~/.codex/auth.json could not be read" };
  }
  if (!codexOnSubscription(text)) {
    return {
      ok: false,
      why:
        "~/.codex/auth.json no longer records auth_mode=chatgpt, so this seat would bill the API per token " +
        "while the firm records it at $0. Refusing to claim for it until it is back on the subscription.",
    };
  }
  return { ok: true, why: "auth_mode=chatgpt" };
}

// ── The wire ─────────────────────────────────────────────────────────────────────────────────

const BASE_URL = process.env.WP_OS_BASE_URL ?? "https://os.joinwestpeek.com";
const DEVICE_ID = process.env.WP_OS_CLAIMER_DEVICE_ID ?? `mac-${hostname()}`;

/**
 * Both halves of the Access service token. They are READ FROM THE ENVIRONMENT and never written,
 * echoed or logged — the launchd job sources them from the vault, so no secret exists in this repo
 * or in the plist.
 */
function accessHeaders() {
  const id = process.env.WP_OS_MAC_ACCESS_CLIENT_ID ?? process.env.CF_ACCESS_CLIENT_ID;
  const secret = process.env.WP_OS_MAC_ACCESS_CLIENT_SECRET ?? process.env.CF_ACCESS_CLIENT_SECRET;
  if (!id || !secret) return null;
  return { "CF-Access-Client-Id": id, "CF-Access-Client-Secret": secret, "content-type": "application/json" };
}

async function call(pathname, body, method = "POST") {
  const headers = accessHeaders();
  if (!headers) throw new Error("WP_OS_MAC_ACCESS_CLIENT_ID / WP_OS_MAC_ACCESS_CLIENT_SECRET are not in the environment");
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method,
    headers,
    ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a non-JSON body is reported by status alone */
  }
  return { status: res.status, body: parsed, raw: text.slice(0, 400) };
}

/** Run one claimed job on its seat. Never throws: a failure is a RESULT the router needs. */
async function runOnSeat(seat, prompt) {
  const cfg = SEATS[seat];
  return new Promise((resolve) => {
    const child = spawn(cfg.bin, cfg.args(prompt), {
      // stdin closed. Both CLIs block for ever on an open stdin with no terminal, which under
      // launchd looks exactly like a hang and is the second of the two traps.
      stdio: ["ignore", "pipe", "pipe"],
      // HER SEAT, NEVER A KEY (21 Sep 2026): the vault injects ANTHROPIC_API_KEY for the Worker's
      // paid lane, and `claude -p` would prefer it over the subscription login and bill the API.
      env: seatEnv(process.env),
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        ok: false,
        error: `${cfg.displayName} did not finish within ${Math.round(RUN_TIMEOUT_MS / 1000)}s and was stopped.`,
      });
    }, RUN_TIMEOUT_MS);

    child.stdout.on("data", (d) => (out += String(d)));
    child.stderr.on("data", (d) => (err += String(d)));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, error: `${cfg.displayName} could not be started: ${e.message}` });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const answer = extractAnswer(out);
      if (answer.length > 0) {
        // EXIT CODE AND ANSWER DECIDE, NOT STDERR. See `looksLikeKnownNoise` above.
        resolve({ ok: true, output: answer });
        return;
      }
      const noise = looksLikeKnownNoise(err) ? " (the models-refresh warning on stderr is cosmetic and is not the cause)" : "";
      resolve({
        ok: false,
        error: `${cfg.displayName} exited ${code} with no answer on stdout${noise}. stderr: ${err.trim().slice(0, 500)}`,
      });
    });
  });
}

async function cycle(seats) {
  await call("/api/subscription-seats/heartbeat", {
    device_id: DEVICE_ID,
    hostname: hostname(),
    agent_version: "1",
    seats,
  });

  const claimed = await call("/api/subscription-seats/claim", { device_id: DEVICE_ID, seats });
  const run = claimed.body?.run;
  if (!run) return { worked: false };

  const seat = run.seat;
  if (!SEATS[seat]) {
    await call("/api/subscription-seats/report", {
      device_id: DEVICE_ID,
      run_id: run.id,
      error: `this claimer does not know the seat "${seat}"`,
    });
    return { worked: true };
  }

  /*
   * THE HANDLING LINE GOES IN FRONT OF THE WORK, not into a log. The router puts it on every run
   * because this is PRIVATE_MODEL_ONLY material, and the model about to read the prompt is the only
   * thing that can act on it.
   */
  const prompt = `${run.handling}\n\n---\n\n${run.prompt}`;
  const result = await runOnSeat(seat, prompt);

  await call("/api/subscription-seats/report", {
    device_id: DEVICE_ID,
    run_id: run.id,
    ...(result.ok ? { output_text: result.output } : { error: result.error }),
  });
  return { worked: true };
}

async function usableSeats() {
  const seats = [];
  for (const seat of Object.keys(SEATS)) {
    if (!(await seatInstalled(seat))) continue;
    if (seat === "codex") {
      const verdict = codexSeatUsable();
      if (!verdict.ok) {
        console.error(`codex seat unusable: ${verdict.why}`);
        continue;
      }
    }
    seats.push(seat);
  }
  return seats;
}

async function main() {
  if (SELF_TEST) return selfTest();

  const seats = await usableSeats();
  if (DOCTOR) {
    console.log(`device: ${DEVICE_ID}`);
    console.log(`base url: ${BASE_URL}`);
    console.log(`access token in environment: ${accessHeaders() ? "yes" : "NO — the claimer cannot authenticate"}`);
    console.log(`usable seats: ${seats.length > 0 ? seats.join(", ") : "NONE"}`);
    process.exit(seats.length > 0 && accessHeaders() ? 0 : 1);
  }

  /*
   * NO USABLE SEAT IS A CLEAN EXIT, NOT AN ERROR, and this is the `bk_local_runtime` lesson from
   * the sister system: a backend permanently disabled with the reason "NO LOCAL HOST" is a lane
   * that looked broken for months. Here, absence is ordinary. The router never hears a heartbeat,
   * skips both seats with no delay, and the firm's work runs on the ladder exactly as before.
   */
  if (seats.length === 0) {
    console.log("No subscription seat is usable on this machine. Exiting quietly; the firm's work is unaffected.");
    return;
  }
  console.log(`claiming for: ${seats.join(", ")} as ${DEVICE_ID}`);

  for (;;) {
    let worked = false;
    try {
      ({ worked } = await cycle(seats));
    } catch (err) {
      // A LOOP THAT DIES ON A NETWORK BLIP IS A LANE THAT SILENTLY DISAPPEARS. Logged and continued.
      console.error(`cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (ONCE) return;
    /*
     * A cycle that DID work goes straight round again — a queue with two runs in it should not wait
     * thirty seconds for the second. A cycle that found nothing sleeps for the heartbeat interval,
     * which is also exactly how often the firm needs to hear from us.
     */
    if (!worked) await new Promise((r) => setTimeout(r, HEARTBEAT_INTERVAL_S * 1000));
  }
}

/** No network, no CLIs, no seats. Just the two parsers that decide whether a run succeeded. */
function selfTest() {
  const cases = [
    ["single block is returned whole", () => extractAnswer("lane is alive") === "lane is alive"],
    ["the last block wins over a preamble", () => extractAnswer("thinking...\n\nlane is alive") === "lane is alive"],
    ["blank output is empty, never a false answer", () => extractAnswer("   \n \n ") === ""],
    ["undefined output does not throw", () => extractAnswer(undefined) === ""],
    ["the models-refresh line is known noise", () => looksLikeKnownNoise("ERROR: failed to refresh available models: unknown variant `max`")],
    ["an unrelated stderr line is not excused", () => !looksLikeKnownNoise("ERROR: authentication failed")],
    ["chatgpt auth mode is on the subscription", () => codexOnSubscription('{"auth_mode":"chatgpt","OPENAI_API_KEY":null}')],
    ["apikey auth mode is refused — it would bill per token", () => !codexOnSubscription('{"auth_mode":"apikey"}')],
    ["unparseable auth.json is refused, not assumed", () => !codexOnSubscription("{{{")],
    ["the seat never sees the vault's API key", () => { const e = seatEnv({ PATH: "/bin", ANTHROPIC_API_KEY: "sk", CLAUDE_CODE_OAUTH_TOKEN: "o" }); return e.PATH === "/bin" && !("ANTHROPIC_API_KEY" in e) && !("CLAUDE_CODE_OAUTH_TOKEN" in e); }],
  ];
  let failed = 0;
  for (const [name, fn] of cases) {
    let ok = false;
    try {
      ok = fn() === true;
    } catch {
      ok = false;
    }
    console.log(`${ok ? "  ok  " : "  FAIL"} ${name}`);
    if (!ok) failed += 1;
  }
  // Rule 0: a self-test that ran nothing has not passed.
  if (cases.length === 0) {
    console.error("SELF-TEST examined ZERO cases — it cannot have passed.");
    process.exit(1);
  }
  if (failed > 0) {
    console.error(`SELF-TEST FAILED: ${failed} of ${cases.length}`);
    process.exit(1);
  }
  console.log(`SELF-TEST PASSED: ${cases.length} cases`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
