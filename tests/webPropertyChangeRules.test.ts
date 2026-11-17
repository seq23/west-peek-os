import { LOCAL_JOB_KINDS, type LocalJobPayload } from "../src/shared/work/localJobs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce, type SweepCard } from "../src/worker/services/workSweep";
import type { ReplyIntentReader } from "../src/worker/services/replyIntent";
import type { QuestionAnswerer } from "../src/worker/services/questionRouting";
import { claimRun, parkRun, progressRun, reapSeatRuns, readRun, reportRun, JOB_SILENCE_MS, MAX_JOB_NAPS, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { parseWebPropertyAsk, isWebPropertyChange, driveFolderLinks, addresseeIn, sitesOf } from "../src/shared/intake/webPropertyChange";
import { parseBlogAsk } from "../src/shared/intake/blogHelp";
import { workCard } from "../src/worker/services/employeeWork";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { preApprovalIn } from "../src/shared/work/approvalReply";
import { readLocalJobReport, WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { KEPT_FOR_NEXT_BUILD, blockedEmailDetail, finishOriginalAsk, missingSecretsOf, needsPreview, parkPhase, phaseModel, readWebPropertyChange, rulesFor, runWebPropertyChangeCard, type WebPropertyChangeRow } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { handleDeveloperChanges, handleDeveloperEmail } from "../src/worker/services/developerDirection";
import { answerBlock } from "../src/worker/services/blocks";
import { handleInboundEmail, MAX_BODY_BYTES } from "../src/worker/effects/inboundEmail";
import { comparableSubject } from "../src/worker/services/emailThread";
import { requestAttachments, textBodyOf } from "../src/worker/effects/mimeAttachments";
import { handleGetRequestAttachment, handleReingestStoredEmail, sendReceived, stuckWindowOpen } from "../src/worker/services/webPropertyChange";
import { readFileSync } from "node:fs";
import { SECRET_BY_EMAIL } from "../src/shared/work/porterWaits";

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
const sent: Array<{ to: string; subject: string; text: string; toAll?: string[]; cc?: string[] }> = [];

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
/**
 * THE INTENT READER, INJECTED (27 Sep 2026). Free text a partner writes is read for its intent
 * through `replyIntent.ts`; the keyword forms never reach it. This fake decides deterministically
 * from the words and records every call, so a test can prove which replies were read by a model
 * and which by the keyword fast path — without a live call.
 */
const intentCalls: string[] = [];
const fakeIntentReader: ReplyIntentReader = async (_env, input) => {
  intentCalls.push(input.text);
  const t = input.text;
  const base = { keyword: null, aiRunId: null, source: "MODEL" as const, reason: "fake reader" };
  if (/let'?s not|think it over|hold on|hold off|\bstop\b|\bwait\b/i.test(t)) return { ...base, kind: "STOP", changes: null, question: null };
  const question = /\?/.test(t) ? (t.match(/[^.\n]*\?/)?.[0] ?? t).trim() : null;
  const changes = /\b(but|make|swap|use|instead|please)\b/i.test(t) ? t.replace(/[^.\n]*\?/, "").trim() || null : null;
  if (question) return { ...base, kind: "QUESTION", changes, question };
  return { ...base, kind: "CONTINUE", changes, question: null };
};
/** What the answerer was handed as the card's own facts, last call. A question with "for certain" in it is one the model cannot answer. */
let answererFacts: string[] | undefined;
const fakeAnswerer: QuestionAnswerer = async (_env, input) => {
  answererFacts = input.facts;
  if (/for certain/i.test(input.question)) return { confident: false, answer: null, reason: "fake: not sure", aiRunId: null };
  return { confident: true, answer: `Yes — ${input.question.slice(0, 60)} The hex is #E0632F and it stays.`, reason: "fake", aiRunId: null };
};
const RUNNERS = { webPropertyChange: (e: Env, c: SweepCard) => runWebPropertyChangeCard(e, c, undefined, undefined, fakeAnswerer, fakeIntentReader) };

async function tick(): Promise<Awaited<ReturnType<typeof sweepOnce>>> {
  return sweepOnce(env, nextTickTime(), RUNNERS);
}

/** Sweep until THIS card is the one worked (older cards the sweep holds are worked first). */
async function tickFor(id: string): Promise<Awaited<ReturnType<typeof sweepOnce>>> {
  // Held cards are leased for HELD_MINUTES; the clock here is real, so a held sibling is skipped.
  for (let i = 0; i < 8; i++) {
    const out = await sweepOnce(env, nextTickTime(), RUNNERS);
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
 * THE FINISHED EMAIL GOES STRAIGHT TO THE PARTNER WHO ASKED (0258, 15 Oct 2026). From 0223 (22 Sep)
 * these pins read the body FILED for Sequoia, because `done_reply_preview_first` was seeded ON. She
 * turned it off — and the firm-wide dial with it — so the DONE reply is SENT. Every pin now reads the
 * mail that actually left, and additionally requires that nothing for this card is still waiting on
 * her Home and that the requester got exactly one finished email. Strictly more than before.
 */
async function finishedEmailFor(cardId: string, to: string, since = 0): Promise<{ text: string; subject: string }> {
  const held = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM preview_approval WHERE work_card_id = ?1 AND state = 'PENDING'")
    .bind(cardId)
    .first<{ n: number }>();
  expect(held?.n, "nothing for this card is held on her Home").toBe(0);
  const mails = sent.slice(since).filter((m) => m.to === to && /: Live$/.test(m.subject));
  expect(mails, "the finished email reached the partner who asked, exactly once").toHaveLength(1);
  return { text: mails[0]!.text, subject: mails[0]!.subject };
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
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; cc?: string[] };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, toAll: body.to, cc: body.cc ?? [] });
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





/** Open a card for a partner, run PLAN with the given report, and return Porter's card id and the newest block thread token. */
async function planned(who: string, chief: string, subject: string, plan: Record<string, unknown>): Promise<{ id: string; token: () => Promise<string> }> {
  const chiefId = await openAssignmentCard(env, { subject, partnerAddress: who, chiefOfStaff: chief, raw: `${subject}: westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${subject.replace(/\W/g, "").slice(0, 6)}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
  const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
  await tickFor(id); // parks PLAN
  await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }], ...plan });
  await tickFor(id); // blocks with the plan
  return {
    id,
    token: async () => (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token,
  };
}

/**
 * #363 (13 Nov 2026, owner ruling: "he needs to never silently drop things we ask for and move them
 * around"). A partner asked for a website and a dashboard in one email. The plan built the website
 * and, by itself, moved the dashboard to "its own card, starts 17 Nov"; the report reader then dropped
 * the `deferred` field, so no card was made and nothing said so. Driven through the real path: the
 * Mac's stored report → applyReport.
 */
/**
 * #363 (13 Nov 2026): a partner asked for a website and a dashboard; the job built the website and
 * put the dashboard off. The OS reopens its own job to finish what was asked. No partner is needed
 * for that, and the path can do nothing a partner's word is needed for.
 */

/**
 * 15 Nov 2026, wc_c548d043…: the partner tail stopped a BUILD that was working from a reply cut short
 * (her rule, 9 Oct 2026: stop the build first). The sweep charged that stop as a failed attempt, so the
 * corrected rebuild ran on its last one. A deliberate stop queues the phase again and spends nothing.
 */

/**
 * #363, migration 0301 (owner, 13 Nov 2026): "i like the safety rule but i should have a developer
 * role that bypasses it". Only the partner who asked changes a job (0241) — and the developer, for
 * work instructions only, herself or through her partner tail. Nothing else moves.
 */



/**
 * THE v1.0 BAR (owner, 13 Nov 2026: builds come out "v1.0 final with persistence and veteran UX/UI POV"). Every built ask
 * says when it is done; a BUILD reports each ask against those checks, and one not met (and not held by a key or a file
 * only the partner can supply) is refused before anything reaches the partner.
 */






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
  await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }], ...plan });
  return id;
}


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


async function releasePlansNobodyNeedsToAnswerAgain(): Promise<string[]> {
  return (await import("../src/worker/services/webPropertyChange")).releasePlansNobodyNeedsToAnswer(env);
}

/** The firm caps an employee at 20 new cards an hour; this file opens many for Porter. Age the earlier ones. */
/**
 * ONE OPEN WEBSITE CARD PER PARTNER PER PROPERTY (28 Sep 2026). A partner's new email that names a
 * property they already have an open card for is a FOLLOW-UP on that card, not a new request
 * (`openSiteCardFor`; tests/followUpJoinsTheOpenSiteCard.test.ts). The intake shapes below each
 * expect a fresh card, so the partner's earlier cards for the property are closed first — the way
 * a real morning starts with yesterday's job landed.
 */
async function closeOpenSiteCardsOf(partner: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET state = 'CANCELLED', lease_until = NULL WHERE kind = ?1 AND lower(requested_by_email) = ?2 AND state NOT IN ('DONE', 'CANCELLED')",
  )
    .bind(WEB_PROPERTY_CHANGE_KIND, partner.toLowerCase())
    .run();
}

async function ageEarlierCards(): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '-2 hours')").run();
}

/*
 * SPLIT FOR TIME (15 Nov 2026). This file was one 99-test file that took 311s on one CI shard, past the
 * 5-minute gate. It is now 3 files, cut at describe blocks with every test kept as it was; each file
 * stands up its own fresh DB with the same beforeAll/afterAll the original had (the shared setup
 * and helpers are repeated verbatim in each). Siblings: webPropertyChange.test.ts, webPropertyChangeReplies.test.ts.
 */

describe("every ask is built in the job or the partner is asked; later work is only what the partner dated (#363)", () => {
  const deferredFrom = async (sourceId: string) =>
    (await env.WP_OS_DB.prepare("SELECT id, title, kind, state, owner_id, requested_by_email, lease_until, description FROM work_card WHERE assigned_from_card_id = ?1 ORDER BY created_at").bind(sourceId).all<Record<string, string | null>>()).results ?? [];
  // These cards are real; the suite's "is Porter looping?" guard counts an hour of them. Age them out on the way in and out.
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  const plan = (more: Record<string, unknown>) => ({ document: "# Plan\n\nnothing to ask", decided: ["the site is built now"], asks: [], publish_ready: true, ...more });
  /** Open a card and park PLAN, without the helper's assumption that the first plan is accepted. */
  async function asked(subject: string): Promise<string> {
    const chiefId = await openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `${subject}: westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${subject.replace(/\W/g, "").slice(0, 6)}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    return id;
  }

  it("rule 1: a plan that puts off an ask the partner did not date is refused, nothing of it is applied, and the next PLAN is told why", async () => {
    const id = await asked("studio website and a sponsor dashboard");
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the studio website", how: "build", done_when: ["it works on the preview"] }, { ask: "the sponsor dashboard", how: "later" }], deferred: [{ ask: "Build the sponsor dashboard", due_at: "2031-03-17", words: "the dashboard is a bigger build" }] }) });
    await tickFor(id);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.plan_filed_at, "the plan was not accepted").toBeNull();
    expect(row.phase).toBe("PLAN");
    expect(await deferredFrom(id), "and nothing was split off").toHaveLength(0);
    expect((await card(id)).state, "a refusal is a failed attempt, never a question for the partner").not.toBe("BLOCKED");
    expect(String((await card(id)).description)).toMatch(/PLAN REFUSED.*sponsor dashboard.*did not date/);
    expect(sent.filter((m) => /studio website and a sponsor dashboard/i.test(m.subject) && /plan ready|going ahead/i.test(m.subject)), "he is told nothing about a refused plan").toHaveLength(0);
    // The sweep plans again, and the job carries the reason.
    const next = (await liveJobFor(id)) ?? (await tickFor(id), await liveJobFor(id));
    expect(next, "PLAN is queued again").not.toBeNull();
    expect(String(next!.job_json)).toMatch(/PLAN REFUSED/);
    // The same request, planned with both asks built: accepted.
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the studio website", how: "build", done_when: ["it works on the preview"] }, { ask: "the sponsor dashboard", how: "build", done_when: ["it works on the preview"] }] }) });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_filed_at).toBeTruthy();
    expect(String((await card(id)).description)).toContain("the sponsor dashboard → built in this job");
  });

  it("rule 2: a plan with no per-ask accounting, or with an ask that is neither built nor asked about, is refused", async () => {
    const id = await asked("press page and a pricing table");
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({}) });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_filed_at).toBeNull();
    expect(String((await card(id)).description)).toMatch(/PLAN REFUSED.*did not account for each thing/);
    if (!(await liveJobFor(id))) await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the press page", how: "build", done_when: ["it works on the preview"] }, { ask: "the pricing table", how: "out of scope" }] }) });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_filed_at).toBeNull();
    expect(String((await card(id)).description)).toMatch(/"the pricing table" is neither built in this job nor asked about/);
    if (!(await liveJobFor(id))) await tickFor(id);
    // A question is a fate; a question with nothing asked is not.
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the press page", how: "build", done_when: ["it works on the preview"] }, { ask: "the pricing table", how: "question" }] }) });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_filed_at).toBeNull();
  });

  it("rules 3 and 4: work the partner dated becomes its own card leased to its date and linked to the source; work that is not a change to this site is never a site job on its repo", async () => {
    const id = await asked("studio site now and the sponsor tracker next week");
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the studio site", how: "build", done_when: ["it works on the preview"] }, { ask: "the sponsor tracker", how: "later" }], deferred: [{ ask: "Build the sponsor tracker in the operating system, not on the public site", due_at: "2031-03-17", words: "the sponsor tracker next week", site_change: false }] }) });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_filed_at, "a partner-dated deferral is a plan like any other").toBeTruthy();
    const made = await deferredFrom(id);
    expect(made, "exactly one card for the one deferred item").toHaveLength(1);
    const c = made[0]!;
    expect(c.title).toContain("(deferred to 2031-03-17)");
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(c.lease_until, "leased to its date, so the sweep leaves it alone until then").toBe("2031-03-17T00:00:00.000Z");
    expect(c.kind, "not forced into a site job").toBeNull();
    expect(await readWebPropertyChange(env, c.id!), "no job on the source repo").toBeNull();
    expect(String((await card(id)).description), "the source card says so").toContain(`its own card (${c.id}) runs on 2031-03-17`);
  });

  it("rule 4: a dated change to THIS site is a site job on the same repo, leased to its date", async () => {
    const id = await asked("studio hero now and swap the photo next month");
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the hero", how: "build", done_when: ["it works on the preview"] }, { ask: "swap the photo", how: "later" }], deferred: [{ ask: "Swap the hero photo for the spring one", due_at: "2031-04-01", words: "swap the photo next month", site_change: true }] }) });
    await tickFor(id);
    const made = await deferredFrom(id);
    expect(made).toHaveLength(1);
    expect(made[0]!.kind).toBe("WEB_PROPERTY_CHANGE");
    expect(made[0]!.lease_until).toBe("2031-04-01T00:00:00.000Z");
    expect((await readWebPropertyChange(env, made[0]!.id!))!.target_repo).toBe((await readWebPropertyChange(env, id))!.target_repo);
  });

  it("rule 3: a deferred item that cannot become a card is said on the source card, in the record and to the partners, never dropped", async () => {
    const before = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'deferred_not_filed:%'").first<{ n: number }>())!.n;
    const id = await asked("studio page now and the press page later in spring");
    await macReports(id, { phase: "PLAN", status: "ok", ...plan({ accounting: [{ ask: "the studio page", how: "build", done_when: ["it works on the preview"] }, { ask: "the press page", how: "later" }], deferred: [{ ask: "Add the press page", due_at: "sometime in spring", words: "the press page later in spring" }] }) });
    await tickFor(id);
    expect(await deferredFrom(id)).toHaveLength(0);
    const desc = String((await card(id)).description);
    expect(desc).toContain("DEFERRED WORK NOT FILED");
    expect(desc).toContain("Add the press page");
    const ev = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.deferred_not_filed' AND object_id = ?1").bind(id).first<{ n: number }>();
    expect(Number(ev?.n)).toBe(1);
    const after = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM notification WHERE dedupe_key LIKE 'deferred_not_filed:%'").first<{ n: number }>())!.n;
    expect(after, "the partners are told").toBeGreaterThan(before);
  });
});

