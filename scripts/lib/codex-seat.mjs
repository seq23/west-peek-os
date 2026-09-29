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
 * UNPROVEN AGAINST THE LIVE CLI. The flag set below (`exec`, `--sandbox workspace-write`,
 * `--skip-git-repo-check`, `--add-dir`, `-c sandbox_workspace_write.network_access=true`, prompt on
 * stdin via `-`) is from the Codex CLI's documented surface, and `codexSupports` asks the installed
 * binary before relying on a flag. A binary that lacks one makes the fallback UNAVAILABLE WITH A
 * SENTENCE, not a silent failure. It has not been run on the owner's Mac; the ledger says so.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

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
 *   --add-dir <d>               the job directory and the package, outside the worktree — AND the git
 *                               directory of every repository worktree (see gitCommonDirs), or a commit fails
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

/**
 * THE GIT DIRECTORIES A WORKTREE'S COMMITS ARE WRITTEN TO (29 Sep 2026, from review of PR #213).
 *
 * Repo work runs in a LINKED worktree (`git worktree add`). Its working files sit in the worktree, but
 * its index, HEAD and the refs a commit moves live in the ORIGINAL repository's `.git/worktrees/<name>`,
 * and new objects go to that repository's `.git/objects` — all outside the worktree. The Codex
 * `workspace-write` sandbox lets the model write only under its working directory and the `--add-dir`
 * folders, so without these the model could edit source but `git add` / `git commit` would fail, and
 * the fallback would produce a BUILD that changed files and recorded nothing.
 *
 * `gitDirOf(dir)` returns `git rev-parse --git-common-dir` for a directory, or null when it is not in a
 * repository (the job directory and the package are not). Injected so the test can use a real
 * repository and this stays free of child processes. Returns absolute, de-duplicated paths.
 */
export function gitCommonDirs(dirs, gitDirOf) {
  const out = [];
  for (const d of dirs) {
    let raw = null;
    try {
      raw = gitDirOf(d);
    } catch {
      raw = null;
    }
    if (!raw || typeof raw !== "string" || raw.trim() === "") continue;
    const abs = path.resolve(d, raw.trim());
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}

/** Does the installed `codex exec --help` mention this flag? Injected `help` text keeps the test offline. */
export function helpMentions(helpText, flag) {
  return typeof helpText === "string" && helpText.includes(flag);
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
export async function runWithCodexFallback({ runClaude, runCodex, limited, usable, supports, addDirs = [], onLine }) {
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
  return {
    ...second,
    out: `[served by Codex after Claude Code reported: ${limit}]\n${second.out}`,
    servedBy: "codex",
    handedOver: true,
  };
}
