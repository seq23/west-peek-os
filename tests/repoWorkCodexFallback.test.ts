import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { CODEX_BUILD_NOTE, codexExecArgs, codexSeatUsable, finishCodexBuild, isGitSandboxBlock, runWithCodexFallback, type RunResult } from "../scripts/lib/codex-seat.mjs";
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

describe("Codex edits; the runner commits, pushes and opens the PR — never merges (31 Oct 2026, boss-os #187)", () => {
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim();

  function scratch(existingPr: { url: string; number: number } | null = null) {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "codex-finish-")));
    const origin = path.join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const main = path.join(root, "main");
    git(root, "clone", "-q", origin, main);
    git(main, "commit", "-q", "--allow-empty", "-m", "init");
    git(main, "push", "-q", "origin", "HEAD:main");
    const wt = path.join(root, "wt");
    git(main, "worktree", "add", "-q", wt, "-b", "work/wpc-probe", "origin/main");
    const gh: string[][] = [];
    const run = (cmd: string, args: string[], o: { cwd: string }) => {
      if (cmd === "gh") {
        gh.push(args);
        if (args[1] === "view") return existingPr ? { status: 0, stdout: JSON.stringify({ ...existingPr, state: "OPEN" }), stderr: "" } : { status: 1, stdout: "", stderr: "no pull requests found" };
        return { status: 0, stdout: "https://github.com/seq23/probe/pull/7\n", stderr: "" };
      }
      try { return { status: 0, stdout: execFileSync(cmd, args, { cwd: o.cwd, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }), stderr: "" }; }
      catch (e: any) { return { status: e.status ?? 1, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }; }
    };
    return { root, origin, main, wt, gh, run };
  }

  it("names no git directory as writable: Codex's args carry only the folders the runner passes", () => {
    const a = codexExecArgs(["/job"]).join(" ");
    expect(a).not.toMatch(/\.git\b/);
  });

  it("turns Codex's uncommitted edit (and its index.lock failure) into a commit, a pushed branch and a PR against main", () => {
    const s = scratch();
    try {
      writeFileSync(path.join(s.wt, "fix.txt"), "the change");
      const out = { phase: "BUILD", status: "failed", reason: "git commit failed: Unable to create .git/worktrees/wt/index.lock: Operation not permitted", proof: "npm run validate passed", pr_title: "Make the flyers scroll" };
      const fin = finishCodexBuild({ cwd: s.wt, branch: "work/wpc-probe", out, run: s.run });
      expect(fin.ok).toBe(true);
      if (!fin.ok) return;
      expect(fin.result.status).toBe("ok");
      expect(fin.result.pr_number).toBe(7);
      expect(fin.result.pr_url).toBe("https://github.com/seq23/probe/pull/7");
      expect(fin.result.reason).toBeUndefined();
      expect(fin.result.proof).toContain("npm run validate passed");
      expect(fin.result.proof).toContain("outside Codex's sandbox");
      expect(git(s.wt, "status", "--porcelain")).toBe("");
      expect(git(s.wt, "log", "-1", "--format=%s")).toBe("Make the flyers scroll");
      expect(git(s.root, "--git-dir", s.origin, "rev-parse", "refs/heads/work/wpc-probe")).toBe(git(s.wt, "rev-parse", "HEAD"));
      expect(git(s.root, "--git-dir", s.origin, "log", "--format=%s", "main")).toBe("init");
      const create = s.gh.find((a) => a[1] === "create") ?? [];
      expect(create[create.indexOf("--base") + 1]).toBe("main");
      expect(create[create.indexOf("--head") + 1]).toBe("work/wpc-probe");
      expect(s.gh.some((a) => a.includes("merge"))).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("reuses the open PR on a rebuild instead of opening a second", () => {
    const s = scratch({ url: "https://github.com/seq23/probe/pull/3", number: 3 });
    try {
      writeFileSync(path.join(s.wt, "fix.txt"), "the rebuild");
      const fin = finishCodexBuild({ cwd: s.wt, branch: "work/wpc-probe", out: { phase: "BUILD", status: "ok", proof: "p" }, run: s.run });
      expect(fin.ok && fin.result.pr_number).toBe(3);
      expect(s.gh.some((a) => a[1] === "create")).toBe(false);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("refuses main, Codex's own real failure, a needs_runs turn, and a build with nothing in it", () => {
    const s = scratch();
    try {
      writeFileSync(path.join(s.main, "x.txt"), "x");
      const onMain = finishCodexBuild({ cwd: s.main, branch: "main", out: { phase: "BUILD", status: "ok" }, run: s.run });
      expect(onMain.ok ? "" : onMain.tag).toBe("REFUSED_PROTECTED_BRANCH");
      writeFileSync(path.join(s.wt, "y.txt"), "y");
      const real = finishCodexBuild({ cwd: s.wt, branch: "work/wpc-probe", out: { phase: "BUILD", status: "failed", reason: "npm run validate failed: 3 tests red" }, run: s.run });
      expect(real.ok ? "" : real.tag).toBe("CODEX_FAILED");
      const runs = finishCodexBuild({ cwd: s.wt, branch: "work/wpc-probe", out: { phase: "BUILD", status: "needs_runs", runs: [] }, run: s.run });
      expect(runs.ok ? "" : runs.tag).toBe("NOT_FINISHED");
      expect(git(s.wt, "status", "--porcelain")).not.toBe("");
      rmSync(path.join(s.wt, "y.txt"));
      const empty = finishCodexBuild({ cwd: s.wt, branch: "work/wpc-probe", out: { phase: "BUILD", status: "ok" }, run: s.run });
      expect(empty.ok ? "" : empty.tag).toBe("NO_CHANGES");
      expect(s.gh).toEqual([]);
    } finally {
      rmSync(s.root, { recursive: true, force: true });
    }
  });

  it("tells Codex the runner does the git steps", () => {
    expect(CODEX_BUILD_NOTE).toContain("UNCOMMITTED");
    expect(CODEX_BUILD_NOTE).toContain("never merges");
    expect(isGitSandboxBlock({ reason: "Unable to create index.lock: Operation not permitted" })).toBe(true);
    expect(isGitSandboxBlock({ reason: "npm test failed" })).toBe(false);
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
