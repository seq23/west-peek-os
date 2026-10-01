import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { codexExecArgs, codexSeatUsable, gitCommonDirs, runWithCodexFallback, type RunResult } from "../scripts/lib/codex-seat.mjs";
import { claudeSpentUsage, codexSpentUsage } from "../scripts/duties/web-property-change.mjs";

/**
 * REPO WORK ON CARDS HAS A SECOND MODEL WHEN CLAUDE CODE'S PLAN IS SPENT (29 Sep 2026).
 *
 * The Mac job runs `claude -p` for each phase and reads the RESULT FROM A FILE the model writes, so
 * which model wrote it does not change how the phase is judged. These cases prove the hand-over is
 * made for exactly one reason — a spent plan — and for no other, with the CLIs replaced by fakes.
 * Nothing here runs Codex; the flag set is UNPROVEN against the installed binary (see codex-seat.mjs).
 */

const ok = (out = "{}", err = ""): RunResult => ({ code: 0, out, err });
const LIMIT_JSON = JSON.stringify({ type: "result", is_error: true, result: "Claude AI usage limit reached|1759071600" });

function harness(opts: { claude: RunResult; usable?: { ok: boolean; why: string }; missing?: string | null; codex?: RunResult }) {
  const calls: string[] = [];
  const lines: string[] = [];
  const run = () =>
    runWithCodexFallback({
      runClaude: async () => (calls.push("claude"), opts.claude),
      runCodex: async () => (calls.push("codex"), opts.codex ?? ok("codex wrote the result file")),
      limited: claudeSpentUsage,
      usable: () => opts.usable ?? { ok: true, why: "auth_mode=chatgpt" },
      supports: async (flags) => (calls.push(`supports:${flags.join(",")}`), opts.missing ?? null),
      addDirs: ["/job", "/pkg"],
      onLine: (l) => lines.push(l),
    });
  return { run, calls, lines };
}

describe("claudeSpentUsage — a spent plan, and nothing else", () => {
  it("reads a failed run that says the plan is out, in JSON or as bare text", () => {
    expect(claudeSpentUsage({ out: LIMIT_JSON, err: "" })).toContain("usage limit reached");
    expect(claudeSpentUsage({ out: "", err: "You've hit your limit · resets 3pm" })).toContain("hit your limit");
    expect(claudeSpentUsage({ out: "Claude AI usage limit reached|1759071600", err: "" })).toBeTruthy();
  });

  it("never treats a SUCCESSFUL run as spent, whatever its answer says", () => {
    const success = JSON.stringify({ type: "result", is_error: false, result: "The docs mention that usage limit reached is what the CLI prints." });
    expect(claudeSpentUsage({ out: success, err: "" })).toBeNull();
  });

  it("does not mistake an ordinary failure for a spent plan", () => {
    const bad = JSON.stringify({ type: "result", is_error: true, result: "Tool call failed: npm run validate exited 1" });
    expect(claudeSpentUsage({ out: bad, err: "" })).toBeNull();
    expect(claudeSpentUsage({ out: "", err: "TypeError: cannot read properties of undefined" })).toBeNull();
    expect(claudeSpentUsage({ out: "", err: "" })).toBeNull();
  });
});

