import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMIT_SUBJECT, lsRemoteHash, runProbe } from "../scripts/probes/codex-repo-job-probe.mjs";
import { PDF_CODE_WORD, claudeArgs, codexArgs, judge, promptFor, solidPng, textPdf, verdictFor } from "../scripts/probes/seat-attachments-probe.mjs";

/**
 * THE TWO MAC PROBES, PROVEN TO CATCH WHAT THEY EXIST TO CATCH (1 Oct 2026).
 *
 * These are scripts the owner runs on her Mac to settle what the cloud sandbox cannot: whether the Codex
 * CLI can commit and push from a linked worktree, and whether either seat can read a picture or a PDF.
 * A probe that reports PROVEN for the wrong reason is worse than no probe, so each is driven here with
 * FAKE `codex` programs against REAL git repositories — one that does everything, one that edits but
 * cannot commit, one that says its plan is spent, one that does nothing — and the verdict must follow
 * what git shows, not what the fake says.
 *
 * WHAT THIS DOES NOT PROVE: anything about the real Codex or Claude Code CLIs. That is what the probes are for.
 */

const roots: string[] = [];
afterAll(() => roots.forEach((r) => rmSync(r, { recursive: true, force: true })));

function fakeCodex(body: string): { bin: string; home: string } {
  const root = mkdtempSync(path.join(tmpdir(), "wp-fake-codex-"));
  roots.push(root);
  const home = path.join(root, "home");
  mkdirSync(path.join(home, ".codex"), { recursive: true });
  writeFileSync(path.join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null }));
  const bin = path.join(root, "codex");
  writeFileSync(
    bin,
    `#!/bin/sh
if [ "$1" = "exec" ] && [ "$2" = "--help" ]; then echo "  --sandbox <MODE>   --add-dir <DIR>"; exit 0; fi
cat > /dev/null
${body}
`,
  );
  chmodSync(bin, 0o755);
  return { bin, home };
}

const COMMIT_AND_PUSH = `printf 'codex-probe\\n' > PROBE.txt
git add PROBE.txt
git commit -q -m "${COMMIT_SUBJECT}"
git push -q origin HEAD:refs/heads/probe-branch
echo DONE`;

const status = (rows: Array<{ q: string; status: string }>, needle: string): string => rows.find((r) => r.q.includes(needle))?.status ?? "MISSING";

describe("the Codex repo-job probe", () => {
  it("reports every step PROVEN only when git shows the file, the commit and the push", async () => {
    const f = fakeCodex(COMMIT_AND_PUSH);
    const { rows } = await runProbe({ codexBin: f.bin, home: f.home });
    expect(rows.map((r) => r.status)).toEqual(["PROVEN", "PROVEN", "PROVEN", "PROVEN"]);
  }, 60_000);

  it("catches a Codex that edits but cannot commit — the .git-write unknown it exists for", async () => {
    // Writes the file, then "fails" the commit exactly as a sandbox that protects .git would.
    const f = fakeCodex(`printf 'codex-probe\\n' > PROBE.txt\necho "fatal: cannot lock ref" >&2\nexit 1`);
    const { rows } = await runProbe({ codexBin: f.bin, home: f.home });
    expect(status(rows, "EDIT")).toBe("PROVEN");
    expect(status(rows, "COMMIT")).toBe("FAILED");
    expect(status(rows, "PUSH")).toBe("FAILED");
  }, 60_000);

  it("does not believe a model that SAYS it committed", async () => {
    const f = fakeCodex(`echo "I created PROBE.txt, committed and pushed it. DONE"`);
    const { rows } = await runProbe({ codexBin: f.bin, home: f.home });
    expect(status(rows, "EDIT")).toBe("FAILED");
    expect(status(rows, "COMMIT")).toBe("FAILED");
    expect(status(rows, "PUSH")).toBe("FAILED");
  }, 60_000);

  it("reads a spent plan as UNTESTED, never as a failed capability", async () => {
    const f = fakeCodex(`echo "You've hit your usage limit. Try again in 3 hours." >&2\nexit 1`);
    const { rows } = await runProbe({ codexBin: f.bin, home: f.home });
    expect(rows.at(-1)!.status).toBe("UNTESTED");
    expect(rows.at(-1)!.evidence).toMatch(/out of usage/);
  }, 60_000);

  it("refuses to run on a seat that has drifted off the subscription (it would bill per token)", async () => {
    const f = fakeCodex(COMMIT_AND_PUSH);
    writeFileSync(path.join(f.home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey" }));
    const { rows } = await runProbe({ codexBin: f.bin, home: f.home });
    expect(rows.at(-1)!.status).toBe("UNTESTED");
    expect(rows.at(-1)!.evidence).toMatch(/subscription|not usable/);
  }, 60_000);

  it("a Codex whose help text lacks --add-dir is FAILED on the flag check and nothing is run", async () => {
    const f = fakeCodex(COMMIT_AND_PUSH);
    writeFileSync(f.bin, `#!/bin/sh\nif [ "$2" = "--help" ]; then echo "  --sandbox <MODE>"; exit 0; fi\ncat >/dev/null\n${COMMIT_AND_PUSH}\n`);
    const { rows } = await runProbe({ codexBin: f.bin, home: f.home });
    expect(rows[0]).toMatchObject({ status: "FAILED" });
    expect(rows[0]!.evidence).toMatch(/--add-dir/);
    expect(rows).toHaveLength(2);
  }, 60_000);

  it("lsRemoteHash accepts a real ls-remote line and nothing else", () => {
    expect(lsRemoteHash(`${"d".repeat(40)}\tHEAD`)).toBe("d".repeat(40));
    expect(lsRemoteHash("fatal: could not read Username for 'https://github.com'")).toBeNull();
  });
});

describe("the attachments probe", () => {
  it("builds a PNG and a PDF a real reader would accept, and a verdict only a real reading satisfies", () => {
    const png = solidPng(16, 16, [220, 20, 20]);
    expect(String.fromCharCode(png[1]!, png[2]!, png[3]!)).toBe("PNG");
    expect(new TextDecoder("latin1").decode(textPdf(PDF_CODE_WORD))).toContain(PDF_CODE_WORD);
    expect(verdictFor("image", "Red")).toBe(true);
    expect(verdictFor("image", "I can't see an image")).toBe(false);
    expect(verdictFor("pdf", `It says ${PDF_CODE_WORD}`)).toBe(true);
    expect(verdictFor("pdf", "ZEBRA")).toBe(false);
  });

  it("treats a spent plan or a missing CLI as UNTESTED and a confident wrong answer as FAILED", () => {
    expect(judge("pdf", { started: true, code: 1, out: "You've hit your weekly limit · resets Oct 2 at 8am", err: "" }).status).toBe("UNTESTED");
    expect(judge("pdf", { started: false, out: "", err: "ENOENT" }).status).toBe("UNTESTED");
    expect(judge("image", { started: true, code: 0, out: "Blue", err: "" }).status).toBe("FAILED");
    expect(judge("image", { started: true, code: 0, out: "Red", err: "" }).status).toBe("PROVEN");
  });

  it("hands Codex the picture with -i and Claude Code a path to Read, and nothing writable to either", () => {
    expect(codexArgs("image", "/tmp/p.png", "q")).toEqual(expect.arrayContaining(["-i", "/tmp/p.png", "--sandbox", "read-only"]));
    expect(claudeArgs("q")).toEqual(["-p", "q", "--allowedTools", "Read"]);
    expect(promptFor("image", "probe.png", "claude_code")).toContain("./probe.png");
  });
});
