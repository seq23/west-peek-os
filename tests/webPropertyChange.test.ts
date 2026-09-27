import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce } from "../src/worker/services/workSweep";
import { claimRun, parkRun, progressRun, reapSeatRuns, readRun, reportRun, JOB_SILENCE_MS, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { parseWebPropertyAsk, isWebPropertyChange, driveFolderLinks, addresseeIn, sitesOf } from "../src/shared/intake/webPropertyChange";
import { parseBlogAsk } from "../src/shared/intake/blogHelp";
import { workCard } from "../src/worker/services/employeeWork";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { preApprovalIn } from "../src/shared/work/approvalReply";
import { readLocalJobReport, WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { needsPreview, parkPhase, phaseModel, readWebPropertyChange, rulesFor, runWebPropertyChangeCard, type WebPropertyChangeRow } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { answerBlock } from "../src/worker/services/blocks";
import { handleInboundEmail, MAX_BODY_BYTES } from "../src/worker/effects/inboundEmail";
import { comparableSubject } from "../src/worker/services/emailThread";
import { requestAttachments, textBodyOf } from "../src/worker/effects/mimeAttachments";
import { handleGetRequestAttachment, handleReingestStoredEmail, sendReceived, stuckWindowOpen } from "../src/worker/services/webPropertyChange";
import { readFileSync } from "node:fs";

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
 *   · THE PLAN IS ON THE CARD'S OWN ROW, NEVER FILED INTO DOCUMENTS (0231, Addendum 4.3), and the
 *     ASKS BLOCK THE CARD, addressed to the partner who asked.
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

const SEQUOIA_PARTNER_EMAIL = "sequoia@westpeek.ventures";
const SCOOTER = "scooter@westpeek.ventures";
const SEQUOIA = "sequoia@westpeek.ventures";
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUv";
const EMAIL = `Hi — please update the westpeek.ventures site with the package here: https://drive.google.com/drive/folders/${FOLDER}?usp=sharing\n\nNew team page, portfolio logos, and the thesis copy in the doc.\n`;

function fakeBucket() {
  const store = new Map<string, Uint8Array>();
  return {
    put: async (key: string, body: ArrayBuffer | Uint8Array | string) => {
      store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body instanceof Uint8Array ? body : new Uint8Array(body));
      return { key };
    },
    get: async (key: string) => {
      const b = store.get(key);
      return b ? { arrayBuffer: async () => b.buffer, text: async () => new TextDecoder().decode(b) } : null;
    },
  };
}

/**
 * THE SWEEP'S CLOCK, three minutes a tick. A card the Mac holds is leased for HELD_MINUTES so the
 * next card gets the tick; a test that ticks "again" is asking what the NEXT sweep does, which is
 * three minutes later, not the same instant.
 */
let clock = Date.now();
function nextTickTime(): Date {
  clock += 3 * 60_000;
  return new Date(clock);
}
async function tick(): Promise<Awaited<ReturnType<typeof sweepOnce>>> {
  return sweepOnce(env, nextTickTime());
}

/** Sweep until THIS card is the one worked (older cards the sweep holds are worked first). */
async function tickFor(id: string): Promise<Awaited<ReturnType<typeof sweepOnce>>> {
  // Held cards are leased for HELD_MINUTES; the clock here is real, so a held sibling is skipped.
  for (let i = 0; i < 8; i++) {
    const out = await sweepOnce(env, nextTickTime());
    if (out.card?.id === id) return out;
    // Nothing waiting means every card is held or done; the clock moves on and the hold expires.
  }
  throw new Error(`the sweep never reached ${id}`);
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
  const run = await env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = 'QUEUED'").bind(cardId).first<SeatRunRow>();
  expect(run, "a LOCAL_JOB was parked for the Mac").not.toBeNull();
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac-test-jobs', claimed_at = ?2, attempt_count = attempt_count + 1 WHERE id = ?1").bind(run!.id, new Date().toISOString()).run();
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
  return steerFromReply(env, { fromHeader: `<${who}>`, authenticationResults: GOOD_AUTH(who), subject: "Re: Porter: blocked", raw, inReplyTo: threadReference(token), references: null, emlKey: null });
}


/**
 * THE FINISHED EMAIL, WHEREVER IT WENT (0223, 22 Sep 2026). `done_reply_preview_first` is seeded ON,
 * so Porter's DONE reply to the partner who asked is FILED for Sequoia with Send it / Send it back /
 * Dismiss rather than sent. These pins used to read `sent.filter(to === SCOOTER)`; they now read the
 * body that is waiting for her, which is the same text, and additionally require that nothing
 * reached the requester before she has seen it. Strictly more than they asserted before.
 */
async function finishedEmailFor(cardId: string): Promise<{ text: string; state: string; owner: string }> {
  const row = await env.WP_OS_DB.prepare("SELECT body_text, state, owner_firm_user_id FROM preview_approval WHERE work_card_id = ?1 ORDER BY created_at DESC")
    .bind(cardId)
    .first<{ body_text: string; state: string; owner_firm_user_id: string }>();
  expect(row, "Porter's finished email is waiting on her Home").not.toBeNull();
  return { text: row!.body_text, state: row!.state, owner: row!.owner_firm_user_id };
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
    expect(isWebPropertyChange(fileOnly), "a property named is a change; the file link is an asset").toBe(true);
    expect(parseWebPropertyAsk("hello", "no links here")).toBeNull();
    expect(isWebPropertyChange(parseWebPropertyAsk("hello", "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp with no property named")), "a folder with no property is not a change").toBe(false);
    expect(driveFolderLinks("a https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOp. and https://drive.google.com/open?id=1ZyXwVuTsRqPoNmLk").map((l) => l.id)).toEqual(["1AbCdEfGhIjKlMnOp", "1ZyXwVuTsRqPoNmLk"]);
  });

  it("the site she ASKED about wins; an email address or a signature never picks the site (23 Sep 2026)", () => {
    const folder = `https://drive.google.com/drive/folders/${FOLDER}`;
    // Her real shape: a community redesign, sent from and signed with the ventures address.
    const signed = parseWebPropertyAsk(
      "Community site redesign",
      `Porter, everything for the community site redesign is in ${folder}. Start with the README.\n\nSequoia Taylor\nsequoia@westpeek.ventures\nwww.westpeek.ventures`,
    );
    expect(signed?.property_host, "a signature's ventures address routed a community redesign").toBe("joinwestpeek.com");
    expect(signed?.site).toBe("sites/community");
    expect(signed?.property_unresolved).toBeFalsy();
    // The agency is West Peek Productions.
    expect(parseWebPropertyAsk("x", `the agency site needs this: ${folder} — reply to sequoia@westpeek.ventures`)?.site).toBe("sites/productions");
    // A site address she WROTE (no site named in words) still names it; one inside an email address never does.
    expect(parseWebPropertyAsk("x", `update joinwestpeek.com from ${folder}`)?.site).toBe("sites/community");
    const mailboxOnly = parseWebPropertyAsk("x", `${folder} — questions to sequoia@westpeek.ventures`);
    expect(mailboxOnly?.property_host, "a mailbox named a site").toBeNull();
    // Two sites in one repo are ONE job over both folders — never a stop, never a silent pick of one.
    const both = parseWebPropertyAsk("x", `update the community site and the agency site from ${folder}`);
    expect(both?.property_host).toBe("westpeekproductions.com, joinwestpeek.com");
    expect(both?.site).toBe("sites/productions, sites/community");
    expect(both?.target_repo).toBe("join-west-peek-main");
    expect(both?.property_unresolved).toBeFalsy();
    expect(isWebPropertyChange(both)).toBe(true);
    expect(sitesOf(both?.property_host)).toEqual(["sites/productions", "sites/community"]);
    // All three in one email: one job over all three.
    expect(sitesOf(parseWebPropertyAsk("x", `the ventures site, the agency site and the community site: ${folder}`)?.property_host)).toEqual(["sites/ventures", "sites/productions", "sites/community"]);
    expect(sitesOf("joinwestpeek.com")).toEqual(["sites/community"]);
    expect(sitesOf(null)).toEqual([]);
  });

  it("\"preview first\" in the opening email is read at the door, so she never has to say it twice", () => {
    const folder = `https://drive.google.com/drive/folders/${FOLDER}`;
    for (const words of ["send me a preview first", "Preview first please", "I want to see it before it goes live", "email me a preview link"]) {
      expect(parseWebPropertyAsk("x", `community site: ${folder}. ${words}.`)?.preview_first, words).toBeTruthy();
    }
    expect(parseWebPropertyAsk("x", `community site: ${folder}.`)?.preview_first).toBeNull();
  });

  it("a folder with no property stays an ordinary assignment, with the link recorded", async () => {
    const id = await openAssignmentCard(env, { subject: "look at this", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `here: https://drive.google.com/drive/folders/${FOLDER}x\nthoughts?`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const c = await card(id);
    expect(c.kind).toBeNull();
    expect(String(c.request_json)).toContain(`${FOLDER}x`);
    expect(c.state).toBe("OPEN");
    // Out of the sweep's way for the rest of the file: this file measures Porter's card.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });
});

describe("an opening email that asks for a preview first", () => {
  it("opens Porter's row with preview_only = 1 — and so does an email that never says it (owner, 23 Sep 2026: preview first for all repo work)", async () => {
    const plain = await openAssignmentCard(env, { subject: "Community site footer", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `Porter, the community site footer is in https://drive.google.com/drive/folders/${FOLDER}pl.\n\nsequoia@westpeek.ventures`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const plainId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(plain)).description))![1]!;
    const plainRow = (await readWebPropertyChange(env, plainId))!;
    expect(JSON.parse(String((await card(plainId)).request_json)).preview_first ?? null, "the request did not ask").toBeNull();
    expect(plainRow.preview_only, "preview first without the phrase").toBe(1);
    expect(needsPreview(plainRow)).toBe(true);
    expect((await card(plainId)).preview_first, "the card's own \"show me first\" is untouched — it is a different hold").toBeNull();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(plainId).run();
    const id = await openAssignmentCard(env, { subject: "Community site redesign", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `Porter, the community site redesign is all in https://drive.google.com/drive/folders/${FOLDER}. Send me a preview first.\n\nsequoia@westpeek.ventures`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const porterId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(id)).description))![1]!;
    const row = await readWebPropertyChange(env, porterId);
    expect(row?.property_host, "routed by the signature again").toBe("joinwestpeek.com");
    expect(row?.preview_only).toBe(1);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(porterId).run();
  });
});

