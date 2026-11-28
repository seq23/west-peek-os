// Copied from: seq23/boss-os tests/chiefSignoff.test.ts @ 6d62771ea6b2b60637295bd38eef335bad9f97fa
import { Buffer } from "node:buffer";
import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { prepareChiefDraft } from "../scripts/chiefs/github.mjs";
import { chiefSignoff } from "../scripts/chiefs/chief-signoff.mjs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const base = {
  repo: "fixture/work", number: 19, head: "a".repeat(40), branch: "fix/calendar", isolatedFork: false,
  messages: ["Fix calendar"], paths: ["src/client/pages/CalendarPage.tsx"], body: "", comments: [] as string[],
  publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
};
const line = `Ship-ready: PASS — Wren looked at the fixture at ${base.head}; Engineering: PASS`;
function approval(overrides: Record<string, unknown> = {}, key = privateKey) {
  const record = Buffer.from(JSON.stringify({
    repo: base.repo, number: base.number, head: base.head, approver: "wren", agent: "aie_walker",
    priorMergedPull: 7, pass: line, ...overrides,
  }));
  return `${line}\n<!-- westpeek-approval: ${record.toString("base64url")}.${Buffer.from(sign(null, record, key)).toString("base64url")} -->`;
}
const independent = `Ship-ready: PASS — Independent fixture review at ${base.head}; Engineering: PASS`;
const commissioned = {
  ...base, isolatedFork: true, branch: "wren/fix-calendar",
  messages: ["Fix calendar\n\nCo-Authored-By: Wren <wren@joinwestpeek.com>"],
};

describe("trusted chief sign-off", () => {
  it("accepts an authenticated approval for a managed agent's current head", () => {
    expect(chiefSignoff({ ...base, comments: [approval()] })).toBeNull();
  });

  it("rejects a forged, copied, edited, self-signed or first-PR record", () => {
    const unrelatedKey = generateKeyPairSync("ed25519").privateKey;
    for (const comment of [line, approval({}, unrelatedKey), approval().replace("looked at", "reviewed"), approval({ number: 42 }),
      approval({ head: "b".repeat(40) }), approval({ agent: "aie_wren" }), approval({ priorMergedPull: 0 }),
      approval({ priorMergedPull: base.number })]) {
      expect(chiefSignoff({ ...base, comments: [comment] })).toBe("CHIEF_APPROVAL_RECORD_REQUIRED");
    }
    expect(chiefSignoff({ ...base, body: approval() })).toBe("CHIEF_APPROVAL_RECORD_REQUIRED");
  });

  it("blocks chief PASS on protected paths or commissioned changes, even with a signed receipt", () => {
    for (const path of ["src/worker/ai/runAi.ts", "src/client/pages/EmployeesPage.tsx", "scripts/duties/web-property-change.mjs"]) {
      expect(chiefSignoff({ ...base, paths: [path], comments: [approval()] })).toBe("PROTECTED_PATH");
    }
    expect(chiefSignoff({ ...commissioned, comments: [approval(), independent] })).toBe("INDEPENDENT_REVIEW_REQUIRED");
    expect(chiefSignoff({ ...commissioned, comments: [independent] })).toBeNull();
    expect(chiefSignoff({ ...commissioned, comments: [independent, "VERDICT: fail"] })).toBe("INDEPENDENT_REVIEW_REQUIRED");
  });

  it("requires both an isolated fork and the correct parsed trailer on each commit", () => {
    expect(chiefSignoff({ ...commissioned, isolatedFork: false, comments: [independent] })).toBe("CHIEF_FORK_REQUIRED");
    expect(chiefSignoff({ ...commissioned, messages: [...commissioned.messages, "Unstamped edit"], comments: [independent] })).toBe("CHIEF_TRAILER_REQUIRED");
    expect(chiefSignoff({ ...commissioned, branch: "fix/calendar", comments: [independent] })).toBe("CHIEF_TRAILER_REQUIRED");
  });
});

