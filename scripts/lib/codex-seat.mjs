/**
 * THE CODEX SEAT, AS THE MAC SCRIPTS USE IT — one place, so the answer claimer and the repo-work
 * duty script agree about what "Codex is usable" and "how to run it" mean.
 *
 * Used by:
 *   · scripts/claimer/subscription-seat-claimer.mjs — answers a parked question with `codex exec`
 *     in a read-only sandbox (no tools that change anything);
 *   · scripts/duties/web-property-change.mjs — when Claude Code reports its plan is out of usage
 *     mid-job, hands the SAME phase to Codex in the SAME worktree (29 Sep 2026).
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never chooses Codex for a reason other than Claude Code's
 * plan being spent. A Claude failure of any other kind — a bad prompt, a crash, a red validator — is
 * the phase's failure, reported as it always was; handing it to a second model would hide the fault
 * and spend a second subscription on the same mistake.
 *
 * THE FLAG SET (`exec`, `--sandbox workspace-write`, `--skip-git-repo-check`, `--add-dir`,
 * `-c sandbox_workspace_write.network_access=true`, prompt on stdin via `-`) RUNS, EDITS THE WORKTREE
 * AND REACHES THE NETWORK — and CANNOT WRITE GIT METADATA, whatever folder is named writable. Boss OS
 * proved that on the owner's Mac (29 Oct 2026, codex-cli 0.163.0: a finished repair died on
 * `.git/worktrees/<wt>/index.lock: Operation not permitted`, no PR; boss-os PR #187). This copy had the
 * same flaw. So Codex only EDITS, and the runner, outside the sandbox, commits, pushes and opens the PR
 * (`finishCodexBuild`). `codexLacks` asks the installed binary before relying on a flag; one that lacks
 * it makes the fallback UNAVAILABLE WITH A SENTENCE, not a silent failure.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { retryAfterFrom } from "./seat-usage-limit.mjs";

/** True only when the CLI is signed in through the ChatGPT subscription, never an API key (which bills per token). */
export function codexOnSubscription(authJsonText) {
  try {
    const parsed = JSON.parse(authJsonText);
    return parsed.auth_mode === "chatgpt";
  } catch {
    return false;
  }
}

/**
 * Is the Codex seat safe to use on this machine? A boolean with a reason, read from ~/.codex/auth.json.
 * `home` is injectable so a test can point it at a temporary directory.
 */
export function codexSeatUsable(home = homedir()) {
  const p = path.join(home, ".codex", "auth.json");
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
        "while the firm records it at $0. Refusing to use it until it is back on the subscription.",
    };
  }
  return { ok: true, why: "auth_mode=chatgpt" };
}

/**
 * The arguments for a Codex run that may EDIT the worktree it is started in (repo work), as opposed to the
 * seat claimer's read-only answer. The prompt goes on stdin (`-`), because a phase prompt is tens of
 * kilobytes and an argument that size is how a command line silently truncates.
 *
 *   --sandbox workspace-write   may write inside the working directory and the --add-dir folders only
 *   -c ...network_access=true   the model runs the repo's validators and package installs; the sandbox
 *                               default blocks the network, which would fail every BUILD
 *   --add-dir <d>               the job directory and the package, outside the worktree
 *
 * NO GIT DIRECTORY IS EVER NAMED HERE (31 Oct 2026). Until then the runner added each worktree's
 * `--git-common-dir` so Codex could commit. That cannot work: Codex's workspace-write sandbox keeps git
 * metadata read-only even inside a named writable root (boss-os PR #187, reproduced on codex-cli 0.163.0).
 * So Codex only EDITS; the runner commits, pushes and opens the PR (`finishCodexBuild`).
 */
export function codexExecArgs(addDirs = []) {
  return [
    "exec",
    "--sandbox", "workspace-write",
    "-c", "sandbox_workspace_write.network_access=true",
    "--skip-git-repo-check",
    ...addDirs.flatMap((d) => ["--add-dir", d]),
    "-",
  ];
}

/** Appended to a BUILD prompt handed to Codex: edit, validate, write the result; the runner does git. */
export const CODEX_BUILD_NOTE = `

## YOU ARE RUNNING IN CODEX'S SANDBOX — THE RUNNER DOES THE GIT STEPS

Git metadata is read-only in this sandbox, so \`git add\`, \`git commit\`, \`git push\` and \`gh pr create\`
cannot work here. Do not run them and do not report that as a block. Make the change and run the
validation exactly as above, leave every change UNCOMMITTED in this worktree, and write the result file
as above with \`status: "ok"\`, \`proof\`, and \`pr_title\` / \`pr_body\` (the body names the change, the
steps you ran and every validator with what it said). Leave \`pr_url\` out. After you exit, the runner
commits, pushes this branch and opens (or reuses) the pull request; it never merges — \`~/bin/land\`
does that, through the LAND phase, on green and an approved plan, as always.
`;

