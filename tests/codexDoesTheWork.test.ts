import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRoles, routeFor, runInOrder, ROLES_FILE } from "../scripts/lib/model-roles.mjs";
import { CLAUDE_CHECK_NOTE, codexSpentUsage, runModel, spentReport } from "../scripts/duties/web-property-change.mjs";

/**
 * WHICH ROUTE DOES A MAC JOB'S TURN (owner, 13 Nov 2026). By job class and privacy, from the one rule table:
 *   not private: HARD → Claude, then Codex (held for Claude's check); CLEAR_BRIEF and SHORT → Codex, then Claude.
 *   private:     HARD → Claude only, a named wait when Claude is out; CLEAR_BRIEF and SHORT → Claude, then Codex.
 * The CLIs are fakes: each records that it was called. Names and figures are made up.
 */
const SPENT = "You've hit your usage limit. Try again in 3 hours.";
const spentWords = (r: { out: string; err: string }) => (`${r.out}${r.err}`.includes("usage limit") ? SPENT : null);
function fakes(opts: { claudeSpent?: boolean; codexSpent?: boolean; codexUsable?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    runBrain: async () => (calls.push("claude"), opts.claudeSpent ? { code: 1, out: "", err: SPENT } : { code: 0, out: "{}", err: "" }),
    runWorker: async () => (calls.push("codex"), opts.codexSpent ? { code: 0, out: "", err: SPENT } : { code: 0, out: "wrote result", err: "" }),
    brainSpent: spentWords,
    workerSpent: codexSpentUsage,
    workerUsable: () => (opts.codexUsable === false ? { ok: false, why: "auth.json records an API key, not the ChatGPT plan" } : { ok: true, why: "auth_mode=chatgpt" }),
    resetsIn: () => 3 * 3600,
  };
}
const PLAIN = "REQUEST: make the RSVP button on the Rooms page orange and add the 14 Nov date.";
const WEB = "WEB_PROPERTY_CHANGE";
/** The real table with one made-up kind added, so CLEAR_BRIEF and SHORT phases can be asked for. */
const rolesWith = () => {
  const cfg = JSON.parse(readFileSync(ROLES_FILE, "utf8"));
  cfg.jobs.TIDY_UP = { SWEEP: "CLEAR_BRIEF", LIST: "SHORT" };
  return loadRoles(JSON.stringify(cfg));
};