describe("Scooter emails a package for the ventures site", () => {
  let chiefCardId = "";
  let porterCardId = "";
  let planRun: SeatRunRow;
  let blockThreadToken = "";

  it("lands on Walker's desk and is handed to Porter at the door, with the folder and the repo on the row", async () => {
    chiefCardId = await openAssignmentCard(env, { subject: "ventures site update", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: EMAIL, limits: EMAILED_TASK_LIMITS, emlKey: null });
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
    const first = await tickFor(porterCardId);
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

    // A HELD CARD IS NOT WAITING: while its job is queued or on the Mac, the sweep never takes it,
    // so every younger card gets the tick. It is claimable again the moment the run is reported.
    const second = await sweepOnce(env, nextTickTime());
    expect(second.card?.id, "a card the Mac holds is skipped").not.toBe(porterCardId);
    expect(second.outcome).toBe("NOTHING_WAITING");
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
    // The button path reads the pulse while the sweep leaves the card alone.
    const held = await runWebPropertyChangeCard(env, { id: porterCardId, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    expect(held.held).toBe(true);
    expect(held.detail).toMatch(/pulling the folder/);
    expect((await sweepOnce(env, nextTickTime())).card?.id).not.toBe(porterCardId);
  });

  it("an unreadable report is a failed attempt, never a silent success", () => {
    expect(readLocalJobReport("").report).toBeNull();
    expect(readLocalJobReport("{\"phase\":\"PLAN\"}").problem).toMatch(/no status/);
    expect(readLocalJobReport("{\"phase\":\"PLAN\",\"status\":\"blocked\"}").problem).toMatch(/must say why/);
    expect(readLocalJobReport("noise\n{\"phase\":\"PLAN\",\"status\":\"ok\",\"document\":\"# plan\"}").report?.document).toBe("# plan");
  });

  it("the PLAN comes back: on the card's own row, never filed into Documents, DECIDED and ASK recorded, the card BLOCKED to Scooter with the asks emailed", async () => {
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
          // NO RECOMMENDATION — a real question only the partner can answer. Since 27 Sep 2026 a
          // plan whose every ask carries a recommendation never waits (see "every decision carries a
          // recommendation" below); ONE ask without one is what still blocks the card.
          { question: "The thesis doc drops the 'first cheque' claim — remove it from the site too?", recommended: "" },
        ],
        publish_ready: true,
        placeholders: [],
      }),
    });
    const out = await tickFor(porterCardId);
    expect(out.outcome, "an ask WITHOUT a recommendation still blocks").toBe("BLOCKED");
    const c = await card(porterCardId);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_reason).toBe("a_question_for_you");
    expect(c.block_who, "Scooter answers Scooter's questions").toBe("SCOOTER");
    expect(String(c.block_needed)).toMatch(/orange accent/);
    expect(String(c.block_needed)).toMatch(/first cheque/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    // 0231, Addendum 4.3: the plan is on the row, never filed into Documents — strengthened from
    // the old pin ("the plan is filed as a Document"), which asserted the behaviour this PR removes.
    expect(row.plan_text, "the plan's text is on the card's own row").toContain("# Plan: ventures site update");
    expect(row.plan_document_id, "no Document is filed for the plan any more").toBeNull();
    expect(row.plan_deliverable_id, "no deliverable is filed for the plan any more").toBeNull();
    expect(JSON.parse(row.asks_json)).toHaveLength(2);
    expect(JSON.parse(row.decided_json)).toHaveLength(2);
    expect(row.current_run_id, "the lease is released").toBeNull();
    const docs = await env.WP_OS_DB.prepare("SELECT id FROM document WHERE title LIKE 'Plan: %'").all<{ id: string }>();
    expect(docs.results ?? [], "Documents holds no 'Plan: …' row for this card").toHaveLength(0);

    // The card's own API response carries the plan text, so the card page can render it without
    // Documents — this is the surface that replaces "Open the plan" navigating to Documents.
    const apiRes = await handleRequest(new Request(`https://test.local/api/work-cards/${porterCardId}/web-property-change`, { headers: { "x-wpos-dev-user": SCOOTER } }), env);
    const apiBody = (await apiRes.json()) as { plan_text: string | null; plan_document_id: string | null };
    expect(apiBody.plan_text).toContain("# Plan: ventures site update");
    expect(apiBody.plan_document_id).toBeNull();

    // THE PLAN EMAIL, ONE SCREEN (owner, 23 Sep 2026: "too long and i have no idea what he wants
    // from me. it says blocked"). The reply options ARE the TL;DR, first; each decision one line
    // with the recommendation in bold; the plan is on the card, not in the mail; never "blocked".
    const email = sent.find((m) => m.to === SCOOTER && /plan ready/i.test(m.subject));
    expect(email, "the asks are emailed to the requesting partner").toBeDefined();
    expect(email!.subject).toBe("Porter: Ventures site update: Plan ready");
    expect(email!.subject).not.toMatch(/blocked/i);
    expect(email!.text).toMatch(/^\*\*TL;DR:\*\* Plan ready\. Reply \*\*approved\*\* and I'll build the preview now\. Nothing goes live until you approve the preview\.\n• \*\*approved\*\*: take my 2 recommendations and build the preview\n• \*\*approved to production\*\*: skip the preview and land on green\n• \*\*changes: …\*\*: hold it and tell me what to change\n• anything else: read as your answers to the decisions below\n/);
    expect(email!.text).toMatch(/\*\*2 decisions \(my recommendation in bold\)\*\*\n• Use the orange accent on the team page headings, or keep black\/white\? → \*\*keep black\/white — the ventures visual system is frozen\*\*\n/);
    expect(email!.text, "the plan itself stays on the card; the mail links to it").not.toMatch(/# Plan: ventures site update|portfolio logos/);
    expect(email!.text).toMatch(/The full plan is on the card: https:\/\/os\.joinwestpeek\.com\/#\/work \(card wc_/);
    expect(email!.text).toMatch(/The first preview comes right after you approve the plan\./);
    expect(email!.text.match(/\*\*approved\*\*:/g), "the options appear once, at the top").toHaveLength(1);
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
    const held = await tickFor(porterCardId);
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

    const next = await tickFor(porterCardId);
    expect(next.outcome).toBe("PROGRESSED");
    expect(next.summary).toMatch(/BUILD queued/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.phase).toBe("BUILD");
    expect(row.plan_approved_at).toBeTruthy();
    expect(row.plan_approved_by).toBe("fu_scooter_taylor");
    const answers = JSON.parse(row.answers_json) as string[];
    expect(answers, "one word answered every ask with its recommendation").toHaveLength(2);
    expect(answers[0]).toMatch(/keep black\/white .*approved as recommended/);
    expect(answers[1], "an ask that had no recommendation records that it had none").toMatch(/no recommendation given/);
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
    const out = await tickFor(porterCardId);
    expect(out.outcome).toBe("FAILED");
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.pr_url).toBe("https://github.com/seq23/join-west-peek-main/pull/14");
    expect(row.check_state).toBe("RED");
    expect(row.check_green_at).toBeNull();
    expect((await card(porterCardId)).work_attempts).toBe(1);
    const again = await tickFor(porterCardId);
    expect(again.outcome).toBe("PROGRESSED");
    expect(again.summary).toMatch(/BUILD queued .* to fix/);
  });

  it("BUILD reports GREEN: every site change previews first (23 Sep 2026), so green STOPS at the preview — LAND is refused, nothing is parked, one preview email; Scooter's \"approved\" after it queues LAND on the cheap model", async () => {
    // A DIFFERENT PR than the red attempt above (#14): the fix-up build opened #15. Pinning 15 is what
    // catches a LAND payload built from a stale row — the row still remembered #14.
    await macReports(porterCardId, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/15", pr_number: 15, branch: "work/wpc-abc12345-fix", check_state: "GREEN", check_url: "https://github.com/seq23/join-west-peek-main/actions/runs/2", proof: "npm run validate: green · shots/team-desktop.png shots/team-390.png · curl https://example.org 200" });
    const green = await tickFor(porterCardId);
    expect(green.outcome, "green stops at the preview; land on green does not override it").toBe("BLOCKED");
    const held = (await readWebPropertyChange(env, porterCardId))!;
    expect(held.preview_only, "opened preview-first without the phrase in the request").toBe(1);
    expect(held.check_state).toBe("GREEN");
    expect(held.check_green_at).toBeTruthy();
    expect(held.phase, "never reached LAND on green alone").toBe("BUILD");
    expect(held.land_approved_at).toBeNull();
    expect(held.forced_by).toBeNull();
    expect(held.preview_emailed_at).toBeTruthy();
    expect(await liveJobFor(porterCardId), "nothing parked for the Mac").toBeNull();
    expect(String((await card(porterCardId)).block_needed)).toMatch(/^PREVIEW READY\./);
    const c0 = await card(porterCardId);
    const gate = await parkPhase(env, { id: porterCardId, title: String(c0.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER }, held, "LAND", await rulesFor(env, WEB_PROPERTY_CHANGE_KIND));
    expect(gate.parked).toBe(false);
    expect((gate as { reason: string }).reason).toMatch(/previews first/);
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = 'deadbeef' WHERE work_card_id = ?1").bind(porterCardId).run()).rejects.toThrow(/second approval after the preview/);
    // RECEIVED at intake, then exactly three: the plan, the question after his "no", the preview —
    // and never the word "blocked" in any of them (owner, 23 Sep 2026).
    const toScooter = sent.filter((m) => m.to === SCOOTER && !/got it/i.test(m.subject));
    expect(toScooter.map((m) => m.subject.replace(/:.*?: /, ": ").replace(/ — .*/, "")), "plan, question, preview — nothing else").toEqual(["Porter: Plan ready", "Porter: A question for you", "Porter: Preview ready"]);
    expect(toScooter.every((m) => !/blocked/i.test(m.subject))).toBe(true);
    const previewMail = toScooter.at(-1)!;
    expect(previewMail.subject).toBe("Porter: Ventures site update: Preview ready");
    // No preview deployment for this repo: the line says so, and the PR stays on the card — never a
    // PR link in her inbox (23 Sep 2026).
    expect(previewMail.text).toMatch(/Current preview \(built \d{1,2}:\d{2} CT, \*{0,2}0\*{0,2} placeholders\): no preview deployment for this site — the change and its screenshots are on the card\n/);
    expect(previewMail.text).not.toMatch(/github\.com/);

    // Sequoia's "approved" is not his: it lands nothing.
    const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterCardId).first<{ token: string }>())!.token;
    expect((await replyFrom(SEQUOIA, "approved", token)).answered).toBe(false);
    expect((await readWebPropertyChange(env, porterCardId))!.land_approved_at).toBeNull();
    // His second "approved", after the preview email: LAND on the cheap model, the PR it previewed.
    expect((await replyFrom(SCOOTER, "approved", token)).answered).toBe(true);
    const out = await tickFor(porterCardId);
    expect(out.outcome).toBe("PROGRESSED");
    expect(out.summary).toMatch(/Landing approved after the preview; LAND queued/);
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.land_approved_by).toBe("fu_scooter_taylor");
    expect(row.phase).toBe("LAND");
    const job = (await liveJobFor(porterCardId))!;
    const payload = JSON.parse(job.job_json!) as { phase: string; model: string; pr: { url: string; number: number | null; branch: string | null; check_green_at: string; land_approved_at: string } };
    expect(payload.phase).toBe("LAND");
    expect(payload.model).toBe("haiku");
    expect(payload.pr.check_green_at).toBe(row.check_green_at);
    expect(payload.pr.land_approved_at).toBe(row.land_approved_at);
    // The LAND job must know WHICH PR: the first real newsletter job (21 Sep 2026) was queued with
    // number null and ran `land ""` — the row in memory had the URL but not the number the report
    // carried. Pinned on the job payload the Mac actually reads, not on the row.
    expect(payload.pr.number, "the LAND job carries the PR number the BUILD report gave").toBe(15);
    expect(payload.pr.branch, "and its branch").toBe("work/wpc-abc12345-fix");
  });

  it("LAND reports the merge: the card is DONE, the row carries the proof, and the DONE email to Scooter carries it too", async () => {
    await macReports(porterCardId, { phase: "LAND", status: "ok", merge_sha: "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e", live_proof: "https://westpeek.ventures/team → 200, nav present, no sister hrefs\nhttps://westpeek.ventures/assets/img/portfolio/x.png → 200" });
    const out = await tickFor(porterCardId);
    expect(out.outcome).toBe("DONE");
    const c = await card(porterCardId);
    expect(c.state).toBe("DONE");
    const row = (await readWebPropertyChange(env, porterCardId))!;
    expect(row.phase).toBe("DONE");
    expect(row.merge_sha).toMatch(/^9f8e7d6c/);
    // 0223: the finished email is HELD for her, carrying the same proof, and Scooter gets nothing
    // until she says so. Both halves are asserted; the proof pins are unchanged.
    expect(sent.filter((m) => m.to === SCOOTER && /done/i.test(m.subject)), "nothing finished reached Scooter on its own").toHaveLength(0);
    const done = await finishedEmailFor(porterCardId);
    expect(done.state).toBe("PENDING");
    expect(done.owner).toBe("fu_sequoia_taylor");
    // "Live" names where it went live (from the LAND's own curl); the PR and the proof are on the card.
    expect(done.text).toMatch(/^\*\*TL;DR:\*\* Live: your change is published\./);
    expect(done.text).toMatch(/\*\*Live now\*\*\n• https:\/\/westpeek\.ventures\/team\n• https:\/\/westpeek\.ventures\/assets\/img\/portfolio\/x\.png\n/);
    expect(done.text, "no PR link in her inbox").not.toMatch(/github\.com|pull\/15/);
    expect(String((await card(porterCardId)).description), "the PR is on the card").toMatch(/pull\/15/);
    const filed = await env.WP_OS_DB.prepare("SELECT kind, prepared_for FROM deliverable WHERE source_type = 'work_card' AND source_id = ?1").bind(porterCardId).first<{ kind: string; prepared_for: string }>();
    expect(filed?.kind).toBe("employee_finding");
    expect(filed?.prepared_for).toBe("fu_scooter_taylor");
  });
});

