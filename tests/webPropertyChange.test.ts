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
import { parseWebPropertyAsk, isWebPropertyChange, driveFolderLinks, addresseeIn, sitesOf, readWebPropertyAsk as readWebPropertyAskFromJson } from "../src/shared/intake/webPropertyChange";
import { parseBlogAsk } from "../src/shared/intake/blogHelp";
import { workCard } from "../src/worker/services/employeeWork";
import { sweepIdentity } from "../src/worker/services/workSweep";
import { preApprovalIn } from "../src/shared/work/approvalReply";
import { readLocalJobReport, WEB_PROPERTY_CHANGE_KIND } from "../src/shared/work/localJobs";
import { KEPT_FOR_NEXT_BUILD, MAC_ASLEEP_TRIES, releaseMacAsleepBlocks, blockedEmailDetail, finishOriginalAsk, missingSecretsOf, needsPreview, parkPhase, phaseModel, readWebPropertyChange, rulesFor, runWebPropertyChangeCard, type WebPropertyChangeRow } from "../src/worker/services/webPropertyChange";
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
 * and helpers are repeated verbatim in each). Siblings: webPropertyChangeRules.test.ts, webPropertyChangeReplies.test.ts.
 */

/*
 * 20 Nov 2026 (inm_83acfab5): Scooter's "Change westpeekproductions.com: Homepage headline copy" said "nothing
 * changes on the live site until I approve", and the plain words "the live site" outranked the host he wrote:
 * Porter's card was titled "Change westpeek.live". "Live" is production, never the property.
 */
const PRODUCTIONS_SUBJECT = "Change westpeekproductions.com: Homepage headline copy";
const PRODUCTIONS_BODY = `Hey Porter!

One small copy change, this one on the live homepage. Same rule as always:
show me on the preview first, nothing changes on the live site until I
approve.

On the homepage, right after the service cards (Live events, Annual
reports, Program stories) and just before Capabilities, there is a headline
with a line under it.

Best,
Scooter`;

