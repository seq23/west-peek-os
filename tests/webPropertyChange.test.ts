import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce } from "../src/worker/services/workSweep";
import { claimRun, parkRun, progressRun, reapSeatRuns, readRun, reportRun, JOB_SILENCE_MS, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { parseWebPropertyAsk, isWebPropertyChange, driveFolderLinks } from "../src/shared/intake/webPropertyChange";
import { readLocalJobReport, WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { parkPhase, phaseModel, readWebPropertyChange, rulesFor, runWebPropertyChangeCard, type WebPropertyChangeRow } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { answerBlock } from "../src/worker/services/blocks";

/**
 * PORTER CHANGES A WEB PROPERTY FROM HER MAC (20 Sep 2026, Plan A).
 *
 * What is proven, each traceable to a rule she gave:
 *
 *   · THE DOOR READS DRIVE. A partner's email with a Drive folder and a property becomes a card on
 *     Porter's desk with the folder, the property and the repo — handed on from the chief of staff
 *     at the door. A folder with no property is an ordinary assignment with the link kept.
 *   · ONE LIVE RUN PER CARD. The runner parks exactly one LOCAL_JOB; a second tick while it is
 *     queued parks nothing and spends no attempt; the row refuses a second one outright.
 *   · THE QUESTION CLAIMER IS NEVER HANDED A JOB. `kinds` on the claim decides.
 *   · THE PLAN IS A DOCUMENT AND THE ASKS BLOCK THE CARD, addressed to the partner who asked.
 *   · A REPLY RESUMES. Scooter's email answer clears Scooter's block; Sequoia's does not; the next
 *     tick records the approval and parks BUILD with the plan and the answers on the job.
 *   · NO LAND WITHOUT APPROVAL AND GREEN, in the Worker and at the row (the 0219 trigger).
 *   · LAND ON GREEN is the seeded rule; OFF blocks with a question instead.
 *   · THE DONE EMAIL CARRIES THE PROOF.
 *   · THE REAPER JUDGES A JOB BY ITS PULSE AND ITS CEILING, not by 0187's five minutes.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];

const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "sequoia@westpeek.ventures";
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUv";
const EMAIL = `Hi — please update the westpeek.ventures site with the package here: https://drive.google.com/drive/folders/${FOLDER}?usp=sharing\n\nNew team page, portfolio logos, and the thesis copy in the doc.\n`;

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array) => {
      store.set(key, body instanceof Uint8Array ? body : new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b.buffer } : null;
    },
  };
}

async function tick(): Promise<Awaited<ReturnType<typeof sweepOnce>>> {
  return sweepOnce(env, new Date());
}

async function card(id: string) {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

async function liveJobFor(cardId: string): Promise<SeatRunRow | null> {
  return env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status IN ('QUEUED','CLAIMED') ORDER BY created_at DESC LIMIT 1")
    .bind(cardId)
    .first<SeatRunRow>();
}

/** The Mac claims the card's live job and reports. */
async function macReports(cardId: string, report: Record<string, unknown>): Promise<SeatRunRow> {
  const run = await claimRun(env, "mac-test-jobs", ["claude_code"], new Date(), ["LOCAL_JOB"]);
  expect(run, "a LOCAL_JOB was parked for the Mac").not.toBeNull();
  expect(run!.work_card_id).toBe(cardId);
  const out = await reportRun(env, { runId: run!.id, deviceId: "mac-test-jobs", outputText: JSON.stringify(report) });
  expect(out.accepted).toBe(true);
  return run!;
}

async function replyFrom(who: string, written: string, token: string) {
  const raw = [
    `From: ${who}`,
    "To: os@joinwestpeek.com",
    "Subject: Re: Porter: blocked",
    "",
    written,
    "",
    "On Sun, 20 Sep 2026 at 21:02, Porter <os@westpeek.ventures> wrote:",
    "> The plan is on the card.",
  ].join("\n");
  return steerFromReply(env, { fromHeader: `<${who}>`, authenticationResults: GOOD_AUTH(who), subject: "Re: Porter: blocked", raw, inReplyTo: threadReference(token), references: null });
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: fakeBucket() as never,
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

describe("the door reads a Drive folder and a property", () => {
  it("parses the folder id, the property and the repo; a file link is not a folder", () => {
    const ask = parseWebPropertyAsk("site update", EMAIL);
    expect(ask?.drive_folder_id).toBe(FOLDER);
    expect(ask?.property_host).toBe("westpeek.ventures");
    expect(ask?.target_repo).toBe("join-west-peek-main");
    expect(isWebPropertyChange(ask)).toBe(true);
    const fileOnly = parseWebPropertyAsk("x", "see https://drive.google.com/file/d/1AbCdEfGhIjKlMnOp/view for the productions site");
    expect(fileOnly?.drive_folder_id).toBeNull();
    expect(fileOnly?.drive_file_url).toContain("/file/d/");
    expect(isWebPropertyChange(fileOnly)).toBe(false);
    expect(parseWebPropertyAsk("hello", "no links here")).toBeNull();
    expect(driveFolderLinks("a https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp. and https://drive.google.com/open?id=1ZyXwVuTsRqPoNmLk").map((l) => l.id)).toEqual(["1AbCdEfGhIjKlMnOp", "1ZyXwVuTsRqPoNmLk"]);
  });

  it("a folder with no property stays an ordinary assignment, with the link recorded", async () => {
    const id = await openAssignmentCard(env, { subject: "look at this", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `here: https://drive.google.com/drive/folders/${FOLDER}x\nthoughts?`, limits: EMAILED_TASK_LIMITS });
    const c = await card(id);
    expect(c.kind).toBeNull();
    expect(String(c.request_json)).toContain(`${FOLDER}x`);
    expect(c.state).toBe("OPEN");
    // Out of the sweep's way for the rest of the file: this file measures Porter's card.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });
});

describe("Scooter emails a package for the ventures site", () => {
  let chiefCardId = "";
  let porterCardId = "";
  let planRun: SeatRunRow;
  let blockThreadToken = "";

  it("lands on Walker's desk and is handed to Porter at the door, with the folder and the repo on the row", async () => {
    chiefCardId = await openAssignmentCard(env, { subject: "ventures site update", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: EMAIL, limits: EMAILED_TASK_LIMITS });
    const chief = await card(chiefCardId);
    expect(chief.state, "the chief's card closes as handed on").toBe("DONE");
    expect(String(chief.description)).toMatch(/Handed to Porter as work card (wc_[a-z0-9-]+)/);
    porterCardId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String(chief.description))![1]!;
    const porter = await card(porterCardId);
    expect(porter.owner_id).toBe("aie_porter");
    expect(porter.kind).toBe(WEB_PROPERTY_CHANGE_KIND);
    expect(porter.requested_by_email).toBe(SCOOTER);
    const row = await readWebPropertyChange(env, porterCardId);
    expect(row?.target_repo).toBe("join-west-peek-main");
    expect(row?.drive_folder_id).toBe(FOLDER);
    expect(row?.phase).toBe("PLAN");
  });

  it("the first tick parks ONE PLAN run for the Mac on the plan model; the next tick parks nothing and spends no attempt", async () => {
    const first = await tick();
    expect(first.card?.id).toBe(porterCardId);
    expect(first.outcome).toBe("PROGRESSED");
    const job = await liveJobFor(porterCardId);
    expect(job).not.toBeNull();
    expect(job!.run_kind).toBe("LOCAL_JOB");
    expect(job!.seat).toBe("claude_code");
    const payload = JSON.parse(job!.job_json!) as { phase: string; model: string; target_repo: string; drive: { folder_id: string }; rules: Record<string, string>; script: string };
    expect(payload.phase).toBe("PLAN");
    expect(payload.model, "the plan phase runs on the strongest model by the seeded rule").toBe("opus");
    expect(payload.target_repo).toBe("join-west-peek-main");
    expect(payload.drive.folder_id).toBe(FOLDER);
    expect(payload.rules.land_on_green).toBe("on");
    expect(payload.script).toBe("scripts/duties/web-property-change.mjs");

    const second = await tick();
    expect(second.card?.id).toBe(porterCardId);
    expect(second.outcome, "a held card is progressed, not attempted").toBe("PROGRESSED");
    const jobs = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM subscription_seat_run WHERE work_card_id = ?1").bind(porterCardId).first<{ n: number }>();
    expect(jobs!.n, "one live run per card").toBe(1);
    expect((await card(porterCardId)).work_attempts).toBe(0);
  });

  it("the row refuses a second live job for the card even if code tries", async () => {
    await expect(
      parkRun(env, { seat: "claude_code", purpose: "dup", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", workCardId: porterCardId, runKind: "LOCAL_JOB", jobJson: "{}" }),
    ).rejects.toThrow(/UNIQUE|unique/);
  });

  it("the question claimer is never handed the job; the job claimer is", async () => {
    const asAnswerer = await claimRun(env, "mac-test-seat", ["claude_code"]);
    expect(asAnswerer, "kinds defaults to ANSWER").toBeNull();
    const asJobs = await claimRun(env, "mac-test-jobs", ["claude_code"], new Date(), ["LOCAL_JOB"]);
    expect(asJobs?.work_card_id).toBe(porterCardId);
    planRun = asJobs!;
    const pulse = await progressRun(env, { runId: planRun.id, deviceId: "mac-test-jobs", note: "pulling the folder" });
    expect(pulse.accepted).toBe(true);
    const held = await tick();
    expect(held.outcome).toBe("PROGRESSED");
    expect(held.summary).toMatch(/pulling the folder/);
  });

  it("an unreadable report is a failed attempt, never a silent success", () => {
    expect(readLocalJobReport("").report).toBeNull();
    expect(readLocalJobReport("{\"phase\":\"PLAN\"}").problem).toMatch(/no status/);
    expect(readLocalJobReport("{\"phase\":\"PLAN\",\"status\":\"blocked\"}").problem).toMatch(/must say why/);
    expect(readLocalJobReport("noise\n{\"phase\":\"PLAN\",\"status\":\"ok\",\"document\":\"# plan\"}").report?.document).toBe("# plan");
  });

  it("the PLAN comes back: a Document on the card, DECIDED and ASK recorded, the card BLOCKED to Scooter with the asks emailed", async () => {
    await reportRun(env, {
      runId: planRun.id,
      deviceId: "mac-test-jobs",
      outputText: JSON.stringify({
        phase: "PLAN",
        status: "ok",
        document: "# Plan: ventures site update\n\n## Changes\n- team page\n- portfolio logos\n\n## Live proof\n- https://westpeek.ventures/team\n",
        decided: ["new /team route with a redirect from /people", "logos on cream tiles per the RUNBOOK"],
        asks: [
          { question: "Use the orange accent on the team page headings, or keep black/white?", recommended: "keep black/white — the ventures visual system is frozen" },
          { question: "The thesis doc drops the 'first cheque' claim — remove it from the site too?", recommended: "remove it; the doc is the source of truth" },
        ],
      }),
    });
    const out = await tick();
    expect(out.outcome).toBe("BLOCKED");
    const c = await card(porterCardId);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_reason).toBe("a_question_for_you");
    expect(c.block_who, "Scooter answers Scooter's questions").toBe("SCOOTER");
    expect(String(c.block_needed)).toMatch(/orange accent/);
    expect(String(c.block_needed)).toMatch(/first cheque/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.plan_document_id, "the plan is filed as a Document").toBeTruthy();
    expect(row.plan_deliverable_id).toBeTruthy();
    expect(JSON.parse(row.asks_json)).toHaveLength(2);
    expect(JSON.parse(row.decided_json)).toHaveLength(2);
    expect(row.current_run_id, "the lease is released").toBeNull();
    const doc = await env.WP_OS_DB.prepare("SELECT title FROM document WHERE id = ?1").bind(row.plan_document_id).first<{ title: string }>();
    expect(doc?.title).toMatch(/^Plan: /);

    const email = sent.find((m) => m.to === SCOOTER && /blocked/i.test(m.subject));
    expect(email, "the asks are emailed to the requesting partner").toBeDefined();
    expect(email!.text).toMatch(/orange accent/);
    expect(email!.text, "each ask carries Porter's recommended default").toMatch(/Porter recommends: keep black\/white/);
    expect(email!.text, "THE PLAN ITSELF is in the mail, not only a link").toMatch(/# Plan: ventures site update/);
    expect(email!.text).toMatch(/portfolio logos/);
    expect(email!.text).toMatch(/Reply "approved"/);
    expect(String(c.block_needed).length, "the card's column stays short").toBeLessThanOrEqual(900);
    const thread = await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterCardId).first<{ token: string }>();
    blockThreadToken = thread!.token;
    expect(blockThreadToken).toBeTruthy();
  });

  it("Sequoia's \"approved\" on Scooter's question is kept as a note and advances nothing", async () => {
    const out = await replyFrom(SEQUOIA, "approved", blockThreadToken);
    expect(out.steered).toBe(true);
    expect(out.answered).toBe(false);
    expect((await card(porterCardId)).state).toBe("BLOCKED");
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterCardId).first<{ body: string }>();
    expect(note?.body).toMatch(/Not the partner this question was addressed to/);
    expect((await readWebPropertyChange(env, porterCardId))!.plan_approved_at).toBeNull();
  });

  it("Scooter's \"no\" HOLDS the card: recorded as a finding, still BLOCKED, nothing approved, nothing parked", async () => {
    const out = await replyFrom(SCOOTER, "No — hold on, I want to look at the logos first", blockThreadToken);
    expect(out.steered).toBe(true);
    expect(out.answered, "the reply reaches the card through the answer door").toBe(true);
    const held = await tick();
    expect(held.outcome).toBe("BLOCKED");
    const c = await card(porterCardId);
    expect(c.state).toBe("BLOCKED");
    expect(String(c.description)).toMatch(/Not approved by scooter@westpeek.ventures: "No — hold on/);
    expect(String(c.block_needed)).toMatch(/Nothing is built/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.plan_approved_at, "\"no\" never sets plan_approved_at").toBeNull();
    expect(row.phase).toBe("PLAN");
    expect(await liveJobFor(porterCardId)).toBeNull();
    // The re-block emailed him again with the plan; the next reply lands on the newest thread.
    const thread = await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterCardId).first<{ token: string }>();
    blockThreadToken = thread!.token;
  });

  it("Scooter replies exactly \"approved\": the block clears, every ask takes its recommended default, BUILD is parked with the plan and the answers on the job", async () => {
    const out = await replyFrom(SCOOTER, "approved", blockThreadToken);
    expect(out.steered).toBe(true);
    expect(out.answered, "the reply IS the answer, through the same door as the button").toBe(true);
    const reopened = await card(porterCardId);
    expect(reopened.state).toBe("OPEN");
    expect(String(reopened.block_answer)).toBe("approved");

    const next = await tick();
    expect(next.outcome).toBe("PROGRESSED");
    expect(next.summary).toMatch(/BUILD queued/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.phase).toBe("BUILD");
    expect(row.plan_approved_at).toBeTruthy();
    expect(row.plan_approved_by).toBe("fu_scooter_taylor");
    const answers = JSON.parse(row.answers_json) as string[];
    expect(answers, "one word answered every ask with its recommendation").toHaveLength(2);
    expect(answers[0]).toMatch(/keep black\/white .*approved as recommended/);
    expect(answers[1]).toMatch(/remove it; the doc is the source of truth/);
    const job = (await liveJobFor(porterCardId))!;
    const payload = JSON.parse(job.job_json!) as { phase: string; model: string; plan: { text: string; answers: string[]; approved_at: string } };
    expect(payload.phase).toBe("BUILD");
    expect(payload.model).toBe("sonnet");
    expect(payload.plan.text).toMatch(/^# Plan: ventures site update/);
    expect(payload.plan.answers[0]).toMatch(/keep black\/white/);
    expect((payload.plan as unknown as { asks: Array<{ recommended: string }> }).asks[0]!.recommended).toMatch(/keep black\/white/);
    expect(payload.plan.approved_at).toBe(row.plan_approved_at);
  });

  it("LAND cannot be parked without approval and green — and the row refuses DONE without a PR, a green and a merge", async () => {
    const row = (await readWebPropertyChange(env, porterCardId))!;
    const c = await card(porterCardId);
    const sweepCard = { id: porterCardId, title: String(c.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER };
    const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
    const noPr = await parkPhase(env, sweepCard, row, "LAND", rules);
    expect(noPr.parked).toBe(false);
    expect((noPr as { reason: string }).reason).toMatch(/no PR/);
    const noGreen = await parkPhase(env, sweepCard, { ...row, pr_url: "https://github.com/x/y/pull/9" } as WebPropertyChangeRow, "LAND", rules);
    expect(noGreen.parked).toBe(false);
    expect((noGreen as { reason: string }).reason).toMatch(/green/);
    const noApproval = await parkPhase(env, sweepCard, { ...row, pr_url: "https://github.com/x/y/pull/9", check_state: "GREEN", check_green_at: "2026-09-20T12:00:00.000Z", plan_approved_at: null } as WebPropertyChangeRow, "LAND", rules);
    expect(noApproval.parked).toBe(false);
    expect((noApproval as { reason: string }).reason).toMatch(/approved/);

    await expect(env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(porterCardId).run()).rejects.toThrow(/cannot be DONE without a PR link, a recorded green check and a merge/);
  });

  it("BUILD reports a RED check: a failed attempt, nothing landed, BUILD is re-queued on the same branch", async () => {
    await macReports(porterCardId, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/14", pr_number: 14, branch: "work/wpc-abc12345", check_state: "RED", check_url: "https://github.com/seq23/join-west-peek-main/actions/runs/1", proof: "validate: 2 failed", reason: "validate:disclosure failed" });
    const out = await tick();
    expect(out.outcome).toBe("FAILED");
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.pr_url).toBe("https://github.com/seq23/join-west-peek-main/pull/14");
    expect(row.check_state).toBe("RED");
    expect(row.check_green_at).toBeNull();
    expect((await card(porterCardId)).work_attempts).toBe(1);
    const again = await tick();
    expect(again.outcome).toBe("PROGRESSED");
    expect(again.summary).toMatch(/BUILD queued .* to fix/);
  });

  it("BUILD reports GREEN: land on green is ON, so LAND is queued at once on the cheap model — no further reply", async () => {
    await macReports(porterCardId, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/14", pr_number: 14, branch: "work/wpc-abc12345", check_state: "GREEN", check_url: "https://github.com/seq23/join-west-peek-main/actions/runs/2", proof: "npm run validate: green · shots/team-desktop.png shots/team-390.png · curl https://example.org 200" });
    const out = await tick();
    expect(out.outcome).toBe("PROGRESSED");
    expect(out.summary).toMatch(/green; landing is queued/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.check_state).toBe("GREEN");
    expect(row.check_green_at).toBeTruthy();
    expect(row.phase).toBe("LAND");
    const job = (await liveJobFor(porterCardId))!;
    const payload = JSON.parse(job.job_json!) as { phase: string; model: string; pr: { url: string; check_green_at: string } };
    expect(payload.phase).toBe("LAND");
    expect(payload.model).toBe("haiku");
    expect(payload.pr.check_green_at).toBe(row.check_green_at);
    // Two blocked emails so far (the plan, then his "no"), and nothing since: green does not email.
    expect(sent.filter((m) => m.to === SCOOTER && /blocked/i.test(m.subject)).length).toBe(2);
    expect(sent.filter((m) => m.to === SCOOTER && !/blocked/i.test(m.subject)).length, "no second email between green and land").toBe(0);
  });

  it("LAND reports the merge: the card is DONE, the row carries the proof, and the DONE email to Scooter carries it too", async () => {
    await macReports(porterCardId, { phase: "LAND", status: "ok", merge_sha: "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e", live_proof: "https://westpeek.ventures/team → 200, nav present, no sister hrefs\nhttps://westpeek.ventures/assets/img/portfolio/x.png → 200" });
    const out = await tick();
    expect(out.outcome).toBe("DONE");
    const c = await card(porterCardId);
    expect(c.state).toBe("DONE");
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.phase).toBe("DONE");
    expect(row.merge_sha).toMatch(/^9f8e7d6c/);
    const done = sent.filter((m) => m.to === SCOOTER && /done/i.test(m.subject));
    expect(done).toHaveLength(1);
    expect(done[0]!.text).toMatch(/pull\/14/);
    expect(done[0]!.text).toMatch(/westpeek\.ventures\/team/);
    const filed = await env.WP_OS_DB.prepare("SELECT kind, prepared_for FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(porterCardId).first<{ kind: string; prepared_for: string }>();
    expect(filed?.kind).toBe("employee_finding");
    expect(filed?.prepared_for).toBe("fu_scooter_taylor");
  });
});

describe("land on green OFF asks first", () => {
  it("a green BUILD blocks with the PR and a question when the rule is off; the answer lands it", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = 'off' WHERE kind = ?1 AND rule_key = 'land_on_green'").bind(WEB_PROPERTY_CHANGE_KIND).run();
    const id = await openAssignmentCard(env, { subject: "productions site", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `westpeekproductions.com refresh — package: https://drive.google.com/drive/folders/${FOLDER}zz`, limits: EMAILED_TASK_LIMITS });
    const porterId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(id)).description))![1]!;
    // Skip the plan ceremony: approve directly through the card's own door.
    await tick(); // parks PLAN
    await macReports(porterId, { phase: "PLAN", status: "ok", document: "# Plan: productions refresh\n\nnothing to ask", decided: ["all structure"], asks: [] });
    await tick(); // blocks: "go" to approve
    expect((await card(porterId)).state).toBe("BLOCKED");
    await answerBlock(env, porterId, "fu_sequoia_taylor", { action: "ANSWER", text: "go" });
    await tick(); // approval → BUILD parked
    await macReports(porterId, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/15", pr_number: 15, check_state: "GREEN" });
    const out = await tick();
    expect(out.outcome).toBe("BLOCKED");
    const c = await card(porterId);
    expect(c.block_who).toBe("SEQUOIA");
    expect(String(c.block_needed)).toMatch(/Land on green is OFF/);
    expect(await liveJobFor(porterId), "nothing queued for the Mac while she decides").toBeNull();
    await answerBlock(env, porterId, "fu_sequoia_taylor", { action: "ANSWER", text: "land it" });
    const landing = await tick();
    expect(landing.outcome).toBe("PROGRESSED");
    expect(landing.summary).toMatch(/LAND queued/);
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = 'on' WHERE kind = ?1 AND rule_key = 'land_on_green'").bind(WEB_PROPERTY_CHANGE_KIND).run();
  });

  it("a rule row overrides the model per phase; a bad value falls back to the registry default", () => {
    expect(phaseModel({ model_plan: "sonnet" }, "PLAN")).toBe("sonnet");
    expect(phaseModel({ model_plan: "gpt-9" }, "PLAN")).toBe("opus");
    expect(phaseModel({}, "LAND")).toBe("haiku");
  });
});

describe("the reaper judges a job by its pulse and its ceiling", () => {
  it("a claimed job silent past JOB_SILENCE_MS is closed (not re-offered); a pinging one is left alone; a queued job waits for the Mac", async () => {
    const now = new Date("2026-09-21T09:00:00.000Z");
    const silent = await parkRun(env, { seat: "claude_code", purpose: "silent", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: JSON.stringify({ queue_max_seconds: 43200 }), maxSeconds: 3600 });
    const alive = await parkRun(env, { seat: "claude_code", purpose: "alive", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: JSON.stringify({ queue_max_seconds: 43200 }), maxSeconds: 3600 });
    const waiting = await parkRun(env, { seat: "claude_code", purpose: "waiting", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: JSON.stringify({ queue_max_seconds: 43200 }) });
    const claimedAt = new Date(now.getTime() - JOB_SILENCE_MS - 60_000).toISOString();
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2, attempt_count = 1 WHERE id IN (?1, ?3)").bind(silent, claimedAt, alive).run();
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET progressed_at = ?2 WHERE id = ?1").bind(alive, new Date(now.getTime() - 30_000).toISOString()).run();
    // An answer-kind row claimed 6 minutes ago keeps 0187's rule: returned to the pool.
    const answer = await parkRun(env, { seat: "claude_code", purpose: "answer", prompt: "x", modelAccess: "PRIVATE_MODEL_ONLY" });
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2, attempt_count = 1 WHERE id = ?1").bind(answer, new Date(now.getTime() - 6 * 60_000).toISOString()).run();
    // A queued job older than 0187's ten minutes but inside its own ceiling.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(waiting, new Date(now.getTime() - 2 * 3600_000).toISOString()).run();

    const out = await reapSeatRuns(env, now);
    expect(out.abandoned).toContain(silent);
    expect((await readRun(env, silent))!.resolution).toMatch(/went quiet/);
    expect((await readRun(env, alive))!.status).toBe("CLAIMED");
    expect((await readRun(env, waiting))!.status, "a job waits for the Mac past the answer queue's ten minutes").toBe("QUEUED");
    expect((await readRun(env, answer))!.status, "0187's answer rule is unchanged").toBe("QUEUED");
    expect(out.returnedToPool).toContain(answer);

    // Past its own ceiling, a queued job is closed with the reason.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(waiting, new Date(now.getTime() - 13 * 3600_000).toISOString()).run();
    const later = await reapSeatRuns(env, now);
    expect(later.abandoned).toContain(waiting);
    expect((await readRun(env, waiting))!.resolution).toMatch(/No machine claimed this job/);
  });

  it("a job past its own ceiling is closed even while pinging", async () => {
    const now = new Date("2026-09-21T10:00:00.000Z");
    const over = await parkRun(env, { seat: "claude_code", purpose: "over", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: "{}", maxSeconds: 600 });
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2, progressed_at = ?3, attempt_count = 1 WHERE id = ?1")
      .bind(over, new Date(now.getTime() - 700_000).toISOString(), new Date(now.getTime() - 10_000).toISOString())
      .run();
    const out = await reapSeatRuns(env, now);
    expect(out.abandoned).toContain(over);
    expect((await readRun(env, over))!.resolution).toMatch(/past its/);
  });

  it("a pulse for a run this device no longer holds is refused", async () => {
    const id = await parkRun(env, { seat: "claude_code", purpose: "p", prompt: "x", modelAccess: "PUBLIC_MODEL_APPROVED", runKind: "LOCAL_JOB", jobJson: "{}" });
    const out = await progressRun(env, { runId: id, deviceId: "someone-else" });
    expect(out.accepted).toBe(false);
  });
});