describe("land on green OFF asks first", () => {
  it("a FORCED change (the only one that skips the preview since 23 Sep 2026): a green BUILD blocks with the PR and a question when the rule is off; the answer lands it", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = 'off' WHERE kind = ?1 AND rule_key = 'land_on_green'").bind(WEB_PROPERTY_CHANGE_KIND).run();
    try {
      const id = await openAssignmentCard(env, { subject: "productions site", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `westpeekproductions.com refresh — package: https://drive.google.com/drive/folders/${FOLDER}zz\n\nyour call, approved to production.`, limits: EMAILED_TASK_LIMITS, emlKey: null });
      const porterId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(id)).description))![1]!;
      expect((await readWebPropertyChange(env, porterId))!.preview_only, "preview-first even when the request forces").toBe(1);
      await tickFor(porterId); // parks PLAN
      // Pre-approved and forced in the request: approved at filing, the force recorded, BUILD parks at once.
      await macReports(porterId, { phase: "PLAN", status: "ok", document: "# Plan: productions refresh\n\nnothing to ask", decided: ["all structure"], asks: [], publish_ready: true });
      expect((await tickFor(porterId)).summary).toMatch(/BUILD queued/);
      const forced = (await readWebPropertyChange(env, porterId))!;
      expect(forced.forced_by, "the named force is the only way past the preview").toBe("fu_sequoia_taylor");
      expect(forced.preview_only, "a force skips the gate; it never clears it").toBe(1);
      await macReports(porterId, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/15", pr_number: 15, check_state: "GREEN" });
      const out = await tickFor(porterId);
      expect(out.outcome).toBe("BLOCKED");
      const c = await card(porterId);
      expect(c.block_who).toBe("SEQUOIA");
      expect(String(c.block_needed)).toMatch(/Land on green is OFF/);
      expect(await liveJobFor(porterId), "nothing queued for the Mac while she decides").toBeNull();
      const question = sent.filter((m) => m.to === SEQUOIA && /: A question for you$/.test(m.subject)).pop()!;
      expect(question.subject, "never \"blocked\" to a partner").not.toMatch(/blocked/i);
      expect(question.text, "the question email carries the question, not the plan").toMatch(/Land on green is OFF/);
      expect(question.text).not.toMatch(/THE PLAN, in full/);
      await answerBlock(env, porterId, "fu_sequoia_taylor", { action: "ANSWER", text: "land it" });
      const landing = await tickFor(porterId);
      expect(landing.outcome).toBe("PROGRESSED");
      expect(landing.summary).toMatch(/LAND queued/);
      await macReports(porterId, { phase: "LAND", status: "ok", merge_sha: "aaaaaaaaaabbbbbbbbbbccccccccccdddddddddd", live_proof: "https://westpeekproductions.com → 200" });
      expect((await tickFor(porterId)).outcome).toBe("DONE");
    } finally {
      await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = 'on' WHERE kind = ?1 AND rule_key = 'land_on_green'").bind(WEB_PROPERTY_CHANGE_KIND).run();
    }
  });

  it("a rule row overrides the model per phase; a bad value falls back to the registry default", () => {
    expect(phaseModel({ model_plan: "sonnet" }, "PLAN")).toBe("sonnet");
    expect(phaseModel({ model_plan: "gpt-9" }, "PLAN")).toBe("opus");
    expect(phaseModel({}, "LAND")).toBe("haiku");
  });
});