describe("spending is the owner's: a spend stop holds the card and emails nobody (13 Nov 2026)", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  it("the Mac's NAMED STOP [SPEND_NEEDS_THE_OWNER] holds the card on what it needs, with no email and no retry", async () => {
    const chiefId = await openAssignmentCard(env, { subject: "studio domain spend", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `Put the studio site on its own domain westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}spend1`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    const from = sent.length;
    await macReports(id, { phase: "PLAN", status: "failed", reason: "NAMED STOP [SPEND_NEEDS_THE_OWNER] this needs money spent, which only the owner approves: register westpeekstudio.com. Nothing was bought; the card waits for her." });
    await tickFor(id);
    const c = await card(id);
    expect(String(c.waiting_for)).toMatch(/^Needs money spent, which only the owner approves — nothing was bought: .*register westpeekstudio\.com/);
    expect(Date.parse(String(c.waiting_until))).toBeGreaterThan(Date.now() + 6 * 24 * 3600 * 1000);
    expect(c.state).not.toBe("BLOCKED");
    expect(await liveJobFor(id), "no retry that could try to buy it again").toBeNull();
    expect(sent.slice(from), "nobody is emailed").toHaveLength(0);
    const ev = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.spend_needs_owner' AND object_id = ?1").bind(id).first<{ n: number }>();
    expect(Number(ev?.n)).toBe(1);
  });
});

describe("the v1.0 bar: every built ask says when it is done, and a build that has not met it is refused (13 Nov 2026)", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  const BASE = { document: "# Plan\n\nnothing to ask", decided: ["as asked"], asks: [], publish_ready: true };
  const pr = (tag: string) => ({ pr_url: "https://github.com/seq23/join-west-peek-main/pull/91", pr_number: 91, branch: `work/wpc-${tag}`, check_state: "GREEN", preview_url: `https://${tag}.west-peek-ventures.pages.dev`, proof: "validate green" });

  const checks = ["Scooter signs in with his own password on the preview", "a saved note is still there after a reload"];
  async function atBuild(tag: string, refusePlanFirst = false): Promise<string> {
    const chiefId = await openAssignmentCard(env, { subject: `productions dashboard ${tag}`, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `Please build a dashboard on westpeek.ventures where I can sign in and edit my notes — package: https://drive.google.com/drive/folders/${FOLDER}${tag}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    if (refusePlanFirst) {
      // PLAN: a built ask with no done-when checks is refused and planned again.
      await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "the dashboard", how: "build" }], ...BASE });
      await tickFor(id);
      expect((await readWebPropertyChange(env, id))!.plan_filed_at, "the plan was not accepted").toBeNull();
      expect(String((await card(id)).description)).toMatch(/PLAN REFUSED.*"the dashboard" is to be built, but the plan does not say when it is done/);
      if (!(await liveJobFor(id))) await tickFor(id);
    }
    await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "the dashboard", how: "build", done_when: checks }], ...BASE });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_filed_at).toBeTruthy();
    return id;
  }
  const noPreviewTo = (from: number) => sent.slice(from).filter((m) => m.to === SCOOTER && /preview/i.test(`${m.subject}\n${m.text}`));

  it("a built ask with no done-when checks is refused at PLAN; a check not met, held by nothing only the partner can supply, is refused at BUILD with no preview", async () => {
    const id = await atBuild("v1bar1", true);
    expect(String((await card(id)).description)).toContain("done when: Scooter signs in with his own password on the preview");
    const from = sent.length;
    await macReports(id, { phase: "BUILD", status: "ok", ...pr("v1bar1"), items: [
      { item: "the dashboard", state: "partial", done_when: [{ check: checks[0], met: true }, { check: checks[1], met: false, note: "reads a snapshot" }] },
      { item: "the notes editor", state: "partial", blocked_by: "too_big", done_when: [{ check: "an edit saves", met: false }] },
    ] });
    await tickFor(id);
    const desc = String((await card(id)).description);
    expect(desc).toMatch(/BUILD REFUSED.*"the dashboard" is not finished \(a saved note is still there after a reload\)/);
    expect(desc).toMatch(/"the notes editor" is not finished \(an edit saves\) and "too_big" is not something only the partner can supply/);
    expect((await readWebPropertyChange(env, id))!.preview_url ?? null, "the refused build's preview is not recorded").toBeNull();
    expect((await card(id)).state, "a refusal is a failed attempt, never a question").not.toBe("BLOCKED");
    expect(noPreviewTo(from), "no preview reached him").toHaveLength(0);
  });

  it("a BUILD that reports no items is refused; one held only by a file only the partner can send, named as missing, goes to preview", async () => {
    const id = await atBuild("v1bar2");
    const from = sent.length;
    await macReports(id, { phase: "BUILD", status: "ok", ...pr("v1bar2") });
    await tickFor(id);
    expect(String((await card(id)).description)).toMatch(/BUILD REFUSED.*no `items` list/);
    expect(noPreviewTo(from)).toHaveLength(0);
    const ok = await atBuild("v1bar3");
    await macReports(ok, { phase: "BUILD", status: "ok", ...pr("v1bar3"), missing_materials: [{ item: "the Productions logo", where: "the dashboard header" }], items: [{ item: "the dashboard", state: "partial", blocked_by: "missing_material", done_when: [{ check: checks[0], met: true }, { check: "the header shows the Productions logo", met: false }] }] });
    await tickFor(ok);
    expect((await readWebPropertyChange(env, ok))!.preview_url).toBe("https://v1bar3.west-peek-ventures.pages.dev");
    expect((await card(ok)).state, "waiting on his word on the preview").toBe("BLOCKED");
  });

  it("one held only by keys only the partner can supply, named as missing with the vault searched, goes to preview and the keys are on the job (14 Nov 2026)", async () => {
    const id = await atBuild("v1bar4");
    const from = sent.length;
    await macReports(id, { phase: "BUILD", status: "ok", ...pr("v1bar4"),
      vault_lookup: { searched: ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"], found: [], missing: ["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"] },
      missing_secrets: [{ name: "DROPBOX_APP_KEY", vendor_url: null, searched: ["DROPBOX_APP_KEY"] }, { name: "DROPBOX_APP_SECRET", vendor_url: null, searched: ["DROPBOX_APP_SECRET"] }],
      items: [{ item: "the dashboard", state: "partial", blocked_by: "missing_secret", done_when: [{ check: checks[0], met: true }, { check: "Dropbox connects by his own OAuth", met: false }] }] });
    await tickFor(id);
    expect(String((await card(id)).description), "not refused as unfinished").not.toMatch(/BUILD REFUSED/);
    expect((await readWebPropertyChange(env, id))!.preview_url).toBe("https://v1bar4.west-peek-ventures.pages.dev");
    expect(missingSecretsOf((await readWebPropertyChange(env, id))!).map((m) => m.name), "the job knows the keys it waits on").toEqual(["DROPBOX_APP_KEY", "DROPBOX_APP_SECRET"]);
    // SAFETY (15 Nov 2026, wc_c548d043): the partner's preview never asks him to email a key; the developer gets the names.
    const toHim = sent.slice(from).filter((m) => m.to === SCOOTER);
    expect(toHim.some((m) => /preview/i.test(m.subject)), "the preview reached him").toBe(true);
    for (const m of toHim) for (const re of SECRET_BY_EMAIL) expect(`${m.subject}\n${m.text}`, "no key by email").not.toMatch(re);
    expect(toHim.map((m) => m.text).join("\n")).not.toContain("DROPBOX_APP_SECRET");
    const desk = await env.WP_OS_DB.prepare("SELECT body FROM notification WHERE firm_user_id = 'fu_sequoia_taylor' AND object_id = ?1 AND title LIKE 'KEYS_MISSING%'").bind(id).first<{ body: string }>();
    expect(desk?.body, "the developer is told the keys by name").toMatch(/DROPBOX_APP_KEY[\s\S]*DROPBOX_APP_SECRET/);
  });
});

describe("a placeholder is counted from the page, and filled in only when material arrived (15 Nov 2026, wc_c548d043)", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  it("a rebuild whose class was renamed (--todo → --pending) and whose list went empty, with no material sent: 2+ placeholders, nothing filled in", async () => {
    const BASE = { document: "# Plan\n\nnothing to ask", decided: ["as asked"], asks: [], publish_ready: true };
    const chiefId = await openAssignmentCard(env, { subject: "productions team tiles ph1", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `Please update the westpeek.ventures team and work pages — package: https://drive.google.com/drive/folders/${FOLDER}ph1`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "the pages", how: "build", done_when: ["the pages show"] }], ...BASE });
    await tickFor(id);
    const items = [{ item: "the pages", state: "done", done_when: [{ check: "the pages show", met: true }] }];
    const team = "Team photos and confirmed names for the two 'Photo to come / Name to confirm' team tiles";
    const work = "Project images, and the client's OK to show results, for TNTP, NCTA Ripple Effect";
    const pr = { pr_url: "https://github.com/seq23/join-west-peek-main/pull/93", pr_number: 93, branch: "work/wpc-ph1", check_state: "GREEN", preview_url: "https://ph1.west-peek-ventures.pages.dev", proof: "validate green" };
    await macReports(id, { phase: "BUILD", status: "ok", ...pr, items, missing_materials: [{ item: team, where: "/" }, { item: work, where: "/work" }] });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const token = (await env.WP_OS_DB.prepare("SELECT message_id FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' ORDER BY sent_at DESC LIMIT 1").bind(id).first<{ message_id: string }>())!.message_id;
    await replyFrom(SCOOTER, "Please tighten the hero copy", token);
    expect((await tickFor(id)).summary).toMatch(/BUILD queued/);
    const from = sent.length;
    // The model's list went empty (it renamed the class to get past the check); the pages still SAY it.
    await macReports(id, { phase: "BUILD", status: "ok", ...pr, items, changed: true, head_sha: "66ca763", missing_materials: [], visible_placeholders: ["Photo to come", "Name to confirm", "Photo to come", "Name to confirm", "Placeholder · TNTP's numbers to come", "Placeholder · the details and results to come"] });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, id))!;
    expect(JSON.parse(row.placeholders_json).length, "never 0 over a page that shows placeholders").toBeGreaterThanOrEqual(2);
    expect(JSON.parse(row.filled_json ?? "[]"), "no material arrived, so nothing is filled in").toEqual([]);
    const mail = sent.slice(from).filter((m) => m.to === SCOOTER && /preview/i.test(m.subject)).map((m) => m.text).join("\n");
    expect(mail).not.toMatch(/Filled in since/);
    expect(mail, "no permission he never gave").not.toMatch(/Filled in[\s\S]*client's OK/);
    expect(mail).toMatch(/2\*{0,2} placeholders/);
  });
});

