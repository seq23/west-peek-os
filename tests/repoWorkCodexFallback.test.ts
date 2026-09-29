import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { codexExecArgs, codexSeatUsable, runWithCodexFallback, type RunResult } from "../scripts/lib/codex-seat.mjs";
import { claudeSpentUsage } from "../scripts/duties/web-property-change.mjs";

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