describe("which route does a Mac job's turn", () => {
  it("hard work that is not private leads on Claude; Codex takes it only when Claude is out of usage, and what Codex did is held for Claude's check", async () => {
    for (const phase of ["PLAN", "BUILD"]) {
      const route = routeFor({ kind: WEB, phase, prompt: PLAIN });
      expect(route, phase).toMatchObject({ jobClass: "HARD", private: false, order: ["claude", "codex"], held: true });
      const fine = fakes();
      expect((await runInOrder({ route, ...fine })).servedBy).toBe("claude");
      expect(fine.calls, "Codex is not asked while Claude answers").toEqual(["claude"]);

      const out = fakes({ claudeSpent: true });
      const r = await runInOrder({ route, ...out });
      expect(out.calls).toEqual(["claude", "codex"]);
      expect(r.servedBy).toBe("codex");
      expect(r.heldForClaude, "Codex's hard work does not land or reach a partner unchecked").toContain("NAMED WAIT [CLAUDE_CHECK]");
      // Held even though Codex wrote a result: the phase reports a wait, never Codex's result.
      const report = spentReport(phase, r, { phase, status: "ok" });
      expect(report).toMatchObject({ phase, status: "failed", waits_seconds: 3 * 3600 });
      expect(report!.reason).toContain("Claude checks it before it lands or reaches a partner");
    }
    // A kind or phase nobody named is HARD: the strictest row, never a guess at something lighter.
    expect(routeFor({ kind: "SOMETHING_NEW", phase: "BUILD", prompt: PLAIN })).toMatchObject({ jobClass: "HARD", order: ["claude", "codex"], held: true });
    expect(routeFor({ kind: WEB, phase: "SOMETHING_NEW", prompt: PLAIN })).toMatchObject({ jobClass: "HARD", held: true });
  });

  it("the held turn is retried on Claude only, with the check written into its prompt, and the hold ends when Claude has answered", async () => {
    const jobDir = mkdtempSync(path.join(tmpdir(), "wpos-held-"));
    try {
      const job = { card_kind: WEB };
      const prompts: string[] = [];
      const first = fakes({ claudeSpent: true });
      writeFileSync(path.join(jobDir, "result-BUILD.json"), JSON.stringify({ phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://example.test/pull/1" }));
      const held = await runModel({ job, phase: "BUILD", prompt: PLAIN, jobDir }, first);
      expect(held.heldForClaude).toBeTruthy();
      expect(existsSync(path.join(jobDir, "codex-result-BUILD.json")), "Codex's result is kept for Claude to read").toBe(true);

      // Claude is still out: the retry does not go back to Codex, and it is a wait again.
      const still = fakes({ claudeSpent: true });
      const again = await runModel({ job, phase: "BUILD", prompt: PLAIN, jobDir }, still);
      expect(still.calls, "a held turn never goes to Codex a second time").toEqual(["claude"]);
      expect(spentReport("BUILD", { ...again, out: SPENT })!.waits_seconds).toBeGreaterThan(0);

      // Claude is back: it is told to check Codex's work, and the hold is over for the run after.
      const back = fakes();
      const checked = await runModel({ job, phase: "BUILD", prompt: PLAIN, jobDir }, { ...back, runBrain: async () => (back.calls.push("claude"), prompts.push("asked"), { code: 0, out: "{}", err: "" }) });
      expect(back.calls).toEqual(["claude"]);
      expect(checked.servedBy).toBe("claude");
      expect(readFileSync(path.join(jobDir, "routes.log"), "utf8")).toContain("Claude checks it now");
      expect(CLAUDE_CHECK_NOTE).toContain("Check it against the request and the plan");
      const after = fakes({ claudeSpent: true });
      await runModel({ job, phase: "BUILD", prompt: PLAIN, jobDir }, after);
      expect(after.calls, "with the check done, the row is the ordinary one again").toEqual(["claude", "codex"]);
    } finally {
      rmSync(jobDir, { recursive: true, force: true });
    }
  });

  it("a private hard job (a private website BUILD) waits for Claude and never reaches Codex — in the prompt, in a file beside it, in a file it cannot read, or marked by the Worker", async () => {
    // Owner ruling, 4 Nov 2026: private is ONLY a committed LP's name (the Worker's `private_model_only`) or
    // deal terms / fund figures. A mention of LPs, prospects, investors or the TLC class page is not.
    for (const prompt of [`${PLAIN}\nAlso list our limited partners on the about page.`, `${PLAIN}\nThe LPs want the deck link.`, `${PLAIN}\nAdd the children's class page.`]) {
      expect(routeFor({ kind: WEB, phase: "BUILD", prompt }).private, prompt).toBe(false);
    }
    const dir = mkdtempSync(path.join(tmpdir(), "wpos-roles-"));
    const unreadable = mkdtempSync(path.join(tmpdir(), "wpos-roles-"));
    try {
      writeFileSync(path.join(dir, "notes.md"), "Investor update: the cap table and pro rata rights.");
      writeFileSync(path.join(unreadable, "list.pdf"), "%PDF");
      const privateTurns = [
        { prompt: `${PLAIN}\nPost the term sheet summary.` },
        { prompt: `${PLAIN}\nShow the fund size and the management fee.` },
        { prompt: `${PLAIN}\nAdd each LP's commitment amount.` },
        { prompt: PLAIN, privateModelOnly: true },
        { prompt: PLAIN, materialDirs: [dir] },
        { prompt: PLAIN, materialDirs: [unreadable] },
      ];
      for (const turn of privateTurns) {
        for (const phase of ["PLAN", "BUILD", "A_PHASE_NOBODY_NAMED"]) {
          const route = routeFor({ kind: WEB, phase, ...turn });
          expect(route, JSON.stringify(turn)).toMatchObject({ jobClass: "HARD", private: true, workClass: "PRIVATE_HARD", order: ["claude"], held: false });
          // Claude answers: Claude did it.
          const fine = fakes();
          await runInOrder({ route, ...fine });
          expect(fine.calls).toEqual(["claude"]);
          // Claude is out of usage and Codex is signed in and idle: Codex is still never asked.
          const out = fakes({ claudeSpent: true });
          const r = await runInOrder({ route, ...out });
          expect(out.calls, "Codex never took private hard work").toEqual(["claude"]);
          expect(r.servedBy).toBe("claude");
          expect(r.heldForClaude).toBeUndefined();
          // And the wait is a wait: named, with a reset time the Worker holds the card for, so no attempt is charged.
          const report = spentReport(phase, { ...r, out: SPENT });
          expect(report).toMatchObject({ phase, status: "failed" });
          expect(report!.waits_seconds).toBeGreaterThanOrEqual(60);
          expect(report!.reason).toContain("NAMED WAIT [CLAUDE_LIMIT]");
        }
      }
      expect(routeFor({ kind: WEB, phase: "BUILD", prompt: PLAIN, privateModelOnly: true }).why).toContain("Private hard work waits for Claude and never goes to Codex");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(unreadable, { recursive: true, force: true });
    }
  });

  it("a private SHORT or CLEAR-BRIEF job reaches Codex when Claude is unavailable: Claude first, Codex as its backup", async () => {
    const roles = rolesWith();
    for (const [kind, phase, jobClass] of [[WEB, "LAND", "SHORT"], ["TIDY_UP", "LIST", "SHORT"], ["TIDY_UP", "SWEEP", "CLEAR_BRIEF"]] as const) {
      const route = routeFor({ kind, phase, prompt: `${PLAIN}\nThe side letter is in the folder.`, privateModelOnly: true }, roles);
      expect(route, `${kind} ${phase}`).toMatchObject({ jobClass, private: true, workClass: "PRIVATE", order: ["claude", "codex"], held: false });
      const fine = fakes();
      expect((await runInOrder({ route, ...fine })).servedBy).toBe("claude");
      expect(fine.calls).toEqual(["claude"]);
      const out = fakes({ claudeSpent: true });
      const r = await runInOrder({ route, ...out });
      expect(out.calls).toEqual(["claude", "codex"]);
      expect(r.servedBy, "Codex is the backup to Claude for private work that is not hard").toBe("codex");
      expect(spentReport(phase, r, { phase, status: "ok" }), "its result stands: nothing is held").toBeNull();
      // Both out of usage: a wait for the earlier reset, not a failure.
      const both = fakes({ claudeSpent: true, codexSpent: true });
      const w = await runInOrder({ route, ...both });
      expect(w).toMatchObject({ servedBy: "none", bothSpent: true, resetsInSeconds: 3 * 3600 });
      expect(spentReport(phase, w)).toMatchObject({ status: "failed", waits_seconds: 3 * 3600 });
    }
  });

  it("Codex counts only when it is signed in with her ChatGPT plan: on an API key it is never run, and the turn waits for Claude", async () => {
    const route = routeFor({ kind: WEB, phase: "LAND", prompt: PLAIN, privateModelOnly: true });
    const f = fakes({ claudeSpent: true, codexUsable: false });
    const r = await runInOrder({ route, ...f });
    expect(f.calls).toEqual(["claude"]);
    expect(r.servedBy).toBe("claude");
    expect(r.err).toContain("Codex cannot take it");
    expect(spentReport("LAND", { ...r, out: SPENT })!.waits_seconds).toBeGreaterThanOrEqual(60);
  });

  it("clear-brief and short work that is not private starts on Codex and moves to Claude when Codex's plan is spent; both spent is a wait", async () => {
    const roles = rolesWith();
    for (const [kind, phase] of [[WEB, "LAND"], ["TIDY_UP", "SWEEP"], ["TIDY_UP", "LIST"]] as const) {
      const route = routeFor({ kind, phase, prompt: PLAIN }, roles);
      expect(route).toMatchObject({ private: false, order: ["codex", "claude"], held: false });
      const fine = fakes();
      expect((await runInOrder({ route, ...fine })).servedBy).toBe("codex");
      expect(fine.calls).toEqual(["codex"]);
      for (const worker of [
        { code: 75, out: "", err: "NAMED STOP [CODEX_LIMIT] resets in 3 hours" },
        { code: 0, out: "", err: SPENT },
      ]) {
        const f = fakes();
        const r = await runInOrder({ route, ...f, runWorker: async () => (f.calls.push("codex"), worker) });
        expect(f.calls, "the job moves up a rung by itself").toEqual(["codex", "claude"]);
        expect(r.servedBy).toBe("claude");
      }
      const both = fakes({ claudeSpent: true, codexSpent: true });
      const w = await runInOrder({ route, ...both });
      expect(w.servedBy).toBe("none");
      expect(w.code).not.toBe(0);
      const report = spentReport(phase, w);
      expect(report).toMatchObject({ phase, status: "failed", waits_seconds: 3 * 3600 });
      expect(report!.reason).toContain("out of usage");
    }
  });
});