describe("runWithCodexFallback", () => {
  it("leaves a healthy Claude run alone and never touches Codex", async () => {
    const h = harness({ claude: ok(JSON.stringify({ is_error: false, result: "done" })) });
    const r = await h.run();
    expect(r.servedBy).toBe("claude");
    expect(r.handedOver).toBe(false);
    expect(h.calls).toEqual(["claude"]);
  });

  it("hands the SAME phase to Codex when — and only when — Claude Code's plan is spent, and says so", async () => {
    const h = harness({ claude: { code: 1, out: LIMIT_JSON, err: "" } });
    const r = await h.run();
    expect(r.servedBy).toBe("codex");
    expect(r.handedOver).toBe(true);
    expect(r.out).toContain("served by Codex");
    expect(r.out).toContain("codex wrote the result file");
    expect(h.calls).toEqual(["claude", "supports:--sandbox,--add-dir", "codex"]);
    expect(h.lines.some((l) => l.includes("handing this phase to Codex"))).toBe(true);
  });

  it("does NOT hand over an ordinary failure — the phase fails as it always did", async () => {
    const claude = { code: 1, out: JSON.stringify({ is_error: true, result: "npm run validate exited 1" }), err: "" };
    const h = harness({ claude });
    const r = await h.run();
    expect(r.servedBy).toBe("claude");
    expect(r.handedOver).toBe(false);
    expect(h.calls).toEqual(["claude"]);
    expect(r.code).toBe(1);
  });

  it("refuses to use Codex when it would bill the API, and says why in the phase's own error text", async () => {
    const h = harness({ claude: { code: 1, out: LIMIT_JSON, err: "" }, usable: { ok: false, why: "no longer records auth_mode=chatgpt" } });
    const r = await h.run();
    expect(r.handedOver).toBe(false);
    expect(r.err).toContain("Codex cannot stand in");
    expect(r.err).toContain("auth_mode=chatgpt");
    expect(h.calls).toEqual(["claude"]);
  });

  it("is unavailable, with a sentence, when the installed Codex lacks a flag the phase needs", async () => {
    const h = harness({ claude: { code: 1, out: LIMIT_JSON, err: "" }, missing: "--add-dir" });
    const r = await h.run();
    expect(r.handedOver).toBe(false);
    expect(r.err).toContain("does not support --add-dir");
    expect(h.calls).not.toContain("codex");
  });

  it("asks only for the flags the phase needs: no --add-dir when there are no extra folders", async () => {
    const calls: string[] = [];
    await runWithCodexFallback({
      runClaude: async () => ({ code: 1, out: LIMIT_JSON, err: "" }),
      runCodex: async () => ok(),
      limited: claudeSpentUsage,
      usable: () => ({ ok: true, why: "" }),
      supports: async (f) => (calls.push(f.join(",")), null),
      addDirs: [],
    });
    expect(calls).toEqual(["--sandbox"]);
  });
});