/** A failure Codex wrote only because the sandbox would not let it commit — the runner can finish that. */
export function isGitSandboxBlock(result) {
  if (!result || typeof result !== "object") return false;
  return /index\.lock|GIT_METADATA|git (metadata|write)|cannot commit|commit, push|read-only.*git|git.*read-only|Operation not permitted.*\.git/i.test(`${result.tag ?? ""} ${result.reason ?? ""} ${result.why ?? ""}`);
}

const PROTECTED_BRANCHES = new Set(["main", "master", "HEAD", ""]);

/**
 * THE RUNNER FINISHES A BUILD CODEX EDITED (31 Oct 2026). Runs OUTSIDE the sandbox, after Codex exits,
 * on the BUILD result object Codex wrote (`{ phase, status, proof, pr_title, pr_body, … }`). Commits what
 * Codex left in the worktree on the work branch, pushes that branch (never main), and opens — or reuses —
 * the pull request against `base`. It never merges: landing is `~/bin/land`'s, through the LAND phase.
 *
 * `run(cmd, args, { cwd })` is injected (spawnSync-shaped: { status, stdout, stderr }) so the validator can
 * drive real git on a scratch repository with a fake `gh`. Returns
 *   { ok: true, result }    the result with status "ok" and pr_url / pr_number filled in
 *   { ok: false, tag, why } a NAMED reason nothing was opened (no result, a real failure, no change, a git error)
 */
