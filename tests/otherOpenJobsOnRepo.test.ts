import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { otherOpenJobsOnRepo } from "../src/worker/services/webPropertyChange";

/*
 * 18 Nov 2026: Scooter asked for one preview covering the privacy pages (one card) and the GA tags (another card's
 * PR on the same repo). The BUILD brief must name the other open job and its branch — and only open jobs on that repo.
 */
let t: TestDb;
let env: Env;
beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  const card = (id: string, title: string, state: string) =>
    env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by) VALUES (?1, ?2, 'x', 'AI', 'aie_porter', ?3, 'NORMAL', 'INTERNAL', 'west-peek', 'scooter@westpeek.ventures', 'test')").bind(id, title, state).run();
  const wpc = (id: string, repo: string, pr: string | null, branch: string | null) =>
    env.WP_OS_DB.prepare("INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, pr_url, branch) VALUES (?1, ?2, 'westpeek.ventures', 'x', 'BUILD', ?3, ?4)").bind(id, repo, pr, branch).run();
  await card("wc_privacy", "Privacy pages", "OPEN");
  await wpc("wc_privacy", "join-west-peek-main", "https://github.com/seq23/join-west-peek-main/pull/40", "work/wpc-privacy");
  await card("wc_ga", "GA4 on the three sites", "IN_PROGRESS");
  await wpc("wc_ga", "join-west-peek-main", "https://github.com/seq23/join-west-peek-main/pull/39", "work/wpc-ga");
  await card("wc_done", "Old finished job", "DONE");
  await wpc("wc_done", "join-west-peek-main", "https://github.com/seq23/join-west-peek-main/pull/12", "work/wpc-done");
  await card("wc_other_repo", "Top Barz voting", "OPEN");
  await wpc("wc_other_repo", "topbarz", null, null);
});
afterAll(async () => disposeTestDb(t));

describe("a BUILD hears the other open jobs on its repo", () => {
  it("names the GA job and its branch, never itself, a finished job or another repo", async () => {
    const jobs = await otherOpenJobsOnRepo(env, "wc_privacy", "join-west-peek-main");
    expect(jobs.map((j) => j.card_id)).toEqual(["wc_ga"]);
    expect(jobs[0]).toMatchObject({ pr_url: "https://github.com/seq23/join-west-peek-main/pull/39", branch: "work/wpc-ga" });
    expect(await otherOpenJobsOnRepo(env, "wc_privacy", null)).toEqual([]);
  });
});
