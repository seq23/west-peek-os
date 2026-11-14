import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { codexSpentUsage, firstRunVerdict, readReview, REVIEW_ROUNDS, reviewAndFix, runReview } from "../scripts/duties/web-property-change.mjs";

/**
 * THE v1.0 BAR ON THE MAC (owner, 13 Nov 2026: "v1.0 final with persistence and veteran UX/UI POV"). A fresh-eyes
 * review before the PR is read, its blocking findings fixed by the builder a bounded number of times, then a named
 * stop; and a first run on the preview that must really pass before any preview is sent. The CLIs are fakes.
 */
const SPENT = "You've hit your usage limit. Try again in 3 hours.";
function fakes(claudeSpent: boolean) {
  const calls: string[] = [];
  return {
    calls,
    runBrain: async () => (calls.push("claude"), claudeSpent ? { code: 1, out: "", err: SPENT } : { code: 0, out: "{}", err: "" }),
    runWorker: async () => (calls.push("codex"), { code: 0, out: "wrote a review", err: "" }),
    brainSpent: (r: { out: string; err: string }) => (`${r.out}${r.err}`.includes("usage limit") ? SPENT : null),
    workerSpent: codexSpentUsage,
    workerUsable: () => ({ ok: true, why: "auth_mode=chatgpt" }),
    resetsIn: () => 3 * 3600,
  };
}

describe("the v1.0 bar on the Mac: a fresh-eyes review and a first run", () => {
  it("the review keeps a private job's routing: Claude only, never Codex or a free route, even with Claude out of usage", async () => {
    const jobDir = mkdtempSync(path.join(tmpdir(), "wpos-review-"));
    try {
      const prompt = "REQUEST: build Scooter's dashboard with sign-in.";
      const priv = fakes(true);
      const r = await runReview({ job: { card_kind: "WEB_PROPERTY_CHANGE", private_model_only: true }, prompt, jobDir }, priv);
      expect(priv.calls, "private review work never leaves Claude").toEqual(["claude"]);
      expect(r.servedBy).toBe("claude");
      expect(readFileSync(path.join(jobDir, "routes.log"), "utf8")).toMatch(/REVIEW → brain: kept on Claude/);
      // The same turn on a job that is not private may fall back to Codex, held for Claude's check: the test can fail.
      const open = fakes(true);
      const o = await runReview({ job: { card_kind: "WEB_PROPERTY_CHANGE" }, prompt, jobDir: mkdtempSync(path.join(tmpdir(), "wpos-review-")) }, open);
      expect(open.calls).toEqual(["claude", "codex"]);
      expect(o.heldForClaude).toBeTruthy();
    } finally {
      rmSync(jobDir, { recursive: true, force: true });
    }
  });

  it("blocking findings go back to the builder, at most REVIEW_ROUNDS times, then a named stop; a clean review passes with what was fixed", async () => {
    const blocking = { findings: [{ lens: "engineer", finding: "notes are kept in memory and vanish on reload", blocking: true }] };
    const clean = { findings: [{ lens: "ux", finding: "the empty state could say more", blocking: false }], summary: "finished" };
    // Fixed on the first round.
    let rebuilds = 0;
    const fixed = await reviewAndFix({ review: async (round) => ({ verdict: readReview(JSON.stringify(round === 0 ? blocking : clean)) }), rebuild: async () => (rebuilds++, {}) });
    expect(rebuilds).toBe(1);
    expect(fixed.line).toMatch(/1 fixed, 1 note — finished/);
    // Never fixed: exactly REVIEW_ROUNDS fix turns, then a stop a human sees, never a pass.
    rebuilds = 0;
    const stuck = await reviewAndFix({ review: async () => ({ verdict: readReview(JSON.stringify(blocking)) }), rebuild: async () => (rebuilds++, {}) });
    expect(rebuilds).toBe(REVIEW_ROUNDS);
    expect(stuck.report).toMatchObject({ phase: "BUILD", status: "failed" });
    expect(stuck.report!.reason).toMatch(/^NAMED STOP \[REVIEW_NOT_MET\].*vanish on reload/);
    // No readable review file is a stop, not a pass.
    const silent = await reviewAndFix({ review: async () => ({ verdict: readReview("not json") }), rebuild: async () => ({}) });
    expect(silent.report!.reason).toMatch(/^NAMED STOP \[REVIEW_UNREADABLE\]/);
    // A wait (the review's route out of usage) is returned as it is.
    const wait = { phase: "BUILD", status: "failed", reason: "NAMED WAIT [CLAUDE_LIMIT] …", waits_seconds: 600 };
    expect((await reviewAndFix({ review: async () => ({ report: wait }), rebuild: async () => ({}) })).report).toBe(wait);
  });

  it("the first run passes only with a zero exit that printed FIRST_RUN OK; no script, a failure or silence stops the preview by name", () => {
    expect(firstRunVerdict({ hasScript: false })).toMatchObject({ ok: false });
    expect(firstRunVerdict({ hasScript: false }).line).toMatch(/^NAMED STOP \[FIRST_RUN_MISSING\]/);
    expect(firstRunVerdict({ hasScript: true, exit: 1, out: "sign-in returned 401" }).line).toMatch(/^NAMED STOP \[FIRST_RUN_FAILED\].*401/);
    expect(firstRunVerdict({ hasScript: true, exit: 0, out: "loaded the page" }).line).toMatch(/^NAMED STOP \[FIRST_RUN_SILENT\]/);
    const ok = firstRunVerdict({ hasScript: true, exit: 0, out: "> first-run\nFIRST_RUN OK signed in, 12 real rows, saved a note, reload kept it" });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.line).toContain("saved a note, reload kept it");
  });
});