export function finishCodexBuild({ cwd, branch, out, run, base = "main" }) {
  const o = out && typeof out === "object" ? { ...out } : null;
  if (!o) return { ok: false, tag: "NO_RESULT_FILE", why: "Codex wrote no build result, so there is nothing the runner may commit for it." };
  if (o.status === "needs_runs") return { ok: false, tag: "NOT_FINISHED", why: "Codex asked the script for runs; the build is not finished, so nothing is committed yet." };
  if (o.status !== "ok" && !isGitSandboxBlock(o)) return { ok: false, tag: "CODEX_FAILED", why: "Codex reported its own failure; the runner does not commit over it." };
  if (typeof o.pr_url === "string" && /^https?:\/\//.test(o.pr_url)) return { ok: true, result: o };
  const g = (...args) => run("git", args, { cwd });
  const head = String(g("rev-parse", "--abbrev-ref", "HEAD").stdout ?? "").trim();
  const want = String(branch ?? head).trim();
  if (PROTECTED_BRANCHES.has(want) || PROTECTED_BRANCHES.has(head) || want === base || head === base) {
    return { ok: false, tag: "REFUSED_PROTECTED_BRANCH", why: `the worktree is on "${head}" (wanted "${want}"); the runner commits only on a work branch, never on ${base}.` };
  }
  if (head !== want) return { ok: false, tag: "WRONG_BRANCH", why: `the worktree is on "${head}", not the job's branch "${want}".` };
  const title = String(o.pr_title ?? "").trim().split("\n")[0].slice(0, 120) || `West Peek OS web property change on ${want}`;
  if (String(g("status", "--porcelain").stdout ?? "").trim()) {
    for (const args of [["add", "-A"], ["rm", "-r", "-q", "--cached", "--ignore-unmatch", "node_modules"]]) {
      const r = g(...args);
      if (r.status !== 0) return { ok: false, tag: "COMMIT_FAILED", why: `git ${args[0]} failed: ${String(r.stderr ?? "").trim().slice(0, 300)}` };
    }
    const c = g("commit", "-q", "-m", `${title}\n\nEdited by Codex (her ChatGPT seat); committed by the West Peek OS runner outside Codex's sandbox.`);
    if (c.status !== 0) return { ok: false, tag: "COMMIT_FAILED", why: `git commit failed: ${String(c.stderr || c.stdout || "").trim().slice(0, 300)}` };
  }
  const ahead = Number(String(g("rev-list", "--count", `origin/${base}..HEAD`).stdout ?? "0").trim() || 0);
  if (!ahead) return { ok: false, tag: "NO_CHANGES", why: `Codex left nothing to commit and ${want} has no commits ahead of origin/${base}.` };
  const push = g("push", "-q", "-u", "origin", `HEAD:refs/heads/${want}`);
  if (push.status !== 0) return { ok: false, tag: "PUSH_FAILED", why: `git push of ${want} failed: ${String(push.stderr ?? "").trim().slice(0, 300)}` };
  const view = run("gh", ["pr", "view", want, "--json", "url,number,state"], { cwd });
  let pr = null;
  try {
    const j = JSON.parse(view.stdout || "null");
    if (view.status === 0 && j?.url && j.state === "OPEN") pr = { url: j.url, number: Number(j.number) };
  } catch {
    pr = null;
  }
  if (!pr) {
    const body = String(o.pr_body ?? "").trim() || `${title}\n\nEdited by Codex on her ChatGPT seat; committed and opened by the West Peek OS runner. Lands only through ~/bin/land on green.\n\n${String(o.proof ?? "").slice(0, 4000)}`;
    const made = run("gh", ["pr", "create", "--base", base, "--head", want, "--title", title, "--body", body], { cwd });
    const url = String(made.stdout ?? "").match(/https:\/\/github\.com\/\S+\/pull\/(\d+)/);
    if (made.status !== 0 || !url) return { ok: false, tag: "PR_NOT_OPENED", why: `gh pr create failed: ${String(made.stderr || made.stdout || "").trim().slice(0, 300)}` };
    pr = { url: url[0], number: Number(url[1]) };
  }
  delete o.reason;
  delete o.tag;
  delete o.pr_title;
  delete o.pr_body;
  const proof = [String(o.proof ?? "").trim(), "Committed, pushed and opened by the West Peek OS runner, outside Codex's sandbox (Codex edited; git metadata is read-only to it)."].filter(Boolean).join("\n");
  return { ok: true, result: { ...o, status: "ok", pr_url: pr.url, pr_number: pr.number, proof } };
}

/** Does the installed `codex exec --help` mention this flag? Injected `help` text keeps the test offline. */
export function helpMentions(helpText, flag) {
  return typeof helpText === "string" && helpText.includes(flag);
}

/** Nothing can be read from a notice (or the wait is silly): look again in an hour. */
const DEFAULT_RESET_WAIT_SECONDS = 60 * 60;
const MAX_RESET_WAIT_SECONDS = 7 * 24 * 60 * 60;

/**
 * How long until the EARLIER of the spent plans resets, read from the notices' own words — whichever seat
 * comes back first can take the phase. A notice with no readable time is not a reason to wait forever:
 * when none of them says, the answer is an hour, and a hold that wakes to a still-spent plan simply holds again.
 */
export function soonestReset(notices, nowMs = Date.now()) {
  const waits = notices
    .map((n) => (typeof n === "string" ? retryAfterFrom(n, nowMs) : null))
    .filter((n) => typeof n === "number" && Number.isFinite(n) && n > 0);
  const wait = waits.length ? Math.min(...waits) : DEFAULT_RESET_WAIT_SECONDS;
  return Math.min(Math.max(Math.round(wait), 60), MAX_RESET_WAIT_SECONDS);
}

/**
 * The orchestration, with every side effect injected so it is tested without a CLI.
 *
 *   1. Run Claude Code.
 *   2. If it did not report a spent plan, that result IS the result — unchanged, including a failure.
 *   3. If it did, and Codex is usable and supports what the phase needs, run the same prompt on Codex.
 *   4. Otherwise return Claude's result with a sentence appended saying why nothing stood in for it.
 *
 * The returned object is the runner's usual `{ code, out, err }` plus `servedBy` ("claude" | "codex")
 * and `handedOver`, so the job log and the phase's failure reason can say which model did the work.
 */
export async function runWithCodexFallback({ runClaude, runCodex, limited, usable, supports, addDirs = [], onLine, codexLimited }) {
  const first = await runClaude();
  const limit = limited(first);
  if (!limit) return { ...first, servedBy: "claude", handedOver: false };

  const seat = usable();
  if (!seat.ok) {
    return {
      ...first,
      err: `${first.err}\n[Claude Code is out of usage (${limit}) and Codex cannot stand in: ${seat.why}]`,
      servedBy: "claude",
      handedOver: false,
    };
  }
  const missing = await supports(addDirs.length > 0 ? ["--sandbox", "--add-dir"] : ["--sandbox"]);
  if (missing) {
    return {
      ...first,
      err: `${first.err}\n[Claude Code is out of usage (${limit}) and the installed Codex CLI does not support ${missing}, so it cannot take the phase. Update Codex.]`,
      servedBy: "claude",
      handedOver: false,
    };
  }
  onLine?.(`Claude Code is out of usage (${limit}); handing this phase to Codex on the ChatGPT Plus seat, same worktree, same prompt`);
  const second = await runCodex();
  /*
   * BOTH SEATS SPENT (1 Oct 2026). Claude Code was out of usage, the phase went to Codex, and Codex said
   * the same thing. Surfacing Codex's raw failure would read as "the phase failed", when the truth is that
   * there is nobody to run it until a plan resets. Say so, with BOTH notices verbatim — each carries its
   * own reset time ("resets Oct 2 at 8am (America/Chicago)") — so the person reading the card knows when
   * it can be tried again and does not retype an answer that cannot help. The code is forced non-zero:
   * a Codex run that printed a notice and exited 0 must not be taken as the phase's work.
   */
  const secondLimit = codexLimited ? codexLimited(second) : null;
  if (secondLimit) {
    return {
      ...second,
      code: second.code === 0 ? 1 : second.code,
      err:
        `${second.err}\n[Both subscription seats are out of usage. Claude Code said: ${limit}. ` +
        `Codex said: ${secondLimit}. This phase cannot run until one of those plans resets — try it again then.]`,
      servedBy: "none",
      handedOver: true,
      bothSpent: true,
      resetsInSeconds: soonestReset([limit, secondLimit]),
    };
  }
  return {
    ...second,
    out: `[served by Codex after Claude Code reported: ${limit}]\n${second.out}`,
    servedBy: "codex",
    handedOver: true,
  };
}
