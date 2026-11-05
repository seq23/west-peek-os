import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { routeFor, runByRole } from "../scripts/lib/model-roles.mjs";
import { codexSpentUsage, spentReport } from "../scripts/duties/web-property-change.mjs";

/**
 * CODEX DOES THE HANDS-ON WORK, CLAUDE IS THE BRAINS (owner, 3 Nov 2026), and confidential text never
 * reaches Codex, whose no-training basis on her ChatGPT plan is a setting, not a contract.
 * The CLIs are fakes: each records that it was called.
 */
function fakes(worker: { code: number; out: string; err: string }) {
  const calls: string[] = [];
  return {
    calls,
    runBrain: async () => (calls.push("claude"), { code: 0, out: "{}", err: "" }),
    runWorker: async () => (calls.push("codex"), worker),
  };
}
const PLAIN = "REQUEST: make the RSVP button on the Rooms page orange and add the 14 Nov date.";

describe("who does the work on the Mac", () => {
  it("a web-property change BUILD goes to the worker (Codex); its PLAN stays with the brain", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wpos-roles-"));
    try {
      writeFileSync(path.join(dir, "brief.md"), "Make the button orange.");
      writeFileSync(path.join(dir, "logo.png"), "png");
      const build = routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt: PLAIN, materialDirs: [dir] });
      expect(build.role).toBe("worker");
      const f = fakes({ code: 0, out: "wrote result", err: "" });
      const r = await runByRole({ route: build, runBrain: f.runBrain, runWorker: f.runWorker, workerSpent: codexSpentUsage });
      expect(r.servedBy).toBe("codex");
      expect(f.calls).toEqual(["codex"]);
      expect(routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "PLAN", prompt: PLAIN }).role).toBe("brain");
      expect(routeFor({ kind: "SOMETHING_NEW", phase: "BUILD", prompt: PLAIN }).role).toBe("brain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a job carrying confidential text never goes to the worker — in the prompt, in a file beside it, or in a file it cannot read", async () => {
    // Owner ruling, 4 Nov 2026: confidential is ONLY a committed LP's name (the Worker's `private_model_only`) or
    // deal terms / fund figures. A mention of LPs, prospects, investors or the TLC class page is not.
    for (const prompt of [`${PLAIN}\nAlso list our limited partners on the about page.`, `${PLAIN}\nThe LPs want the deck link.`, `${PLAIN}\nAdd the children's class page.`]) {
      expect(routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt }).role, prompt).toBe("worker");
    }
    const texts = [`${PLAIN}\nPost the term sheet summary.`, `${PLAIN}\nShow the fund size and the management fee.`, `${PLAIN}\nAdd each LP's commitment amount.`];
    for (const prompt of texts) {
      const route = routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt });
      expect(route.role, prompt).toBe("brain");
      const f = fakes({ code: 0, out: "", err: "" });
      await runByRole({ route, runBrain: f.runBrain, runWorker: f.runWorker });
      expect(f.calls).toEqual(["claude"]);
    }
    expect(routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt: PLAIN, privateModelOnly: true }).role, "the Worker marked it: it names a committed LP").toBe("brain");
    const dir = mkdtempSync(path.join(tmpdir(), "wpos-roles-"));
    try {
      writeFileSync(path.join(dir, "notes.md"), "Investor update: the cap table and pro rata rights.");
      expect(routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt: PLAIN, materialDirs: [dir] }).role).toBe("brain");
      rmSync(path.join(dir, "notes.md"));
      writeFileSync(path.join(dir, "list.pdf"), "%PDF");
      expect(routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt: PLAIN, materialDirs: [dir] }).role).toBe("brain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a Codex limit is a retried named note with no Claude call", async () => {
    const route = routeFor({ kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", prompt: PLAIN });
    for (const worker of [
      { code: 75, out: "", err: "NAMED STOP [CODEX_LIMIT] resets in 3 hours" },
      { code: 0, out: "", err: "You've hit your usage limit. Try again in 3 hours." },
    ]) {
      const f = fakes(worker);
      const r = await runByRole({ route, runBrain: f.runBrain, runWorker: f.runWorker, workerSpent: codexSpentUsage, resetsIn: () => 3 * 3600 });
      expect(f.calls).toEqual(["codex"]);
      expect(r.servedBy).toBe("none");
      expect(r.code).not.toBe(0);
      const report = spentReport("BUILD", r);
      expect(report).toMatchObject({ phase: "BUILD", status: "failed", waits_seconds: 3 * 3600 });
      expect(report!.reason).toContain("NAMED STOP [CODEX_LIMIT]");
    }
  });
});