/** Open a card for a partner, run PLAN with the given report, and return Porter's card id and the newest block thread token. */
async function planned(who: string, chief: string, subject: string, plan: Record<string, unknown>): Promise<{ id: string; token: () => Promise<string> }> {
  const chiefId = await openAssignmentCard(env, { subject, partnerAddress: who, chiefOfStaff: chief, raw: `${subject}: westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${subject.replace(/\W/g, "").slice(0, 6)}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
  const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
  await tickFor(id); // parks PLAN
  await macReports(id, { phase: "PLAN", status: "ok", ...plan });
  await tickFor(id); // blocks with the plan
  return {
    id,
    token: async () => (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token,
  };
}

describe("a plan that is not publish-ready previews first (21 Sep 2026)", () => {
  const PLACEHOLDERS = ["Airtable links", "Sengo logo", "episode records", "approved orange hex"];
  let id = "";
  let porter: Awaited<ReturnType<typeof planned>>;

  it("a recommended ask on a NOT-ready plan goes ahead too (27 Sep 2026): the FYI names the placeholders as optional missing items; the card is never blocked at the plan", async () => {
    porter = await planned(SEQUOIA, "Wren", "community rebuild", {
      document: "# Plan: community site rebuild\n\nTwelve open items ship as structured placeholders.",
      decided: ["placeholder blocks are marked and listed"],
      asks: [{ question: "Use the draft orange until the approved hex arrives?", recommended: "placeholder until supplied" }],
      publish_ready: false,
      placeholders: PLACEHOLDERS,
    });
    id = porter.id;
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.publish_ready).toBe(0);
    expect(JSON.parse(row.placeholders_json)).toEqual(PLACEHOLDERS);
    const c = await card(id);
    // STRICTER THAN THE OLD PIN (which asserted a "NOT PUBLISH-READY" block): a plan with nothing to
    // decide from scratch never blocks, ready or not — the preview stop below is what guards a
    // not-ready plan, and the finding says so.
    expect(c.state).not.toBe("BLOCKED");
    expect(row.phase).toBe("BUILD");
    expect(row.plan_approved_by).toMatch(/^request:/);
    expect(String(c.description)).toMatch(/It stops at a preview link before anything lands/);
    // The FYI: the placeholders are OPTIONAL missing items, the preview is built with placeholders
    // for them, and nothing goes live until she approves the preview.
    const email = sent.filter((m) => m.to === SEQUOIA && /going ahead/i.test(m.subject)).pop()!;
    expect(email.subject).toBe("Porter: Community rebuild: Going ahead");
    expect(email.text).toMatch(/^\*\*TL;DR:\*\* Going ahead with these — every decision had my recommendation, so I've taken it and started the build, with placeholders for the \*{0,2}4\*{0,2} missing items\. Reply \*\*changes: …\*\* to steer\. Nothing goes live until you approve the preview\./);
    expect(email.text).toMatch(/\*\*Missing items \(optional\)\*\*\n• Airtable links\n• Sengo logo\n• episode records\n• approved orange hex\n• You don't need these to continue\./);
    expect(email.text, "the plan is on the card, not in the mail").not.toMatch(/# Plan: community site rebuild|Twelve open items/);
    expect(sent.filter((m) => m.to === SEQUOIA && /plan ready/i.test(m.subject) && /Community rebuild/.test(m.subject)), "the asking form never went out").toHaveLength(0);
  });

  it("GREEN does NOT land — the preview email goes out with the four reply options, the link and the placeholders still showing, and the card waits", async () => {
    expect((await readWebPropertyChange(env, id))!.plan_approved_at).toBeTruthy();
    expect(await liveJobFor(id), "BUILD was parked at filing").not.toBeNull();
    // The card is for westpeek.ventures (planned() names it), so its preview lives under that site's
    // Pages project, and the link she gets is the branch alias — the build she is approving.
    await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/21", pr_number: 21, branch: "work/wpc-comm1234", check_state: "GREEN", preview_url: "https://a1b2c3d4.west-peek-ventures.pages.dev", proof: "npm run validate green · shots/community-desktop.png shots/community-390.png" });
    const green = await tickFor(id);
    expect(green.outcome, "green stops at the preview, land-on-green notwithstanding").toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.check_state).toBe("GREEN");
    expect(row.preview_url).toBe("https://a1b2c3d4.west-peek-ventures.pages.dev");
    expect(row.preview_emailed_at).toBeTruthy();
    expect(row.land_approved_at).toBeNull();
    expect(row.phase, "never reached LAND").toBe("BUILD");
    expect(await liveJobFor(id), "nothing parked for the Mac").toBeNull();
    const c = await card(id);
    expect(String(c.block_needed)).toMatch(/^PREVIEW READY\. Look at it here: https:\/\/work-wpc-comm1234\.west-peek-ventures\.pages\.dev\./);
    expect(String(c.block_needed)).toMatch(/reply "approved" to land it/i);
    // THE PREVIEW EMAIL (owner's spec, 23 Sep 2026): the four reply options ARE the TL;DR; then
    // the link, the placeholders still showing, and the card. No proof dump, never "blocked".
    const email = sent.filter((m) => m.to === SEQUOIA && /preview ready/i.test(m.subject)).pop()!;
    expect(email.subject).toBe("Porter: Community rebuild: Preview ready");
    expect(email.text).toMatch(/^\*\*TL;DR:\*\* Preview ready, with \*{0,2}4\*{0,2} placeholders\. Reply with one of these:\n• \*\*approved\*\*: publish this preview as is \(placeholders included\)\.\n• \*\*changes: …\*\*: I'll make them and send you a new preview\.\n• \*\*Missing items \+ "publish"\*\*: attach them or add them to Drive, reply "publish", and I'll fill them in and publish without another preview\.\n• \*\*Missing items \+ "preview"\*\*: attach them or add them to Drive, reply "preview", and I'll fill them in and send you another preview\.\n/);
    expect(email.text).toMatch(/Current preview \(built \d{1,2}:\d{2} CT, \*{0,2}4\*{0,2} placeholders\): https:\/\/work-wpc-comm1234\.west-peek-ventures\.pages\.dev\n/);
    expect(email.text, "never the per-commit hash").not.toMatch(/a1b2c3d4/);
    expect(email.text).toMatch(/\*\*Still missing \(optional\)\*\*\n• Airtable links\n• Sengo logo\n/);
    expect(email.text, "no proof dump in her inbox; it is on the card").not.toMatch(/community-390\.png|npm run validate/);
    expect(email.text.replace(/card wc_\S+/, "")).not.toMatch(/blocked/i);
  });

  it("\"changes: …\" after the preview rebuilds with them and sends a NEW preview (her option 2); the old preview's approval is gone; the other partner's \"approved\" holds it; the row refuses a merge", async () => {
    const firstPreviewAt = (await readWebPropertyChange(env, id))!.preview_emailed_at!;
    await replyFrom(SEQUOIA, "changes: the Sengo logo is wrong, swap it", await porter.token());
    const rebuild = await tickFor(id);
    expect(rebuild.outcome).toBe("PROGRESSED");
    expect(rebuild.summary).toMatch(/Changes after the preview; BUILD queued/);
    const queued = (await readWebPropertyChange(env, id))!;
    expect(queued.land_approved_at).toBeNull();
    expect(queued.refresh_intent).toBe("CHANGES");
    expect(JSON.parse(queued.answers_json).at(-1), "her words go to the build").toMatch(/^changes: the Sengo logo is wrong/);
    const job = JSON.parse((await liveJobFor(id))!.job_json!) as { phase: string; refresh: boolean };
    expect(job.phase).toBe("BUILD");
    expect(job.refresh, "a change is rebuilt whatever the materials").toBe(false);
    expect(String((await card(id)).description)).toMatch(/asked for changes \("changes: the Sengo logo is wrong/);
    const beforeMail = sent.length;
    await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/21", pr_number: 21, branch: "work/wpc-comm1234", check_state: "GREEN", preview_url: "https://e9f8a7b6.west-peek-ventures.pages.dev", materials: "5:aaaa", proof: "validate green" });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const second = (await readWebPropertyChange(env, id))!;
    expect(second.preview_url).toBe("https://e9f8a7b6.west-peek-ventures.pages.dev");
    expect(second.preview_emailed_at! > firstPreviewAt, "the approval now binds to the NEW preview").toBe(true);
    const newPreview = sent.slice(beforeMail).filter((m) => m.to === SEQUOIA);
    expect(newPreview, "one new preview email").toHaveLength(1);
    expect(newPreview[0]!.subject).toBe("Porter: Community rebuild: New preview ready");
    expect(newPreview[0]!.text, "the same branch alias shows the rebuilt site").toMatch(/Current preview \(built [^)]+\): https:\/\/work-wpc-comm1234\.west-peek-ventures\.pages\.dev\n/);
    expect(String((await card(id)).description)).toMatch(/Preview ready — Current preview \(built [^)]+\): https:\/\/work-wpc-comm1234\.west-peek-ventures\.pages\.dev/);
    const other = await replyFrom(SCOOTER, "approved", await porter.token());
    expect(other.answered).toBe(false);
    expect((await card(id)).state).toBe("BLOCKED");
    expect((await readWebPropertyChange(env, id))!.land_approved_at).toBeNull();
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = 'deadbeef' WHERE work_card_id = ?1").bind(id).run()).rejects.toThrow(/second approval after the preview/);
  });

  it("the requesting partner's second \"approved\" records the landing approval and parks LAND", async () => {
    const out = await replyFrom(SEQUOIA, "approved", await porter.token());
    expect(out.answered).toBe(true);
    const landing = await tickFor(id);
    expect(landing.outcome).toBe("PROGRESSED");
    expect(landing.summary).toMatch(/Landing approved after the preview; LAND queued/);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.land_approved_at).toBeTruthy();
    expect(row.land_approved_by).toBe("fu_sequoia_taylor");
    expect(row.phase).toBe("LAND");
    const job = (await liveJobFor(id))!;
    const payload = JSON.parse(job.job_json!) as { phase: string; plan: { publish_ready: boolean; placeholders: string[] }; pr: { land_approved_at: string; preview_url: string } };
    expect(payload.phase).toBe("LAND");
    expect(payload.plan.publish_ready).toBe(false);
    expect(payload.pr.land_approved_at).toBe(row.land_approved_at);
    await macReports(id, { phase: "LAND", status: "ok", merge_sha: "0123456789abcdef0123456789abcdef01234567", live_proof: "https://joinwestpeek.com → 200" });
    expect((await tickFor(id)).outcome).toBe("DONE");
  });
});

describe("\"preview\" on a publish-ready plan takes the same road", () => {
  it("with nothing to ask the build starts unasked; \"preview first\" by reply makes it stop at the preview and land only on the second \"approved\"; a repo with no preview says so", async () => {
    const porter = await planned(SCOOTER, "Walker", "team page tweak", {
      document: "# Plan: team page tweak\n\nready to ship.",
      decided: ["structure only"],
      asks: [],
      publish_ready: true,
      placeholders: [],
    });
    // planned() already ticked: with nothing to ask, BUILD is parked and no plan email went.
    const row0 = (await readWebPropertyChange(env, porter.id))!;
    expect(row0.phase).toBe("BUILD");
    expect(row0.plan_approved_by).toMatch(/built without asking/);
    expect(row0.preview_only, "already preview-first before he says so (23 Sep 2026)").toBe(1);
    // He replies "preview first" to the RECEIVED email: a note on the card, read before the build.
    const out = await replyFrom(SCOOTER, "preview first", await porter.token());
    expect(out.steered).toBe(true);
    const held = await tickFor(porter.id);
    expect(held.outcome).toBe("PROGRESSED");
    const row1 = (await readWebPropertyChange(env, porter.id))!;
    expect(row1.preview_only).toBe(1);
    expect(String((await card(porter.id)).description)).toMatch(/asked for a preview first/);
    await macReports(porter.id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/22", pr_number: 22, check_state: "GREEN", proof: "shots/team-desktop.png", materials: "12:abcd1234" });
    expect((await tickFor(porter.id)).outcome).toBe("BLOCKED");
    const c = await card(porter.id);
    expect(String(c.block_needed)).toMatch(/No preview deployment exists for this repo — the PR link and the screenshots stand in for it/);
    expect((await readWebPropertyChange(env, porter.id))!.land_approved_at).toBeNull();
    expect((await readWebPropertyChange(env, porter.id))!.materials_fingerprint, "the material set the build used is kept").toBe("12:abcd1234");
    // "preview" again after the preview is not a landing approval: it asks the Mac for ONE materials
    // check (her option 4) — and when nothing changed, she is told so and it waits on the same preview.
    const beforeCheck = sent.length;
    await replyFrom(SCOOTER, "preview", await porter.token());
    const check = await tickFor(porter.id);
    expect(check.outcome).toBe("PROGRESSED");
    expect(check.summary).toMatch(/A materials check after the preview; BUILD queued/);
    const checkJob = JSON.parse((await liveJobFor(porter.id))!.job_json!) as { phase: string; refresh: boolean; materials_fingerprint: string };
    expect(checkJob.refresh).toBe(true);
    expect(checkJob.materials_fingerprint).toBe("12:abcd1234");
    expect((await readWebPropertyChange(env, porter.id))!.land_approved_at).toBeNull();
    await macReports(porter.id, { phase: "BUILD", status: "unchanged", materials: "12:abcd1234" });
    const unchangedTick = await tickFor(porter.id);
    expect(unchangedTick.outcome, unchangedTick.summary).toBe("BLOCKED");
    const told = sent.slice(beforeCheck).filter((m) => m.to === SCOOTER);
    expect(told, "one email: nothing new, no second preview").toHaveLength(1);
    expect(told[0]!.text).toMatch(/^\*\*TL;DR:\*\* I didn't find anything new in the folder or attached\./);
    expect(told[0]!.text, "the preview link rides on it").toMatch(/Current preview \(built/);
    expect((await readWebPropertyChange(env, porter.id))!.land_approved_at).toBeNull();
    expect((await readWebPropertyChange(env, porter.id))!.refresh_intent).toBeNull();
    await replyFrom(SCOOTER, "approved", await porter.token());
    const landing = await tickFor(porter.id);
    expect(landing.summary).toMatch(/LAND queued/);
    expect((await readWebPropertyChange(env, porter.id))!.land_approved_by).toBe("fu_scooter_taylor");
    await macReports(porter.id, { phase: "LAND", status: "ok", merge_sha: "fedcba9876543210fedcba9876543210fedcba98", live_proof: "https://westpeek.ventures/team → 200" });
    expect((await tickFor(porter.id)).outcome).toBe("DONE");
  });
});

describe("the named bypass: \"approved to production\" (21 Sep 2026)", () => {
  const PLACEHOLDERS = ["Airtable link", "winner records"];
  const notReady = {
    document: "# Plan: productions news page\n\nTwo open items ship as placeholders.",
    decided: ["structure"],
    asks: [],
    publish_ready: false,
    placeholders: PLACEHOLDERS,
  };

  it("plain \"approved\" on a not-ready plan still means PREVIEW, never production", async () => {
    const porter = await planned(SCOOTER, "Walker", "productions news A", notReady);
    await replyFrom(SCOOTER, "approved", await porter.token());
    await tickFor(porter.id);
    await macReports(porter.id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/31", pr_number: 31, check_state: "GREEN", preview_url: "https://p31.westpeekproductions.pages.dev" });
    expect((await tickFor(porter.id)).outcome).toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.forced_by).toBeNull();
    expect(row.phase).toBe("BUILD");
    expect(String((await card(porter.id)).block_needed)).toMatch(/^PREVIEW READY/);
    // "approved to production" on the PREVIEW email forces it too — from the requester.
    await replyFrom(SCOOTER, "approved to production", await porter.token());
    const landing = await tickFor(porter.id);
    expect(landing.summary).toMatch(/Forced to production after the preview; LAND queued/);
    expect((await readWebPropertyChange(env, porter.id))!.forced_by).toBe("fu_scooter_taylor");
  });

  it("the other partner's \"approved to production\" is a note only; the row itself refuses a forcer who did not ask", async () => {
    const porter = await planned(SCOOTER, "Walker", "productions news B", notReady);
    // Nothing to decide (no asks) → approved by the request at filing, never blocked (27 Sep 2026).
    expect((await card(porter.id)).state).not.toBe("BLOCKED");
    const other = await replyFrom(SEQUOIA, "approved to production", await porter.token());
    expect(other.steered).toBe(true);
    expect(other.answered).toBe(false);
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.forced_by).toBeNull();
    expect(row.plan_approved_by).toMatch(/^request:/);
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET forced_by = 'fu_sequoia_taylor' WHERE work_card_id = ?1").bind(porter.id).run()).rejects.toThrow(/only the partner who asked for a change can force it/);
    // Her note is read on the next tick and kept, never acted on: only the requester forces.
    await tickFor(porter.id);
    expect((await readWebPropertyChange(env, porter.id))!.forced_by).toBeNull();
    const note = await env.WP_OS_DB.prepare("SELECT response FROM work_card_note WHERE work_card_id = ?1 AND author_id = 'fu_sequoia_taylor' ORDER BY created_at DESC LIMIT 1").bind(porter.id).first<{ response: string | null }>();
    expect(String(note?.response)).toMatch(/Kept, not acted on: only Scooter Taylor steers this card/);
  });

  it("the requester's \"approved to production\" on the plan skips the preview, lands on green, records who forced it, and the DONE email names the placeholders and the partner — to BOTH partners", async () => {
    const before = sent.length;
    const porter = await planned(SCOOTER, "Walker", "productions news C", notReady);
    // The plan was approved by the request (nothing to decide) and BUILD is already queued; his
    // "approved to production" arrives as a reply to the FYI — a note on an OPEN card — and is
    // read on the next tick with the same weight it had as a block answer (27 Sep 2026).
    const out = await replyFrom(SCOOTER, "approved to production", await porter.token());
    expect(out.steered).toBe(true);
    const build = await tickFor(porter.id);
    expect(build.summary).toMatch(/BUILD is queued/);
    let row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.forced_by).toBe("fu_scooter_taylor");
    expect(row.forced_at).toBeTruthy();
    expect(JSON.parse(row.forced_placeholders_json!)).toEqual(PLACEHOLDERS);
    expect(String((await card(porter.id)).description)).toMatch(/FORCED TO PRODUCTION by Scooter Taylor .*Airtable link; winner records/);
    await macReports(porter.id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/33", pr_number: 33, check_state: "GREEN", preview_url: "https://p33.westpeekproductions.pages.dev", proof: "validate green" });
    const green = await tickFor(porter.id);
    expect(green.outcome, "no preview stop: green lands").toBe("PROGRESSED");
    expect(green.summary).toMatch(/landing is queued/);
    row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.phase).toBe("LAND");
    expect(row.land_approved_at, "no second approval was needed or recorded").toBeNull();
    const job = (await liveJobFor(porter.id))!;
    expect((JSON.parse(job.job_json!) as { pr: { forced_by: string } }).pr.forced_by).toBe("fu_scooter_taylor");
    await macReports(porter.id, { phase: "LAND", status: "ok", merge_sha: "abcdef0123456789abcdef0123456789abcdef01", live_proof: "https://westpeekproductions.com/news → 200" });
    expect((await tickFor(porter.id)).outcome).toBe("DONE");
    const since = sent.slice(before);
    const toScooter = since.filter((m) => m.to === SCOOTER && /: Live$/.test(m.subject));
    const toSequoia = since.filter((m) => m.to === SEQUOIA);
    // 0223: the requester's copy is held for her first; the words on it are unchanged.
    expect(toScooter, "the forced landing does not email Scooter before she has read it").toHaveLength(0);
    const held = await finishedEmailFor(porter.id);
    expect(held.state).toBe("PENDING");
    expect(held.text).toMatch(/\*\*Published with placeholders\*\*\n• Landed to production with \*{0,2}2\*{0,2} placeholders by Scooter Taylor's instruction: Airtable link; winner records/);
    expect(held.text).toMatch(/^\*\*TL;DR:\*\* Live: your change is published\./);
    expect(held.text).toMatch(/\*\*Live now\*\*\n• https:\/\/westpeekproductions\.com\/news\n/);
    // She is told twice now, and the two are different things: the both-partners notice that a
    // forced landing always sends, and (0223) the finished email waiting for her decision.
    expect(toSequoia, "the other partner is told, and holds the finished email").toHaveLength(2);
    expect(toSequoia[0]!.text).toMatch(/Landed to production with 2 placeholders by Scooter Taylor's instruction/);
    expect(toSequoia[0]!.text).toMatch(/pull\/33/);
    expect(toSequoia.some((m) => /Send it|approve/i.test(m.text)), "the second is the preview, with the doors on it").toBe(true);
  });
});

/** Open a pre-approved card (the phrase in the partner's own request), run PLAN, return the id. */
async function preApproved(who: string, chief: string, subject: string, phrase: string, plan: Record<string, unknown>, extra = ""): Promise<string> {
  const chiefId = await openAssignmentCard(env, {
    subject,
    partnerAddress: who,
    chiefOfStaff: chief,
    raw: `${subject} on westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${subject.replace(/\W/g, "").slice(0, 6)}\n\n${phrase}. ${extra}\n`,
    limits: EMAILED_TASK_LIMITS, emlKey: null,
  });
  const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
  await tickFor(id); // parks PLAN
  await macReports(id, { phase: "PLAN", status: "ok", ...plan });
  return id;
}

describe("pre-approval in the request: \"your call\" (21 Sep 2026)", () => {
  it("the phrases are read only from what the partner wrote, never from a quoted original", () => {
    for (const p of ["your call", "you decide", "no need to ask", "just do it", "pick everything", "no options"]) expect(preApprovalIn(`update the page — ${p}!`)).toBe(p);
    expect(preApprovalIn("update the page, and ask me about the colours")).toBeNull();
    const quoted = parseWebPropertyAsk("Re: site", `please look at this: https://drive.google.com/drive/folders/${FOLDER}q westpeek.ventures\n\nOn Mon, Porter wrote:\n> your call, just do it`);
    expect(quoted?.pre_approval, "a quoted 'your call' is not the partner's").toBeNull();
    const own = parseWebPropertyAsk("site", `https://drive.google.com/drive/folders/${FOLDER}q westpeek.ventures — your call, approved to production`);
    expect(own?.pre_approval).toBe("your call");
    expect(own?.force).toBe("approved to production");
  });

  it("a ready plan: approved at filing in the requester's name, BUILD parks with no reply, GREEN stops at the preview (23 Sep 2026) and the requester's \"approved\" lands it", async () => {
    const before = sent.length;
    const id = await preApproved(SCOOTER, "Walker", "footer links", "your call", {
      document: "# Plan: footer links\n\nready.",
      decided: ["structure"],
      asks: [{ question: "Open the links in a new tab?", recommended: "yes, with rel=noopener" }],
      publish_ready: true,
      placeholders: [],
    });
    const out = await tickFor(id);
    expect(out.outcome, "no block: the plan is approved as filed").toBe("PROGRESSED");
    expect(out.summary).toMatch(/pre-approved \("your call"\); BUILD queued/);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.pre_approved_phrase).toBe("your call");
    expect(row.plan_approved_at).toBeTruthy();
    expect(row.plan_approved_by).toBe("fu_scooter_taylor (pre-approved in the request)");
    expect(JSON.parse(row.asks_json), "no options offered").toEqual([]);
    expect(JSON.parse(row.decided_json).some((d: string) => /new tab\? → yes, with rel=noopener \(decided; pre-approved/.test(d))).toBe(true);
    expect(row.land_approved_at, "pre-approval is never the landing approval").toBeNull();
    expect((await card(id)).state).toBe("IN_PROGRESS");
    expect(String((await card(id)).description)).toMatch(/Pre-approved in the request by Scooter Taylor \("your call"\)/);
    // No FYI, no plan email: under a pre-approval the partner hears RECEIVED then DONE only.
    const mail = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(mail).toHaveLength(1);
    expect(mail[0]!.subject).toMatch(/got it/i);
    expect(mail[0]!.text).toMatch(/You pre-approved this \("your call"\), so the next thing you'll get is the preview link — reply "approved" and it goes live/);
    expect(mail[0]!.text, "never promises a finished result it will not send first").not.toMatch(/next thing you'll get is the finished result/);
    await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/41", pr_number: 41, check_state: "GREEN" });
    const green = await tickFor(id);
    expect(green.outcome, "a pre-approval approves the plan, never the landing").toBe("BLOCKED");
    const held = (await readWebPropertyChange(env, id))!;
    expect(held.phase).toBe("BUILD");
    expect(held.land_approved_at).toBeNull();
    expect(held.forced_by).toBeNull();
    expect(await liveJobFor(id)).toBeNull();
    const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token;
    expect((await replyFrom(SCOOTER, "approved", token)).answered).toBe(true);
    expect((await tickFor(id)).summary).toMatch(/Landing approved after the preview; LAND queued/);
    expect((await readWebPropertyChange(env, id))!.phase).toBe("LAND");
  });

  it("a ready plan, then \"stop\" from the requester by reply: the card is held and the queued build is closed", async () => {
    const id = await preApproved(SCOOTER, "Walker", "hero copy", "just do it", { document: "# Plan: hero copy\n\nready.", decided: [], asks: [], publish_ready: true, placeholders: [] });
    expect((await tickFor(id)).summary).toMatch(/BUILD queued/);
    const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token;
    const reply = await replyFrom(SCOOTER, "stop", token);
    expect(reply.steered).toBe(true);
    expect(reply.answered, "the card was not blocked, so the reply is a note").toBe(false);
    const held = await tickFor(id);
    expect(held.outcome).toBe("BLOCKED");
    expect(String((await card(id)).description)).toMatch(/Held by scooter@westpeek.ventures: "stop"/);
    expect(await liveJobFor(id), "the queued BUILD is closed").toBeNull();
    // The other partner's "stop" would be a note, not a hold — proven by the requester check inside heldByRequester.
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "approved" });
    expect((await tickFor(id)).summary).toMatch(/BUILD queued/);
  });

  it("a NOT-ready plan, pre-approved: still stops at the preview and asks once", async () => {
    const id = await preApproved(SEQUOIA, "Wren", "events page", "you decide", {
      document: "# Plan: events page\n\nthe episode records are placeholders.",
      decided: [],
      asks: [],
      publish_ready: false,
      placeholders: ["episode records"],
    });
    const out = await tickFor(id);
    expect(out.summary).toMatch(/BUILD queued/);
    await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/42", pr_number: 42, check_state: "GREEN", preview_url: "https://p42.pages.dev" });
    expect((await tickFor(id)).outcome, "not ready stops at the preview even when pre-approved").toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.phase).toBe("BUILD");
    expect(row.forced_by).toBeNull();
    expect(row.land_approved_at).toBeNull();
    const rules = await rulesFor(env, WEB_PROPERTY_CHANGE_KIND);
    const c = await card(id);
    const gate = await parkPhase(env, { id, title: String(c.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SEQUOIA }, row, "LAND", rules);
    expect(gate.parked).toBe(false);
    expect((gate as { reason: string }).reason).toMatch(/previews first/);
  });

  it("a NOT-ready plan, pre-approved AND forced in the same request: lands on green, named as forced", async () => {
    const id = await preApproved(SCOOTER, "Walker", "press page", "no need to ask", {
      document: "# Plan: press page\n\nthe logo pack is a placeholder.",
      decided: [],
      asks: [],
      publish_ready: false,
      placeholders: ["logo pack"],
    }, "approved to production.");
    const out = await tickFor(id);
    expect(out.summary).toMatch(/BUILD queued/);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.force_phrase).toBe("approved to production");
    expect(row.forced_by).toBe("fu_scooter_taylor");
    expect(JSON.parse(row.forced_placeholders_json!)).toEqual(["logo pack"]);
    expect(String((await card(id)).description)).toMatch(/said "approved to production": a plan that is not publish-ready lands anyway, named as forced by Scooter Taylor/);
    await macReports(id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/43", pr_number: 43, check_state: "GREEN", preview_url: "https://p43.pages.dev" });
    const green = await tickFor(id);
    expect(green.summary, "no preview stop: forced").toMatch(/landing is queued/);
    expect((await readWebPropertyChange(env, id))!.phase).toBe("LAND");
  });
});

