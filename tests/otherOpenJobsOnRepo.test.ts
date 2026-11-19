import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { foldCarriedJobs, otherOpenJobsOnRepo } from "../src/worker/services/webPropertyChange";
import { readLocalJobReport } from "../src/shared/work/localJobs";

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

/*
 * #510 (19 Nov 2026): the privacy build merged the GA branch in, and the GA card kept asking Scooter to approve its
 * own preview. A card the Mac proved carried is folded into the card that carries it; nothing else is touched.
 */
describe("a BUILD that carries another job's branch folds that card in", () => {
  it("keeps carried_jobs from the Mac's report, card ids only", () => {
    const { report } = readLocalJobReport(JSON.stringify({ phase: "BUILD", status: "ok", pr_url: "https://x/pull/40", carried_jobs: ["wc_ga", "rm -rf /", ""] }));
    expect(report?.carried_jobs).toEqual(["wc_ga"]);
  });
  it("merges the carried GA card into the privacy card; a finished card, another repo or another partner's card stays", async () => {
    await env.WP_OS_DB.prepare("INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, requested_by_email, created_by) VALUES ('wc_hers', 'Her own job on the same repo', 'x', 'AI', 'aie_porter', 'OPEN', 'NORMAL', 'INTERNAL', 'west-peek', 'sequoia@example.com', 'test')").run();
    await env.WP_OS_DB.prepare("INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, branch) VALUES ('wc_hers', 'join-west-peek-main', 'westpeek.ventures', 'x', 'BUILD', 'work/wpc-hers')").run();
    const folded = await foldCarriedJobs(env, { id: "wc_privacy", requested_by_email: "scooter@westpeek.ventures" }, { target_repo: "join-west-peek-main", pr_url: "https://github.com/seq23/join-west-peek-main/pull/40" }, ["wc_ga", "wc_done", "wc_other_repo", "wc_hers", "wc_missing"]);
    expect(folded).toEqual(["wc_ga"]);
    const rows = (await env.WP_OS_DB.prepare("SELECT id, state, merged_into_card_id FROM work_card WHERE id IN ('wc_ga','wc_done','wc_other_repo','wc_hers') ORDER BY id").all<{ id: string; state: string; merged_into_card_id: string | null }>()).results;
    expect(rows).toEqual([
      { id: "wc_done", state: "DONE", merged_into_card_id: null },
      { id: "wc_ga", state: "CANCELLED", merged_into_card_id: "wc_privacy" },
      { id: "wc_hers", state: "OPEN", merged_into_card_id: null },
      { id: "wc_other_repo", state: "OPEN", merged_into_card_id: null },
    ]);
    expect((await otherOpenJobsOnRepo(env, "wc_privacy", "join-west-peek-main")).map((j) => j.card_id)).toEqual(["wc_hers"]);
  });
});