describe("the property comes from the address he wrote, never from the word 'live'", () => {
  it("Scooter's 20 Nov email resolves to westpeekproductions.com", () => {
    const ask = parseWebPropertyAsk(PRODUCTIONS_SUBJECT, PRODUCTIONS_BODY)!;
    expect(ask.property_host).toBe("westpeekproductions.com");
    expect(ask.target_repo).toBe("join-west-peek-main");
    expect(ask.site).toBe("sites/productions");
    expect(ask.parts).toBeUndefined();
  });

  it("'the live site', 'go live' and 'live homepage' alone never name westpeek.live", () => {
    for (const body of ["Please fix the typo on the live site.", "Can this go live tomorrow?", "Swap the headline on the live homepage.", "Update the live website footer."]) {
      const ask = parseWebPropertyAsk("small fix", body);
      expect(ask?.property_host ?? null, body).not.toBe("westpeek.live");
      expect(ask?.target_repo ?? null, body).not.toBe("westpeek-live");
    }
  });

  it("an email that really names westpeek.live still goes there", () => {
    expect(parseWebPropertyAsk("Change westpeek.live: event page", "Please add the Fall Summit banner.")!.property_host).toBe("westpeek.live");
    expect(parseWebPropertyAsk("events", "Add the Fall Summit to westpeek.live, it should go live on Monday.")!.property_host).toBe("westpeek.live");
    expect(parseWebPropertyAsk("events", "On westpeek live, add the Fall Summit banner.")!.target_repo).toBe("westpeek-live");
  });

  it("when the subject's address and the body's words disagree, the address wins and the disagreement is kept", () => {
    const ask = parseWebPropertyAsk("Change westpeekproductions.com: footer", "Hey Porter, the community site footer link should match.")!;
    expect(ask.property_host).toBe("westpeekproductions.com");
    expect(ask.property_conflict).toMatch(/westpeekproductions\.com.*joinwestpeek\.com/);
    expect(readWebPropertyAskFromJson(JSON.stringify(ask))?.property_conflict, "the log survives the round trip").toBe(ask.property_conflict);
    expect(parseWebPropertyAsk("Change westpeekproductions.com: footer", "Fix the footer.")!.property_conflict, "no disagreement, nothing logged").toBeUndefined();
  });

  it("through the door: Walker hands it to Porter titled for westpeekproductions.com, and the title and request agree", async () => {
    const chiefId = await openAssignmentCard(env, { subject: PRODUCTIONS_SUBJECT, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: PRODUCTIONS_BODY, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const porterId = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    const porter = await card(porterId);
    expect(String(porter.title)).toMatch(/^Change westpeekproductions\.com:/);
    expect(JSON.parse(String(porter.request_json)).property_host).toBe("westpeekproductions.com");
    expect((await readWebPropertyChange(env, porterId))?.property_host).toBe("westpeekproductions.com");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(porterId).run();
  });
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

  it("a folder with no property stays an ordinary assignment (a partner session, never a site job), with the link recorded", async () => {
    const id = await openAssignmentCard(env, { subject: "look at this", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: `here: https://drive.google.com/drive/folders/${FOLDER}x\nthoughts?`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const c = await card(id);
    expect(c.kind).toBe("PARTNER_SESSION");
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
    expect((await sweepOnce(env, nextTickTime(), RUNNERS)).card?.id).not.toBe(porterCardId);
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
        accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }],
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
    expect(email!.subject).toBe("ACTION REQUIRED: Porter: Ventures site update: Plan ready");
    expect(email!.subject).not.toMatch(/blocked/i);
    expect(email!.text).toMatch(/^\*\*TL;DR:\*\* \*\*Reply "approved" and I\'ll build the preview now, or "changes: …" with what to change first\.\*\* If I don\'t hear back, nothing goes live, it stays where it is, and I\'ll ask again in a couple of days\. Plan ready\. Nothing goes live until you approve the preview\.\n• \*\*approved\*\*: take my 2 recommendations and build the preview\n• \*\*approved to production\*\*: skip the preview and land on green\n• \*\*changes: …\*\*: hold it and tell me what to change\n• anything else: read as your answers to the decisions below\n/);
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
    // 0253: every wait is three parts — what, why, and the exact reply that clears it — from one template.
    expect(String(c.block_needed)).toMatch(/^Waiting on: your word to carry on\. Why: you said "[^"]+", so nothing is built or landed until you say otherwise\. To clear it by email: reply "approved" to carry on, "changes: <what to change>" to re-plan, or "drop it" to close it\./);
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
    // Every phase writes, decides or merges: Opus (owner, 5 Nov 2026).
    expect(payload.model).toBe("opus");
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
    await macReports(porterCardId, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/14", pr_number: 14, branch: "work/wpc-abc12345", check_state: "RED", check_url: "https://github.com/seq23/join-west-peek-main/actions/runs/1", proof: "validate: 2 failed", reason: "validate:disclosure failed" });
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
    await macReports(porterCardId, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/15", pr_number: 15, branch: "work/wpc-abc12345-fix", check_state: "GREEN", check_url: "https://github.com/seq23/join-west-peek-main/actions/runs/2", proof: "npm run validate: green · shots/team-desktop.png shots/team-390.png · curl https://example.org 200" });
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
    expect(String((await card(porterCardId)).block_needed)).toMatch(/^Waiting on: your word on the preview[\s\S]*Why: every site change previews before it goes live[\s\S]*To clear it by email: reply "approved"[\s\S]*PREVIEW READY\./);
    const c0 = await card(porterCardId);
    const gate = await parkPhase(env, { id: porterCardId, title: String(c0.title), kind: WEB_PROPERTY_CHANGE_KIND, owner_id: "aie_porter", state: "IN_PROGRESS", work_attempts: 0, firm_scope: "west-peek", requested_by_email: SCOOTER }, held, "LAND", await rulesFor(env, WEB_PROPERTY_CHANGE_KIND));
    expect(gate.parked).toBe(false);
    expect((gate as { reason: string }).reason).toMatch(/previews first/);
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET merge_sha = 'deadbeef' WHERE work_card_id = ?1").bind(porterCardId).run()).rejects.toThrow(/second approval after the preview/);
    // RECEIVED at intake, then exactly three: the plan, the question after his "no", the preview —
    // and never the word "blocked" in any of them (owner, 23 Sep 2026).
    const toScooter = sent.filter((m) => m.to === SCOOTER && !/got it/i.test(m.subject));
    expect(toScooter.map((m) => m.subject.replace(/Porter: .*: /, "Porter: ").replace(/ — .*/, "")), "plan, question, preview — nothing else, each asking him to act").toEqual(["ACTION REQUIRED: Porter: Plan ready", "ACTION REQUIRED: Porter: A question for you", "ACTION REQUIRED: Porter: Preview ready"]);
    expect(toScooter.every((m) => !/blocked/i.test(m.subject))).toBe(true);
    const previewMail = toScooter.at(-1)!;
    expect(previewMail.subject).toBe("ACTION REQUIRED: Porter: Ventures site update: Preview ready");
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
    expect(payload.model).toBe("opus");
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
    // 0258: the finished email goes straight to Scooter, carrying the same proof, and nothing is
    // held for her. Both halves are asserted; the proof pins are unchanged.
    const done = await finishedEmailFor(porterCardId, SCOOTER);
    expect(sent.filter((m) => m.to === SEQUOIA && /: Live$/.test(m.subject)), "she is not sent a copy to approve").toHaveLength(0);
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
      await macReports(porterId, { phase: "PLAN", status: "ok", accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }], document: "# Plan: productions refresh\n\nnothing to ask", decided: ["all structure"], asks: [], publish_ready: true });
      expect((await tickFor(porterId)).summary).toMatch(/BUILD queued/);
      const forced = (await readWebPropertyChange(env, porterId))!;
      expect(forced.forced_by, "the named force is the only way past the preview").toBe("fu_sequoia_taylor");
      expect(forced.preview_only, "a force skips the gate; it never clears it").toBe(1);
      await macReports(porterId, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/15", pr_number: 15, check_state: "GREEN" });
      const out = await tickFor(porterId);
      expect(out.outcome).toBe("BLOCKED");
      const c = await card(porterId);
      expect(c.block_who).toBe("SEQUOIA");
      expect(String(c.block_needed)).toMatch(/^Waiting on: your word to land https:\/\/github\.com\/[^.]+\. Why: land-on-green is switched off for this kind[\s\S]*To clear it by email: reply "land it" to merge and deploy, or "changes: <what to change>"\./);
      expect(await liveJobFor(porterId), "nothing queued for the Mac while she decides").toBeNull();
      const question = sent.filter((m) => m.to === SEQUOIA && /: A question for you$/.test(m.subject)).pop()!;
      expect(question.subject, "never \"blocked\" to a partner").not.toMatch(/blocked/i);
      expect(question.text, "the question email carries the three-part wait, not the plan").toMatch(/Waiting on: your word to land[\s\S]*land-on-green is switched off[\s\S]*To clear it by email: reply "land it"/);
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

  it("no stored per-phase rule chooses what the Claude seat is started with: every phase gets the seat's one value from the rule table", () => {
    // Owner, 13 Nov 2026: no standing rule about any model. The value is data (seat_invocation in modelOrder.json);
    // a stored rule row, whatever it names, cannot start a phase with anything else.
    const seatStart = JSON.parse(readFileSync("src/shared/ai/modelOrder.json", "utf8")).seat_invocation.claude_code.model as string;
    expect(seatStart.length).toBeGreaterThan(0);
    for (const stored of ["sonnet", "haiku", "opus", "anything-else", ""]) {
      for (const phase of ["PLAN", "BUILD", "LAND"] as const) expect(phaseModel({ [`model_${phase.toLowerCase()}`]: stored }, phase)).toBe(seatStart);
    }
    for (const k of LOCAL_JOB_KINDS) for (const p of Object.values(k.phases)) expect(p.model).toBe(seatStart);
  });
});

describe("a job that left out part of the original request is reopened by the system to finish it (#363)", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  const INSTRUCTION = "Finish the original request: the members area was asked for and left out. Build it at /members on this site, behind a password, in the same preview.";

  async function atPreview(tag: string): Promise<string> {
    const chiefId = await openAssignmentCard(env, { subject: `ventures refresh ${tag}`, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `Hey Porter! Please refresh westpeek.ventures and build the members area — package: https://drive.google.com/drive/folders/${FOLDER}${tag}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "refresh the ventures site", how: "build", done_when: ["it works on the preview"] }], document: "# Plan\n\nnothing to ask", decided: ["as asked"], asks: [], publish_ready: true });
    await tickFor(id);
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/88", pr_number: 88, branch: `work/wpc-${tag}`, check_state: "GREEN", preview_url: `https://${tag}.west-peek-ventures.pages.dev`, proof: "validate green" });
    await tickFor(id);
    expect((await card(id)).state, "waiting on his word on the preview").toBe("BLOCKED");
    expect(await liveJobFor(id)).toBeNull();
    return id;
  }

  it("the left-out ask, in the partner's own words, queues a BUILD carrying the instruction; nothing is approved and no partner is recorded as saying it", async () => {
    const id = await atPreview("orig1");
    const out = await finishOriginalAsk(env, id, { ask: "the members area", instruction: INSTRUCTION, enteredBy: "test" });
    expect(out.ok, JSON.stringify(out)).toBe(true);
    await tickFor(id);
    const job = await liveJobFor(id);
    expect(job, "BUILD is queued for the Mac").not.toBeNull();
    const payload = JSON.parse(String(job!.job_json)) as { phase: string; rebuild: { intent: string; changes: string; stage?: boolean } | null };
    expect(payload.phase).toBe("BUILD");
    expect(payload.rebuild?.intent).toBe("CHANGES");
    expect(payload.rebuild?.changes).toContain("Build it at /members on this site, behind a password");
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.land_approved_at ?? null, "reopening approves nothing").toBeNull();
    const c = await env.WP_OS_DB.prepare("SELECT block_answer, block_answered_by FROM work_card WHERE id = ?1").bind(id).first<{ block_answer: string | null; block_answered_by: string | null }>();
    expect(c?.block_answered_by ?? null, "never attributed to a partner").toBeNull();
    const ev = await env.WP_OS_DB.prepare("SELECT actor_type FROM event_record WHERE event_type = 'web_property_change.original_ask_reopened' AND object_id = ?1").bind(id).first<{ actor_type: string }>();
    expect(ev?.actor_type).toBe("system");
    // The rebuilt preview still waits for HIS word.
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/88", pr_number: 88, branch: "work/wpc-orig1", changed: true, head_sha: "moved-1", check_state: "GREEN", preview_url: "https://orig1.west-peek-ventures.pages.dev", proof: "validate green" });
    await tickFor(id);
    expect((await card(id)).state).toBe("BLOCKED");
    expect((await readWebPropertyChange(env, id))!.land_approved_at ?? null).toBeNull();
    expect(await liveJobFor(id), "no LAND without his approval").toBeNull();
  });

  it("refuses words the partner never wrote, and anything that reads as an approval, a publish or a force", async () => {
    const id = await atPreview("orig2");
    const notAsked = await finishOriginalAsk(env, id, { ask: "a podcast studio", instruction: INSTRUCTION, enteredBy: "test" });
    expect(notAsked.ok, "work that was never asked for is not added").toBe(false);
    for (const words of ["approved", "publish", "approved to production", "Finish the original request: approved"]) {
      const out = await finishOriginalAsk(env, id, { ask: "the members area", instruction: words, enteredBy: "test" });
      expect(out.ok, `"${words}" must be refused`).toBe(false);
    }
    expect(await liveJobFor(id), "nothing was queued").toBeNull();
    const row = (await readWebPropertyChange(env, id))!;
    expect(row.refresh_intent ?? null).toBeNull();
    expect(row.land_approved_at ?? null).toBeNull();
    expect((await card(id)).state, "still waiting on his word").toBe("BLOCKED");
  });
});

describe("a build the partner tail stopped on purpose is queued again without spending an attempt", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);

  async function stopLiveBuild(id: string, resolution: string, claimed = true) {
    const job = await liveJobFor(id);
    expect(job, "BUILD is queued").not.toBeNull();
    expect(JSON.parse(String(job!.job_json)).phase).toBe("BUILD");
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'ABANDONED', claimed_by = ?2, claimed_at = ?3, resolution = ?4 WHERE id = ?1")
      .bind(job!.id, claimed ? "mac-test-jobs" : null, claimed ? new Date().toISOString() : null, resolution)
      .run();
    return job!.id;
  }

  async function atBuild(tag: string): Promise<string> {
    const chiefId = await openAssignmentCard(env, { subject: `ventures refresh ${tag}`, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: `Hey Porter! Please refresh westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${tag}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "refresh the ventures site", how: "build", done_when: ["it works on the preview"] }], document: "# Plan\n\nnothing to ask", decided: ["as asked"], asks: [], publish_ready: true });
    await tickFor(id);
    return id;
  }

  it("the tail's stop is not an attempt; the rebuild is queued on the next tick", async () => {
    const id = await atBuild("stop1");
    const before = Number((await card(id)).work_attempts);
    const stopped = await stopLiveBuild(id, "Stopped by the partner tail 2026-11-14T23:0xZ: built from a known-bad input. The reply was stored cut at 4,000 chars.");
    const out = await tickFor(id);
    expect(out.outcome, JSON.stringify(out)).not.toBe("FAILED");
    const after = await card(id);
    expect(Number(after.work_attempts), "no attempt was spent on the stop").toBeLessThanOrEqual(before);
    expect(after.work_last_failure ?? null).toBeNull();
    await tickFor(id);
    const again = await liveJobFor(id);
    expect(again, "BUILD queued again").not.toBeNull();
    expect(again!.id).not.toBe(stopped);
    expect(JSON.parse(String(again!.job_json)).phase).toBe("BUILD");
  });

  it("a stop before the Mac claimed it is queued again, never a Blocked 'waiting on the Mac' for the partner (18 Nov 2026)", async () => {
    const id = await atBuild("stop3");
    const stopped = await stopLiveBuild(id, "Stopped by the partner tail before claim: the BUILD carried a summary of his reply, not his words.", false);
    const out = await tickFor(id);
    expect(out.outcome, JSON.stringify(out)).not.toBe("FAILED");
    const after = await card(id);
    expect(after.state, "never Blocked on the partner for a stop").not.toBe("BLOCKED");
    expect(String(after.block_needed ?? "")).not.toMatch(/the Mac/);
    await tickFor(id);
    const again = await liveJobFor(id);
    expect(again, "BUILD queued again").not.toBeNull();
    expect(again!.id).not.toBe(stopped);
  });

  it("a run nobody claimed inside the queue ceiling is still the Mac's wait (negative)", async () => {
    const id = await atBuild("stop4");
    await stopLiveBuild(id, "no machine claimed this run inside its 43200s queue ceiling", false);
    await tickFor(id);
    const after = await card(id);
    expect(after.state).toBe("BLOCKED");
    expect(String(after.block_needed ?? "")).toMatch(/the Mac/);
  });

  it("the Mac's wait keeps its word: back in the queue when the Mac checks in inside its day; never at night, never held, never a fourth time", async () => {
    const id = await atBuild("mac1");
    const blockedBySleepingMac = async () => {
      await stopLiveBuild(id, "no machine claimed this run inside its 64800s queue ceiling", false);
      await tickFor(id);
      return card(id);
    };
    const first = await blockedBySleepingMac();
    expect(first.state).toBe("BLOCKED");
    expect(String(first.block_needed ?? "")).toMatch(/resumes by itself the next time the Mac is open/);
    // Tomorrow 18:00 UTC is midday Central (inside the Mac's day); 09:00 UTC is 03:00-04:00 Central (outside it).
    const b = new Date(Date.parse(String(first.blocked_at)) + 86_400_000);
    const noon = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 18));
    const night = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate(), 9));
    const macSaysHello = (at: Date) =>
      env.WP_OS_DB.prepare(
        `INSERT OR REPLACE INTO subscription_seat_device (seat, device_id, hostname, agent_version, last_seen_at, capabilities_json, first_seen_at)
         VALUES ('claude_code', 'dev_mac_wait', 'Sequoias-Mac', 'test', ?1, '[]', ?1)`,
      ).bind(new Date(at.getTime() - 30_000).toISOString()).run();

    expect(await releaseMacAsleepBlocks(env, noon), "no claimer has said hello since it stopped").not.toContain(id);
    await macSaysHello(night);
    expect(await releaseMacAsleepBlocks(env, night), "the Mac checking in at night is outside its day").not.toContain(id);
    await macSaysHello(noon);
    // A hello from before the stop is not the Mac coming back: the block came after it.
    const realBlockedAt = String(first.blocked_at);
    await env.WP_OS_DB.prepare("UPDATE work_card SET blocked_at = ?2 WHERE id = ?1").bind(id, new Date(noon.getTime() - 10_000).toISOString()).run();
    expect(await releaseMacAsleepBlocks(env, noon), "the only hello came before it stopped").not.toContain(id);
    await env.WP_OS_DB.prepare("UPDATE work_card SET blocked_at = ?2 WHERE id = ?1").bind(id, realBlockedAt).run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET held_at = ?2, held_reason = 'her own hold, in the test' WHERE id = ?1").bind(id, new Date().toISOString()).run();
    expect(await releaseMacAsleepBlocks(env, noon), "a held card stays exactly as she left it").not.toContain(id);
    await env.WP_OS_DB.prepare("UPDATE work_card SET held_at = NULL WHERE id = ?1").bind(id).run();

    // Through the sweep's own tick, so the release is proven wired where production runs it.
    const tick = await sweepOnce(env, noon, RUNNERS);
    const back = await card(id);
    expect(back.state, "the Mac is back inside its day").not.toBe("BLOCKED");
    expect(String(back.block_answer)).toMatch(/AUTO-RETRY: the Mac is open again/);
    expect(await releaseMacAsleepBlocks(env, noon), "once per stop, never in a loop").not.toContain(id);
    if (tick.card?.id !== id) await tickFor(id);
    const again = await liveJobFor(id);
    expect(again, "the same phase is queued for the Mac again").not.toBeNull();
    expect(JSON.parse(String(again!.job_json)).phase).toBe("BUILD");

    // Each further miss is released the same way, until the Mac has missed it MAC_ASLEEP_TRIES times.
    for (let miss = 2; miss < MAC_ASLEEP_TRIES; miss++) {
      expect((await blockedBySleepingMac()).state).toBe("BLOCKED");
      expect(await releaseMacAsleepBlocks(env, noon)).toContain(id);
      await tickFor(id);
    }
    const last = await blockedBySleepingMac();
    expect(last.state).toBe("BLOCKED");
    expect(String(last.block_needed ?? ""), "the last miss promises nothing it cannot keep").not.toMatch(/resumes by itself/);
    expect(String(last.block_needed ?? "")).toMatch(/try again/);
    expect(await releaseMacAsleepBlocks(env, noon), "never released a fourth time").not.toContain(id);
  });

  it("a run that simply went missing on the Mac still spends its attempt (negative)", async () => {
    const id = await atBuild("stop2");
    await stopLiveBuild(id, "mac-test-jobs has held this job for 49 minutes, past its 40 minutes ceiling.");
    const out = await tickFor(id);
    expect(out.outcome).toBe("FAILED");
    expect(String((await card(id)).work_last_failure)).toMatch(/Attempt \d of \d/);
  });
});

describe("the developer may direct any job with a work instruction, and with nothing else (#363, 0301)", () => {
  beforeAll(ageEarlierCards);
  afterAll(ageEarlierCards);
  const MAC = { id: "fu_subscription_claimer", email: "subscription-claimer@joinwestpeek.com", fullName: "Mac", status: "ACTIVE", roles: [] as string[], authorityScopes: [] };
  const door = (id: string, changes: string, identity: typeof MAC = MAC) =>
    handleDeveloperChanges({ request: new Request(`https://os.joinwestpeek.com/api/work-cards/${id}/developer-changes`, { method: "POST", body: JSON.stringify({ changes }) }), env, identity, params: { id } } as never);

  async function atPreview(tag: string, partnerAddress: string): Promise<string> {
    const chiefId = await openAssignmentCard(env, { subject: `ventures refresh ${tag}`, partnerAddress, chiefOfStaff: "Walker", raw: `Hey Porter! Please refresh westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${tag}`, limits: EMAILED_TASK_LIMITS, emlKey: null });
    const id = /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
    await tickFor(id);
    await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "refresh the ventures site", how: "build", done_when: ["it works on the preview"] }], document: "# Plan\n\nnothing to ask", decided: ["as asked"], asks: [], publish_ready: true });
    await tickFor(id);
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/89", pr_number: 89, branch: `work/wpc-${tag}`, check_state: "GREEN", preview_url: `https://${tag}.west-peek-ventures.pages.dev`, proof: "validate green" });
    await tickFor(id);
    expect((await card(id)).state, "waiting on the requester's word on the preview").toBe("BLOCKED");
    return id;
  }
  const rebuildOf = async (id: string) => {
    const job = await liveJobFor(id);
    return job ? (JSON.parse(String(job.job_json)) as { phase: string; rebuild: { intent: string; changes: string; stage?: boolean } | null }) : null;
  };

  it("her exact email goes, word for word, as Porter, to the one partner who asked, once (14 Nov 2026)", async () => {
    const id = await atPreview("devmail1", SCOOTER);
    const TEXT = "Hi Scooter,\n\nYour dashboard is ready.\n- Today shows what needs you first.\n\nPorter";
    const mail = (identity: typeof MAC = MAC) =>
      handleDeveloperEmail({ request: new Request(`https://os.joinwestpeek.com/api/work-cards/${id}/developer-email`, { method: "POST", body: JSON.stringify({ subject: "Your dashboard is ready", text: TEXT }) }), env, identity, params: { id } } as never);
    const from = sent.length;
    expect((await mail({ ...MAC, email: "someone@westpeek.ventures" })).status, "not the Mac: refused").toBe(403);
    expect(sent.length).toBe(from);
    expect((await mail()).status).toBe(200);
    const mine = sent.slice(from);
    expect(mine, "exactly one email").toHaveLength(1);
    expect(mine[0]!.text, "the body is the given text, exactly").toBe(TEXT);
    expect(mine[0]!.subject).toBe("Your dashboard is ready");
    expect(mine[0]!.toAll, "to the partner who asked, alone").toEqual([SCOOTER]);
    expect(mine[0]!.cc, "nobody copied").toEqual([]);
    expect((await mail()).status, "the same words twice: refused").toBe(409);
    expect(sent.length - from).toBe(1);
  });

  it("her 'changes: …' on his job rebuilds with her words; her 'approved' on it lands nothing", async () => {
    const id = await atPreview("dev1", SCOOTER);
    await answerBlock(env, id, "fu_sequoia_taylor", { action: "ANSWER", text: "approved" });
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.land_approved_at ?? null, "the developer never approves another partner's job").toBeNull();
    expect(await liveJobFor(id)).toBeNull();
    await answerBlock(env, id, "fu_sequoia_taylor", { action: "ANSWER", text: "changes: add the members page at /members" });
    await tickFor(id);
    const payload = await rebuildOf(id);
    expect(payload?.phase).toBe("BUILD");
    expect(payload?.rebuild?.intent).toBe("CHANGES");
    expect(payload?.rebuild?.changes).toContain("add the members page at /members");
    expect(String((await card(id)).description)).toContain("Directed by Sequoia (developer)");
  });

  it("a Managing Partner without the role is refused exactly as before: his 'changes: …' on her job moves nothing", async () => {
    const id = await atPreview("dev2", SEQUOIA);
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: add the members page at /members" });
    await tickFor(id);
    expect(await liveJobFor(id), "no rebuild").toBeNull();
    expect((await readWebPropertyChange(env, id))!.refresh_intent ?? null).toBeNull();
    const holders = await env.WP_OS_DB.prepare("SELECT fur.firm_user_id AS id FROM firm_user_role fur JOIN role r ON r.id = fur.role_id WHERE r.key = 'DEVELOPER'").all<{ id: string }>();
    expect((holders.results ?? []).map((h) => h.id), "the role is held by the owner and nobody else").toEqual(["fu_sequoia_taylor"]);
  });

  it("the tail door: the Mac's identity enters her work instruction, recorded as hers through the tail; it refuses approvals, publish, force and every other caller", async () => {
    const id = await atPreview("dev3", SCOOTER);
    for (const words of ["approved", "changes: approved", "publish", "approved to production", "preview"]) {
      const res = await door(id, words);
      expect(res.status, `"${words}" is not a work instruction`).toBe(400);
    }
    const partner = await door(id, "add the members page at /members", { ...MAC, id: "fu_scooter_taylor", email: SCOOTER, roles: ["MANAGING_PARTNER"] });
    expect(partner.status, "a partner uses the card or email, never this door").toBe(403);
    expect((await card(id)).state, "nothing above moved the job").toBe("BLOCKED");
    const res = await door(id, "add the members page at /members");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { recorded_as: string }).recorded_as).toBe("Sequoia (developer), through the partner tail (Claude)");
    const c = await env.WP_OS_DB.prepare("SELECT block_answered_by FROM work_card WHERE id = ?1").bind(id).first<{ block_answered_by: string | null }>();
    expect(c?.block_answered_by, "never recorded as a partner's own answer").toBe("tail:fu_sequoia_taylor");
    await tickFor(id);
    const payload = await rebuildOf(id);
    expect(payload?.rebuild?.intent).toBe("CHANGES");
    expect(payload?.rebuild?.changes).toContain("add the members page at /members");
    expect((await readWebPropertyChange(env, id))!.land_approved_at ?? null).toBeNull();
    const ev = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'work_card.directed_by_developer' AND object_id = ?1").bind(id).first<{ payload_json: string }>();
    expect(String(ev?.payload_json)).toContain("partner tail (Claude)");
  });

  it("the tail door carries a full scope whole, up to the partner-answer bound, and refuses one past it rather than cutting it", async () => {
    const id = await atPreview("dev3b", SCOOTER);
    const tail = "the help page is linked from every empty state";
    const long = `${"build the connections screen with one row per account. ".repeat(110)}${tail}`;
    expect(long.length).toBeGreaterThan(4000);
    expect((await door(id, "x".repeat(8001))).status, "past the bound is refused, never cut").toBe(400);
    expect((await door(id, long)).status).toBe(200);
    await tickFor(id);
    expect((await rebuildOf(id))?.rebuild?.changes, "the end of the instruction reaches the builder").toContain(tail);
  });

  /**
   * 13 Nov 2026: a partner got "New preview ready" three times in ninety minutes. Two of those builds were
   * the developer's instructions through the tail door; he had asked for nothing and the link was the one
   * he already held. One preview email per round of HIS changes; the job still waits on him, on the new build.
   */
  const rebuilt = async (id: string, tag: string, branch: string, more: Record<string, unknown> = {}) => {
    await tickFor(id);
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/89", pr_number: 89, branch, changed: true, head_sha: `head-${tag}`, check_state: "GREEN", preview_url: `https://${tag}.west-peek-ventures.pages.dev`, proof: "validate green", ...more });
    expect((await tickFor(id)).outcome, "the job waits on the partner's word on the preview").toBe("BLOCKED");
  };
  const previewMails = (since: number) => sent.slice(since).filter((m) => m.to === SCOOTER && /preview ready$/i.test(m.subject));

  it("a rebuild for the developer's instruction, on the link the partner already holds, waits on him without a second preview email; his own changes get one", async () => {
    const start = sent.length;
    const id = await atPreview("dev4", SCOOTER);
    expect(previewMails(start), "the first preview is always mailed").toHaveLength(1);
    const first = (await readWebPropertyChange(env, id))!;

    const afterFirst = sent.length;
    expect((await door(id, "move the sign-in form above the fold")).status).toBe(200);
    await rebuilt(id, "dev4b", "work/wpc-dev4");
    expect(sent.slice(afterFirst).filter((m) => m.to === SCOOTER), "nothing he did not ask for reaches him").toHaveLength(0);
    const quiet = (await readWebPropertyChange(env, id))!;
    expect(quiet.check_green_at! > first.check_green_at!, "the new build is the one on the card").toBe(true);
    expect(quiet.preview_emailed_at! > first.preview_emailed_at!, "his approval binds to the new build").toBe(true);
    const c = await card(id);
    expect([c.state, c.block_reason, c.block_who], "waiting on his word exactly as after a mailed preview").toEqual(["BLOCKED", "a_question_for_you", "SCOOTER"]);
    const notice = await env.WP_OS_DB.prepare("SELECT sent FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'PREVIEW' AND cause = ?2").bind(id, quiet.check_green_at).first<{ sent: number }>();
    expect(notice?.sent, "the build is on the notice ledger, as not mailed").toBe(0);

    // A second instruction on top of the first: still the developer's, still the link he holds.
    expect((await door(id, "and make the button orange")).status).toBe(200);
    await rebuilt(id, "dev4c", "work/wpc-dev4");
    expect(sent.slice(afterFirst).filter((m) => m.to === SCOOTER)).toHaveLength(0);

    // His own words are a round of his changes: one email, and it describes the build that is current now.
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: put the founders photo on the home page" });
    await rebuilt(id, "dev4d", "work/wpc-dev4");
    const his = previewMails(afterFirst);
    expect(his, "one preview email for his round").toHaveLength(1);
    expect(his[0]!.text).toContain("put the founders photo on the home page");
    expect(his[0]!.text).toContain("https://work-wpc-dev4.west-peek-ventures.pages.dev");

    // The developer's rebuild that moves the preview to a link he has never been sent is mailed: never silent on a new link.
    const beforeMove = sent.length;
    expect((await door(id, "rename the branch for the launch")).status).toBe(200);
    await rebuilt(id, "dev4e", "work/wpc-dev4-launch");
    expect(previewMails(beforeMove), "a link he does not hold is mailed").toHaveLength(1);
    expect(previewMails(beforeMove)[0]!.text).toContain("https://work-wpc-dev4-launch.west-peek-ventures.pages.dev");
  });

  /**
   * 14 Nov 2026: the partner held a preview link while the developer directed a full rebuild. A half-built change
   * must never show on the link he holds: the rebuild is STAGED (the job says so), built on "<branch>-next" with its
   * own preview, and nothing is mailed to him; his own changes are not staged.
   */
  it("the developer's rebuild while he holds a preview is staged on its own branch and preview, and not mailed", async () => {
    const id = await atPreview("dev7", SCOOTER);
    const afterFirst = sent.length;
    expect((await door(id, "rebuild the dashboard to the full scope")).status).toBe(200);
    await tickFor(id);
    expect((await rebuildOf(id))?.rebuild, "the job tells the Mac to stage it").toMatchObject({ intent: "CHANGES", stage: true });
    await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: "https://github.com/seq23/join-west-peek-main/pull/90", pr_number: 90, branch: "work/wpc-dev7-next", changed: true, head_sha: "head-dev7b", check_state: "GREEN", preview_url: "https://work-wpc-dev7-next.west-peek-ventures.pages.dev", proof: "validate green" });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    expect(sent.slice(afterFirst).filter((m) => m.to === SCOOTER), "the staged build is not mailed to him").toHaveLength(0);
    const row = (await readWebPropertyChange(env, id))!;
    expect([row.branch, row.pr_number], "the staged PR is the job's PR now").toEqual(["work/wpc-dev7-next", 90]);
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: put the founders photo on the home page" });
    await tickFor(id);
    expect((await rebuildOf(id))?.rebuild?.stage, "his own changes are never marked staged").toBeUndefined();
  });

  /** 14 Nov 2026: review findings for a developer rebuild that is queued (not waiting on a word) join it, still staged. */
  it("the tail door adds to a queued developer rebuild, keeping it staged and quiet; a job with no rebuild of hers is refused", async () => {
    const id = await atPreview("dev10", SCOOTER);
    expect((await door(id, "rebuild the dashboard to the full scope")).status).toBe(200);
    await tickFor(id);
    await macReports(id, { phase: "BUILD", status: "failed", reason: "the review still blocks" });
    await tickFor(id);
    expect((await card(id)).state, "between attempts, not waiting on a word").not.toBe("BLOCKED");
    const res = await door(id, "list the production redirect URL for every account in Help");
    expect(res.status).toBe(200);
    let job = null as Awaited<ReturnType<typeof rebuildOf>>;
    for (let t = 0; t < 4 && !job; t += 1) {
      await tickFor(id);
      job = await rebuildOf(id);
    }
    expect(job?.rebuild?.changes, "both instructions reach the builder").toContain("rebuild the dashboard to the full scope");
    expect(job?.rebuild?.changes).toContain("production redirect URL");
    expect(job?.rebuild?.stage, "still staged").toBe(true);
    const plain = await atPreview("dev11", SCOOTER);
    await answerBlock(env, plain, "fu_scooter_taylor", { action: "ANSWER", text: "changes: put the founders photo on the home page" });
    await tickFor(plain);
    expect((await door(plain, "and make the button orange")).status, "his own queued rebuild is never added to").toBe(409);
  });

  /** 14 Nov 2026: a retry rebuilt blind and failed the same way; now it is handed the refusal it must fix first. */
  it("a retry after a refused BUILD carries the refusal to the builder; the first attempt carries none", async () => {
    const id = await atPreview("dev9", SCOOTER);
    expect((await door(id, "rebuild the dashboard to the full scope")).status).toBe(200);
    await tickFor(id);
    const first = await liveJobFor(id);
    expect((JSON.parse(String(first!.job_json)) as { last_refusal?: string | null }).last_refusal ?? null, "nothing refused yet").toBeNull();
    const why = "1 passage(s) of the private document are in what this PR adds, at functions/x.mjs:459";
    await macReports(id, { phase: "BUILD", status: "failed", reason: why });
    let again = null as Awaited<ReturnType<typeof liveJobFor>>;
    for (let t = 0; t < 4 && !again; t += 1) {
      await tickFor(id);
      again = await liveJobFor(id);
    }
    expect((JSON.parse(String(again!.job_json)) as { last_refusal?: string | null }).last_refusal, "the retry hears what to fix").toContain("functions/x.mjs:459");
    // A second, different refusal: the next retry hears both, so it does not rebuild the first one back in.
    await macReports(id, { phase: "BUILD", status: "failed", reason: "asked for runs three times without finishing" });
    let third = null as Awaited<ReturnType<typeof liveJobFor>>;
    for (let t = 0; t < 4 && !third; t += 1) {
      await tickFor(id);
      third = await liveJobFor(id);
    }
    const heard = String((JSON.parse(String(third!.job_json)) as { last_refusal?: string | null }).last_refusal);
    expect(heard).toContain("asked for runs three times");
    expect(heard, "the older refusal is still in front of it").toContain("functions/x.mjs:459");
  });

  /**
   * 14 Nov 2026 (owner: no email to Scooter about the dashboard error). A staged developer rebuild that fails, again
   * and again, up to the retry cap, emails the partner nothing: every outcome is held for the developer's tail.
   */
  it("a staged developer rebuild that fails three times sends the partner zero emails; each outcome is held for the tail", async () => {
    const id = await atPreview("dev8", SCOOTER);
    const from = sent.length;
    expect((await door(id, "rebuild the dashboard to the full scope")).status).toBe(200);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      let pj = null as Awaited<ReturnType<typeof rebuildOf>>;
      for (let t = 0; t < 4 && !pj; t += 1) {
        await tickFor(id);
        pj = await rebuildOf(id);
      }
      expect(pj?.rebuild?.stage, `attempt ${attempt} is staged`).toBe(true);
      await macReports(id, { phase: "BUILD", status: "failed", reason: "NAMED STOP [REVIEW_NOT_MET] the review still blocks after two fix rounds" });
    }
    for (let t = 0; t < 6 && (await card(id)).state !== "BLOCKED"; t += 1) await sweepOnce(env, nextTickTime(), RUNNERS);
    const c = await card(id);
    expect([c.state, c.block_reason], "the retry cap stopped it").toEqual(["BLOCKED", "tried_and_could_not_finish"]);
    expect(sent.slice(from).filter((m) => m.to === SCOOTER), "nothing reaches the partner").toHaveLength(0);
    const held = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'web_property_change.partner_mail_held' AND object_id = ?1").bind(id).first<{ n: number }>();
    expect(Number(held?.n), "the outcome is on the spine for the tail").toBeGreaterThan(0);
  });

  /**
   * 17 Nov 2026 (wc_c548d043): Scooter asked "confirm what's already done, what needs building and your estimate",
   * "Tell me if you recommend a better approach", and "please don't ask me to reply \"approved\" until I say so".
   * Porter answered in the BUILD's notes; the preview email carried none of it and ended 'reply "approved"'.
   */
  it("the preview email carries what the build answered, and asks for no \"approved\" when he said not to", async () => {
    const id = await atPreview("ans1", SCOOTER);
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: make the logo smaller. Tell me if you recommend a better approach. Please confirm what's already done and your estimate. No publishing yet, and please don't ask me to reply \"approved\" until I say so." });
    const from = sent.length;
    await rebuilt(id, "ans1b", "work/wpc-ans1", {
      items: [
        { item: "(1) Make the logo smaller", state: "done", done_when: [{ check: "logo 15% smaller", met: true }] },
        { item: "(2) Confirm what's done and the estimate; recommend a better approach", state: "done", done_when: [{ check: "answered", met: true, note: "Done: the logo. Left: nothing. Estimate: under an hour once copy arrives." }] },
      ],
      notes: "BETTER APPROACH: the strip waits 1.5s after a touch before drifting again. (cost $2.10)",
    });
    const detail = String(await blockedEmailDetail(env, id));
    expect(detail).toContain("WHAT YOU ASKED, ANSWERED");
    expect(detail).toContain("Estimate: under an hour");
    expect(detail).toContain("waits 1.5s after a touch");
    expect(detail, "the run's cost is not his to read").not.toContain("cost $");
    expect(detail, "no ask for the word he said not to ask for").not.toMatch(/Reply "approved" to (?:land|publish)|reply "approved" to publish/);
    const mail = sent.slice(from).filter((m) => m.to === SCOOTER).map((m) => m.text).join("\n");
    expect(mail).toContain("Estimate: under an hour");
    expect(detail).toContain("Nothing lands until you say you are ready");
    expect(mail, "the email itself asks for no approved either").not.toMatch(/Reply "approved" to (?:land|publish)|reply "approved" to publish/);
    // Ordinary changes words still get the usual ask.
    const other = await atPreview("ans2", SCOOTER);
    await answerBlock(env, other, "fu_scooter_taylor", { action: "ANSWER", text: "changes: make the logo smaller" });
    await rebuilt(other, "ans2b", "work/wpc-ans2");
    expect(String(await blockedEmailDetail(env, other))).toMatch(/Reply "approved" to land it/);
  });

  /**
   * 13 Nov 2026: Porter's "answered" email told a partner "The last build was for: …" and quoted the
   * developer's instruction word for word. What a partner reads about a build is what HE asked for.
   */
  it("the developer's instruction is never quoted to the partner: not in the answer to his question, the preview email, or what the job says it waits on", async () => {
    const id = await atPreview("dev5", SCOOTER);
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: put the founders photo on the home page" });
    await rebuilt(id, "dev5b", "work/wpc-dev5", { proof: "founders photo on the home page: checked at 390px" });
    expect(String(await blockedEmailDetail(env, id)), "the proof of the build he asked for is his to read").toContain("checked at 390px");
    const from = sent.length;
    const INTERNAL = "strip the zebra-crossing fallback from the sign-in handler";
    expect((await door(id, INTERNAL)).status).toBe(200);
    // The build's own summary of what it did describes her instruction just as plainly.
    const PROOF = "zebra-crossing fallback removed from the sign-in handler; 14 tests green";
    await rebuilt(id, "dev5c", "work/wpc-dev5", { proof: PROOF });
    expect(String((await readWebPropertyChange(env, id))!.rebuilt_for), "the instruction is what the build was for").toContain(INTERNAL);
    expect((await readWebPropertyChange(env, id))!.build_proof, "the proof stays on the card").toBe(PROOF);
    expect(String(await blockedEmailDetail(env, id)), "what the sweep hands his email and his notice").not.toContain("zebra-crossing");

    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "Do you know for certain where I can see it?" });
    expect((await tickFor(id)).outcome).toBe("BLOCKED");
    const answered = sent.slice(from).filter((m) => m.to === SCOOTER && /answered/.test(m.subject));
    expect(answered, "his question is answered from the card").toHaveLength(1);
    expect(answered[0]!.text).toContain("The preview is at");
    expect(answererFacts?.join(" "), "nor is it handed to the model that words the answer").not.toContain("zebra-crossing");

    // A preview email that does go out for her instruction (the link moved) says nothing of it either.
    expect((await door(id, `${INTERNAL}, on the launch branch`)).status).toBe(200);
    await rebuilt(id, "dev5d", "work/wpc-dev5-launch", { proof: PROOF });
    expect(previewMails(from)).toHaveLength(1);
    expect(String(await blockedEmailDetail(env, id))).not.toContain("zebra-crossing");

    const his = sent.slice(from).filter((m) => m.to === SCOOTER);
    expect(his.length).toBeGreaterThanOrEqual(2);
    for (const m of his) expect(`${m.subject}\n${m.text}`, `"${m.subject}" carries no developer instruction`).not.toContain("zebra-crossing");
    expect(String((await card(id)).block_needed), "what the job says it waits on").not.toContain("zebra-crossing");
    expect(JSON.parse((await readWebPropertyChange(env, id))!.answers_json).join(" "), "it is not one of his answers").not.toContain("zebra-crossing");
  });

  /**
   * 13 Nov 2026: "Do you have a link to the dashboard yet?" was answered with the site's root. A page the
   * build recorded is linked; a page the card has no record of is not guessed at.
   */
  it("a question about a part of the job that has its own page on the preview is answered with that page's link, when the build recorded it; otherwise the site link and nothing invented", async () => {
    const id = await atPreview("pg1", SCOOTER);
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: add a members area and tidy the about page" });
    await rebuilt(id, "pg1b", "work/wpc-pg1", { changed_files: ["sites/ventures/members.html", "sites/ventures/about.html", "sites/ventures/styles.css"] });
    const root = "https://work-wpc-pg1.west-peek-ventures.pages.dev";
    const answerTo = async (question: string) => {
      const from = sent.length;
      await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: question });
      expect((await tickFor(id)).outcome).toBe("BLOCKED");
      const mails = sent.slice(from).filter((m) => m.to === SCOOTER && /answered/.test(m.subject));
      expect(mails).toHaveLength(1);
      return mails[0]!.text;
    };
    const members = await answerTo("Do you know for certain where the members area is?");
    expect(members.split("\n")[0], "the page he asked about is the answer").toContain(`${root}/members.`);
    expect(members, "and the site's own link is still there").toContain(`The preview is at ${root}.`);
    expect(members).not.toContain(`${root}/about`);
    const unknown = await answerTo("Do you know for certain where the dashboard is?");
    expect(unknown).toContain(`The preview is at ${root}.`);
    expect(unknown, "no page the card does not record").not.toMatch(/pages\.dev\/[a-z]/);
  });

  /**
   * 13 Nov 2026: the dashboard was built by an early build, as a Pages Function; later builds changed other
   * pages, the card's list of pages was overwritten each time, and "where is the dashboard?" found nothing.
   */
  it("a page an earlier build made is still linked after later builds change other pages, a function-served page included", async () => {
    const id = await atPreview("pg2", SCOOTER);
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: add a members area and a dashboard" });
    await rebuilt(id, "pg2b", "work/wpc-pg2", { changed_files: ["sites/ventures/members.html", "functions/dashboard/[[path]].js", "functions/_lib/store.mjs", "functions/api/lead.js", "sites/community/lounge.html"] });
    await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: "changes: add the nine city pages" });
    await rebuilt(id, "pg2c", "work/wpc-pg2", { changed_files: ["austin", "boston", "chicago", "denver", "eugene", "fresno", "garland", "houston", "irvine"].map((c) => `sites/ventures/${c}.html`) });
    const root = "https://work-wpc-pg2.west-peek-ventures.pages.dev";
    const answerTo = async (question: string) => {
      const from = sent.length;
      await answerBlock(env, id, "fu_scooter_taylor", { action: "ANSWER", text: question });
      expect((await tickFor(id)).outcome).toBe("BLOCKED");
      const mails = sent.slice(from).filter((m) => m.to === SCOOTER && /answered/.test(m.subject));
      expect(mails).toHaveLength(1);
      return mails[0]!.text;
    };
    expect(await answerTo("Do you know for certain where the members area is?"), "build 1's page, after build 2").toContain(`${root}/members.`);
    expect(await answerTo("Do you know for certain if there is a link to the dashboard yet?"), "the page a function serves").toContain(`${root}/dashboard.`);
    expect(await answerTo("Do you know for certain where the irvine page is?"), "the ninth page of one build is on the record").toContain(`${root}/irvine.`);
    const other = await answerTo("Do you know for certain where the lounge is?");
    expect(other, "another site's page in the same repo is not this job's").not.toContain("/lounge");
    expect(other).not.toContain("/api");
  });
});
