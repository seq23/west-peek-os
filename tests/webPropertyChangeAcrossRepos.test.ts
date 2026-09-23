import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce } from "../src/worker/services/workSweep";
import { reportRun, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { parseWebPropertyAsk, propertiesIn, slicesByRepo, sitesOf, WEB_PROPERTIES } from "../src/shared/intake/webPropertyChange";
import { WEB_PROPERTY_CHANGE_KIND, type LocalJobPayload } from "../src/shared/work/localJobs";
import { aggregateParts, parkPhase, readParts, readWebPropertyChange, rulesFor } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";

/**
 * ONE WEBSITE JOB ACROSS SEVERAL REPOS (owner, 23 Sep 2026, migration 0236).
 *
 * Her words: "there is a world where we ask you to fix something on the community site and
 * westpeek live in the same email." What is proven here:
 *
 *   · THE DOOR: community site + westpeek live in one email → ONE Porter card with TWO parts, one
 *     per repo, each with its own sites and — when the email separates them — its own slice.
 *   · MOST SPECIFIC HOST FIRST: dilution.joinwestpeek.com and venturedeals.joinwestpeek.com never
 *     read as the community site (joinwestpeek.com), and the community site never reads as either.
 *   · ONE PLAN over both repos, one approval email, one "approved".
 *   · BUILD: one PR per repo. One RED holds both: nothing lands, the card names the red repo, the
 *     Worker refuses to park LAND, and the row refuses a part's merge.
 *   · PREVIEW FIRST: ONE email listing every repo's preview (or PR + screenshots when a repo has no
 *     preview deployment).
 *   · LAND: one "approved" lands both; a LAND that stops part way records what merged and resumes;
 *     the card is DONE only when every repo merged, and the DONE email names every repo with proof.
 *   · A SINGLE-REPO JOB IS UNCHANGED: no parts, no `parts` on the job.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;

let clock = Date.now();
async function tickFor(id: string): Promise<Awaited<ReturnType<typeof sweepOnce>>> {
  for (let i = 0; i < 8; i++) {
    clock += 3 * 60_000;
    const out = await sweepOnce(env, new Date(clock));
    if (out.card?.id === id) return out;
  }
  throw new Error(`the sweep never reached ${id}`);
}

async function card(id: string) {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

async function liveJob(cardId: string): Promise<SeatRunRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status IN ('QUEUED','CLAIMED') ORDER BY created_at DESC LIMIT 1").bind(cardId).first<SeatRunRow>();
}

async function payloadOf(cardId: string): Promise<LocalJobPayload> {
  const job = await liveJob(cardId);
  expect(job, "a LOCAL_JOB is parked for the Mac").not.toBeNull();
  return JSON.parse(job!.job_json!) as LocalJobPayload;
}

async function macReports(cardId: string, report: Record<string, unknown>): Promise<void> {
  const run = await env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = 'QUEUED'").bind(cardId).first<SeatRunRow>();
  expect(run, "a LOCAL_JOB was parked for the Mac").not.toBeNull();
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac-test-jobs', claimed_at = ?2, attempt_count = attempt_count + 1 WHERE id = ?1").bind(run!.id, new Date().toISOString()).run();
  const out = await reportRun(env, { runId: run!.id, deviceId: "mac-test-jobs", outputText: JSON.stringify(report) });
  expect(out.accepted).toBe(true);
}

async function reply(cardId: string, written: string) {
  const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(cardId).first<{ token: string }>())!.token;
  const raw = [`From: ${SEQUOIA}`, "To: os@joinwestpeek.com", "Subject: Re: Porter: blocked", "", written, "", "On Wed, 23 Sep 2026 at 09:02, Porter <os@westpeek.ventures> wrote:", "> The plan is on the card."].join("\n");
  return steerFromReply(env, { fromHeader: `<${SEQUOIA}>`, authenticationResults: GOOD_AUTH(SEQUOIA), subject: "Re: Porter: blocked", raw, inReplyTo: threadReference(token), references: null, emlKey: null });
}

async function porterCardFrom(subject: string, raw: string): Promise<string> {
  const chiefId = await openAssignmentCard(env, { subject, partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw, limits: EMAILED_TASK_LIMITS, emlKey: null });
  const m = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description));
  expect(m, "the chief handed the card to Porter at the door").not.toBeNull();
  return m![1]!;
}

const blockedTo = (who: string) => sent.filter((m) => m.to === who && /blocked/i.test(m.subject));

const TWO_REPOS = "Porter, two things. On the community site, the footer link to the team page 404s — point it at /team. On westpeek live, change the homepage banner to say Fall Summit, 14 Oct.";
const COMMUNITY_PR = "https://github.com/seq23/join-west-peek-main/pull/301";
const LIVE_PR = "https://github.com/seq23/westpeek-live/pull/88";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
  } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("the door reads sites in several repos as ONE job with a part per repo", () => {
  it("community site + westpeek live → one ask, two parts, each its own repo, sites and slice", () => {
    const ask = parseWebPropertyAsk("two fixes", TWO_REPOS)!;
    expect(ask.property_unresolved, "sites in two repos are no longer unresolved").toBeFalsy();
    expect(ask.parts).toHaveLength(2);
    expect(ask.parts!.map((p) => p.repo)).toEqual(["join-west-peek-main", "westpeek-live"]);
    expect(ask.parts![0]!.property_host).toBe("joinwestpeek.com");
    expect(ask.parts![0]!.site).toBe("sites/community");
    expect(ask.parts![1]!.property_host).toBe("westpeek.live");
    expect(sitesOf(ask.parts![1]!.property_host), "westpeek.live IS its repo: the scope is the root").toEqual(["."]);
    expect(ask.property_host).toBe("joinwestpeek.com, westpeek.live");
    expect(ask.target_repo).toBe("join-west-peek-main + westpeek-live");
    // The email separates them, so each repo gets its own sentence plus the shared opener, never the other's.
    expect(ask.parts![0]!.ask).toMatch(/footer link/);
    expect(ask.parts![0]!.ask).not.toMatch(/Fall Summit/);
    expect(ask.parts![1]!.ask).toMatch(/Fall Summit/);
    expect(ask.parts![1]!.ask).not.toMatch(/footer/);
    expect(ask.parts![1]!.ask, "a shared sentence goes to every part").toMatch(/two things/);
  });

  it("when the email does not separate them, every part gets the whole request", () => {
    const whole = "Please put the new West Peek logo on the community site and the live site.";
    const ask = parseWebPropertyAsk("logo", whole)!;
    expect(ask.parts).toHaveLength(2);
    for (const p of ask.parts!) expect(p.ask).toBe(whole);
    const m = slicesByRepo("Community site: fix the footer. Everything else can wait.", ["join-west-peek-main", "westpeek-live"]);
    expect(m.get("westpeek-live"), "a repo with no sentence of its own → the whole request to each").toBe("Community site: fix the footer. Everything else can wait.");
  });

  it("the most specific host wins, in BOTH directions: dilution and venturedeals are never the community site, and the community site is never either", () => {
    const one = (text: string) => propertiesIn(text).map((p) => p.repo);
    // Hosts written out.
    expect(one("please fix dilution.joinwestpeek.com")).toEqual(["founder-dilution-dashboard"]);
    expect(one("please fix venturedeals.joinwestpeek.com")).toEqual(["secondaries"]);
    expect(one("please fix joinwestpeek.com")).toEqual(["join-west-peek-main"]);
    expect(one("https://dilution.joinwestpeek.com/ has a typo")).toEqual(["founder-dilution-dashboard"]);
    // Words.
    expect(one("the dilution dashboard has a broken chart")).toEqual(["founder-dilution-dashboard"]);
    expect(one("the dilution calculator rounds wrong")).toEqual(["founder-dilution-dashboard"]);
    expect(one("update the venture deals page")).toEqual(["secondaries"]);
    expect(one("the secondaries site needs a new deal")).toEqual(["secondaries"]);
    expect(one("the community site footer 404s")).toEqual(["join-west-peek-main"]);
    // Both named: two repos, each once — the parent host is named by itself only when written by itself.
    expect(one("fix dilution.joinwestpeek.com and joinwestpeek.com")).toEqual(["join-west-peek-main", "founder-dilution-dashboard"]);
    expect(one("the community site and the dilution dashboard")).toEqual(["join-west-peek-main", "founder-dilution-dashboard"]);
    const ask = parseWebPropertyAsk("x", "Fix the chart on dilution.joinwestpeek.com")!;
    expect(ask.parts, "one repo is not several").toBeUndefined();
    expect(ask.target_repo).toBe("founder-dilution-dashboard");
    expect(ask.property_host).toBe("dilution.joinwestpeek.com");
    // Every other *.joinwestpeek.com site, both directions.
    expect(one("pitch.joinwestpeek.com is down")).toEqual(["west-peek-pitch-lab"]);
    expect(one("pitchlab.joinwestpeek.com is down"), "an alias host names its site").toEqual(["west-peek-pitch-lab"]);
    expect(one("network.joinwestpeek.com login copy")).toEqual(["west-peek-network-os"]);
    expect(one("the pitch lab and the community site")).toEqual(["join-west-peek-main", "west-peek-pitch-lab"]);
    expect(one("network os and venture deals")).toEqual(["west-peek-network-os", "secondaries"]);
    // A mailbox at the community domain names no site.
    expect(propertiesIn("questions to sequoia@joinwestpeek.com")).toEqual([]);
  });

  it("every registered host is unique, and every host names only its own property", () => {
    const hosts = WEB_PROPERTIES.map((p) => p.host);
    expect(new Set(hosts).size).toBe(hosts.length);
    for (const p of WEB_PROPERTIES) {
      for (const h of [p.host, ...(p.aliases ?? [])]) expect(propertiesIn(`please update ${h} today`), h).toEqual([p]);
      for (const w of p.words) expect(propertiesIn(`please update ${w} today`), w).toEqual([p]);
    }
    expect(WEB_PROPERTIES.map((p) => p.repo), "every West Peek site repo is registered").toEqual(
      expect.arrayContaining(["join-west-peek-main", "westpeek-live", "west-peek-pitch-lab", "west-peek-network-os", "secondaries", "founder-dilution-dashboard"]),
    );
  });

  it("a single-repo email is unchanged: no parts; two sites in one repo stay one repo", () => {
    const one = parseWebPropertyAsk("x", "the community site footer 404s")!;
    expect(one.parts).toBeUndefined();
    expect(one.target_repo).toBe("join-west-peek-main");
    const sameRepo = parseWebPropertyAsk("x", "the community site and the agency site both need the new logo")!;
    expect(sameRepo.parts).toBeUndefined();
    expect(sameRepo.site).toBe("sites/productions, sites/community");
  });
});

describe("community site + westpeek live in one email, land on green", () => {
  let id = "";

  it("is ONE Porter card with TWO parts; ONE PLAN run is parked carrying both repos", async () => {
    id = await porterCardFrom("two fixes", TWO_REPOS);
    const c = await card(id);
    expect(c.kind).toBe(WEB_PROPERTY_CHANGE_KIND);
    const parts = await readParts(env, id);
    expect(parts.map((p) => p.repo)).toEqual(["join-west-peek-main", "westpeek-live"]);
    const porterCards = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card WHERE kind = 'WEB_PROPERTY_CHANGE' AND requested_by_email = ?1 AND state <> 'CANCELLED'").bind(SEQUOIA).first<{ n: number }>();
    expect(porterCards!.n, "one email, one card").toBe(1);
    const received = sent.filter((m) => m.to === SEQUOIA && /got it/i.test(m.subject));
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toMatch(/Repos: join-west-peek-main \(joinwestpeek\.com\); westpeek-live \(westpeek\.live\)/);

    expect((await tickFor(id)).outcome).toBe("PROGRESSED");
    const jobs = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM subscription_seat_run WHERE work_card_id = ?1").bind(id).first<{ n: number }>();
    expect(jobs!.n, "one run for the whole job").toBe(1);
    const payload = await payloadOf(id);
    expect(payload.phase).toBe("PLAN");
    expect(payload.parts!.map((p) => [p.repo, p.sites])).toEqual([
      ["join-west-peek-main", ["sites/community"]],
      ["westpeek-live", ["."]],
    ]);
    expect(payload.parts![1]!.ask).toMatch(/Fall Summit/);
  });

  it("ONE plan over both repos → ONE approval email; one \"approved\" parks ONE BUILD with both parts", async () => {
    await macReports(id, {
      phase: "PLAN",
      status: "ok",
      document: "# Plan: two fixes\n\n## join-west-peek-main\n- footer link → /team\n\n## westpeek-live\n- banner: Fall Summit, 14 Oct\n",
      decided: ["footer href only"],
      asks: [{ question: "Banner date format: 14 Oct or October 14?", recommended: "14 Oct, as you wrote it" }],
      publish_ready: true,
      placeholders: [],
    });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const plans = blockedTo(SEQUOIA);
    expect(plans, "one plan email for both repos").toHaveLength(1);
    expect(plans[0]!.text).toMatch(/## join-west-peek-main/);
    expect(plans[0]!.text).toMatch(/## westpeek-live/);
    expect((await reply(id, "approved")).answered).toBe(true);
    const next = await tickFor(id);
    expect(next.summary).toMatch(/BUILD queued/);
    const payload = await payloadOf(id);
    expect(payload.phase).toBe("BUILD");
    expect(payload.parts).toHaveLength(2);
    expect(payload.max_seconds, "one run builds both repos, so its ceiling covers both").toBe(2 * 90 * 60);
  });

  it("BUILD: one PR per repo; westpeek-live RED holds BOTH — nothing lands, the card names the red repo, LAND is refused and the row refuses a merge", async () => {
    await macReports(id, {
      phase: "BUILD",
      status: "ok",
      pr_url: `${COMMUNITY_PR} · ${LIVE_PR}`,
      check_state: "RED",
      reason: "not every PR is green",
      parts: [
        { repo: "join-west-peek-main", pr_url: COMMUNITY_PR, pr_number: 301, branch: "work/wpc-x", check_state: "GREEN", proof: "validate green · shots/community-390.png" },
        { repo: "westpeek-live", pr_url: LIVE_PR, pr_number: 88, branch: "work/wpc-x", check_state: "RED", proof: "npm run validate: 1 failed" },
      ],
    });
    expect((await tickFor(id)).outcome).toBe("FAILED");
    const parts = await readParts(env, id);
    expect(parts.map((p) => [p.repo, p.pr_number, p.check_state])).toEqual([
      ["join-west-peek-main", 301, "GREEN"],
      ["westpeek-live", 88, "RED"],
    ]);
    expect(parts[0]!.check_green_at).toBeTruthy();
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.check_state, "the job is RED while any repo is").toBe("RED");
    expect(row.check_green_at).toBeNull();
    expect(row.pr_url).toBe(`${COMMUNITY_PR} · ${LIVE_PR}`);
    expect(String((await card(id)).description)).toMatch(/Not every PR is green, so nothing lands: westpeek-live RED \(https:\/\/github\.com\/seq23\/westpeek-live\/pull\/88\)/);
    expect(await liveJob(id), "nothing was parked to land").toBeNull();

    // The Worker's LAND gate refuses even from a row that claims green overall, naming the red repo.
    const c = await card(id);
    const sweepCard = { id, title: String(c.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SEQUOIA };
    const refused = await parkPhase(env, sweepCard, { ...row, check_state: "GREEN", check_green_at: "2026-09-23T12:00:00.000Z" }, "LAND", await rulesFor(env, WEB_PROPERTY_CHANGE_KIND));
    expect(refused.parked).toBe(false);
    expect((refused as { reason: string }).reason).toMatch(/not every PR is green, so none lands: westpeek-live RED/);
    // And the row: the green repo cannot be recorded merged while its sibling is red.
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change_part SET merge_sha = 'abc' WHERE work_card_id = ?1 AND repo = 'join-west-peek-main'").bind(id).run()).rejects.toThrow(/all or nothing \(0236\)/);
  });

  it("the next BUILD resumes: the green repo rides along as green; both GREEN → LAND is queued for both at once", async () => {
    const again = await tickFor(id);
    expect(again.summary).toMatch(/BUILD queued/);
    const payload = await payloadOf(id);
    expect(payload.parts![0]!.pr?.check_state, "the green repo is not rebuilt").toBe("GREEN");
    expect(payload.parts![1]!.pr?.check_state).toBe("RED");
    await macReports(id, {
      phase: "BUILD",
      status: "ok",
      pr_url: `${COMMUNITY_PR} · ${LIVE_PR}`,
      check_state: "GREEN",
      parts: [
        { repo: "join-west-peek-main", pr_url: COMMUNITY_PR, pr_number: 301, check_state: "GREEN" },
        { repo: "westpeek-live", pr_url: LIVE_PR, pr_number: 88, check_state: "GREEN", proof: "validate green · shots/banner-390.png" },
        { repo: "someone-elses-repo", pr_url: "https://github.com/x/y/pull/1", pr_number: 1, check_state: "GREEN" },
      ],
    });
    const out = await tickFor(id);
    expect(out.summary).toMatch(/All 2 PRs are green; landing all of them is queued/);
    expect(await readParts(env, id), "a repo the card never named is never written").toHaveLength(2);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.check_state).toBe("GREEN");
    expect(row.phase).toBe("LAND");
    const payload2 = await payloadOf(id);
    expect(payload2.phase).toBe("LAND");
    expect(payload2.parts!.map((p) => [p.repo, p.pr?.number, p.pr?.check_state])).toEqual([
      ["join-west-peek-main", 301, "GREEN"],
      ["westpeek-live", 88, "GREEN"],
    ]);
    expect(payload2.parts!.every((p) => p.pr?.check_green_at)).toBe(true);
    // The row refuses DONE while any repo is unmerged — even if the parent somehow held a merge.
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = 'pretend' WHERE work_card_id = ?1").bind(id).run();
    await expect(env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(id).run()).rejects.toThrow(/any repo's PR is unmerged/);
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = NULL WHERE work_card_id = ?1").bind(id).run();
  });

  it("LAND lands both: DONE, every repo merged, and the finished email names every repo with proof per site", async () => {
    await macReports(id, {
      phase: "LAND",
      status: "ok",
      merge_sha: "join-west-peek-main@aaaa, westpeek-live@bbbb",
      live_proof: "both sites answered 200",
      parts: [
        { repo: "join-west-peek-main", merge_sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", live_proof: "https://joinwestpeek.com/team → 200" },
        { repo: "westpeek-live", merge_sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", live_proof: "https://westpeek.live → 200, banner reads Fall Summit, 14 Oct" },
      ],
    });
    expect((await tickFor(id)).outcome).toBe("DONE");
    expect((await card(id)).state).toBe("DONE");
    const parts = await readParts(env, id);
    expect(parts.every((p) => p.merge_sha && p.landed_at)).toBe(true);
    const done = await env.WP_OS_DB.prepare("SELECT body_text FROM preview_approval WHERE work_card_id = ?1 ORDER BY created_at DESC").bind(id).first<{ body_text: string }>();
    expect(done, "the finished email is waiting for her").not.toBeNull();
    expect(done!.body_text).toMatch(/Landed 2 PRs in 2 repos, together/);
    expect(done!.body_text).toMatch(/join-west-peek-main \(joinwestpeek\.com\): https:\/\/github\.com\/seq23\/join-west-peek-main\/pull\/301 as aaaaaaaaaa/);
    expect(done!.body_text).toMatch(/westpeek-live \(westpeek\.live\): https:\/\/github\.com\/seq23\/westpeek-live\/pull\/88 as bbbbbbbbbb/);
    expect(done!.body_text).toMatch(/joinwestpeek\.com\/team → 200/);
    expect(done!.body_text).toMatch(/banner reads Fall Summit/);
  });
});

describe("\"preview first\" across two repos", () => {
  let id = "";

  it("GREEN in both repos stops at ONE preview email listing both — a repo with no preview deployment says the PR stands in", async () => {
    id = await porterCardFrom("banner and footer", `${TWO_REPOS} Send me a preview first.`);
    expect((await readWebPropertyChange(env, id))!.preview_only).toBe(1);
    await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", document: "# Plan: banner and footer\n\nboth repos, structure only.", decided: ["structure"], asks: [], publish_ready: true, placeholders: [] });
    expect((await tickFor(id)).summary, "nothing to ask: built without asking").toMatch(/BUILD queued/);
    const before = blockedTo(SEQUOIA).length;
    await macReports(id, {
      phase: "BUILD",
      status: "ok",
      pr_url: "x",
      check_state: "GREEN",
      parts: [
        { repo: "join-west-peek-main", pr_url: "https://github.com/seq23/join-west-peek-main/pull/302", pr_number: 302, check_state: "GREEN", preview_url: "https://e5f6.join-west-peek-community.pages.dev", proof: "shots/community-390.png" },
        { repo: "westpeek-live", pr_url: "https://github.com/seq23/westpeek-live/pull/89", pr_number: 89, check_state: "GREEN", proof: "shots/live-desktop.png shots/live-390.png" },
      ],
    });
    expect((await tickFor(id)).outcome, "green stops at the preview").toBe("BLOCKED");
    expect(await liveJob(id), "nothing parked to land").toBeNull();
    const previews = blockedTo(SEQUOIA).slice(before);
    expect(previews, "ONE preview email for both repos").toHaveLength(1);
    const text = previews[0]!.text;
    expect(text).toMatch(/PREVIEW READY in 2 repos — one landing for all of them/);
    expect(text).toMatch(/join-west-peek-main \(joinwestpeek\.com\): look at it here: https:\/\/e5f6\.join-west-peek-community\.pages\.dev\. The PR: https:\/\/github\.com\/seq23\/join-west-peek-main\/pull\/302/);
    expect(text).toMatch(/westpeek-live \(westpeek\.live\): no preview deployment for this repo — the PR and its screenshots stand in for it\. The PR: https:\/\/github\.com\/seq23\/westpeek-live\/pull\/89/);
    expect(text).toMatch(/live-390\.png/);
    expect(text).toMatch(/Reply "approved" to land every PR together/);
  });

  it("one \"approved\" parks ONE LAND over both; a LAND that stops part way records the merge and resumes without landing it twice", async () => {
    expect((await reply(id, "approved")).answered).toBe(true);
    expect((await tickFor(id)).summary).toMatch(/Landing approved after the preview; LAND queued/);
    const payload = await payloadOf(id);
    expect(payload.parts!.map((p) => p.pr?.number)).toEqual([302, 89]);
    expect(payload.pr?.land_approved_at).toBeTruthy();
    // The first repo landed; ~/bin/land refused the second (main went red underneath it).
    await macReports(id, { phase: "LAND", status: "failed", reason: "~/bin/land stopped on westpeek-live after join-west-peek-main landed: main is red", parts: [{ repo: "join-west-peek-main", merge_sha: "cccccccccccccccccccccccccccccccccccccccc" }] });
    expect((await tickFor(id)).outcome).toBe("FAILED");
    expect((await card(id)).state).not.toBe("DONE");
    const parts = await readParts(env, id);
    expect(parts[0]!.merge_sha).toMatch(/^cccc/);
    expect(parts[1]!.merge_sha).toBeNull();
    const again = await tickFor(id);
    expect(again.summary).toMatch(/LAND queued/);
    const resumed = await payloadOf(id);
    expect(resumed.parts![0]!.merge_sha, "the Mac is told what already merged").toMatch(/^cccc/);
    expect(resumed.parts![1]!.merge_sha).toBeNull();
    // An ok report that is still missing a repo's merge does not finish the card.
    await macReports(id, { phase: "LAND", status: "ok", merge_sha: "x", live_proof: "partial", parts: [{ repo: "join-west-peek-main", merge_sha: "cccccccccccccccccccccccccccccccccccccccc" }] });
    const short = await tickFor(id);
    expect(short.outcome).toBe("FAILED");
    expect(short.summary).toMatch(/without a merge for westpeek-live/);
    expect((await card(id)).state).not.toBe("DONE");
    await tickFor(id);
    await macReports(id, { phase: "LAND", status: "ok", merge_sha: "x", live_proof: "https://westpeek.live → 200", parts: [{ repo: "join-west-peek-main", merge_sha: "cccccccccccccccccccccccccccccccccccccccc" }, { repo: "westpeek-live", merge_sha: "dddddddddddddddddddddddddddddddddddddddd", live_proof: "https://westpeek.live → 200" }] });
    expect((await tickFor(id)).outcome).toBe("DONE");
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.merge_sha).toBe("join-west-peek-main@cccccccccccccccccccccccccccccccccccccccc, westpeek-live@dddddddddddddddddddddddddddddddddddddddd");
  });
});

describe("a single-repo job is unchanged", () => {
  it("no parts rows, no `parts` on the job, the same ceiling as before", async () => {
    const id = await porterCardFrom("footer", "Porter, the community site footer link to the team page 404s — point it at /team.");
    expect(await readParts(env, id)).toEqual([]);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.target_repo).toBe("join-west-peek-main");
    await tickFor(id);
    const payload = await payloadOf(id);
    expect(payload.parts, "a single-repo job carries no parts").toBeUndefined();
    expect(payload.target_repo).toBe("join-west-peek-main");
    expect(payload.sites).toEqual(["sites/community"]);
    expect(payload.max_seconds).toBe(40 * 60);
  });

  it("the aggregate is GREEN only when every part is, RED when any is, and merged only when all are", () => {
    const p = (repo: string, check_state: "GREEN" | "RED" | "PENDING" | null, merge_sha: string | null = null) => ({ repo, pr_url: `u/${repo}`, check_state, check_green_at: check_state === "GREEN" ? `2026-09-23T1${repo.length % 10}:00:00Z` : null, preview_url: null, build_proof: null, merge_sha });
    expect(aggregateParts([p("a", "GREEN"), p("bb", "GREEN")]).check_state).toBe("GREEN");
    expect(aggregateParts([p("a", "GREEN"), p("bb", "PENDING")]).check_state).toBe("PENDING");
    expect(aggregateParts([p("a", "PENDING"), p("bb", "RED")]).check_state).toBe("RED");
    expect(aggregateParts([p("a", "GREEN"), p("bb", "RED")]).check_green_at).toBeNull();
    expect(aggregateParts([]).check_state, "no parts is never green").toBe("PENDING");
    expect(aggregateParts([p("a", "GREEN", "1"), p("bb", "GREEN")]).merge_sha).toBeNull();
    expect(aggregateParts([p("a", "GREEN", "1"), p("bb", "GREEN", "2")]).merge_sha).toBe("a@1, bb@2");
  });
});