const SCOOTER_MIME = (opts: { subject: string; body: string; image?: boolean; quoted?: string }) =>
  [
    "Received: from mail-yw1-x112b.google.com (2607:f8b0:4864:20::112b)",
    "        by cloudflare-email.net (cloudflare) id AVO4JGYRhCSD",
    "        for <os@joinwestpeek.com>; Mon, 21 Sep 2026 16:00:12 +0000",
    "DKIM-Signature: v=1; a=rsa-sha256; d=westpeek-ventures.20251104.gappssmtp.com; s=20251104;",
    "        bh=55bbj7y7UvA7lR/N/NoivXmDt5Iwz8DCR5icYSy9kNQ=;",
    "Authentication-Results: mx.cloudflare.net;",
    "\tdkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104 header.b=dOhiTg8n;",
    "\tdmarc=none header.from=westpeek.ventures policy.dmarc=none;",
    "\tspf=pass (mx.cloudflare.net: domain of scooter@westpeek.ventures designates 2607:f8b0:4864:20::112b as permitted sender) smtp.mailfrom=scooter@westpeek.ventures;",
    "From: Scooter Taylor <scooter@westpeek.ventures>",
    "To: os@joinwestpeek.com",
    `Subject: ${opts.subject}`,
    "Message-ID: <sensori-photo-1@mail.gmail.com>",
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="000000000000abc"',
    "",
    "--000000000000abc",
    'Content-Type: multipart/alternative; boundary="000000000000def"',
    "",
    "--000000000000def",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: quoted-printable",
    "",
    `${opts.body.replace(/—/g, "=E2=80=94")}`,
    ...(opts.quoted ? ["", "On Mon, 21 Sep 2026 at 09:00, Porter <os@westpeek.ventures> wrote:", `> ${opts.quoted}`] : []),
    "",
    "--000000000000def",
    'Content-Type: text/html; charset="UTF-8"',
    "",
    `<div dir="ltr">${opts.body}</div>`,
    "--000000000000def--",
    ...(opts.image
      ? [
          "--000000000000abc",
          'Content-Type: image/jpeg; name="sensori-founders.jpg"',
          'Content-Disposition: attachment; filename="sensori-founders.jpg"',
          "Content-Transfer-Encoding: base64",
          "",
          Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF fake photo bytes for the test")]).toString("base64"),
        ]
      : []),
    "--000000000000abc--",
    "",
  ].join("\r\n");

const PHOTO_RECEIVED = "Got it — sorry this took so long. Your sister forgot to plug in her Mac so it went to sleep in the middle of my work, and she also tasked me with a bunch of back-end clean-up that took priority — I'm just now getting to your requests. I have the photo and I'm on the Sensori swap now; you'll hear from me when it's done.";

const GOOD_AUTH_HEADER = "mx.cloudflare.net; spf=pass smtp.mailfrom=scooter@westpeek.ventures; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com; dmarc=none";

function inbound(raw: string, headers: Record<string, string> = {}) {
  const bytes = new TextEncoder().encode(raw);
  const h = new Headers({ from: "Scooter Taylor <scooter@westpeek.ventures>", to: "os@joinwestpeek.com", subject: /^Subject: (.*)$/m.exec(raw)?.[1] ?? "", "message-id": `<${crypto.randomUUID()}@mail.gmail.com>`, "authentication-results": GOOD_AUTH_HEADER, ...headers });
  return { from: "scooter@westpeek.ventures", to: "os@joinwestpeek.com", headers: h, raw: new Blob([bytes]).stream(), rawSize: bytes.byteLength };
}