describe("chief draft broker", () => {
  const config = { project: "fixture/work", fork: "isolated/work", forkToken: "fork-fixture", pullsToken: "pulls-fixture" };
  const draft = { title: "Calendar fix", base: "a".repeat(40), patch: "fixture patch" };
  const call = { chief: "wren" as const, id: "fixture" };
  const tip = "b".repeat(40);
  const tree = "c".repeat(40);

  function githubFixture({ actions = false, path = "docs/calendar.md" } = {}) {
    const published: Array<{ token: string; args: string[] }> = [];
    let currentBranch = "";
    let pull = false;
    const run = async (token: string, command: string, args: string[], input?: string) => {
      if (command === "gh") {
        const endpoint = args[1]!;
        if (endpoint === `repos/${config.project}`) return JSON.stringify({ full_name: config.project, private: false, default_branch: "main" });
        if (endpoint === `repos/${config.fork}`) return JSON.stringify({ full_name: config.fork, fork: true, parent: { full_name: config.project } });
        if (endpoint.endsWith("/actions/permissions")) return JSON.stringify({ enabled: actions });
        if (endpoint.includes("/pulls?")) return JSON.stringify(pull ? [{
          draft: true, state: "open", number: 9, head: { sha: tip, ref: currentBranch, repo: { full_name: config.fork } }, base: { ref: "main" },
        }] : []);
        if (args[0] === "pr") {
          published.push({ token, args });
          pull = true;
          return "";
        }
      }
      if (command !== "git") throw new Error("fixture command was unexpected");
      if (args.includes("ls-remote")) return currentBranch ? `${tip}\trefs/heads/${currentBranch}` : "";
      if (args.includes("rev-parse")) return draft.base;
      if (args.includes("write-tree")) return tree;
      if (args.includes("diff")) return `${path}\0`;
      if (args.includes("commit-tree")) {
        expect(input).toMatch(/\nCo-Authored-By: Wren <wren@joinwestpeek.com>\n$/);
        return tip;
      }
      if (args.includes("push")) {
        published.push({ token, args });
        currentBranch = args.at(-1)!.split("refs/heads/")[1]!;
      }
      return "";
    };
    return { published, run, reviewedBase: async () => true, currentLease: async () => true, publicContent: async () => true };
  }

  it("stamps, pushes only the isolated fork and opens a draft with a separate credential", async () => {
    const fixture = githubFixture();
    expect(await prepareChiefDraft(call, draft, config, fixture)).toEqual({ ok: true, receipt: "https://github.com/fixture/work/pull/9", head: tip });
    expect(fixture.published.map(({ token }) => token)).toEqual([config.forkToken, config.pullsToken]);
    expect(fixture.published[0]?.args.at(-2)).toBe("https://github.com/isolated/work.git");
    expect(fixture.published[1]?.args).toContain("--draft");
  });

  it("rejects an unisolated target or protected diff before any publish", async () => {
    const actionsEnabled = githubFixture({ actions: true });
    const protectedDiff = githubFixture({ path: ".github/workflows/ci.yml" });
    const privatePatch = githubFixture();
    expect(await prepareChiefDraft(call, draft, config, actionsEnabled)).toEqual({ ok: false, code: "REPO_SETTINGS" });
    expect(await prepareChiefDraft(call, draft, config, protectedDiff)).toEqual({ ok: false, code: "PROTECTED_PATH" });
    expect(await prepareChiefDraft(call, draft, config, { ...privatePatch, publicContent: async () => false })).toEqual({ ok: false, code: "PRIVATE_DRAFT" });
    expect(await prepareChiefDraft(call, draft, config, { ...privatePatch, reviewedBase: async () => false })).toEqual({ ok: false, code: "REPO_SETTINGS" });
    expect(actionsEnabled.published.concat(protectedDiff.published, privatePatch.published)).toEqual([]);
  });
});