describe("a step the partner kept for himself is his, not unfinished work (14 Nov 2026)", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  it("a check he reserved in his own words goes to preview; the same shape with words he never wrote is refused", async () => {
    /*
     * Scooter's brief: "We will walk the rules before any money view ships." The BUILD did every ask and reported
     * that one check as not met, quoting him; the bar refused it as unfinished and no preview reached him.
     */
    const BASE = { document: "# Plan\n\nnothing to ask", decided: ["as asked"], asks: [], publish_ready: true };
    const checks = ["Scooter signs in with his own password on the preview", "walk the cash rules with Scooter before any money view ships"];
    const more = "\n\nFinance stays private. We will walk the rules before any money view ships.";
    const atBuild = async (tag: string): Promise<string> => {
      const chiefId = await openAssignmentCard(env, { subject: `productions money ${tag}`, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `Please build a dashboard on westpeek.ventures where I can sign in and see deals — package: https://drive.google.com/drive/folders/${FOLDER}${tag}${more}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
      const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
      await tickFor(id);
      await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "the dashboard", how: "build", done_when: checks }], ...BASE });
      await tickFor(id);
      expect((await readWebPropertyChange(env, id))!.plan_filed_at).toBeTruthy();
      return id;
    };
    const pr = (tag: string) => ({ pr_url: "https://github.com/seq23/join-west-peek-main/pull/92", pr_number: 92, branch: `work/wpc-${tag}`, check_state: "GREEN", preview_url: `https://${tag}.west-peek-ventures.pages.dev`, proof: "validate green" });
    const his = await atBuild("held1");
    await macReports(his, { phase: "BUILD", status: "ok", ...pr("held1"), items: [{ item: "the dashboard", state: "partial", done_when: [{ check: checks[0], met: true }, { check: checks[1], met: false, note: "his own words: 'We will walk the rules before any money view ships'; nothing lands without his yes" }] }] });
    await tickFor(his);
    expect(String((await card(his)).description), "not refused as unfinished").not.toMatch(/BUILD REFUSED/);
    expect((await readWebPropertyChange(env, his))!.preview_url).toBe("https://held1.west-peek-ventures.pages.dev");
    const not = await atBuild("held2");
    await macReports(not, { phase: "BUILD", status: "ok", ...pr("held2"), items: [{ item: "the dashboard", state: "partial", done_when: [{ check: checks[0], met: true }, { check: checks[1], met: false, note: "his words: 'We will do the money view next month'" }] }] });
    await tickFor(not);
    expect(String((await card(not)).description), "words he never wrote hold nothing").toMatch(/BUILD REFUSED.*walk the cash rules/);
    expect((await readWebPropertyChange(env, not))!.preview_url ?? null).toBeNull();
  });
});

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
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/21", pr_number: 21, branch: "work/wpc-comm1234", check_state: "GREEN", preview_url: "https://a1b2c3d4.west-peek-ventures.pages.dev", proof: "npm run validate green · shots/community-desktop.png shots/community-390.png" });
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
    expect(String(c.block_needed)).toMatch(/^Waiting on: your word on the preview at https:\/\/work-wpc-comm1234\.west-peek-ventures\.pages\.dev\. Why: every site change previews before it goes live[\s\S]*To clear it by email: reply "approved" to publish it[\s\S]*PREVIEW READY\. Look at it here: https:\/\/work-wpc-comm1234\.west-peek-ventures\.pages\.dev\./);
    expect(String(c.block_needed)).toMatch(/reply "approved" to land it/i);
    // THE PREVIEW EMAIL (owner's spec, 23 Sep 2026): the four reply options ARE the TL;DR; then
    // the link, the placeholders still showing, and the card. No proof dump, never "blocked".
    const email = sent.filter((m) => m.to === SEQUOIA && /preview ready/i.test(m.subject)).pop()!;
    expect(email.subject).toBe("ACTION REQUIRED: Porter: Community rebuild: Preview ready");
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
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/21", pr_number: 21, branch: "work/wpc-comm1234", changed: true, head_sha: "moved-731", check_state: "GREEN", preview_url: "https://e9f8a7b6.west-peek-ventures.pages.dev", materials: "5:aaaa", proof: "validate green" });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const second = (await readWebPropertyChange(env, id))!;
    expect(second.preview_url).toBe("https://e9f8a7b6.west-peek-ventures.pages.dev");
    expect(second.preview_emailed_at! > firstPreviewAt, "the approval now binds to the NEW preview").toBe(true);
    const newPreview = sent.slice(beforeMail).filter((m) => m.to === SEQUOIA);
    expect(newPreview, "one new preview email").toHaveLength(1);
    expect(newPreview[0]!.subject).toBe("ACTION REQUIRED: Porter: Community rebuild: New preview ready");
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
    await macReports(porter.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/22", pr_number: 22, check_state: "GREEN", proof: "shots/team-desktop.png", materials: "12:abcd1234" });
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
    await macReports(porter.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/31", pr_number: 31, check_state: "GREEN", preview_url: "https://p31.westpeekproductions.pages.dev" });
    expect((await tickFor(porter.id)).outcome).toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.forced_by).toBeNull();
    expect(row.phase).toBe("BUILD");
    expect(String((await card(porter.id)).block_needed)).toMatch(/^Waiting on: your word on the preview[\s\S]*Why: every site change previews before it goes live[\s\S]*To clear it by email: reply "approved"[\s\S]*PREVIEW READY\./);
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
    await macReports(porter.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/33", pr_number: 33, check_state: "GREEN", preview_url: "https://p33.westpeekproductions.pages.dev", proof: "validate green" });
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
    // 0258: the requester's copy goes straight to him; the words on it are unchanged.
    expect(toScooter, "the finished email reaches Scooter once, on its own").toHaveLength(1);
    const held = await finishedEmailFor(porter.id, SCOOTER, before);
    expect(held.text).toMatch(/\*\*Published with placeholders\*\*\n• Landed to production with \*{0,2}2\*{0,2} placeholders by Scooter Taylor's instruction: Airtable link; winner records/);
    expect(held.text).toMatch(/^\*\*TL;DR:\*\* Live: your change is published\./);
    expect(held.text).toMatch(/\*\*Live now\*\*\n• https:\/\/westpeekproductions\.com\/news\n/);
    // She is told once: the both-partners notice that a forced landing always sends. Since 0258
    // there is no second, held copy of the finished email waiting for her decision.
    expect(toSequoia, "the other partner is told, and nothing is held for her").toHaveLength(1);
    expect(toSequoia[0]!.text).toMatch(/Landed to production with 2 placeholders by Scooter Taylor's instruction/);
    expect(toSequoia[0]!.text).toMatch(/pull\/33/);
    expect(toSequoia.some((m) => /Send it|approve/i.test(m.text)), "no preview doors — nothing waits on her").toBe(false);
  });
});

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
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/41", pr_number: 41, check_state: "GREEN" });
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
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/42", pr_number: 42, check_state: "GREEN", preview_url: "https://p42.pages.dev" });
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
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/43", pr_number: 43, check_state: "GREEN", preview_url: "https://p43.pages.dev" });
    const green = await tickFor(id);
    expect(green.summary, "no preview stop: forced").toMatch(/landing is queued/);
    expect((await readWebPropertyChange(env, id))!.phase).toBe("LAND");
  });
});
