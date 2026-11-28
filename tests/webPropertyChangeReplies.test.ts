import { LOCAL_JOB_KINDS, macDayOpen, macDayWords, type LocalJobPayload } from "../src/shared/work/localJobs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { sweepOnce, type SweepCard } from "../src/worker/services/workSweep";
import { keywordIntent, type ReplyIntentReader } from "../src/worker/services/replyIntent";
import { opensWithApproval } from "../src/shared/work/approvalReply";
import type { QuestionAnswerer } from "../src/worker/services/questionRouting";
import { claimRun, parkRun, progressRun, reapSeatRuns, readRun, reportRun, JOB_SILENCE_MS, MAX_JOB_NAPS, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { parseWebPropertyAsk, isWebPropertyChange, driveFolderLinks, addresseeIn, sitesOf } from "../src/shared/intake/webPropertyChange";
import { parseBlogAsk } from "../src/shared/intake/blogHelp";
import { workCard } from "../src/worker/services/employeeWork";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { preApprovalIn } from "../src/shared/work/approvalReply";
import { readLocalJobReport, WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { KEPT_FOR_NEXT_BUILD, REPLANNED_WITH_REPLY, HIS_REPLIES_SINCE, releaseMacAsleepBlocks, blockedEmailDetail, finishOriginalAsk, missingSecretsOf, needsPreview, parkPhase, phaseModel, readWebPropertyChange, rulesFor, runWebPropertyChangeCard, type WebPropertyChangeRow } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { handleDeveloperChanges, handleDeveloperEmail } from "../src/worker/services/developerDirection";
import { answerBlock } from "../src/worker/services/blocks";
import { handleInboundEmail, MAX_BODY_BYTES } from "../src/worker/effects/inboundEmail";
import { comparableSubject } from "../src/worker/services/emailThread";
import { readMail, requestAttachments } from "../src/worker/effects/mail";
import { liveAddressLine, handleGetRequestAttachment, handleReingestStoredEmail, sendReceived, stuckWindowOpen } from "../src/worker/services/webPropertyChange";
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
 * through `replyIntent.ts`, every reply and the one-word ones too (the model reads first, 22 Nov 2026). This fake
 * decides deterministically from the words and records every call, so a test can prove each reply was read by the
 * model, and once — without a live call.
 */
const intentCalls: string[] = [];
const fakeIntentReader: ReplyIntentReader = async (_env, input) => {
  intentCalls.push(input.text);
  const t = input.text;
  // The fake stands in for the model, which reads the one-word replies ("approved", "hold off") as the word lists do.
  const words = keywordIntent(t);
  // A model carries his whole words as the change (replyIntent.ts#fromReader), never the cut the word lists make.
  if (words) return { ...words, changes: words.changes === null ? null : t, source: "MODEL" as const, reason: "fake reader" };
  const base = { reading: { kind: "ANSWERS" as const, text: t }, approves: opensWithApproval(t), aiRunId: null, source: "MODEL" as const, reason: "fake reader" };
  if (/let'?s not|think it over|hold on|hold off|\bstop\b|\bwait\b/i.test(t)) return { ...base, reading: { kind: "REFUSED" as const, text: t }, approves: false, kind: "STOP", changes: null, question: null };
  // The live reader's 18 Nov shape: CONTINUE, the changes, and the question beside them (wc_c548d043).
  if (/point that domain/i.test(t)) return { ...base, kind: "CONTINUE", changes: t, question: "What is needed on your side to point westpeekproductions.com at the new site?" };
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
 * and helpers are repeated verbatim in each). Siblings: webPropertyChange.test.ts, webPropertyChangeRules.test.ts.
 */

describe("Porter reads the email (21 Sep 2026): the request is the specification", () => {
  beforeAll(() => closeOpenSiteCardsOf(SCOOTER));
  const PHOTO_EMAIL = SCOOTER_MIME({ subject: "Sensori photo swap on westpeek.ventures", body: "Swap the Sensori founders photo on westpeek.ventures for the one attached. Same spot, same size.", image: true });
  let porterId = "";

  it("the text body is the partner's words, not the headers; the image is an attachment; a quoted folder link is not the request's", async () => {
    expect(await (await readMail(PHOTO_EMAIL)).text).toBe("Swap the Sensori founders photo on westpeek.ventures for the one attached. Same spot, same size.");
    const { attachments } = await requestAttachments(await readMail(PHOTO_EMAIL));
    expect(attachments.map((a) => [a.filename, a.mediaType])).toEqual([["sensori-founders.jpg", "image/jpeg"]]);
    const quoted = SCOOTER_MIME({ subject: "Re: West Peek Community rebuild", body: "Change the tagline on westpeek.ventures to 'Good people meet good people'.", quoted: "package: https://drive.google.com/drive/folders/1jdhn1qHJW0vurKBU4QYttJIv0ut6-p8d" });
    const ask = parseWebPropertyAsk("Re: West Peek Community rebuild", await (await readMail(quoted)).text);
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

  it("a Mac 'blocked' is never a question for Scooter until the bound: two retries with no email, then ONE three-part email to the partner who asked (owner, 6 Oct 2026)", async () => {
    // 21 Sep 2026: a stale claimer answered "no Drive FOLDER is on the card" and the OS emailed
    // Scooter to send a folder link for a photo he had attached, then parked the card for a
    // 24-hour nag. The partner's decisions travel only as the plan's asks. 6 Oct 2026: after the
    // bound the partner who asked gets ONE email — what was tried, why, and the reply that restarts
    // it — never a "stuck" addressed to Sequoia and never a link into the OS.
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
    expect(fault.outcome, "attempt 3: the bound").toBe("BLOCKED");
    const c = await card(porterId);
    expect(c.block_who, "addressed to the partner who asked — never a lane owner").toBe("SCOOTER");
    expect(c.block_reason, "a question in plain words, not a technical fault").toBe("a_question_for_you");
    expect(String(c.block_needed)).toMatch(/^Waiting on: a word from you\. Why: I tried this PLAN three times and could not finish: no Drive FOLDER is on the card[\s\S]*To clear it by email: reply "try again" to run it once more, "changes: <what to change>" to change the ask, or "drop it" to close it\./);
    expect(String(c.block_needed).split("To clear it by email:")[1], "the clearing line is email-only: never a link into the OS, never a card, never \"ask Sequoia\"").not.toMatch(/on the card|ask Sequoia|https?:\/\//i);
    const toScooter = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(toScooter.length, "Scooter got exactly one email").toBe(1);
    expect(toScooter[0]!.text).toMatch(/Waiting on: a word from you[\s\S]*To clear it by email: reply "try again"/);
    expect(sent.slice(before).filter((m) => m.to === SEQUOIA_PARTNER_EMAIL).length, "Sequoia got nothing — it is not hers").toBe(0);
    // Put the card back the way the next test expects it: open, PLAN queued.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN', work_attempts = 0, block_reason = NULL, block_who = NULL, blocked_at = NULL, block_nag_at = NULL WHERE id = ?1").bind(porterId).run();
    await env.WP_OS_DB.prepare("DELETE FROM work_card_notice WHERE work_card_id = ?1 AND kind IN ('STUCK', 'QUESTION') AND cause LIKE '%a word from you%'").bind(porterId).run();
    const back = await tickFor(porterId);
    expect(back.summary).toMatch(/PLAN queued/);
  });

  it("nothing to ask + publish-ready → built without asking: no plan email, BUILD parked, the card says why; green stops at ONE preview email, his \"approved\" lands it, then DONE", async () => {
    const before = sent.length;
    await macReports(porterId, { phase: "PLAN", status: "ok", accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }], document: "# Plan: Sensori photo swap\n\nReplace sites/ventures/assets/img/portfolio/sensori-founders.jpg with the attachment; same dimensions.", decided: ["same file name and dimensions, so no markup change"], asks: [], publish_ready: true, placeholders: [] });
    const out = await tickFor(porterId);
    expect(out.outcome, "no block").toBe("PROGRESSED");
    expect(out.summary).toMatch(/nothing to ask; BUILD queued/);
    const row = (await readWebPropertyChange(env, porterId))!;
    expect(row.plan_approved_by).toMatch(/no partner decisions in this change; built without asking/);
    expect(String((await card(porterId)).description)).toMatch(/No partner decisions in this change; built without asking/);
    expect(String((await card(porterId)).description), "the finding says where it stops").toMatch(/On green it stops at a preview link; it lands when the partner approves the preview/);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER), "no plan email").toHaveLength(0);
    // His two asks reached Porter's card with his email (27 Nov 2026: the door's hand-off no longer strands them on the
    // closed chief card), so the build's ledger marks each in his words, and the DONE reply goes only once both are.
    await macReports(porterId, { phase: "BUILD", status: "ok", items: [{ item: "Swap the Sensori founders photo on westpeek.ventures for the one attached.", state: "done", done_when: [{ check: "it works on the preview", met: true }] }, { item: "Same spot, same size.", state: "done", done_when: [{ check: "same file name and dimensions on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/51", pr_number: 51, check_state: "GREEN", proof: "validate green · shots" });
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
    const asks = (await env.WP_OS_DB.prepare("SELECT words FROM partner_ask WHERE work_card_id = ?1 ORDER BY seq").bind(porterId).all<{ words: string }>()).results!.map((a) => a.words);
    expect(asks, "his asks are on the card doing the work, not the chief's closed card").toEqual(["Swap the Sensori founders photo on westpeek.ventures for the one attached.", "Same spot, same size."]);
    // The seat's marking read (tests/doneMarksEveryBuild.test.ts proves it from the build ledger) has no seat here: its
    // marks are written as it would write them, so this test keeps proving the email count of the DONE itself.
    await env.WP_OS_DB.prepare("UPDATE partner_ask SET status = 'DONE', why = 'built and live on westpeek.ventures' WHERE work_card_id = ?1").bind(porterId).run();
    expect((await tickFor(porterId)).outcome).toBe("DONE");
    // RECEIVED reached him before this window; since 0258 the DONE reply goes straight to him, so
    // since the BUILD began his inbox has had the preview and the finished email — no plan email.
    const done = sent.slice(before).filter((m) => m.to === SCOOTER);
    expect(done, "the preview, then the finished email; nothing else").toHaveLength(2);
    expect((await finishedEmailFor(porterId, SCOOTER, before)).subject, "the finished work reached him, nothing waits on her Home").toMatch(/: Live$/);
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
    expect(sent.filter((m) => m.to === SEQUOIA).pop()!.subject).toBe("ACTION REQUIRED: Porter: Hero photo rights B: Plan ready");
  });

  it("he asked to confirm the plan first: every ask recommended, and still the plan waits for his word (19 Nov 2026, wc_59ef2d40)", async () => {
    const chiefId = await openAssignmentCard(env, { subject: "quote tool", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `quote tool: westpeek.ventures. Flag any questions before turning an assumption into a fixed rule. Please confirm the plan and remaining gaps. package: https://drive.google.com/drive/folders/${FOLDER}quoteA`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "quote tool", how: "build", done_when: ["it works on the preview"] }], document: "# Plan: quote tool", decided: [], asks: [{ question: "Contingency on owner hours?", recommended: "Yes, as the brief's examples do." }], publish_ready: true, placeholders: [] });
    await tickFor(id);
    expect((await card(id)).state).toBe("BLOCKED");
    expect((await readWebPropertyChange(env, id))!.plan_approved_at, "never approved on his behalf").toBeNull();
    const released = await (await import("../src/worker/services/webPropertyChange")).releasePlansNobodyNeedsToAnswer(env);
    expect(released, "the sweep does not release it either").not.toContain(id);
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
    expect(toScooter.map((m) => m.subject.replace(/^(?:ACTION REQUIRED: )?Porter: .*: /, "")), "the question once, then the FYI once").toEqual(["Plan ready", "Going ahead"]);
    // The FYI is once per filing: another tick sends nothing more.
    await macReports(porter.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/77", pr_number: 77, check_state: "GREEN", preview_url: "https://p77.west-peek-ventures.pages.dev" });
    expect((await tickFor(porter.id)).outcome, "green still stops at the preview: the FYI is a plan approval, never a landing approval").toBe("BLOCKED");
    expect((await readWebPropertyChange(env, porter.id))!.land_approved_at).toBeNull();
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /Going ahead/.test(m.subject))).toHaveLength(1);
  });

  it("a 4 MB partner email (a real jpg attached) becomes Porter's card with request_text and one attachment row, not a Deck card", async () => {
    await closeOpenSiteCardsOf(SCOOTER); // his earlier card for this property is open; this is a NEW request (28 Sep 2026)
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
      "Anything needing a login, a payment, an account, a CAPTCHA, or a private page: do NOT attempt it, and do NOT block for it",
      "Never ask for a login",
      "A partner's ask is itself the approval to do the work",
      "The vault is checked first, and a missing key is never a block",
      "Production only through a RUNBOOK-named script; never a bare `wrangler deploy`; schema changes only through migrations in the deploy",
      "RUNBOOK_FORBIDS",
      "the photo you said was attached — nothing arrived",
      "A change with no partner decision returns `asks: []`",
    ]) {
      expect(prompt, `the prompt must say: ${line.slice(0, 50)}`).toContain(line);
    }
  });
});

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
    await closeOpenSiteCardsOf(SCOOTER); // a new request, not a follow-up on an open card (28 Sep 2026)
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
    expect(String((await card(porterId)).block_needed)).toMatch(/^Waiting on: the name of the site or repo this is for\. Why: the email named no site I know[\s\S]*To clear it by email: reply with the site \([^)]*westpeek\.ventures[^)]*\) or the GitHub repo as owner\/name/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(porterId).run();
  });

  it("a website request addressed to Walker stays with his session instead of entering the general loop", async () => {
    const chiefId = await openAssignmentCard(env, { subject: "Spot on the site", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Walker, please add a spot on westpeek.ventures for people to sign up", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const out = await workCard(env, { request: new Request("https://os.joinwestpeek.com/internal/test"), env, identity: sweepIdentity(), params: {} }, chiefId, { maxSteps: 2 });
    expect(out).toMatchObject({ finished: false, blocked: false, steps: [] });
    expect(await card(chiefId)).toMatchObject({ kind: "PARTNER_SESSION", owner_id: "aie_walker", state: "OPEN" });
    const browse = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM browser_task WHERE work_card_id = ?1").bind(chiefId).first<{ n: number }>();
    expect(browse!.n, "no browser task, no permission block").toBe(0);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(chiefId).run();
  });

  it("a partner's 'Re: <our subject>' reply answers the block and creates no card, even without our token", async () => {
    const chiefId = await openAssignmentCard(env, { subject: "Something Walker holds", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Walker, find me three podcast hosts who cover seed funds.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    // A general-loop card on Walker's desk (an emailed one is a partner session now, whose reply redirects the session:
    // tests/partnerSession.test.ts); this proves the block-answer door every other card takes.
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = NULL WHERE id = ?1").bind(chiefId).run();
    const { blockCard } = await import("../src/worker/services/blocks");
    await blockCard(env, { id: chiefId, title: "From scooter@westpeek.ventures: Something Walker holds", firm_scope: "west-peek" }, { reason: "permission_to_open_a_page", trying: "podcast hosts", employee: "Walker", url: "https://example.org" });
    const { replyToRequester } = await import("../src/worker/services/requestReply");
    const c0 = await card(chiefId);
    const reply = await replyToRequester(env, { id: chiefId, title: String(c0.title), requested_by_email: SCOOTER, firm_scope: "west-peek" }, "BLOCKED", "Walker", String(c0.block_needed));
    expect(reply.sent).toBe(true);
    const cardsBefore = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
    // The subject we sent is the one he replies to — "a question", never "blocked" (23 Sep 2026).
    expect(sent.at(-1)!.subject).toBe("ACTION REQUIRED: Walker: a question — Something Walker holds");
    const raw = SCOOTER_MIME({ subject: "Re: ACTION REQUIRED: Walker: a question — Something Walker holds", body: "Yes he can open.\n\nSent from my iPhone" });
    // The wire carries the subject RFC 2047-encoded (an em-dash is not a ByteString).
    await handleInboundEmail(inbound(raw, { subject: `=?UTF-8?B?${Buffer.from("Re: ACTION REQUIRED: Walker: a question — Something Walker holds").toString("base64")}?=` }), env);
    const cardsAfter = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
    expect(cardsAfter, "no new card for a reply").toBe(cardsBefore);
    const c = await card(chiefId);
    expect(c.state).toBe("OPEN");
    expect(String(c.block_answer)).toMatch(/^Yes he can open/);
    expect(c.block_answered_by).toBe("fu_scooter_taylor");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(chiefId).run();
  });

  it("a partner's long reply answers the block WHOLE: a 4,130-character brief keeps its last lines (14 Nov 2026)", async () => {
    /*
     * Scooter's "whole vision" reply to a Porter preview was 4,130 characters. The reply door cut it
     * at 4,000 before answerBlock saw it: block_answer and the note ended "we expan", his closing
     * question was gone, and a build started from the part.
     */
    const chiefId = await openAssignmentCard(env, { subject: "Something long Walker holds", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Walker, find me three podcast hosts who cover seed funds.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    await env.WP_OS_DB.prepare("UPDATE work_card SET kind = NULL WHERE id = ?1").bind(chiefId).run();
    const { blockCard } = await import("../src/worker/services/blocks");
    await blockCard(env, { id: chiefId, title: "From scooter@westpeek.ventures: Something long Walker holds", firm_scope: "west-peek" }, { reason: "permission_to_open_a_page", trying: "podcast hosts", employee: "Walker", url: "https://example.org" });
    const { replyToRequester } = await import("../src/worker/services/requestReply");
    const c0 = await card(chiefId);
    await replyToRequester(env, { id: chiefId, title: String(c0.title), requested_by_email: SCOOTER, firm_scope: "west-peek" }, "BLOCKED", "Walker", String(c0.block_needed));
    const subject = sent.at(-1)!.subject;
    const lines = Array.from({ length: 66 }, (_, i) => `${i + 1}. Point ${i + 1} of the brief, a full line of what he wants built.`);
    const body = `Hey Walker!\n\n${lines.join("\n")}\n\nWhen that works end to end with real data, we expand.\n\nWhat do you need from me to start?\n\nBest,\nScooter`;
    expect(body.length, "the fixture is past the old 4,000 cut").toBeGreaterThan(4100);
    await handleInboundEmail(inbound(SCOOTER_MIME({ subject: `Re: ${subject}`, body }), { subject: `=?UTF-8?B?${Buffer.from(`Re: ${subject}`).toString("base64")}?=` }), env);
    const c = await card(chiefId);
    expect(c.state).toBe("OPEN");
    expect(String(c.block_answer), "his closing question is on the card").toMatch(/we expand\.\s+What do you need from me to start\?/);
    expect(String(c.block_answer)).not.toMatch(/cut here/);
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 AND body LIKE 'You asked what to do.%' ORDER BY created_at DESC LIMIT 1").bind(chiefId).first<{ body: string }>();
    expect(String(note?.body), "and in the note the employee reads").toMatch(/What do you need from me to start\?/);
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
    expect(String(c1.block_answer), "what he WROTE, above the quote, and not the phone's footer").toBe("approved");
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
    await closeOpenSiteCardsOf(SCOOTER); // a new request, not a follow-up on an open card (28 Sep 2026)
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

  it("a re-read of a REPLY supersedes nothing — and a live card whose description merely mentions the subject is never cancelled (27 Sep 2026, learned in production)", async () => {
    // The live website card, blocked on a real question; its PLAN email out to Scooter.
    const porter = await planned(SCOOTER, "Walker", "supersede me not", { document: "# Plan", decided: [], asks: [{ question: "Which orange?" }], publish_ready: true, placeholders: [] });
    expect((await card(porter.id)).state).toBe("BLOCKED");
    const planSubject = sent.filter((m) => m.to === SCOOTER).at(-1)!.subject;
    // A merge bullet mentioning a stray intake's title, as services/mergeCards.ts writes one.
    await env.WP_OS_DB.prepare("UPDATE work_card SET description = description || char(10) || ?2 WHERE id = ?1")
      .bind(porter.id, `• Folded in card wc_stray ("From scooter@westpeek.ventures: ${planSubject}", done → cancelled) by Sequoia.`)
      .run();
    // His reply to the PLAN email, stored, then read through the door again.
    const key = `inbound-email/2026-09-27/${crypto.randomUUID()}.eml`;
    // Its own Message-ID: the fixture's fixed one was already kept by an earlier test, and a re-read is indexed by it.
    const raw = SCOOTER_MIME({ subject: `Re: ${planSubject}`, body: "All good. Yes will upload 4 and 5 for sure soon\n\nSent from my iPhone", image: true }).replace(/^Message-ID: .*$/m, `Message-ID: <${crypto.randomUUID()}@mail.gmail.com>`);
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(key, raw);
    const cardsBefore = (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n;
    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    const body = (await res.json()) as { superseded: string[]; steered_card: string | null; new_card: string | null; detail?: string };
    const events = (await env.WP_OS_DB.prepare("SELECT event_type, substr(payload_json, 1, 300) p FROM event_record WHERE event_type LIKE 'inbound_email.%' ORDER BY created_at DESC LIMIT 3").all<{ event_type: string; p: string }>()).results;
    expect(res.status, JSON.stringify({ body, events })).toBe(200);
    expect(body.superseded, "a reply supersedes nothing").toEqual([]);
    expect(body.steered_card).toBe(porter.id);
    expect(body.new_card).toBeNull();
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n).toBe(cardsBefore);
    const c = await card(porter.id);
    expect(c.state, "the card the reply is about is answered, never cancelled").toBe("OPEN");
    expect(String(c.block_answer)).toMatch(/^All good/);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM request_attachment WHERE work_card_id = ?1 AND source = 'REPLY'").bind(porter.id).first<{ n: number }>())!.n, "the reply's photo is on the card").toBe(1);
  });

  it("a re-read of a NEW message the door had mis-steered onto an older card never cancels that card (9 Oct 2026, learned in production)", async () => {
    // The westpeek.ventures spam fix, BLOCKED on Scooter's preview, opened the day before.
    const older = await planned(SCOOTER, "Walker", "spam fix waits on its preview", { document: "# Plan", decided: [], asks: [{ question: "Approve the preview?" }], publish_ready: true, placeholders: [] });
    await env.WP_OS_DB.prepare("UPDATE work_card SET created_at = '2026-10-08T19:32:38.429Z' WHERE id = ?1").bind(older.id).run();
    expect((await card(older.id)).state).toBe("BLOCKED");
    // Scooter's brand-new request, stored and indexed against the card it was wrongly steered onto.
    const key = `inbound-email/2026-10-09/${crypto.randomUUID()}.eml`;
    const raw = SCOOTER_MIME({ subject: "New site build: voting.topbarz.xyz/entry", body: "Hey!\n\nWe need a page at voting.topbarz.xyz/entry for the Top Barz contest. Keep it simple.", image: false }).replace(/^Message-ID: .*$/m, `Message-ID: <${crypto.randomUUID()}@mail.gmail.com>`);
    await (env.WP_OS_DOCUMENTS as unknown as { put: (k: string, b: string) => Promise<unknown> }).put(key, raw);
    await env.WP_OS_DB.prepare(
      "INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, work_card_id, firm_scope) VALUES (?1, ?2, ?3, ?4, 'os@joinwestpeek.com', 'New site build: voting.topbarz.xyz/entry', '2026-10-09T13:31:18.557Z', 1, '{}', ?5, 'west-peek')",
    )
      .bind(`inm_${crypto.randomUUID()}`, `${crypto.randomUUID()}@mail.gmail.com`, key, SCOOTER, older.id)
      .run();
    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: key }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: SEQUOIA, fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    });
    const body = (await res.json()) as { superseded: string[]; new_card: string | null };
    expect(body.superseded, "the card the message was steered onto is not one it opened").not.toContain(older.id);
    expect((await card(older.id)).state, "the spam fix still waits on its preview").toBe("BLOCKED");
    if (body.new_card) await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(body.new_card).run();
  });
});

describe("a partner's reply is permission to continue (owner, 27 Sep 2026)", () => {
  beforeAll(ageEarlierCards);
  const REAL_QUESTION = { document: "# Plan: colours", decided: ["Ventures first"], asks: [{ question: "Which orange, exactly?" }], publish_ready: true, placeholders: [] };
  const lastFinding = async (id: string) => String((await card(id)).description);

  it("PLAN: \"No problem, looks great\" approves the plan (it used to read as a refusal) — every recommendation taken, BUILD queued, read by the model once", async () => {
    const porter = await planned(SCOOTER, "Walker", "colours A", REAL_QUESTION);
    expect((await card(porter.id)).state).toBe("BLOCKED");
    intentCalls.length = 0;
    await replyFrom(SCOOTER, "No problem, looks great", await porter.token());
    const next = await tickFor(porter.id);
    expect(next.summary).toMatch(/Plan approved; BUILD queued/);
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.phase).toBe("BUILD");
    expect(row.plan_approved_by).toBe("fu_scooter_taylor");
    expect(JSON.parse(row.answers_json)).toEqual(["1. (no recommendation given) (approved as recommended)"]);
    expect(await lastFinding(porter.id)).toMatch(/their reply read as go ahead, every recommendation taken \(fake reader\): "No problem, looks great"/);
    expect(intentCalls, "free text is read once").toEqual(["No problem, looks great"]);
  });

  it("PLAN: a long email full of instructions (Scooter's shape) approves WITH the instructions carried to the build; the one-word reply is read by the model too", async () => {
    const porter = await planned(SCOOTER, "Walker", "colours B", REAL_QUESTION);
    const email = "Hey Hey!\n\nI went through both sites. Please lift the orange from #C45A3C to #E0632F on a white background and use the PDF palette's deep tones as section accents. Swap Darian and Shanna's photos back. Keep 'Join our community' going to Instagram.\n\nSent from my iPhone";
    intentCalls.length = 0;
    await replyFrom(SCOOTER, email, await porter.token());
    expect((await tickFor(porter.id)).summary).toMatch(/BUILD queued/);
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.plan_approved_at).toBeTruthy();
    expect(JSON.parse(row.answers_json).at(-1), "his instructions ride to the build").toMatch(/^Hey Hey!/);
    expect(await lastFinding(porter.id)).toMatch(/read as go ahead with instructions/);
    const job = JSON.parse((await liveJobFor(porter.id))!.job_json!) as { plan: { answers: string[] } };
    expect(job.plan.answers.at(-1)).toMatch(/lift the orange/);
    expect(intentCalls).toHaveLength(1);
    // No keyword fast path: "approved" on another card is read by the model first, once.
    const other = await planned(SCOOTER, "Walker", "colours B2", REAL_QUESTION);
    intentCalls.length = 0;
    await replyFrom(SCOOTER, "approved", await other.token());
    expect((await tickFor(other.id)).summary).toMatch(/BUILD queued/);
    expect(intentCalls, "the model reads the one word too").toEqual(["approved"]);
  });

  it("PLAN: \"hold off\" is the one thing that holds, read by the model; a stop said in more words holds too", async () => {
    const porter = await planned(SCOOTER, "Walker", "colours C", REAL_QUESTION);
    intentCalls.length = 0;
    await replyFrom(SCOOTER, "Hold off — I want to check the logos with Sequoia first", await porter.token());
    expect((await tickFor(porter.id)).outcome).toBe("BLOCKED");
    expect(intentCalls).toEqual(["Hold off — I want to check the logos with Sequoia first"]);
    const c = await card(porter.id);
    expect(String(c.block_needed)).toMatch(/^Waiting on: your word to carry on\. Why: you said "Hold off/);
    expect(String(c.block_needed)).toMatch(/nothing is built or landed until you say otherwise\. To clear it by email: reply "approved"/);
    expect((await readWebPropertyChange(env, porter.id))!.plan_approved_at).toBeNull();
    expect(await liveJobFor(porter.id)).toBeNull();
    // A stop in other words, read by the model.
    const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(porter.id).first<{ token: string }>())!.token;
    await replyFrom(SCOOTER, "Let's not do this yet, I want to think it over", token);
    expect((await tickFor(porter.id)).outcome).toBe("BLOCKED");
    expect(intentCalls).toEqual(["Hold off — I want to check the logos with Sequoia first", "Let's not do this yet, I want to think it over"]);
    expect((await readWebPropertyChange(env, porter.id))!.plan_approved_at).toBeNull();
  });

  it("PLAN: a question approves the plan on the recommendations AND is answered by Porter in his next email — the work never waits on it", async () => {
    const porter = await planned(SCOOTER, "Walker", "colours D", REAL_QUESTION);
    await replyFrom(SCOOTER, "Is #E0632F the final hex or a placeholder?", await porter.token());
    expect((await tickFor(porter.id)).summary).toMatch(/BUILD queued/);
    const row = (await readWebPropertyChange(env, porter.id))!;
    expect(row.plan_approved_at).toBeTruthy();
    expect(JSON.parse(row.answers_json)).toEqual(["1. (no recommendation given) (approved as recommended)"]);
    const finding = await lastFinding(porter.id);
    expect(finding).toMatch(/read as a question, every recommendation taken/);
    expect(finding).toMatch(/asked: "Is #E0632F the final hex or a placeholder\?" — answered by Porter/);
    const ev = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'work_card.question_answered_mid_flow' AND object_id = ?1").bind(porter.id).first<{ payload_json: string }>();
    expect(ev, "the answer is on the spine").not.toBeNull();
    expect(JSON.parse(ev!.payload_json)).toMatchObject({ confident: true });
  });

  /** A card at its preview: plan approved by the request (recommended ask), BUILD reported GREEN, the preview email out. */
  async function atPreview(subject: string): Promise<{ id: string; token: () => Promise<string>; planToken: string }> {
    const porter = await planned(SCOOTER, "Walker", subject, { document: "# Plan", decided: [], asks: [{ question: "Lift the orange to #E0632F?", recommended: "Yes, as described." }], publish_ready: true, placeholders: [] });
    const row0 = (await readWebPropertyChange(env, porter.id))!;
    expect(row0.plan_approved_by, "approved by the request").toMatch(/^request:/);
    const planToken = (await env.WP_OS_DB.prepare("SELECT message_id FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PLAN'").bind(porter.id).first<{ message_id: string }>())!.message_id;
    await macReports(porter.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: `https://github.com/seq23/join-west-peek-main/pull/${Math.floor(Math.random() * 9000) + 100}`, pr_number: 9, check_state: "GREEN", preview_url: "https://p9.west-peek-ventures.pages.dev" });
    expect((await tickFor(porter.id)).outcome).toBe("BLOCKED");
    expect(String((await card(porter.id)).block_needed)).toMatch(/^Waiting on: your word on the preview[\s\S]*Why: every site change previews before it goes live[\s\S]*To clear it by email: reply "approved"[\s\S]*PREVIEW READY\./);
    return { ...porter, planToken };
  }

  it("PREVIEW: a free-form positive reply with no changes LANDS it, the same as \"approved\" (her decision, 27 Sep 2026)", async () => {
    const p = await atPreview("preview A");
    await replyFrom(SCOOTER, "Looks great to me, this is exactly it", await p.token());
    const out = await tickFor(p.id);
    expect(out.summary).toMatch(/Landing approved after the preview; LAND queued/);
    const row = (await readWebPropertyChange(env, p.id))!;
    expect(row.land_approved_at).toBeTruthy();
    expect(row.land_approved_by).toBe("fu_scooter_taylor");
    expect(await lastFinding(p.id)).toMatch(/their reply read as go ahead \(fake reader\): "Looks great to me/);
  });

  it("PREVIEW: a positive reply WITH changes rebuilds with them and sends a fresh preview; the next positive reply of any wording lands", async () => {
    const p = await atPreview("preview B");
    await replyFrom(SCOOTER, "Looks good but make the hero photo the group shot", await p.token());
    const rebuild = await tickFor(p.id);
    expect(rebuild.summary).toMatch(/Changes after the preview; BUILD queued/);
    let row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent).toBe("CHANGES");
    expect(row.land_approved_at).toBeNull();
    expect(JSON.parse(row.answers_json).at(-1)).toMatch(/make the hero photo the group shot/);
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "moved-1737", check_state: "GREEN", preview_url: "https://p9b.west-peek-ventures.pages.dev" });
    expect((await tickFor(p.id)).outcome, "a fresh preview waits").toBe("BLOCKED");
    await replyFrom(SCOOTER, "Perfect, that's the one", await p.token());
    expect((await tickFor(p.id)).summary).toMatch(/LAND queued/);
    row = (await readWebPropertyChange(env, p.id))!;
    expect(row.land_approved_at).toBeTruthy();
  });

  it("PREVIEW: 'Hey Porter! Approved. Please publish … send the live links' approves the landing: his words are built and it lands on green, never a second preview to approve (19 Nov 2026, wc_c548d043)", async () => {
    const p = await atPreview("preview approved-with-words");
    const previews = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' AND sent = 1").bind(p.id).first<{ n: number }>())!.n;
    const before = await previews();
    await replyFrom(SCOOTER, "Hey Porter!\n\nApproved. Please publish the new site and the privacy pages, as directed in my last email. Keep Clarity off.\n\nPlease send the live links when complete.", await p.token());
    await tickFor(p.id);
    let row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent, "his words still reach the build").toBe("CHANGES");
    expect(row.rebuilt_for).toMatch(/send the live links/);
    expect(row.land_approved_at, "his approval is recorded at once").toBeTruthy();
    expect(row.land_approved_by).toBe("fu_scooter_taylor");
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "approved-1", check_state: "GREEN", preview_url: "https://p9a.west-peek-ventures.pages.dev" });
    expect((await tickFor(p.id)).summary, "green lands").toMatch(/landing is queued/);
    expect((await liveJobFor(p.id))?.purpose).toMatch(/LAND/);
    expect(await previews(), "no second preview email for a preview he approved").toBe(before);
    row = (await readWebPropertyChange(env, p.id))!;
    expect(row.phase).toBe("LAND");
  });

  it("PREVIEW: 'Approved. Please publish …' whose build the Mac never claimed builds his words when the Mac is back; the old build never lands (23 Nov 2026)", async () => {
    await ageEarlierCards(); // one more card in this block: keep the 20-an-hour loop limit for the cards after it
    const p = await atPreview("preview approved-mac-asleep");
    await replyFrom(SCOOTER, "Hey Porter!\n\nApproved. Please publish the new site and the privacy pages, as directed in my last email.\n\nPlease send the live links when complete.", await p.token());
    await tickFor(p.id);
    expect((await readWebPropertyChange(env, p.id))!.land_approved_at, "his approval rides with his words").toBeTruthy();
    const job = await liveJobFor(p.id);
    expect(JSON.parse(String(job!.job_json)).phase).toBe("BUILD");
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'ABANDONED', resolution = 'no machine claimed this run inside its 64800s queue ceiling' WHERE id = ?1").bind(job!.id).run();
    await tickFor(p.id);
    const asleep = await env.WP_OS_DB.prepare("SELECT state, blocked_at FROM work_card WHERE id = ?1").bind(p.id).first<{ state: string; blocked_at: string }>();
    expect(asleep?.state).toBe("BLOCKED");
    const b = new Date(Date.parse(String(asleep!.blocked_at)) + 86_400_000);
    const noon = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 18));
    await env.WP_OS_DB.prepare(
      `INSERT OR REPLACE INTO subscription_seat_device (seat, device_id, hostname, agent_version, last_seen_at, capabilities_json, first_seen_at)
       VALUES ('claude_code', 'dev_mac_wait_r', 'Sequoias-Mac', 'test', ?1, '[]', ?1)`,
    ).bind(new Date(noon.getTime() - 30_000).toISOString()).run();
    expect(await releaseMacAsleepBlocks(env, noon)).toContain(p.id);
    await tickFor(p.id);
    const again = await liveJobFor(p.id);
    expect(again, "a job is queued").not.toBeNull();
    const payload = JSON.parse(String(again!.job_json)) as { phase: string; rebuild: { changes: string } | null };
    expect(payload.phase, "his words are built first; the old build is never landed").toBe("BUILD");
    expect(payload.rebuild?.changes).toMatch(/send the live links/);
  });

  it("PREVIEW: words that change the site WITHOUT an opening approval still send a fresh preview, and a greeting alone never approves (19 Nov 2026)", async () => {
    const p = await atPreview("preview greeting-changes");
    await replyFrom(SCOOTER, "Hey Porter!\n\nPlease make the hero photo the group shot.", await p.token());
    await tickFor(p.id);
    const row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent).toBe("CHANGES");
    expect(row.land_approved_at, "changes alone land nothing").toBeNull();
  });

  it("PREVIEW: a change said while the rebuild is on the Mac is kept, and the finished build rebuilds for it with the first round; one preview carries both (15 Nov 2026, wc_c548d043)", async () => {
    const p = await atPreview("preview kept");
    const previews = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' AND sent = 1").bind(p.id).first<{ n: number }>())!.n;
    const before = await previews();
    await replyFrom(SCOOTER, "Please make the inquiry email easier to read on a phone", await p.token());
    expect((await tickFor(p.id)).summary).toMatch(/Changes after the preview; BUILD queued/);
    const first = (await liveJobFor(p.id))!;
    // His second reply lands while that build is on the Mac.
    await replyFrom(SCOOTER, "Please make the dashboard lists clearer, no side links", await p.token());
    await tickFor(p.id);
    const note = await env.WP_OS_DB.prepare("SELECT acknowledged_at, response FROM work_card_note WHERE work_card_id = ?1 AND body LIKE '%no side links%'").bind(p.id).first<{ acknowledged_at: string | null; response: string | null }>();
    expect(note?.acknowledged_at, "read, so the sweep does not spin on it").toBeTruthy();
    expect(note?.response, "kept for the next build, never 'rebuilding' and dropped").toBe(KEPT_FOR_NEXT_BUILD);
    expect((await liveJobFor(p.id))!.id, "the build on the Mac is left to finish").toBe(first.id);
    // The first round's build comes back green: it does NOT mail a preview that leaves his second reply out.
    const row = (await readWebPropertyChange(env, p.id))!;
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "kept-1", check_state: "GREEN", preview_url: "https://p9k.west-peek-ventures.pages.dev" });
    const after = await tickFor(p.id);
    expect(after.outcome, after.summary).not.toBe("BLOCKED");
    expect(after.summary).toMatch(/Changes after the preview; BUILD queued/);
    expect(await previews(), "no preview that leaves out his second reply").toBe(before);
    const job = JSON.parse((await liveJobFor(p.id))!.job_json!) as LocalJobPayload;
    expect(job.rebuild!.changes, "the second reply is this build's job").toMatch(/no side links/);
    expect(job.rebuild!.changes, "and the first round, never previewed, is still in it").toMatch(/inquiry email/);
    // That build goes green: exactly one fresh preview, and it names both rounds.
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "kept-2", check_state: "GREEN", preview_url: "https://p9k.west-peek-ventures.pages.dev" });
    expect((await tickFor(p.id)).outcome).toBe("BLOCKED");
    expect(await previews()).toBe(before + 1);
    const said = String((await card(p.id)).block_needed);
    expect(said).toMatch(/inquiry email/);
    expect(said).toMatch(/no side links/);
  });

  it("PREVIEW: changes asked WITH a question while the rebuild is queued are kept and built before any preview, never only an answer on the row (28 Nov 2026, wc_9f7312e4)", async () => {
    const p = await atPreview("preview queued question");
    const token = await p.token();
    const from = sent.length;
    await replyFrom(SCOOTER, "Please make the inquiry email subject read New inquiry", token);
    expect((await tickFor(p.id)).summary).toMatch(/Changes after the preview; BUILD queued/);
    const queued = (await liveJobFor(p.id))!;
    // His next reply asks a question AND gives changes while that BUILD is still queued (not claimed).
    await replyFrom(SCOOTER, "Please put the sign-up form at the top. Can the homepage go live on its own?", token);
    await tickFor(p.id);
    const note = await env.WP_OS_DB.prepare("SELECT acknowledged_at, response FROM work_card_note WHERE work_card_id = ?1 AND body LIKE '%sign-up form at the top%'").bind(p.id).first<{ acknowledged_at: string | null; response: string | null }>();
    expect(note?.acknowledged_at, "read, so the sweep does not spin on it").toBeTruthy();
    expect(note?.response, "kept for the next build, never 'carried into the build' the queued job will not build").toBe(KEPT_FOR_NEXT_BUILD);
    expect((await liveJobFor(p.id))!.id, "the queued build is left alone").toBe(queued.id);
    const row = (await readWebPropertyChange(env, p.id))!;
    const items = [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }];
    await macReports(p.id, { phase: "BUILD", status: "ok", items, pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "q-1", check_state: "GREEN", preview_url: "https://p9q.west-peek-ventures.pages.dev" });
    const out = await tickFor(p.id);
    expect(out.outcome, out.summary).not.toBe("BLOCKED");
    expect(out.summary).toMatch(/BUILD queued/);
    expect(sent.slice(from).filter((m) => m.to === SCOOTER && /preview ready/i.test(m.subject)), "no preview that leaves out his second reply").toHaveLength(0);
    const again = JSON.parse((await liveJobFor(p.id))!.job_json!) as LocalJobPayload;
    expect(again.rebuild!.changes, "his second reply is this build's job").toMatch(/sign-up form at the top/);
    expect(again.rebuild!.changes, "and the first round, never previewed, is still in it").toMatch(/New inquiry/);
  });

  it("ONE ROUND, EVERY REPLY (15 Nov 2026, wc_c548d043): replies while the rebuild is queued or on the Mac are all built before any preview, and the one preview marks every ask, whole", async () => {
    const p = await atPreview("preview round");
    const token = await p.token();
    // What the "Got it" stores for each email (partner_ask), recorded as already answered so the sweep sends no second one.
    let seq = 0;
    const asked = async (words: string) => {
      const m = `inm_round_${crypto.randomUUID()}`;
      await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, work_card_id, firm_scope) VALUES (?1, ?2, 'inbound/' || ?1 || '.eml', ?3, 'os@joinwestpeek.com', 'Re: preview', ?4, 10, ?5, 'west-peek')").bind(m, `<${m}@test>`, SCOOTER, new Date().toISOString(), p.id).run();
      await env.WP_OS_DB.prepare("INSERT INTO partner_understood (inbound_message_id, work_card_id, partner_email, state, firm_scope) VALUES (?1, ?2, ?3, 'SENT', 'west-peek')").bind(m, p.id, SCOOTER).run();
      await env.WP_OS_DB.prepare("INSERT INTO partner_ask (id, work_card_id, inbound_message_id, seq, words, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, 'west-peek')").bind(`pa_${crypto.randomUUID()}`, p.id, m, ++seq, words).run();
    };
    const previewsTo = (from: number) => sent.slice(from).filter((m) => m.to === SCOOTER && /preview/i.test(m.subject));
    const from = sent.length;
    await replyFrom(SCOOTER, "Please make the inquiry email subject read New inquiry", token);
    await asked("make the inquiry email subject read New inquiry");
    expect((await tickFor(p.id)).summary).toMatch(/Changes after the preview; BUILD queued/);
    // The second reply arrives while that BUILD is queued, the third once the Mac has taken it (#447 keeps both).
    await replyFrom(SCOOTER, "Please use labelled funnel lists on the dashboard", token);
    await asked("use labelled funnel lists on the dashboard");
    await tickFor(p.id);
    const run = (await liveJobFor(p.id))!;
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac-test-jobs', claimed_at = ?2, attempt_count = attempt_count + 1 WHERE id = ?1").bind(run.id, new Date().toISOString()).run();
    await new Promise((r) => setTimeout(r, 5));
    await replyFrom(SCOOTER, "Please put less on the screen", token);
    await asked("put less on the screen");
    await tickFor(p.id);
    const row = (await readWebPropertyChange(env, p.id))!;
    const items = [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }];
    expect((await reportRun(env, { runId: run.id, deviceId: "mac-test-jobs", outputText: JSON.stringify({ phase: "BUILD", status: "ok", items, pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "round-1", check_state: "GREEN", preview_url: "https://p9r.west-peek-ventures.pages.dev" }) })).accepted).toBe(true);
    const attemptsBefore = Number((await card(p.id)).work_attempts);
    const out = await tickFor(p.id);
    expect(out.outcome, "a build that missed a reply is not the round's reply").not.toBe("BLOCKED");
    expect(Number((await card(p.id)).work_attempts), "no attempt charged for the unfinished round").toBeLessThanOrEqual(attemptsBefore);
    expect(out.summary).toMatch(/BUILD queued/);
    expect(previewsTo(from), "no preview until a build has covered every reply").toHaveLength(0);
    const again = JSON.parse((await liveJobFor(p.id))!.job_json!) as LocalJobPayload;
    for (const w of [/New inquiry/, /labelled funnel lists/, /less on the screen/]) expect(again.rebuild!.changes).toMatch(w);
    await macReports(p.id, { phase: "BUILD", status: "ok", items, pr_url: row.pr_url, pr_number: 9, changed: true, head_sha: "round-2", check_state: "GREEN", preview_url: "https://p9r.west-peek-ventures.pages.dev" });
    expect((await tickFor(p.id)).outcome).toBe("BLOCKED");
    const mails = previewsTo(from);
    expect(mails, "one preview for the round").toHaveLength(1);
    for (const w of ["make the inquiry email subject read New inquiry", "use labelled funnel lists on the dashboard", "put less on the screen"]) expect(mails[0]!.text).toContain(`Done: "${w}"`);
  });

  it("PREVIEW: a remark about the site is a change to make — the rebuild carries it as THE job; a build that moved nothing is a failed attempt, never the same preview twice (28 Sep 2026)", async () => {
    const p = await atPreview("preview B2");
    const previews = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW'").bind(p.id).first<{ n: number }>())!.n;
    const before = await previews();
    await replyFrom(SCOOTER, "I don't know if people know they can scroll on the flyers to kinda make that thing", await p.token());
    expect((await tickFor(p.id)).summary).toMatch(/Changes after the preview; BUILD queued/);
    let row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent).toBe("CHANGES");
    expect(row.rebuilt_for, "his words are what the rebuild is for").toMatch(/scroll on the flyers/);
    // The Mac's job carries them as THIS RUN'S WHOLE JOB, not one answer among many.
    const job = JSON.parse((await liveJobFor(p.id))!.job_json!) as LocalJobPayload;
    expect(job.rebuild).toMatchObject({ intent: "CHANGES" });
    expect(job.rebuild!.changes).toMatch(/scroll on the flyers/);
    // The Mac verifies the old build, moves nothing, reports ok: a failed attempt, no email.
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: row.pr_url, pr_number: 9, check_state: "GREEN", preview_url: "https://p9b2.west-peek-ventures.pages.dev", changed: false, head_sha: "1a447a3" });
    const inert = await tickFor(p.id);
    expect(inert.outcome, inert.summary).not.toBe("BLOCKED");
    expect(inert.summary).toMatch(/BUILD moved nothing for the partner's request/);
    expect(await previews(), "no second copy of the same preview").toBe(before);
    expect((await readWebPropertyChange(env, p.id))!.refresh_intent, "the rebuild is still owed").toBe("CHANGES");
    expect(await lastFinding(p.id)).toMatch(/came back with no new commit on the branch/);
    // The next BUILD carries the same words; one that moves the branch is the fresh preview, and it says what changed in his words.
    expect((await tickFor(p.id)).summary).toMatch(/BUILD queued|BUILD is queued/);
    const again = JSON.parse((await liveJobFor(p.id))!.job_json!) as LocalJobPayload;
    expect(again.rebuild!.changes).toMatch(/scroll on the flyers/);
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: row.pr_url, pr_number: 9, check_state: "GREEN", preview_url: "https://p9b2.west-peek-ventures.pages.dev", changed: true, head_sha: "6f943e3" });
    expect((await tickFor(p.id)).outcome).toBe("BLOCKED");
    expect(await previews()).toBe(before + 1);
    const c = await card(p.id);
    expect(String(c.block_needed)).toMatch(/^Waiting on: your word on the preview[\s\S]*Why: every site change previews before it goes live[\s\S]*To clear it by email: reply "approved"[\s\S]*PREVIEW READY\./);
    expect(String(c.block_needed)).toMatch(/Changed since the last preview, as you asked: "I don't know if people know they can scroll on the flyers/);
    row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent).toBeNull();
    // A materials check afterwards ("preview") no longer claims that change.
    await replyFrom(SCOOTER, "preview", await p.token());
    await tickFor(p.id);
    expect((await readWebPropertyChange(env, p.id))!.rebuilt_for).toBeNull();
  });

  /**
   * 13 Nov 2026: "Do you have a link to the dashboard yet?" on a job's thread was answered "I don't know that one for
   * certain, so I've passed it to Sequoia" and "Nothing is being built for this", with the preview link on the card —
   * and nothing reached Sequoia but an in-app line. The card answers first; "passed" means an email to her.
   */
  it("PREVIEW: a question Porter is not sure of is answered from the card's own state, never 'passed to Sequoia' while the card has the answer", async () => {
    const q = await atPreview("preview Q1");
    const before = sent.length;
    await replyFrom(SCOOTER, "Do you know for certain where I can see it?", await q.token());
    expect((await tickFor(q.id)).outcome).toBe("BLOCKED");
    const link = String((await readWebPropertyChange(env, q.id))!.preview_url).match(/https:\/\/[^\s]+pages\.dev/)![0];
    expect(answererFacts?.join(" "), "the answerer is handed the card's state").toContain("The preview is at");
    const mails = sent.slice(before).filter((m) => m.to === SCOOTER && /answered/.test(m.subject));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("The preview is at");
    expect(mails[0]!.text).toContain(new URL(link).hostname.split(".").slice(-3).join("."));
    expect(mails[0]!.text).not.toMatch(/passed it to Sequoia|Nothing is being built for this/);
    expect(sent.slice(before).filter((m) => m.to === SEQUOIA), "nothing is sent to her: the card had the answer").toHaveLength(0);
    expect((await readWebPropertyChange(env, q.id))!.land_approved_at, "a question lands nothing").toBeNull();
  });

  it("PREVIEW: a question riding on changes is answered by email AND the rebuild is queued, never one without the other (18 Nov 2026)", async () => {
    const q = await atPreview("preview Q3");
    const before = sent.length;
    await replyFrom(SCOOTER, "Add the case studies below as written and send another preview. Please tell me what's needed on your side to point that domain at the new site. Don't publish until I reply.", await q.token());
    await tickFor(q.id);
    const answered = sent.slice(before).filter((m) => m.to === SCOOTER && /answered/.test(m.subject));
    expect(answered, "his question is answered by email").toHaveLength(1);
    expect(answered[0]!.text).toMatch(/point westpeekproductions\.com/);
    expect((await readWebPropertyChange(env, q.id))!.refresh_intent, "and his changes are rebuilt").toBe("CHANGES");
    expect((await readWebPropertyChange(env, q.id))!.land_approved_at, "nothing lands").toBeNull();
    // 19 Nov 2026, wc_76e6d7ff: the rebuild comes back refused by the v1.0 bar, so the card sits at the same preview
    // with no run in flight. It queues again; his question is never answered a second time.
    await macReports(q.id, { phase: "BUILD", status: "ok", changed: true, items: [{ item: "the case studies", state: "partial", done_when: [{ check: "case studies on the page", met: false }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/9", pr_number: 9, check_state: "GREEN", preview_url: "https://p9.west-peek-ventures.pages.dev" });
    await tickFor(q.id);
    await tickFor(q.id);
    expect(await liveJobFor(q.id), "the rebuild is queued again").not.toBeNull();
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /answered/.test(m.subject)), "one answer for the one reply").toHaveLength(1);
  });

  it("PREVIEW: 'what is needed to point the domain?' reaches the answerer with the confirmed live address (18 Nov 2026)", async () => {
    const q = await atPreview("preview Q4");
    await replyFrom(SCOOTER, "What's needed on your side to point the domain at the new site?", await q.token());
    await tickFor(q.id);
    expect(answererFacts?.join(" ")).toMatch(/goes live at westpeek\.ventures[^.]*already served by the site's own Cloudflare Pages project/);
    // A host the built-in list does not hold is never claimed as already pointed.
    expect(liveAddressLine({ property_host: "brand-new-site.example" })).toBeNull();
  });

  it("PLAN: when neither Porter nor the card has the answer, 'passed to Sequoia' is an email to her, once", async () => {
    const porter = await planned(SCOOTER, "Walker", "colours Q2", REAL_QUESTION);
    const before = sent.length;
    await replyFrom(SCOOTER, "Do we know for certain who owns the font licence?", await porter.token());
    await tickFor(porter.id);
    const mails = sent.slice(before);
    expect(mails.filter((m) => m.to === SCOOTER && /passed it to Sequoia/.test(m.text)), "he is told it was passed on").toHaveLength(1);
    const toHer = mails.filter((m) => m.to === SEQUOIA && /who owns the font licence/.test(m.text));
    expect(toHer, "and it really was: she gets his question by email").toHaveLength(1);
  });

  it("PREVIEW: a stop holds it; a question is answered and the preview stays up with nothing landed; the one switch turns free-form landing off", async () => {
    const p = await atPreview("preview C");
    await replyFrom(SCOOTER, "Let's not do this yet, I want to think it over", await p.token());
    expect((await tickFor(p.id)).outcome).toBe("BLOCKED");
    expect(String((await card(p.id)).block_needed)).toMatch(/^Waiting on: your word to carry on\. Why: you said "Let's not do this yet/);
    expect((await readWebPropertyChange(env, p.id))!.land_approved_at).toBeNull();
    expect(await liveJobFor(p.id)).toBeNull();

    const q = await atPreview("preview D");
    await replyFrom(SCOOTER, "Is the orange the final hex?", await q.token());
    const asked = await tickFor(q.id);
    expect(asked.outcome).toBe("BLOCKED");
    expect(await lastFinding(q.id)).toMatch(/asked a question; answered by email\. The same preview waits for a positive reply — nothing lands until then/);
    expect((await readWebPropertyChange(env, q.id))!.land_approved_at).toBeNull();
    expect(await liveJobFor(q.id), "nothing lands on a question").toBeNull();
    expect(await lastFinding(q.id)).toMatch(/asked: "Is the orange the final hex\?" — answered by Porter/);

    // THE SWITCH: off, a free-form go-ahead is noted and the preview waits for a keyword.
    await env.WP_OS_DB.prepare("INSERT OR REPLACE INTO work_kind_rule (kind, rule_key, label, value, editable, note, set_by) VALUES (?1, 'free_reply_lands_preview', 'Free-form reply lands the preview', 'off', 1, 'test', 'fu_sequoia_taylor')").bind(WEB_PROPERTY_CHANGE_KIND).run();
    try {
      const s = await atPreview("preview E");
      await replyFrom(SCOOTER, "Looks great to me, this is exactly it", await s.token());
      expect((await tickFor(s.id)).outcome).toBe("BLOCKED");
      expect((await readWebPropertyChange(env, s.id))!.land_approved_at).toBeNull();
      expect(await lastFinding(s.id)).toMatch(/read as go-ahead, but free_reply_lands_preview is off/);
      // The keyword still lands with the switch off.
      await replyFrom(SCOOTER, "approved", await s.token());
      expect((await tickFor(s.id)).summary).toMatch(/LAND queued/);
    } finally {
      await env.WP_OS_DB.prepare("DELETE FROM work_kind_rule WHERE kind = ?1 AND rule_key = 'free_reply_lands_preview'").bind(WEB_PROPERTY_CHANGE_KIND).run();
    }
  });

  it("a late \"approved\" on the PLAN thread, after the plan was approved and while the PREVIEW waits, lands NOTHING — recorded, acknowledged, the preview still waits for its own reply (the approval binds to the latest preview)", async () => {
    const p = await atPreview("late reply");
    const before = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>();
    const out = await replyFrom(SCOOTER, "approved", p.planToken);
    expect(out.steered).toBe(true);
    expect(out.answered, "not an answer to the preview's question").toBe(false);
    expect((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n).toBe(before!.n);
    const c = await card(p.id);
    expect(c.state, "back in the sweep's hands so the note is read; never an answer to the preview").toBe("OPEN");
    expect(c.block_answer, "never written as the answer to the preview's question").toBeNull();
    expect(String(c.description)).toMatch(/Scooter replied on the PLAN email thread while the card waits on its PREVIEW: "approved"\. Read as instructions for the build, never as approval of a preview it did not answer/);
    const note = await env.WP_OS_DB.prepare("SELECT body, acknowledged_at FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(p.id).first<{ body: string; acknowledged_at: string | null }>();
    expect(note!.body).toMatch(/^\(Reply on the earlier email thread; read as instructions, never as an approval of the preview\.\) approved$/);
    // The next tick reads the note, acknowledges it in words, and lands nothing.
    const tickOut = await tickFor(p.id);
    expect(tickOut.outcome).toBe("BLOCKED");
    const row = (await readWebPropertyChange(env, p.id))!;
    expect(row.land_approved_at).toBeNull();
    expect(row.phase).toBe("BUILD");
    expect(await liveJobFor(p.id)).toBeNull();
    const acked = await env.WP_OS_DB.prepare("SELECT response FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(p.id).first<{ response: string | null }>();
    expect(String(acked!.response)).toMatch(/this answered the plan email\. The preview still waits for your approval of it: reply to the preview email/);
    expect(String((await card(p.id)).description)).toMatch(/replied "approved" on the PLAN email thread after the plan was approved; the preview it did not answer still waits/);
    // Instructions in a late reply ARE applied: they rebuild the preview.
    await replyFrom(SCOOTER, "Also please swap the Darian and Shanna photos", p.planToken);
    const rebuilt = await tickFor(p.id);
    expect(rebuilt.summary).toMatch(/Changes after the preview; BUILD queued/);
    expect((await readWebPropertyChange(env, p.id))!.refresh_intent).toBe("CHANGES");
    expect((await readWebPropertyChange(env, p.id))!.land_approved_at).toBeNull();
    // And the reply to the PREVIEW email itself still lands it once the new preview is up.
    await macReports(p.id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: (await readWebPropertyChange(env, p.id))!.pr_url, pr_number: 9, changed: true, head_sha: "moved-1847", check_state: "GREEN", preview_url: "https://p9c.west-peek-ventures.pages.dev" });
    expect((await tickFor(p.id)).outcome).toBe("BLOCKED");
    await replyFrom(SCOOTER, "approved", await p.token());
    expect((await tickFor(p.id)).summary).toMatch(/Landing approved after the preview; LAND queued/);
  });
});

describe("STUCK is sent once, only when idle past the ceiling inside the window", () => {
  beforeAll(ageEarlierCards);
  it("the Mac sleeps mid-plan → the job goes back to the queue, no attempt is spent, no card is blocked; the partner hears ONCE that the Mac is asleep, never 'Blocked'", async () => {
    /*
     * THE NIGHT OF 27–28 SEP 2026, PINNED THE OTHER WAY ROUND. This used to assert that a run
     * closed as "went quiet" was a FAILED attempt and that the partner's one notice said
     * "Blocked". Her ruling after that night: a sleeping Mac is a wait, never a failure and never a
     * block — the job waits and is tried again when the Mac wakes, the card spends nothing, and the
     * partner is told once, in those words, with the owner of the Mac named as who can wake it.
     */
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = '00-24' WHERE kind = ?1 AND rule_key = 'stuck_window_ct'").bind(WEB_PROPERTY_CHANGE_KIND).run();
    const before = sent.length;
    const chiefId = await openAssignmentCard(env, { subject: "stuck test", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Change the footer on westpeek.ventures.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id); // PLAN parked
    const attemptsBefore = Number((await card(id)).work_attempts ?? 0);
    // The Mac claimed it in a five-second Power Nap blip and slept again: the pulse stops.
    const run = (await liveJobFor(id))!;
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2, attempt_count = 1 WHERE id = ?1")
      .bind(run.id, new Date(Date.now() - JOB_SILENCE_MS - 60_000).toISOString())
      .run();
    const reaped = await reapSeatRuns(env, new Date());
    expect(reaped.returnedToPool, "silence is a nap: back to the queue, not the grave").toContain(run.id);
    expect(reaped.abandoned).not.toContain(run.id);
    const napped = (await readRun(env, run.id))!;
    expect(napped.status).toBe("QUEUED");
    expect(napped.claimed_by).toBeNull();
    expect(napped.resolution).toMatch(/waits for the Mac to wake/);
    // The sweep sees a card with a live (queued) job and leaves it alone — no tick is spent on it at
    // all, which is why `tickFor` would never reach it. Run the card's own step directly: it holds.
    const retry = await runWebPropertyChangeCard(env, { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    expect(retry.held, "a nap is not a failed attempt: the card is held for the same job").toBe(true);
    expect(retry.progressed).toBe(true);
    expect(retry.blocked).toBe(false);
    expect((await card(id)).state).not.toBe("BLOCKED");
    expect(Number((await card(id)).work_attempts ?? 0), "no attempt spent on a sleeping Mac").toBe(attemptsBefore);
    expect((await liveJobFor(id))!.id, "the same job, not a second one").toBe(run.id);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /: Blocked$/.test(m.subject)), "nothing says Blocked").toHaveLength(0);
    // The Mac stays asleep through its own day (noon Central); 46 minutes pass. The partner hears once, in the right words.
    const noon = new Date(Date.now() + 86_400_000);
    noon.setUTCHours(18, 0, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"], now: noon });
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(run.id, new Date(noon.getTime() - 46 * 60_000).toISOString()).run();
    const held = await runWebPropertyChangeCard(env, { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    expect(held.held).toBe(true);
    const asleep = sent.slice(before).filter((m) => m.to === SCOOTER && /: Waiting for the Mac$/.test(m.subject));
    expect(asleep).toHaveLength(1);
    expect(asleep[0]!.text).toMatch(/^\*\*TL;DR:\*\* Not started yet: the lane I build on \(Sequoia's Mac\) is asleep\./);
    expect(asleep[0]!.text).toMatch(/went to sleep part-way through the plan/);
    expect(asleep[0]!.text).toMatch(/tell Sequoia to open the Mac/);
    expect(asleep[0]!.text).not.toMatch(/Blocked/);
    await runWebPropertyChangeCard(env, { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /: Waiting for the Mac$/.test(m.subject)), "the same cause never emails twice").toHaveLength(1);
    expect(sent.slice(before).filter((m) => m.to === SCOOTER && /: Blocked$/.test(m.subject)), "still nothing says Blocked").toHaveLength(0);
    const kinds = (await env.WP_OS_DB.prepare("SELECT kind FROM work_card_notice WHERE work_card_id = ?1 ORDER BY sent_at").bind(id).all<{ kind: string }>()).results!.map((n) => n.kind);
    expect(kinds).toEqual(["RECEIVED", "STUCK"]);
    vi.useRealTimers();
    await env.WP_OS_DB.prepare("UPDATE work_kind_rule SET value = '06-22' WHERE kind = ?1 AND rule_key = 'stuck_window_ct'").bind(WEB_PROPERTY_CHANGE_KIND).run();
  });

  it("a build queued after the Mac's day survives the night: the partner hears once, in the true hours, and a pre-#572 twelve-hour ceiling does not close it before 10:00", async () => {
    /*
     * 22 Nov 2026 (#572): the claimer takes work only between 10:00 and 21:59 Central. A build queued at 21:30 sits
     * until 10:00. The partner must not hear "the Mac is asleep" (it is closed on purpose), must hear the real hours
     * once, and a job that still carries the old twelve-hour ceiling must not be closed at 09:30, before the Mac opens.
     */
    const before = sent.length;
    const chiefId = await openAssignmentCard(env, { subject: "night test", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Change the header on westpeek.ventures.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id); // PLAN parked
    const run = (await liveJobFor(id))!;
    // 21:30 Central on a January evening (CST, so the hours below are exact): queued just before the Mac closes,
    // carrying the twelve hours every job had before #572.
    const queued = new Date("2030-01-15T03:30:00.000Z");
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2, job_json = json_set(job_json, '$.queue_max_seconds', 43200) WHERE id = ?1").bind(run.id, queued.toISOString()).run();
    const step = () => runWebPropertyChangeCard(env, { id, title: "t", kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER });
    const toScooter = () => sent.slice(before).filter((m) => m.to === SCOOTER && /: Waiting for the Mac$/.test(m.subject));
    try {
      // 23:00 Central: outside the partner-email window, so nothing is said at night.
      vi.useFakeTimers({ toFake: ["Date"], now: new Date(queued.getTime() + 90 * 60_000) });
      expect((await step()).held).toBe(true);
      expect(toScooter(), "no email to a partner at 23:00").toHaveLength(0);
      // 06:30 Central the next morning: the window is open, the Mac's day is not. Said once, in the true hours.
      vi.setSystemTime(new Date(queued.getTime() + 9 * 3600_000));
      expect((await step()).held).toBe(true);
      await step();
      const told = toScooter();
      expect(told, "said once").toHaveLength(1);
      expect(told[0]!.text).toContain(`takes work ${macDayWords()}`);
      expect(told[0]!.text).not.toMatch(/is asleep/);
      expect(told[0]!.text).not.toMatch(/tell Sequoia to open the Mac/);
      // 09:45 Central, 12h15m after queueing (before the Mac opens): its own twelve hours would have closed it. Today's floor holds.
      const morning = new Date(queued.getTime() + 12.25 * 3600_000);
      expect(macDayOpen(morning), "the Mac's day is still closed").toBe(false);
      const reaped = await reapSeatRuns(env, morning);
      expect(reaped.abandoned, "never closed through the closed hours").not.toContain(run.id);
      expect((await readRun(env, run.id))!.status).toBe("QUEUED");
      expect((await card(id)).state).not.toBe("BLOCKED");
      // Twenty minutes into the Mac's day it has not been idle "45 minutes": no second notice yet.
      vi.setSystemTime(new Date(queued.getTime() + 12 * 3600_000 + 50 * 60_000)); // 10:20 Central
      expect(macDayOpen(new Date())).toBe(true);
      await step();
      expect(toScooter(), "idle counts from the opening at 10:00, not from 21:30").toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the window is Central hours", () => {
    expect(stuckWindowOpen("06-22", new Date("2026-09-21T17:00:00Z"))).toBe(true); // 12:00 CDT
    expect(stuckWindowOpen("06-22", new Date("2026-09-21T08:00:00Z"))).toBe(false); // 03:00 CDT
    expect(stuckWindowOpen("00-24", new Date("2026-09-21T08:00:00Z"))).toBe(true);
  });
});

describe("the reaper judges a job by its pulse and its ceiling", () => {
  it("a claimed job silent past JOB_SILENCE_MS goes back to the queue with the sleeping-Mac words and no attempt; a pinging one is left alone; a queued job waits for the Mac; a job that keeps napping is closed", async () => {
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
    const silentCreated = (await readRun(env, silent))!.created_at;

    const out = await reapSeatRuns(env, now);
    // SILENCE IS A NAP (28 Sep 2026): the same row goes back to QUEUED, the claim is cleared, the
    // words say why, and `created_at` still bounds the whole wait by the queue ceiling.
    expect(out.returnedToPool).toContain(silent);
    expect(out.abandoned).not.toContain(silent);
    const nap = (await readRun(env, silent))!;
    expect(nap.status).toBe("QUEUED");
    expect(nap.claimed_by).toBeNull();
    expect(nap.claimed_at).toBeNull();
    expect(nap.progressed_at).toBeNull();
    expect(nap.resolution).toMatch(/went quiet/);
    expect(nap.resolution).toMatch(/waits for the Mac to wake/);
    expect(nap.resolution).toMatch(/no attempt was spent/);
    expect(nap.created_at, "the wait is still bounded from the first parking").toBe(silentCreated);
    expect((await readRun(env, alive))!.status).toBe("CLAIMED");
    expect((await readRun(env, waiting))!.status, "a job waits for the Mac past the answer queue's ten minutes").toBe("QUEUED");
    expect((await readRun(env, answer))!.status, "0187's answer rule is unchanged").toBe("QUEUED");
    expect(out.returnedToPool).toContain(answer);

    // The Mac wakes, claims it again, and sleeps again — five more times. The sixth nap closes it:
    // something other than sleep is stopping this job, and a queue that retries for ever is inert.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2, attempt_count = ?3 WHERE id = ?1")
      .bind(silent, claimedAt, MAX_JOB_NAPS - 1)
      .run();
    const fifth = await reapSeatRuns(env, now);
    expect(fifth.returnedToPool, "under the cap it still naps").toContain(silent);
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac', claimed_at = ?2, attempt_count = ?3 WHERE id = ?1")
      .bind(silent, claimedAt, MAX_JOB_NAPS)
      .run();
    const sixth = await reapSeatRuns(env, now);
    expect(sixth.abandoned, "at the cap it is closed").toContain(silent);
    expect((await readRun(env, silent))!.status).toBe("ABANDONED");
    expect((await readRun(env, silent))!.resolution).toMatch(/closed rather than offered again/);
    expect((await readRun(env, silent))!.resolution).not.toMatch(/waits for the Mac to wake/);

    // Its own twelve hours (a job parked before #572) never closes it inside the Mac's night: today's floor holds.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(waiting, new Date(now.getTime() - 13 * 3600_000).toISOString()).run();
    expect((await reapSeatRuns(env, now)).abandoned).not.toContain(waiting);
    // Past the ceiling, a queued job is closed with the reason.
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET created_at = ?2 WHERE id = ?1").bind(waiting, new Date(now.getTime() - 19 * 3600_000).toISOString()).run();
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

/*
 * #605 (27 Nov 2026, wc_9f7312e4): Scooter corrected the homepage top while the PLAN was on the Mac, and changed the
 * Give and Take brief while the first BUILD was. The plan went out as "Going ahead" with the top he had corrected, and
 * the build ran without his change: both replies sat on the row as answers no running job reads.
 */
describe("a reply while a job is on the Mac is built in, never sent past (27 Nov 2026, #605)", () => {
  // Every card earlier tests left open would be swept first; these two are the only ones in play.
  beforeAll(() => env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED', lease_until = NULL WHERE state NOT IN ('DONE', 'CANCELLED')").run());
  const PLAN_REPORT = (document: string) => ({ phase: "PLAN", status: "ok", accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }], document, decided: [], asks: [{ question: "Tint the six tiles?", recommended: "Yes, light tints." }], publish_ready: true, placeholders: [] });
  const claim = async (runId: string) => env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac-test-jobs', claimed_at = ?2, attempt_count = attempt_count + 1 WHERE id = ?1").bind(runId, new Date().toISOString()).run();
  const goingAhead = (id: string) => env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PLAN' AND sent = 1").bind(id).first<{ n: number }>().then((r) => r!.n);
  const previews = (id: string) => env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' AND sent = 1").bind(id).first<{ n: number }>().then((r) => r!.n);
  const threadOf = async (id: string) => (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token;

  it("PLAN: his reply while the plan is on the Mac is planned in — no 'Going ahead', no BUILD from the plan that missed it; the plan written again goes ahead once, carrying it", async () => {
    const subject = "community redesign replan";
    const chiefId = await openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `${subject}: westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}replan`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id); // parks PLAN
    const plan1 = (await liveJobFor(id))!;
    expect(JSON.parse(plan1.job_json!).phase).toBe("PLAN");
    await claim(plan1.id);
    await new Promise((r) => setTimeout(r, 5));
    await replyFrom(SCOOTER, "One correction to the homepage top: a single rotating line under the wordmark, not a tagline plus a separate line.", await threadOf(id));
    expect((await reportRun(env, { runId: plan1.id, deviceId: "mac-test-jobs", outputText: JSON.stringify(PLAN_REPORT("# Plan\n\nHero: a tagline plus a separate line.")) })).accepted).toBe(true);
    const out = await tickFor(id);
    expect(out.summary).toMatch(/PLAN queued again/);
    expect(await goingAhead(id), "no 'Going ahead' with the plan he had already corrected").toBe(0);
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.phase).toBe("PLAN");
    expect(row.plan_approved_at, "nothing approved from the plan that missed his reply").toBeNull();
    expect(row.plan_filed_at, "the stale plan is not filed").toBeNull();
    expect(JSON.parse(row.answers_json), "no recommendation taken as his answer").toEqual([expect.stringMatching(/single rotating line/)]);
    const plan2 = (await liveJobFor(id))!;
    expect(plan2.id).not.toBe(plan1.id);
    const job = JSON.parse(plan2.job_json!) as LocalJobPayload;
    expect(job.phase).toBe("PLAN");
    expect(String(job.request), "the plan written again reads his reply beside his request").toContain(HIS_REPLIES_SINCE);
    expect(String(job.request)).toMatch(/--- reply 1 ---\n[\s\S]*single rotating line/);
    const note = await env.WP_OS_DB.prepare("SELECT acknowledged_at, response FROM work_card_note WHERE work_card_id = ?1 AND body LIKE '%single rotating line%'").bind(id).first<{ acknowledged_at: string | null; response: string | null }>();
    expect(note?.acknowledged_at).toBeTruthy();
    expect(note?.response).toBe(REPLANNED_WITH_REPLY);
    expect(String((await card(id)).description)).toMatch(/wrote a reply while it was being written[\s\S]*Nothing was mailed, approved or built from the plan that missed it/);
    expect(Number((await card(id)).work_attempts ?? 0), "an overtaken plan is not a spent attempt").toBeLessThanOrEqual(1);
    // The plan written with his reply: approved by the request as before, ONE "Going ahead", BUILD carries his words.
    await macReports(id, PLAN_REPORT("# Plan\n\nHero: one rotating line under the wordmark."));
    expect((await tickFor(id)).summary).toMatch(/BUILD queued/);
    expect(await goingAhead(id)).toBe(1);
    const built = (await readWebPropertyChange(env, id))!;
    expect(built.phase).toBe("BUILD");
    expect(built.plan_text).toMatch(/one rotating line/);
    const build = JSON.parse((await liveJobFor(id))!.job_json!) as { plan: { answers: string[] } };
    expect(build.plan.answers[0]).toMatch(/single rotating line/);
  });

  it("BUILD: his change while the FIRST build is on the Mac is kept; that build rebuilds for it before any preview, and one preview carries it", async () => {
    const p = await planned(SCOOTER, "Walker", "first build kept", { document: "# Plan", decided: [], asks: [{ question: "Tint the six tiles?", recommended: "Yes, light tints." }], publish_ready: true, placeholders: [] });
    const first = (await liveJobFor(p.id))!;
    expect(JSON.parse(first.job_json!).phase).toBe("BUILD");
    await claim(first.id);
    const before = await previews(p.id);
    await replyFrom(SCOOTER, "One change before you go further. Please make sure a Give and Take ask adds nobody to the network list.", await p.token());
    await tickFor(p.id);
    const note = await env.WP_OS_DB.prepare("SELECT acknowledged_at, response FROM work_card_note WHERE work_card_id = ?1 AND body LIKE '%network list%'").bind(p.id).first<{ acknowledged_at: string | null; response: string | null }>();
    expect(note?.acknowledged_at, "read, so the sweep does not spin on it").toBeTruthy();
    expect(note?.response, "kept for the next build, never carried as an answer the running build cannot read").toBe(KEPT_FOR_NEXT_BUILD);
    expect((await liveJobFor(p.id))!.id, "the build on the Mac is left to finish").toBe(first.id);
    const green = (sha: string) => ({ phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/605", pr_number: 605, changed: true, head_sha: sha, check_state: "GREEN", preview_url: "https://p605.west-peek-ventures.pages.dev" });
    expect((await reportRun(env, { runId: first.id, deviceId: "mac-test-jobs", outputText: JSON.stringify(green("first-1")) })).accepted).toBe(true);
    const after = await tickFor(p.id);
    expect(after.outcome, after.summary).not.toBe("BLOCKED");
    expect(await previews(p.id), "no preview that leaves his change out").toBe(before);
    const job = JSON.parse((await liveJobFor(p.id))!.job_json!) as LocalJobPayload;
    expect(job.rebuild!.changes, "his change is this build's job").toMatch(/network list/);
    await macReports(p.id, green("first-2"));
    expect((await tickFor(p.id)).outcome).toBe("BLOCKED");
    expect(await previews(p.id)).toBe(before + 1);
    expect(String((await card(p.id)).block_needed)).toMatch(/network list/);
  });
});