describe("the Codex run itself", () => {
  it("edits only the worktree and the named folders, reaches the network, reads the prompt from stdin", () => {
    const a = codexExecArgs(["/job", "/pkg"]);
    expect(a[0]).toBe("exec");
    expect(a).toContain("workspace-write");
    expect(a).not.toContain("danger-full-access");
    expect(a.join(" ")).toContain("sandbox_workspace_write.network_access=true");
    expect(a.join(" ")).toContain("--add-dir /job --add-dir /pkg");
    expect(a[a.length - 1]).toBe("-");
  });

  it("is usable only on the ChatGPT subscription — an API-key login would bill per token", () => {
    const home = mkdtempSync(path.join(tmpdir(), "codex-home-"));
    try {
      expect(codexSeatUsable(home).ok).toBe(false);
      mkdirSync(path.join(home, ".codex"));
      writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "x" }));
      const bad = codexSeatUsable(home);
      expect(bad.ok).toBe(false);
      expect(bad.why).toContain("bill the API per token");
      writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }));
      expect(codexSeatUsable(home).ok).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("a linked worktree commits into the ORIGINAL repository's .git — so that must be writable (PR #213 review)", () => {
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } }).trim();
  const gitDirOf = (dir: string): string | null => {
    try {
      return execFileSync("git", ["-C", dir, "rev-parse", "--git-common-dir"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
    } catch {
      return null;
    }
  };

  it("names the original repo's .git for a linked worktree, and nothing for a folder that is no repository", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "wt-")));
    try {
      const repo = path.join(root, "repo");
      mkdirSync(repo);
      git(repo, "init", "-q", "-b", "main");
      writeFileSync(path.join(repo, "a.txt"), "a");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init");
      const worktree = path.join(root, "wt");
      git(repo, "worktree", "add", "-q", "-b", "job", worktree);
      const jobDir = path.join(root, "job");
      mkdirSync(jobDir);

      const dirs = gitCommonDirs([worktree, jobDir], gitDirOf);
      expect(dirs, "the worktree's commits go into the original repo's .git").toEqual([path.join(repo, ".git")]);
      // Proof the premise is real: the linked worktree's own index lives UNDER that directory, outside the worktree.
      const perWorktree = git(worktree, "rev-parse", "--git-dir");
      expect(realpathSync(perWorktree).startsWith(path.join(repo, ".git"))).toBe(true);
      expect(realpathSync(perWorktree).startsWith(worktree)).toBe(false);

      // And the arguments Codex is started with carry it as a writable folder.
      const args = codexExecArgs([jobDir, ...dirs]);
      expect(args.join(" ")).toContain(`--add-dir ${path.join(repo, ".git")}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("de-duplicates, and tolerates a probe that throws", () => {
    expect(gitCommonDirs(["/a", "/a/b"], () => "/r/.git")).toEqual(["/r/.git"]);
    expect(gitCommonDirs(["/a"], () => { throw new Error("no git"); })).toEqual([]);
    expect(gitCommonDirs(["/a"], () => "")).toEqual([]);
  });
});

/**
 * BOTH SEATS SPENT (1 Oct 2026). Claude Code said "You've hit your weekly limit · resets Oct 2 at 8am"
 * on the owner's Mac. If Codex says the same, the phase must say that nobody can run it until a plan
 * resets — with both notices — rather than surface Codex's raw failure as though the phase had failed.
 */
describe("both seats spent", () => {
  const CLAUDE_WEEKLY = JSON.stringify({ type: "result", is_error: true, result: "You've hit your weekly limit · resets Oct 2 at 8am (America/Chicago)" });

  it("codexSpentUsage reads a short Codex notice on stdout or stderr, and never a long answer", () => {
    expect(codexSpentUsage({ out: "", err: "You've hit your usage limit. Try again in 3 hours." })).toContain("usage limit");
    expect(codexSpentUsage({ out: "usage limit reached", err: "" })).toBeTruthy();
    expect(codexSpentUsage({ out: `Usage limit reached is what the CLI prints. ${"x".repeat(700)}`, err: "" })).toBeNull();
    expect(codexSpentUsage({ out: "wrote the file", err: "" })).toBeNull();
  });

  it("says so — with both notices — when Codex is spent too, and the phase is NOT taken as done", async () => {
    const calls: string[] = [];
    const out = await runWithCodexFallback({
      runClaude: async () => (calls.push("claude"), { code: 1, out: CLAUDE_WEEKLY, err: "" }),
      // Codex prints its notice and EXITS 0 — the trap: a zero exit must not read as the phase's work.
      runCodex: async () => (calls.push("codex"), { code: 0, out: "", err: "You've hit your usage limit. Try again in 3 hours." }),
      limited: claudeSpentUsage,
      codexLimited: codexSpentUsage,
      usable: () => ({ ok: true, why: "auth_mode=chatgpt" }),
      supports: async () => null,
      addDirs: [],
    });
    expect(calls).toEqual(["claude", "codex"]);
    expect(out.bothSpent).toBe(true);
    expect(out.servedBy).toBe("none");
    expect(out.code, "a notice printed with exit 0 is still not a finished phase").not.toBe(0);
    expect(out.err).toMatch(/Both subscription seats are out of usage/);
    expect(out.err).toMatch(/resets Oct 2 at 8am/);
    expect(out.err).toMatch(/usage limit/);
  });

  it("is unchanged when Codex is fine: it still serves the phase", async () => {
    const out = await runWithCodexFallback({
      runClaude: async () => ({ code: 1, out: CLAUDE_WEEKLY, err: "" }),
      runCodex: async () => ({ code: 0, out: "codex wrote the result file", err: "" }),
      limited: claudeSpentUsage,
      codexLimited: codexSpentUsage,
      usable: () => ({ ok: true, why: "auth_mode=chatgpt" }),
      supports: async () => null,
      addDirs: [],
    });
    expect(out.servedBy).toBe("codex");
    expect(out.bothSpent).toBeUndefined();
  });
});