describe("Porter reads the email (21 Sep 2026): the request is the specification", () => {
  const PHOTO_EMAIL = SCOOTER_MIME({ subject: "Sensori photo swap on westpeek.ventures", body: "Swap the Sensori founders photo on westpeek.ventures for the one attached. Same spot, same size.", image: true });
  let porterId = "";

  it("the text body is the partner's words, not the headers; the image is an attachment; a quoted folder link is not the request's", () => {
    expect(textBodyOf(PHOTO_EMAIL)).toBe("Swap the Sensori founders photo on westpeek.ventures for the one attached. Same spot, same size.");
    const { attachments } = requestAttachments(PHOTO_EMAIL);
    expect(attachments.map((a) => [a.filename, a.mediaType])).toEqual([["sensori-founders.jpg", "image/jpeg"]]);
    const quoted = SCOOTER_MIME({ subject: "Re: West Peek Community rebuild", body: "Change the tagline on westpeek.ventures to 'Good people meet good people'.", quoted: "package: https://drive.google.com/drive/folders/1jdhn1qHJW0vurKBU4QYttJIv0ut6-p8d" });
    const ask = parseWebPropertyAsk("Re: West Peek Community rebuild", textBodyOf(quoted));
    expect(ask?.target_repo).toBe("join-west-peek-main");
    expect(ask?.drive_folder_id, "a folder in a quoted earlier thread is not this request's package").toBeNull();
    expect(isWebPropertyChange(ask), "a request with no folder and no attachment is still a change").toBe(true);
  });

  it("Scooter's exact shape — one sentence + an attached image + no Drive link → Porter's card, the attachment kept and listed, RECEIVED sent once", async () => {
    const before = sent.length;
    await handleInboundEmail(inbound(PHOTO_EMAIL), env);
    const c = (await env.WP_OS_DB.prepare("SELECT id, description, requested_by_email FROM work_card WHERE kind = 'WEB_PROPERTY_CHANGE' ORDER BY created_at DESC LIMIT 1").first<{ id: string; description: string; requested_by_email: string }>())!;
    porterId = c.id;
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(c.description, "the card carries his words, not Received: headers").toMatch(/Swap the Sensori founders photo/);
    expect(c.description).not.toMatch(/Received: from/);
    const row = (await readWebPropertyChange(env, porterId))!;
    expect(row.request_text).toMatch(/^Swap the Sensori founders photo/);
    expect(row.drive_folder_id).toBeNull();
    const att = (await env.WP_OS_DB.prepare("SELECT id, filename, media_type, eml_key FROM request_attachment WHERE work_card_id = ?1").bind(porterId).all<{ id: string; filename: string; media_type: string; eml_key: string }>()).results!;
    expect(att.map((a) => a.filename)).toEqual(["sensori-founders.jpg"]);
    expect(att[0]!.eml_key).toMatch(/^inbound-email\//);
    const received = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(received, "exactly one RECEIVED").toHaveLength(1);
    expect(received[0]!.text).toMatch(/Got it — I'm on it/);
    expect(received[0]!.text).toMatch(/Attachments: sensori-founders\.jpg/);
    expect(received[0]!.text).toMatch(/Drive folder: no/);
    const notices = (await env.WP_OS_DB.prepare("SELECT kind, cause, message_id FROM work_card_notice WHERE work_card_id = ?1").bind(porterId).all<{ kind: string; cause: string; message_id: string | null }>()).results!;
    expect(notices.map((n) => n.kind)).toEqual(["RECEIVED"]);
    expect(notices[0]!.message_id, "recorded with a message id").toBeTruthy();
    const again = await sendReceived(env, porterId);
    expect(again.sent, "the same cause never emails twice").toBe(false);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER)).toHaveLength(1);
  });

  it("the PLAN job carries REQUEST and the attachment; the Mac fetches it by name through the Worker", async () => {
    const out = await tickFor(porterId);
    expect(out.summary).toMatch(/PLAN queued/);
    const job = (await liveJobFor(porterId))!;
    const payload = JSON.parse(job.job_json!) as { request: string; attachments: Array<{ id: string; filename: string; path: string }>; drive: { folder_id: string | null } };
    expect(payload.request).toMatch(/^Swap the Sensori founders photo/);
    expect(payload.attachments).toHaveLength(1);
    expect(payload.attachments[0]!.filename).toBe("sensori-founders.jpg");
    expect(payload.drive.folder_id).toBeNull();
    const res = await handleGetRequestAttachment({
      request: new Request(`https://os.joinwestpeek.com${payload.attachments[0]!.path}`),
      env,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: { id: porterId, attId: payload.attachments[0]!.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes[0]).toBe(0xff);
    expect(new TextDecoder().decode(bytes)).toMatch(/fake photo bytes/);
  });

  it("a Mac 'blocked' is never a question for Scooter: two retries with no email, then a lane fault addressed to Sequoia", async () => {
    // 21 Sep 2026: a stale claimer answered "no Drive FOLDER is on the card" and the OS emailed
    // Scooter to send a folder link for a photo he had attached, then parked the card for a
    // 24-hour nag. The partner's decisions travel only as the plan's asks.
    const before = sent.length;
    const stale = { phase: "PLAN", status: "blocked", reason: "no Drive FOLDER is on the card — send the folder link (a file link is not enough)" };
    await macReports(porterId, stale);
    const first = await tickFor(porterId);
    expect(first.outcome, "attempt 1: a retry, not a block").not.toBe("BLOCKED");
    expect((await card(porterId)).state, "the card is not BLOCKED").not.toBe("BLOCKED");
    expect(sent.length, "nobody is emailed for a lane stumble").toBe(before);
    const again = await tickFor(porterId);
    expect(again.summary, "PLAN is queued again on the next tick").toMatch(/PLAN queued/);
    await macReports(porterId, stale);
    const second = await tickFor(porterId);
    expect(second.outcome).not.toBe("BLOCKED");
    expect(sent.length).toBe(before);
    const third = await tickFor(porterId);
    expect(third.summary).toMatch(/PLAN queued/);
    await macReports(porterId, stale);
    const fault = await tickFor(porterId);
    expect(fault.outcome, "attempt 3: a lane fault").toBe("BLOCKED");
    const c = await card(porterId);
    expect(c.block_who, "addressed to the owner of the lane, never the requesting partner").toBe("SEQUOIA");
    expect(c.block_reason).toBe("a_lane_refused_the_work");
    expect(sent.slice(before).filter((m) => m.to === SCOOTER).length, "Scooter got nothing").toBe(0);
    expect(sent.slice(before).filter((m) => m.to === SEQUOIA_PARTNER_EMAIL && /stuck|blocked/i.test(m.subject)).length, "the owner got the lane fault, once").toBe(1);
    // Put the card back the way the next test expects it: open, PLAN queued.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN', work_attempts = 0, block_reason = NULL, block_who = NULL, blocked_at = NULL, block_nag_at = NULL WHERE id = ?1").bind(porterId).run();
    await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'STUCK'").bind(porterId).run();
    const back = await tickFor(porterId);
    expect(back.summary).toMatch(/PLAN queued/);
  });

  it("nothing to ask + publish-ready → built without asking: no plan email, BUILD parked, the card says why; green stops at ONE preview email, his \"approved\" lands it, then DONE", async () => {
    const before = sent.length;
    await macReports(porterId, { phase: "PLAN", status: "ok", document: "# Plan: Sensori photo swap\n\nReplace sites/ventures/assets/img/portfolio/sensori-founders.jpg with the attachment; same dimensions.", decided: ["same file name and dimensions, so no markup change"], asks: [], publish_ready: true, placeholders: [] });
    const out = await tickFor(porterId);
    expect(out.outcome, "no block").toBe("PROGRESSED");
    expect(out.summary).toMatch(/nothing to ask; BUILD queued/);
    const row = (await readWebPropertyChange(env, porterId))!;
    expect(row.plan_approved_by).toMatch(/no partner decisions in this change; built without asking/);
    expect(String((await card(porterId)).description)).toMatch(/No partner decisions in this change; built without asking/);
    expect(String((await card(porterId)).description), "the finding says where it stops").toMatch(/On green it stops at a preview link; it lands when the partner approves the preview/);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER), "no plan email").toHaveLength(0);
    await macReports(porterId, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/51", pr_number: 51, check_state: "GREEN", proof: "validate green · shots" });
    // PREVIEW FIRST (owner, 23 Sep 2026): green alone never lands, even with nothing to ask.
    expect((await tickFor(porterId)).outcome).toBe("BLOCKED");
    expect((await readWebPropertyChange(env, porterId))!.phase).toBe("BUILD");
    expect(await liveJobFor(porterId), "nothing parked for the Mac on green").toBeNull();
    const preview = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(preview, "exactly one email since the BUILD began: the preview").toHaveLength(1);
    expect(preview[0]!.subject).toMatch(/: Preview ready$/);
    expect(preview[0]!.text, "no PR link in her inbox; the PR is on the card").not.toMatch(/pull\/51/);
    expect(String((await card(porterId)).description)).toMatch(/pull\/51/);
    const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porterId).first<{ token: string }>())!.token;
    expect((await replyFrom(SCOOTER, "approved", token)).answered).toBe(true);
    expect((await tickFor(porterId)).summary).toMatch(/Landing approved after the preview; LAND queued/);
    await macReports(porterId, { phase: "LAND", status: "ok", merge_sha: "1111111111222222222233333333334444444444", live_proof: "https://westpeek.ventures/#portfolio → 200, new photo hash" });
    expect((await tickFor(porterId)).outcome).toBe("DONE");
    // RECEIVED reached him before this window; the DONE reply is held for her (0223), so since the
    // BUILD began his inbox has had the preview and nothing else — no plan email, no finished email.
    const done = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(done, "only the preview; the finished email is held for her").toHaveLength(1);
    expect((await finishedEmailFor(porterId)).state, "the finished work is waiting on her Home").toBe("PENDING");
    const kinds = (await env.WP_OS_DB.prepare("SELECT kind FROM work_card_notice WHERE work_card_id = ?1 ORDER BY sent_at").bind(porterId).all<{ kind: string }>()).results!.map((n) => n.kind);
    expect(kinds).toEqual(["RECEIVED", "PREVIEW", "DONE"]);
  });

  it("a single ask WITH a recommendation never waits (27 Sep 2026): approved by the request, BUILD parked, the plan email is the FYI \"Going ahead\"; the same ask WITHOUT one still asks", async () => {
    const before = sent.length;
    const id = (await planned(SEQUOIA, "Wren", "hero photo rights", {
      document: "# Plan: hero photo\n\nthe photo is from a news site.",
      decided: [],
      asks: [{ question: "Use the photo from https://news.example.com/x? Rights unclear.", recommended: "ask the photographer; use the founders' own photo meanwhile" }],
      publish_ready: true,
      placeholders: [],
    })).id;
    const c = await card(id);
    expect(c.state, "nothing to decide from scratch → no block").not.toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.phase).toBe("BUILD");
    expect(row.plan_approved_at).toBeTruthy();
    expect(row.plan_approved_by, "approved by the REQUEST, never in a partner's name (0241's trigger)").toMatch(/^request:wc_/);
    expect(JSON.parse(row.answers_json)).toEqual(["1. ask the photographer; use the founders' own photo meanwhile (approved as recommended)"]);
    expect(await liveJobFor(id), "BUILD is parked for the Mac").not.toBeNull();
    expect(String(c.description)).toMatch(/Approved by the request: every decision \(1\) carried Porter's recommendation/);
    const kinds = (await env.WP_OS_DB.prepare("SELECT kind, cause FROM work_card_notice WHERE work_card_id = ?1 ORDER BY sent_at").bind(id).all<{ kind: string; cause: string }>()).results!;
    expect(kinds.map((n) => n.kind)).toEqual(["RECEIVED", "PLAN"]);
    expect(kinds[1]!.cause).toMatch(/^fyi:/);
    const fyi = sent.slice(before).filter((m) => m.to === SEQUOIA).pop()!;
    expect(fyi.subject).toBe("Porter: Hero photo rights: Going ahead");
    expect(fyi.text).toMatch(/^\*\*TL;DR:\*\* Going ahead with these — every decision had my recommendation, so I've taken it and started the build\. Reply \*\*changes: …\*\* to steer\. Nothing goes live until you approve the preview\./);
    expect(fyi.text).toMatch(/• \*\*changes: …\*\*: I'll make them as I build\n• \*\*stop\*\*: hold it/);
    expect(fyi.text).toMatch(/\*\*1 decision, taken as I recommended \(in bold\)\*\*\n• Use the photo from https:\/\/news\.example\.com\/x\? Rights unclear → \*\*ask the photographer; use the founders' own photo meanwhile\*\*/);
    expect(fyi.text, "an FYI never asks for \"approved\"").not.toMatch(/Reply \*\*approved\*\*/);

    // The SAME ask with no recommendation is a real question: the asking form, the card blocked.
    const asked = (await planned(SEQUOIA, "Wren", "hero photo rights B", {
      document: "# Plan: hero photo B\n\nthe photo is from a news site.",
      decided: [],
      asks: [{ question: "Use the photo from https://news.example.com/x? Rights unclear." }],
      publish_ready: true,
      placeholders: [],
    })).id;
    expect((await card(asked)).state).toBe("BLOCKED");
    expect((await readWebPropertyChange(env, asked))!.plan_approved_at).toBeNull();
    expect(sent.filter((m) => m.to === SEQUOIA).pop()!.subject).toBe("Porter: Hero photo rights B: Plan ready");
  });

  it("a card BLOCKED at its plan before the rule, every ask recommended, is released by the sweep and goes to BUILD on its own — one FYI, never the question twice", async () => {
    const before = sent.length;
    // Blocked the old way: a real question. Then the asks are rewritten as the Mac would have filed
    // them for wc_77f52b33 on 27 Sep — one ask, one recommendation — with the block still standing.
    const porter = await planned(SCOOTER, "Walker", "community colours", {
      document: "# Plan: community colours",
      decided: ["Ventures first"],
      asks: [{ question: "Which orange?" }],
      publish_ready: true,
      placeholders: [],
    });
    expect((await card(porter.id)).state).toBe("BLOCKED");
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET asks_json = ?2 WHERE work_card_id = ?1")
      .bind(porter.id, JSON.stringify([{ question: "Community colours: OK to lift the orange from #C45A3C to #E0632F on a white background?", recommended: "Yes, as described." }]))
      .run();
    const asking = sent.slice(before).filter((m) => m.to === SCOOTER && /Plan ready/.test(m.subject));
    expect(asking, "the asking form already went out").toHaveLength(1);

    const released = await (await import("../src/worker/services/webPropertyChange")).releasePlansNobodyNeedsToAnswer(env);
    expect(released).toContain(porter.id);
    const reopened = await card(porter.id);
    expect(reopened.state).toBe("OPEN");
    expect(reopened.block_who).toBeNull();
    expect(reopened.block_needed).toBeNull();
    expect(String(reopened.description)).toMatch(/Released from the plan wait: every decision carried a recommendation/);
    expect(await releasePlansNobodyNeedsToAnswerAgain(), "a second pass finds nothing to release").not.toContain(porter.id);

    const next = await tickFor(porter.id);
    expect(next.outcome).toBe("PROGRESSED");
    expect(next.summary).toMatch(/Plan approved by the request .*BUILD queued/);
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.phase).toBe("BUILD");
    expect(row.plan_approved_by).toBe(`request:${porter.id} (every decision carried a recommendation; taken as the plan was filed)`);
    const toScooter = sent.slice(before).filter((m) => m.to === SCOOTER && !/Got it$/.test(m.subject));
    expect(toScooter.map((m) => m.subject.replace(/^Porter: .*: /, "")), "the question once, then the FYI once").toEqual(["Plan ready", "Going ahead"]);
    // The FYI is once per filing: another tick sends nothing more.
    await macReports(porter.id, { phase: "BUILD", status: "ok", pr_url: "https://github.com/seq23/join-west-peek-main/pull/77", pr_number: 77, check_state: "GREEN", preview_url: "https://p77.west-peek-ventures.pages.dev" });
    expect((await tickFor(porter.id)).outcome, "green still stops at the preview: the FYI is a plan approval, never a landing approval").toBe("BLOCKED");
    expect((await readWebPropertyChange(env, porter.id))!.land_approved_at).toBeNull();
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /Going ahead/.test(m.subject))).toHaveLength(1);
  });

  it("a 4 MB partner email (a real jpg attached) becomes Porter's card with request_text and one attachment row, not a Deck card", async () => {
    // A real-sized photo: ~3 MB of bytes, base64'd inside the MIME, so the message is over MAX_BODY_BYTES for real.
    const photo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(3 * 1024 * 1024, 7)]);
    const big = SCOOTER_MIME({ subject: "Sensori photo swap, big", body: "Same swap on westpeek.ventures, bigger photo attached.", image: true }).replace(
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF fake photo bytes for the test")]).toString("base64"),
      photo.toString("base64").replace(/(.{76})/g, "$1\r\n"),
    );
    const msg = inbound(big);
    expect(msg.rawSize).toBeGreaterThan(4 * 1024 * 1024 * 0.9);
    /*
     * BOUNDED, AND THE STORED COPY IS BYTE-EXACT (21 Sep 2026). The first real re-read of Scooter's
     * 3.9 MB photo email hung the production Worker: the raw stream was tee'd for R2 and for text,
     * and workerd's tee applies the unread branch's backpressure to the source, so the R2 branch
     * waited on a reader that was only going to start after the put. 14 ms of CPU, 110 s of wall
     * time, then the client gave up. Miniflare does not deadlock the same way, so the pin here is
     * the two things a deadlock cannot produce: a finish inside a hard ceiling far below the
     * per-test timeout, and a stored .eml whose bytes equal what arrived.
     */
    const t0 = Date.now();
    await handleInboundEmail(msg, env);
    expect(Date.now() - t0, "an oversize partner message must be stored and read in one pass, never two consumers of one stream").toBeLessThan(15_000);
    const c = (await env.WP_OS_DB.prepare("SELECT id, kind, title, description FROM work_card ORDER BY created_at DESC LIMIT 1").first<{ id: string; kind: string; title: string; description: string }>())!;
    const stored = (await env.WP_OS_DB.prepare("SELECT eml_key FROM request_attachment WHERE work_card_id = ?1").bind(c.id).first<{ eml_key: string }>())!;
    const obj = await (env.WP_OS_DOCUMENTS as unknown as { get: (k: string) => Promise<{ arrayBuffer: () => Promise<ArrayBuffer> } | null> }).get(stored.eml_key);
    expect(obj, "the stored .eml exists").not.toBeNull();
    expect((await obj!.arrayBuffer()).byteLength, "the stored copy is the whole message, byte for byte").toBe(msg.rawSize);
    expect(c.kind).toBe("WEB_PROPERTY_CHANGE");
    expect(c.title).not.toMatch(/^Deck:/);
    expect((await readWebPropertyChange(env, c.id))!.request_text).toMatch(/^Same swap on westpeek\.ventures/);
    const att = (await env.WP_OS_DB.prepare("SELECT filename, bytes FROM request_attachment WHERE work_card_id = ?1").bind(c.id).all<{ filename: string; bytes: number }>()).results!;
    expect(att.map((a) => a.filename)).toEqual(["sensori-founders.jpg"]);
    expect(att[0]!.bytes).toBeGreaterThan(3 * 1024 * 1024 * 0.99);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(c.id).run();
  });

  it("a stored message can be read through the door again", async () => {
    const key = `inbound-email/2026-09-21/${crypto.randomUUID()}.eml`;
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: Uint8Array) => Promise<unknown> }).put(key, new TextEncoder().encode(SCOOTER_MIME({ subject: "Reingest me — team page on westpeek.ventures", body: "Add the new team member on westpeek.ventures; photo attached.", image: true })));
    const res = await handleReingestStoredEmail({
      // The owner's words for Scooter's photo card, verbatim (Sequoia, 21 Sep 2026 15:05 CT).
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key, received_tldr: PHOTO_RECEIVED }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { new_card: string };
    const row = (await readWebPropertyChange(env, body.new_card))!;
    expect(row.request_text).toMatch(/Add the new team member/);
    const received = sent.filter((m) => m.to === SCOOTER).pop()!;
    expect(received.text, "the re-read's RECEIVED carries the owner's first line verbatim").toContain(PHOTO_RECEIVED);
    expect(received.text).toMatch(/Attachments: sensori-founders\.jpg/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(body.new_card).run();
  });

  it("the prompt tells Porter the request is the spec, he has tools, and the rights/login/RUNBOOK/cannot-act policy", () => {
    const prompt = readFileSync(new URL("../scripts/duties/web-property-change-prompt.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    for (const line of [
      "The REQUEST is the specification",
      "You have tools; use them for whatever the request needs",
      "Fetch a public page or image by URL",
      "record the source URL",
      "a portfolio company's logo or founder photo from that company's website",
      "a picture from a news site — is an **ASK** naming the source URL",
      'A pre-approval phrase ("your call") does NOT waive a rights ask',
      "Anything needing a login, a payment, an account, a CAPTCHA, or a private page: do NOT attempt it. BLOCK",
      "RUNBOOK_FORBIDS",
      "A request you cannot act on at all",
      "you said the photo is attached; nothing arrived",
      "A change with no partner decision returns `asks: []`",
    ]) {
      expect(prompt, `the prompt must say: ${line.slice(0, 50)}`).toContain(line);
    }
  });
});

