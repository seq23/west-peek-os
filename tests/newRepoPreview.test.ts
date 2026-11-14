import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { newRepoNameFrom } from "../src/shared/intake/webPropertyChange";
import { parseReplyIntent, type ReplyIntentReader } from "../src/worker/services/replyIntent";
import { runWebPropertyChangeCard } from "../src/worker/services/webPropertyChange";
import { createNewRepo } from "../scripts/duties/web-property-change.mjs";

/**
 * NEW REPOS AND PREVIEWS (13 Nov 2026). Something that does not exist yet gets its own seq23 repo with a
 * free Cloudflare Pages preview; three repos that had a Pages project but no preview host get one.
 */

vi.mock("../src/worker/ai/runAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker/ai/runAi")>();
  return {
    ...actual,
    runAi: async () => ({ run: { id: "run_x", status: "COMPLETED", output_text: "INTENT: CONTINUE\nDOOR: BUILD\nSEAT: none\nBUILD_IN: NEW\nCHANGES: none\nQUESTION: none\nREASON: a build", failure_reason: null } }),
  };
});

let t: TestDb;
let env: Env;
const SCOOTER = "scooter@westpeek.ventures";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});
afterAll(async () => disposeTestDb(t));

const newBuild: ReplyIntentReader = async (_e, input) => ({ ...parseReplyIntent("INTENT: CONTINUE\nDOOR: BUILD\nSEAT: none\nBUILD_IN: NEW\nCHANGES: none\nQUESTION: none\nREASON: a new app", input.text), keyword: null, aiRunId: null });

describe("a new repo for something that does not exist yet", () => {
  it("is named from the subject, plainly, and never collides", () => {
    expect(newRepoNameFrom("An app for the Rooms check-in")).toBe("wp-app-rooms-check-in");
    expect(newRepoNameFrom("West Peek sponsor tracker")).toBe("west-peek-sponsor-tracker");
    expect(newRepoNameFrom("Build me a new", [])).toBe("west-peek-build");
    expect(newRepoNameFrom("An app for the Rooms check-in", ["wp-app-rooms-check-in"])).toBe("wp-app-rooms-check-in-2");
  });

  it("the door registers seq23/<name> with its free preview host, and Porter's job is told to create it", async () => {
    const chief = await openAssignmentCard(env, { subject: "An app for the Rooms check-in", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Make me a simple app where Room hosts can check people in at the door.", limits: EMAILED_TASK_LIMITS, emlKey: null, readWords: newBuild });
    const row = await env.WP_OS_DB.prepare("SELECT repo, github_repo, pages_host, seeded, requested_by FROM web_property_registry WHERE repo = 'wp-app-rooms-check-in'").first<Record<string, unknown>>();
    expect(row).toMatchObject({ github_repo: "seq23/wp-app-rooms-check-in", pages_host: "wp-app-rooms-check-in.pages.dev", seeded: 0, requested_by: SCOOTER });
    const job = await env.WP_OS_DB.prepare("SELECT c.id, c.title, c.kind, c.owner_id, c.state, c.firm_scope, c.requested_by_email, w.target_repo FROM work_card c JOIN web_property_change w ON w.work_card_id = c.id WHERE c.assigned_from_card_id = ?1").bind(chief).first<Record<string, string>>();
    expect(job).toMatchObject({ kind: "WEB_PROPERTY_CHANGE", target_repo: "wp-app-rooms-check-in" });
    await runWebPropertyChangeCard(env, { id: job!.id!, title: job!.title!, kind: job!.kind!, owner_id: job!.owner_id!, state: job!.state!, work_attempts: 0, firm_scope: job!.firm_scope!, requested_by_email: job!.requested_by_email! } as never);
    const run = await env.WP_OS_DB.prepare("SELECT job_json FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' ORDER BY created_at DESC LIMIT 1").bind(job!.id).first<{ job_json: string }>();
    const payload = JSON.parse(run!.job_json) as { new_repo?: boolean; github_repo: string; pages_hosts: string[]; phase: string };
    expect(payload).toMatchObject({ phase: "PLAN", new_repo: true, github_repo: "seq23/wp-app-rooms-check-in" });
    expect(payload.pages_hosts).toEqual(["wp-app-rooms-check-in.pages.dev"]);
  });

  it("the Mac creates it public under seq23 with a Pages project connected to it; only seq23, and a missing key is said by name", async () => {
    const calls: string[][] = [];
    const posted: Array<{ url: string; body: unknown }> = [];
    const sh = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (cmd === "gh" && args[0] === "repo" && args[1] === "view") throw new Error("not found");
      return { stdout: "" };
    };
    const fetchFake = (async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posted.push({ url, body: JSON.parse(String(init.body)) });
        return new Response("{}", { status: 200 });
      }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "newrepo-")), "wp-app-rooms-check-in");
    const out = await createNewRepo(dir, "seq23/wp-app-rooms-check-in", { CLOUDFLARE_API_TOKEN: "t" }, () => {}, { sh, fetch: fetchFake });
    expect(out).toMatchObject({ ok: true, created: true, pagesHost: "wp-app-rooms-check-in.pages.dev" });
    const create = calls.find((c) => c[0] === "gh" && c[1] === "repo" && c[2] === "create")!;
    expect(create).toContain("--public");
    expect(create).toContain("seq23/wp-app-rooms-check-in");
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toMatchObject({ name: "wp-app-rooms-check-in", source: { type: "github", config: { owner: "seq23", repo_name: "wp-app-rooms-check-in" } } });
    // A plain static repo (no package.json) still builds: the live probe's first build failed on `npm run build`.
    expect((posted[0]!.body as { build_config: { build_command: string; destination_dir: string } }).build_config).toMatchObject({ destination_dir: "dist" });
    expect((posted[0]!.body as { build_config: { build_command: string } }).build_config.build_command).toMatch(/-f package\.json/);

    expect((await createNewRepo(dir, "someone-else/repo", { CLOUDFLARE_API_TOKEN: "t" }, () => {}, { sh, fetch: fetchFake })).ok).toBe(false);
    const noKey = await createNewRepo(dir, "seq23/wp-other", {}, () => {}, { sh, fetch: fetchFake });
    expect(noKey.ok).toBe(false);
    expect(noKey.why).toMatch(/CLOUDFLARE_API_TOKEN/);
  });
});

describe("every registered repo with a Pages project has its preview host", () => {
  it("network, venture deals and dilution link their previews", async () => {
    const rows = (await env.WP_OS_DB.prepare("SELECT repo, pages_host FROM web_property_registry WHERE repo IN ('west-peek-network-os', 'secondaries', 'founder-dilution-dashboard') ORDER BY repo").all<{ repo: string; pages_host: string | null }>()).results ?? [];
    expect(rows).toEqual([
      { repo: "founder-dilution-dashboard", pages_host: "founder-dilution-dashboard.pages.dev" },
      { repo: "secondaries", pages_host: "secondaries.pages.dev" },
      { repo: "west-peek-network-os", pages_host: "west-peek-network-os.pages.dev" },
    ]);
  });
});
