import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachmentUrl, chiefChildEnvironment, chiefClaudeArgs, chiefCodexArgs, readChiefRunBudget, run } from "../scripts/duties/partner-session.mjs";
import { maskPrivateInputs } from "../src/worker/ai/scrub";

describe("chief runner", () => {
  it("limits the live runner to workspace files and drops ambient credentials", () => {
    const args = chiefClaudeArgs({ cwd: "/private/chief-fixture", job: { employee: { name: "Wren" } }, model: "sonnet" });
    expect(args[args.indexOf("--tools") + 1]?.split(",").sort()).toEqual(["Edit", "Read", "Write"]);
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("--setting-sources=");
    expect(args).toContain("--safe-mode");
    const { permissions } = JSON.parse(args[args.indexOf("--settings") + 1]!);
    expect(permissions).toMatchObject({
      blockReadsOutsideWorkingDirectories: true,
      blockWritesOutsideWorkingDirectories: true,
    });
    expect(chiefChildEnvironment({ PATH: "/bin", HOME: "/tmp/test", GH_TOKEN: "fixture-only",
      SSH_AUTH_SOCK: "/test/auth.sock", CUSTOM_ACCESS_SECRET: "fixture-only" })).toEqual({ PATH: "/bin", HOME: "/tmp/test" });
    const codex = chiefCodexArgs("/private/chief-fixture/codex-result.json");
    expect(codex).toEqual(expect.arrayContaining(["--ignore-user-config", "--ephemeral", "shell_tool", "apps", 'web_search="disabled"', "permissions.chief.network.enabled=false"]));
  });

  it("only prepares an authenticated attachment request for its exact origin and card", () => {
    const host = "https://os.joinwestpeek.com";
    const route = "/api/work-cards/wc_fixture/attachments/att_fixture";
    expect(attachmentUrl(host, "wc_fixture", route).href).toBe(host + route);
    expect(() => attachmentUrl("https://os.joinwestpeek.com.example.org", "wc_fixture", route)).toThrow();
    expect(() => attachmentUrl(host, "wc_other", route)).toThrow();
    expect(() => attachmentUrl(host, "wc_fixture", `${route}/../../unrelated`)).toThrow();
    expect(() => attachmentUrl(host, "wc_fixture", "//example.org/attachment")).toThrow();
  });

  it("rejects a capped or unmeasured run before accepting its output", () => {
    const budget = readChiefRunBudget();
    const assistant = (id: string, input_tokens: number) =>
      ({ type: "assistant", message: { id, usage: { input_tokens, output_tokens: 10 } } });
    const result = { type: "result", subtype: "success", is_error: false, num_turns: 3 };
    expect(budget(assistant("same", 550_000))).toBeNull();
    expect(budget(assistant("same", 550_000))).toBeNull();
    expect(budget(assistant("next", 500_000))).toBe("The session reached its token limit.");
    expect(readChiefRunBudget()({ ...result, usage: { input_tokens: 5, output_tokens: 4 } })).toBeNull();
    expect(readChiefRunBudget()(result)).toBe("The session did not report its usage.");
    expect(readChiefRunBudget()({ ...result, num_turns: 41 })).toBe("The session reached its turn limit.");
  });

  const job = { phase: "SESSION", employee: { name: "Wren" }, card: { id: "wc_fixture" } };
  const result = (reply: string) => JSON.stringify({
    status: "ok", reply, asks: [{ words: "Fixture", status: "DONE" }],
  });
  const exit = { code: 0, out: "", err: "" };

  it("keeps overlapping chief attempts and duplicate attachment names distinct", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "chief-fixture-"));
    try {
      const attachments = [
        { id: "att_first", filename: "notes.txt", path: "/fixture/first" },
        { id: "att_second", filename: "notes.txt", path: "/fixture/second" },
      ];
      const loadAttachment = async (_card: string, route: string, target: string) => {
        await writeFile(target, route, { flag: "wx" });
      };
      let arrivals = 0;
      let release: () => void = () => undefined;
      const ready = new Promise<void>((resolve) => { release = resolve; });
      const attempt = (reply: string) => run({ ...job, attachments }, { jobDir }, {
        loadAttachment,
        runClaude: async ({ cwd, prompt }) => {
          await writeFile(join(cwd, "result-SESSION.json"), result(reply));
          if (++arrivals === 2) release();
          await ready;
          for (const attachment of attachments) {
            const path = join(cwd, "attachments", attachment.id + ".txt");
            expect(prompt).toContain(path);
            expect(await readFile(path, "utf8")).toBe(attachment.path);
          }
          return exit;
        },
      });
      const [old, current] = await Promise.all([attempt("Earlier reply"), attempt("Current reply")]);
      expect(old.reply).toBe("Earlier reply");
      expect(current.reply).toBe("Current reply");
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  it("refuses linked or oversized output even if the session process exits successfully", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "chief-fixture-"));
    try {
      const external = join(jobDir, "outside.json");
      await writeFile(external, result("Fixture private content"));
      const attempt = (write: (target: string) => Promise<void>) => run(job, { jobDir }, {
        runClaude: async ({ cwd }) => {
          await write(join(cwd, "result-SESSION.json"));
          return exit;
        },
      });
      expect(await attempt((target) => symlink(external, target))).toMatchObject({ status: "failed" });
      expect(await attempt((target) => writeFile(target, result("x".repeat(300_000))))).toMatchObject({ status: "failed" });
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  it("hands the original fund turn to the subscribed Codex seat when Claude is out", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "chief-fixture-"));
    const request = "Summarize the term sheet for Larkspur Lantern Holdings.";
    const calls: string[] = [];
    try {
      const outcome = await run({ ...job, request }, { jobDir }, {
        codexUsable: () => ({ ok: true }),
        runClaude: async ({ prompt }) => {
          expect(prompt).toContain(request);
          calls.push("Claude");
          return { code: 1, out: "", err: "Usage limit reached" };
        },
        runCodex: async ({ prompt, resultPath }) => {
          expect(prompt).toContain(request);
          calls.push("Codex");
          await writeFile(resultPath, result("Prepared a summary."));
          return exit;
        },
      });
      expect(calls).toEqual(["Claude", "Codex"]);
      expect(outcome).toMatchObject({ status: "ok", reply: "Prepared a summary.", routing: [expect.stringContaining("Claude Code"), expect.stringContaining("Codex")] });
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  it("keeps a turn pending when the subscription is unavailable and refuses to call API-key Codex", async () => {
    const jobDir = await mkdtemp(join(tmpdir(), "chief-fixture-"));
    try {
      const outcome = await run(job, { jobDir }, {
        codexUsable: () => ({ ok: false }),
        runClaude: async () => ({ code: 1, out: "", err: "" }),
        runCodex: async () => { throw new Error("Codex must be on a subscription"); },
      });
      expect(outcome).toMatchObject({ status: "failed", model_unavailable: true, waits_seconds: 1800 });
    } finally {
      await rm(jobDir, { recursive: true, force: true });
    }
  });

  it("masks marked deal figures, restores their meaning and leaves everyday text alone", () => {
    const everyday = "Sort the $25 event tickets and group the last 8 responses.";
    expect(maskPrivateInputs([everyday], [], true).inputs).toEqual([everyday]);
    const fund = "Larkspur Lantern Holdings: the term sheet lists a management fee of 1.75% and post-money of $7.5M.";
    const masked = maskPrivateInputs([fund], ["Larkspur Lantern Holdings"], true);
    expect(masked.inputs[0]).not.toMatch(/Larkspur|term sheet|management fee|1\.75|7\.5|post-money/i);
    expect(masked.restore(masked.inputs[0]!)).toBe(fund);
    expect(maskPrivateInputs(["Larkspur Lantern Holdings put in $7.5M."], ["Larkspur Lantern Holdings"], true).inputs[0]).not.toMatch(/Larkspur|7\.5/);
  });
});