async function releasePlansNobodyNeedsToAnswerAgain(): Promise<string[]> {
  return (await import("../src/worker/services/webPropertyChange")).releasePlansNobodyNeedsToAnswer(env);
}

/** The firm caps an employee at 20 new cards an hour; this file opens many for Porter. Age the earlier ones. */
async function ageEarlierCards(): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-2 hours')").run();
}

describe("Scooter's second email (21 Sep 2026): 'Hey Porter! … a spot on the site'", () => {
  beforeAll(ageEarlierCards);
  const NEWSLETTER = (extra = "") => SCOOTER_MIME({
    subject: "Newsletter signup on the site",
    body: `Hey Porter!\n\nCan we add a newsletter signup on the site? Just a spot where people can drop their email and subscribe.${extra}\n\nThanks!\nScooter`,
  });

  it("a newsletter signup form is not blog help; the addressee is read; 'the site' is a web-property change with the host unresolved", () => {
    expect(parseBlogAsk("Newsletter signup on the site", "Can we add a newsletter signup on the site? a spot where people can drop their email")).toBeNull();
    expect(parseBlogAsk("blog", "help me make an outline for a blog post on newsletters and do research")?.modes).toEqual(["OUTLINE"]);
    expect(addresseeIn("Hey Porter!\n\nCan we…")).toBe("Porter");
    expect(addresseeIn("Porter, please…")).toBe("Porter");
    expect(addresseeIn("Hi Porter — quick one")).toBe("Porter");
    expect(addresseeIn("Hey there, can you…")).toBeNull();
    const ask = parseWebPropertyAsk("Newsletter signup on the site", "Hey Porter!\n\nCan we add a newsletter signup on the site?");
    expect(ask?.addressee).toBe("Porter");
    expect(ask?.property_unresolved).toBe(true);
    expect(ask?.target_repo).toBeNull();
    expect(isWebPropertyChange(ask)).toBe(true);
    // Not addressed to Porter and no host: not a web change.
    expect(parseWebPropertyAsk("x", "Hey Walker, can we add a signup on the site?")?.property_unresolved ?? false).toBe(false);
  });

  it("with a recent web-property card from this partner, 'the site' is inferred from it and the RECEIVED email states the assumption; the card is Porter's, kind WEB_PROPERTY_CHANGE", async () => {
    const before = sent.length;
    await handleInboundEmail(inbound(NEWSLETTER()), env);
    const chief = (await env.WP_OS_DB.prepare("SELECT id, state, kind, description FROM work_card WHERE title = 'From scooter@westpeek.ventures: Newsletter signup on the site' ORDER BY created_at DESC LIMIT 1").first<{ id: string; state: string; kind: string | null; description: string }>())!;
    expect(chief.kind, "not blog help").toBeNull();
    expect(chief.state, "handed on at the door").toBe("DONE");
    const porterId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(chief.description)![1]!;
    const c = (await env.WP_OS_DB.prepare("SELECT id, kind, owner_id, requested_by_email FROM work_card WHERE id = ?1").bind(porterId).first<{ id: string; kind: string | null; owner_id: string; requested_by_email: string }>())!;
    expect(c.kind).toBe("WEB_PROPERTY_CHANGE");
    expect(c.owner_id).toBe("aie_porter");
    const row = (await readWebPropertyChange(env, c.id))!;
    expect(row.property_host, "inferred from the photo swap earlier in this file").toBe("westpeek.ventures");
    expect(row.property_assumed_from).toMatch(/^westpeek\.ventures — the one you had me on/);
    expect(row.request_text).toMatch(/^Hey Porter!/);
    const received = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(received).toHaveLength(1);
    expect(received[0]!.text).toMatch(/I'm reading "the site" as westpeek\.ventures — the one you had me on/);
    expect(received[0]!.text).toMatch(/reply if not/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(c.id).run();
  });

  it("with nothing recent to infer from, Porter asks which site — the one question only they can answer", async () => {
    const chiefId = await openAssignmentCard(env, { subject: "Footer tweak", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Hey Porter — make the footer smaller on our site please.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const porterId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    // Take the inference away: the row says the property is unresolved.
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET target_repo = 'unresolved', property_host = NULL, property_assumed_from = NULL WHERE work_card_id = ?1").bind(porterId).run();
    const out = await tickFor(porterId);
    expect(out.outcome).toBe("BLOCKED");
    expect(String((await card(porterId)).block_needed)).toMatch(/^Which site\?/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(porterId).run();
  });

  it("a chief of staff's card that reads as a website change is handed to Porter by the general runner, never browsed", async () => {
    // Simulate the hand-patched shape: kind NULL on Walker's desk with the request text.
    const chiefId = await openAssignmentCard(env, { subject: "Spot on the site", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "please add a spot on westpeek.ventures for people to sign up", limits: EMAILED_TASK_LIMITS, emlKey: null });
    // The door already handed it on; undo that to reproduce the defect shape.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN', kind = NULL WHERE id = ?1").bind(chiefId).run();
    const out = await workCard(env, { request: new Request("https://os.joinwestpeek.com/internal/test"), env, identity: sweepIdentity(), params: {} }, chiefId, { maxSteps: 2 });
    expect(out.finished).toBe(true);
    expect(out.steps[0]!.action).toBe("assigned");
    expect((await card(chiefId)).state).toBe("DONE");
    const browse = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM browser_task WHERE work_card_id = ?1").bind(chiefId).first<{ n: number }>();
    expect(browse!.n, "no browser task, no permission block").toBe(0);
  });

  it("a partner's 'Re: <our subject>' reply answers the block and creates no card, even without our token", async () => {
    const chiefId = await openAssignmentCard(env, { subject: "Something Walker holds", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Walker, find me three podcast hosts who cover seed funds.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const { blockCard } = await import("../src/worker/services/blocks");
    await blockCard(env, { id: chiefId, title: "From scooter@westpeek.ventures: Something Walker holds", firm_scope: "west-peek" }, { reason: "permission_to_open_a_page", trying: "podcast hosts", employee: "Walker", url: "https://example.org" });
    const { replyToRequester } = await import("../src/worker/services/requestReply");
    const c0 = await card(chiefId);
    const reply = await replyToRequester(env, { id: chiefId, title: String(c0.title), requested_by_email: SCOOTER, firm_scope: "west-peek" }, "BLOCKED", "Walker", String(c0.block_needed));
    expect(reply.sent).toBe(true);
    const cardsBefore = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
    // The subject we sent is the one he replies to — "a question", never "blocked" (23 Sep 2026).
    expect(sent.at(-1)!.subject).toBe("Walker: a question — Something Walker holds");
    const raw = SCOOTER_MIME({ subject: "Re: Walker: a question — Something Walker holds", body: "Yes he can open.\n\nSent from my iPhone" });
    // The wire carries the subject RFC 2047-encoded (an em-dash is not a ByteString).
    await handleInboundEmail(inbound(raw, { subject: `=?UTF-8?B?${Buffer.from("Re: Walker: a question — Something Walker holds").toString("base64")}?=` }), env);
    const cardsAfter = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
    expect(cardsAfter, "no new card for a reply").toBe(cardsBefore);
    const c = await card(chiefId);
    expect(c.state).toBe("OPEN");
    expect(String(c.block_answer)).toMatch(/^Yes he can open/);
    expect(c.block_answered_by).toBe("fu_scooter_taylor");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(chiefId).run();
  });

  it("an OVERSIZE partner reply steers the card it answers — by our token, and by the Re: subject alone (doubled prefix included) — and opens no card (27 Sep 2026)", async () => {
    /*
     * TWICE IN ONE DAY. Scooter's 3 MB reply to the hand-off email and his 472 KB reply to the PLAN
     * email (the Carlos photo attached) were both over MAX_BODY_BYTES; the oversize branch opened a
     * new Walker card for each without asking whether it was a reply, while the card they answered
     * sat BLOCKED waiting for exactly those words. One reply check for every size now.
     */
    const smallPhoto = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("JFIF fake photo bytes for the test")]).toString("base64");
    const bigPhoto = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600 * 1024, 7)]).toString("base64").replace(/(.{76})/g, "$1\r\n");
    const countCards = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;

    // 1 · BY TOKEN. A card blocked on a real question; the reply carries our token in In-Reply-To.
    const porter = await planned(SCOOTER, "Walker", "community colours big", { document: "# Plan", decided: [], asks: [{ question: "Which orange?" }], publish_ready: true, placeholders: [] });
    expect((await card(porter.id)).state).toBe("BLOCKED");
    const before = await countCards();
    const byToken = inbound(SCOOTER_MIME({ subject: "Re: Porter: Community colours big: Plan ready", body: "approved\n\nSent from my iPhone", image: true }).replace(smallPhoto, bigPhoto), { "in-reply-to": threadReference(await porter.token()) });
    expect(byToken.rawSize, "the fixture is genuinely over the cap").toBeGreaterThan(MAX_BODY_BYTES);
    await handleInboundEmail(byToken, env);
    expect(await countCards(), "a reply opens no card, whatever its size").toBe(before);
    const c1 = await card(porter.id);
    expect(c1.state, "the block is answered").toBe("OPEN");
    expect(String(c1.block_answer), "what he WROTE, above the quote").toMatch(/^approved\n/);
    expect(c1.block_answered_by).toBe("fu_scooter_taylor");
    const att = (await env.WP_OS_DB.prepare("SELECT filename, source, bytes FROM request_attachment WHERE work_card_id = ?1").bind(porter.id).all<{ filename: string; source: string; bytes: number }>()).results!;
    expect(att.map((a) => [a.filename, a.source]), "the reply's photo is kept against the card it steered").toEqual([["sensori-founders.jpg", "REPLY"]]);
    expect(att[0]!.bytes).toBeGreaterThan(600 * 1024 * 0.99);
    const indexed = await env.WP_OS_DB.prepare("SELECT work_card_id FROM inbound_message ORDER BY received_at DESC LIMIT 1").first<{ work_card_id: string | null }>();
    expect(indexed?.work_card_id, "the stored message is indexed against the steered card").toBe(porter.id);

    // 2 · BY SUBJECT ALONE — no token at all, as both of his replies today arrived — against the
    //     doubled prefix stored on today's threads ("Porter: Porter: Plan ready").
    const second = await planned(SCOOTER, "Walker", "community colours bigger", { document: "# Plan", decided: [], asks: [{ question: "Which orange, really?" }], publish_ready: true, placeholders: [] });
    await env.WP_OS_DB.prepare("UPDATE email_thread SET subject = 'Porter: Porter: Plan ready' WHERE token = ?1").bind(await second.token()).run();
    const before2 = await countCards();
    const bySubject = inbound(SCOOTER_MIME({ subject: "Re: Porter: Porter: Plan ready", body: "Yes go ahead\n\nSent from my iPhone", image: true }).replace(smallPhoto, bigPhoto), {
      // Gmail's chain: only the SES message id, never our token.
      references: "<010001a0e3b6b039-061d7fcc-774a-45c4-91bc-0f1d78b58b10-000000@email.amazonses.com>",
      "in-reply-to": "<010001a0e3b6b039-061d7fcc-774a-45c4-91bc-0f1d78b58b10-000000@email.amazonses.com>",
    });
    expect(bySubject.rawSize).toBeGreaterThan(MAX_BODY_BYTES);
    await handleInboundEmail(bySubject, env);
    expect(await countCards(), "no card for a reply matched by subject either").toBe(before2);
    const c2 = await card(second.id);
    expect(c2.state).toBe("OPEN");
    expect(String(c2.block_answer)).toMatch(/^Yes go ahead/);
    // The match tolerates what clients do to a subject: the single-prefix form of the same line
    // matches the doubled one stored, an em-dash rewritten, an ellipsis dropped, case and spacing.
    expect(comparableSubject("Re: Porter: Plan ready")).toBe(comparableSubject("Porter: Porter: Plan ready"));
    expect(comparableSubject("RE: Fwd: Porter: Community site redesign - now yours")).toBe(comparableSubject("Porter: Community site redesign — now yours"));
    expect(comparableSubject("Re: Porter: Community site redesign — everything is in: Preview ready")).toBe(comparableSubject("Porter: Community site redesign — everything is in…: Preview ready"));
    expect(comparableSubject("Re: Porter: Plan ready"), "different lines stay different").not.toBe(comparableSubject("Porter: Preview ready"));
  });

  it("a re-read supersedes the live duplicate and returns the card it created; every partner .eml is stored", async () => {
    const key = `inbound-email/2026-09-21/${crypto.randomUUID()}.eml`;
    const raw = SCOOTER_MIME({ subject: "Newsletter signup on the site", body: "Hey Porter!\n\nCan we add a newsletter signup on the site? Just a spot where people can drop their email." });
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(key, raw);
    // The live duplicate: the mis-read chief card, still BLOCKED.
    const dup = await openAssignmentCard(env, { subject: "Newsletter signup on the site", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Received: from x\r\nSubject: Newsletter signup on the site\r\n\r\n(garbage)", limits: EMAILED_TASK_LIMITS, emlKey: key });
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = NULL WHERE id = ?1").bind(dup).run();
    await (await import("../src/worker/services/blocks")).blockCard(env, { id: dup, title: "From scooter@westpeek.ventures: Newsletter signup on the site", firm_scope: "west-peek" }, { reason: "the_brief_is_missing", trying: "Newsletter signup on the site", employee: "Walker" });
    const dupTitle = String((await card(dup)).title);
    expect(dupTitle).toBe("From scooter@westpeek.ventures: Newsletter signup on the site");
    // STRICTER THAN THE PREFIX IT USED TO ASSERT (22 Sep 2026): the door no longer mints a key of
    // its own, so the card must name the EXACT key the message was kept under at the intake. A card
    // pointing at some other stored message is the failure this line now catches.
    expect(String((await card(dup)).description), "the card names the key the message was kept under").toContain(`Stored message: ${key}`);
    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key, received_tldr: "Got it — and ignore the 'Walker: blocked' email you just got.", reply_on_thread: "wpt_04e85ca12a124c358b220e84d893cdcb" }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { superseded: string[]; new_card: string; new_card_kind: string };
    expect(body.superseded).toContain(dup);
    expect((await card(dup)).state).toBe("CANCELLED");
    expect(String((await card(dup)).next_action)).toMatch(/Superseded by a re-read/);
    expect(body.new_card_kind).toBe("WEB_PROPERTY_CHANGE");
    expect(body.new_card).not.toBe(dup);
    expect((await readWebPropertyChange(env, body.new_card))!.request_text).toMatch(/^Hey Porter!/);
    const received = sent.filter((m) => m.to === SCOOTER).pop()!;
    expect(received.text).toMatch(/ignore the 'Walker: blocked' email/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(body.new_card).run();
  });

  it("the prompt records the Google Sheet default for a form's destination", () => {
    const prompt = readFileSync(new URL("../scripts/duties/web-property-change-prompt.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(prompt).toContain("the DESTINATION IS A GOOGLE SHEET");
    expect(prompt).toContain("recorded default (Sequoia, 21 Sep 2026), not an ask");
    expect(prompt).toContain("validate:forms");
  });
});

describe("STUCK is sent once, only when idle past the ceiling inside the window", () => {
  beforeAll(ageEarlierCards);
  it("a run that dies mid-plan and is not re-claimed within the ceiling → exactly one STUCK; a second tick sends nothing", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = '00-24' WHERE kind = ?1 AND rule_key = 'stuck_window_ct'").bind(WEB_PROPERTY_CHANGE_KIND).run();
    const before = sent.length;
    const chiefId = await openAssignmentCard(env, { subject: "stuck test", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Change the footer on westpeek.ventures.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id); // PLAN parked
    // The Mac claimed it and died mid-plan: the reaper closes the run.
    const run = (await liveJobFor(id))!;
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'ABANDONED', claimed_by = 'mac', resolution = 'went quiet' WHERE id = ?1").bind(run.id).run();
    const retry = await tickFor(id);
    expect(retry.outcome, "a failed attempt, re-parked next tick").toBe("FAILED");
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /: Blocked$/.test(m.subject)), "a re-claim inside the ceiling says nothing").toHaveLength(0);
    await tickFor(id); // re-parked
    const queued = (await liveJobFor(id))!;
    expect(queued.status).toBe("QUEUED");
    // Nobody claims it; 46 minutes pass.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(queued.id, new Date(Date.now() - 46 * 60_000).toISOString()).run();
    const held = await runWebPropertyChangeCard(env, { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    expect(held.held).toBe(true);
    const stuck = sent.slice(before).filter((m) => m.to === SCOOTER && /: Blocked$/.test(m.subject));
    expect(stuck).toHaveLength(1);
    expect(stuck[0]!.text).toMatch(/^\*\*TL;DR:\*\* Blocked: the plan has been waiting \*{0,2}46\*{0,2} minutes for the Mac/);
    await runWebPropertyChangeCard(env, { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /: Blocked$/.test(m.subject)), "the same cause never emails twice").toHaveLength(1);
    const kinds = (await env.WP_OS_DB.prepare("SELECT kind FROM work_card_notice WHERE work_card_id = ?1 ORDER BY sent_at").bind(id).all<{ kind: string }>()).results!.map((n) => n.kind);
    expect(kinds).toEqual(["RECEIVED", "STUCK"]);
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = '06-22' WHERE kind = ?1 AND rule_key = 'stuck_window_ct'").bind(WEB_PROPERTY_CHANGE_KIND).run();
  });

  it("the window is Central hours", () => {
    expect(stuckWindowOpen("06-22", new Date("2026-09-21T17:00:00Z"))).toBe(true); // 12:00 CDT
    expect(stuckWindowOpen("06-22", new Date("2026-09-21T08:00:00Z"))).toBe(false); // 03:00 CDT
    expect(stuckWindowOpen("00-24", new Date("2026-09-21T08:00:00Z"))).toBe(true);
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
