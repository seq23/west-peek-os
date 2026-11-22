import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { claimNextCard, sweepOnce, type SweepCard } from "../src/worker/services/workSweep";
import { keywordIntent, type ReplyIntentReader } from "../src/worker/services/replyIntent";
import { opensWithApproval } from "../src/shared/work/approvalReply";
import type { QuestionAnswerer } from "../src/worker/services/questionRouting";
import { reportRun, type SeatRunRow } from "../src/worker/ai/subscriptionSeats";
import { readWebPropertyChange, runWebPropertyChangeCard } from "../src/worker/services/webPropertyChange";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import type { FirstReadDecision } from "../src/worker/services/partnerUnderstood";
import { decideReplyWords } from "../src/worker/services/firstReadDecides";

/**
 * THE FIRST READ DECIDES (owner ruling, 19 Nov 2026). Claude's first read of a partner email is the authority for what
 * moves a Porter job; the keyword rules act only when no first read exists after the ten-minute wait, and say so.
 * Each decision the partner tail patched one phrase at a time (#531, #542, #546) has two proofs here, with his own
 * phrasing (or the variant the keywords still misread): a stubbed first read that disagrees with the keywords wins,
 * and with no first read nothing moves until the wait is over, then the keywords act and are logged.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string }> = [];
const SCOOTER = "scooter@westpeek.ventures";
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const FOLDER = "1AbCdEfGhIjKlMnOpQrStUv";

let clock = Date.now();
const nextTickTime = (): Date => new Date((clock += 3 * 60_000));
/** The same deterministic intent reader the reply suite uses: "please/make/swap/…" are changes, the rest goes ahead. */
const fakeIntentReader: ReplyIntentReader = async (_env, input) => {
  const t = input.text;
  // The fake stands in for the model, which reads the one-word replies ("approved", "hold off") as the word lists do.
  const words = keywordIntent(t);
  // A model carries his whole words as the change (replyIntent.ts#fromReader), never the cut the word lists make.
  if (words) return { ...words, changes: words.changes === null ? null : t, source: "MODEL" as const, reason: "fake reader" };
  const base = { reading: { kind: "ANSWERS" as const, text: t }, approves: opensWithApproval(t), aiRunId: null, source: "MODEL" as const, reason: "fake reader" };
  if (/let'?s not|hold on|hold off|\bstop\b|\bwait\b/i.test(t)) return { ...base, reading: { kind: "REFUSED" as const, text: t }, approves: false, kind: "STOP", changes: null, question: null };
  const question = /\?/.test(t) ? (t.match(/[^.\n]*\?/)?.[0] ?? t).trim() : null;
  const changes = /\b(but|make|swap|use|instead|please)\b/i.test(t) ? t.replace(/[^.\n]*\?/, "").trim() || null : null;
  if (question) return { ...base, kind: "QUESTION", changes, question };
  return { ...base, kind: "CONTINUE", changes, question: null };
};
const fakeAnswerer: QuestionAnswerer = async (_env, input) => ({ confident: true, answer: `Yes — ${input.question.slice(0, 60)}`, reason: "fake", aiRunId: null });
const RUNNERS = { webPropertyChange: (e: Env, c: SweepCard) => runWebPropertyChangeCard(e, c, undefined, undefined, fakeAnswerer, fakeIntentReader) };
/**
 * Would the sweep start this card right now (real time)? Claims until it gets this card or nothing, then gives every
 * claim back. The wait for the first read is the sweep's own (`claimNextCard`): a card whose partner email is younger
 * than ten minutes with no settled first read is never started.
 */
async function sweepWouldStart(id: string): Promise<boolean> {
  const taken: string[] = [];
  let hit = false;
  for (let i = 0; i < 12; i++) {
    const c = await claimNextCard(env, new Date());
    if (!c) break;
    taken.push(c.id);
    if (c.id === id) {
      hit = true;
      break;
    }
  }
  for (const c of taken) await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL, work_attempts = MAX(COALESCE(work_attempts, 1) - 1, 0) WHERE id = ?1").bind(c).run();
  return hit;
}

async function tickFor(id: string) {
  for (let i = 0; i < 8; i++) {
    const out = await sweepOnce(env, nextTickTime(), RUNNERS);
    if (out.card?.id === id) return out;
  }
  throw new Error(`the sweep never reached ${id}`);
}
const card = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
const liveJob = (id: string) => env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status IN ('QUEUED','CLAIMED') ORDER BY created_at DESC LIMIT 1").bind(id).first<SeatRunRow & { job_json?: string }>();
const decisionsLogged = async (id: string) =>
  ((await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'partner_reply.first_read_decides' ORDER BY rowid").bind(id).all<{ payload_json: string }>()).results ?? []).map((r) => JSON.parse(r.payload_json) as { what: string; used: string; first_read: string | null; keyword: string });

async function macReports(cardId: string, report: Record<string, unknown>): Promise<void> {
  const run = await env.WP_OS_DB.prepare("SELECT * FROM subscription_seat_run WHERE work_card_id = ?1 AND run_kind = 'LOCAL_JOB' AND status = 'QUEUED'").bind(cardId).first<SeatRunRow>();
  expect(run, "a LOCAL_JOB was parked for the Mac").not.toBeNull();
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = 'mac-test-jobs', claimed_at = ?2, attempt_count = attempt_count + 1 WHERE id = ?1").bind(run!.id, new Date().toISOString()).run();
  expect((await reportRun(env, { runId: run!.id, deviceId: "mac-test-jobs", outputText: JSON.stringify(report) })).accepted).toBe(true);
}

async function replyFrom(written: string, token: string, messageId: string | null = null) {
  const raw = [`From: ${SCOOTER}`, "To: os@joinwestpeek.com", "Subject: Re: Porter: preview", "", written, "", "On Thu, 19 Nov 2026 at 09:02, Porter <os@westpeek.ventures> wrote:", "> The preview is ready."].join("\n");
  return steerFromReply(env, { fromHeader: `<${SCOOTER}>`, authenticationResults: GOOD_AUTH(SCOOTER), subject: "Re: Porter: preview", raw, inReplyTo: threadReference(token), references: null, emlKey: null, messageId });
}

/**
 * HIS EMAIL ON THE CARD, as the door stores it, and (when given) its first read's decision. `at` is when it arrived;
 * with no decision and no Got it row the first read is still due.
 */
async function hisEmail(cardId: string, at: string, decision?: Partial<FirstReadDecision>, messageId?: string): Promise<string> {
  const id = `inm_${crypto.randomUUID().slice(0, 8)}`;
  await env.WP_OS_DB.prepare(
    "INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, work_card_id, firm_scope) VALUES (?1, ?2, ?3, ?4, 'os@joinwestpeek.com', 'Re: Porter', ?5, 10, ?6, ?7, 'west-peek')",
  )
    .bind(id, messageId ?? `<${id}@test>`, `inbound/${id}.eml`, SCOOTER, at, JSON.stringify({ partner: SCOOTER }), cardId)
    .run();
  if (decision) {
    const full: FirstReadDecision = { kind: "change", property: null, handOffTo: null, planApproved: null, holds: [], ...decision };
    await env.WP_OS_DB.prepare("INSERT INTO partner_understood (inbound_message_id, work_card_id, partner_email, state, brief_json, reader) VALUES (?1, ?2, ?3, 'SENT', ?4, 'CLAUDE')")
      .bind(id, cardId, SCOOTER, JSON.stringify({ decision: full, holds: [], questions: [], unclear: [], files: [] }))
      .run();
  }
  return id;
}

/** The whole reply timeline moved back: preview 20 minutes ago, his reply and its email `minutes` ago. */
async function aged(cardId: string, inm: string, minutes: number): Promise<void> {
  const ago = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
  await env.WP_OS_DB.prepare("UPDATE web_property_change SET preview_emailed_at = ?2 WHERE work_card_id = ?1").bind(cardId, ago(20)).run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET block_answered_at = ?2 WHERE id = ?1").bind(cardId, ago(minutes)).run();
  await env.WP_OS_DB.prepare("UPDATE inbound_message SET received_at = ?2 WHERE id = ?1").bind(inm, ago(minutes)).run();
}

async function opened(subject: string, raw: string): Promise<string> {
  const chiefId = await openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw, limits: EMAILED_TASK_LIMITS, emlKey: null });
  return /Handed to Porter as work card (wc_[a-z0-9-]+)/.exec(String((await card(chiefId)).description))![1]!;
}

/** A job at its preview, waiting on his word: the plan approved by the request, a green build, one preview sent. */
async function atPreview(subject: string): Promise<{ id: string; token: string }> {
  const id = await opened(subject, `${subject}: westpeek.ventures — package: https://drive.google.com/drive/folders/${FOLDER}${subject.replace(/\W/g, "").slice(0, 6)}`);
  await tickFor(id);
  await macReports(id, { phase: "PLAN", status: "ok", accounting: [{ ask: "what the partner asked for", how: "build", done_when: ["it works on the preview"] }], document: "# Plan", decided: [], asks: [{ question: "Lift the orange?", recommended: "Yes." }], publish_ready: true, placeholders: [] });
  await tickFor(id);
  await macReports(id, { phase: "BUILD", status: "ok", items: [{ item: "the ask", state: "done", done_when: [{ check: "it works on the preview", met: true }] }], pr_url: `https://github.com/seq23/join-west-peek-main/pull/${Math.floor(Math.random() * 9000) + 100}`, pr_number: 9, check_state: "GREEN", preview_url: "https://p9.west-peek-ventures.pages.dev" });
  expect((await tickFor(id)).outcome).toBe("BLOCKED");
  const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ token: string }>())!.token;
  return { id, token };
}

/** His reply arrives and is filed on the card; returns his stored email (no first read yet unless a decision is given). */
async function replies(p: { id: string; token: string }, words: string, decision?: Partial<FirstReadDecision>): Promise<string> {
  const messageId = `fr_${crypto.randomUUID().slice(0, 8)}@test`;
  await replyFrom(words, p.token, messageId);
  const answeredAt = String((await card(p.id)).block_answered_at);
  const inm = await hisEmail(p.id, answeredAt, decision, messageId);
  // The first read is in: what his reply says about the card itself is decided now, as partnerUnderstood.ts does.
  if (decision) await decideReplyWords(env, { inboundId: inm, messageId, receivedAt: answeredAt, decision: { kind: "change", property: null, handOffTo: null, planApproved: null, holds: [], ...decision } });
  return inm;
}

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
  await env.WP_OS_DB.prepare("INSERT INTO web_property_registry (id, host, repo, site, words_json) VALUES ('wpr_topbarz_test', 'voting.topbarz.xyz', 'topbarz-voting', '.', '[\"top barz\",\"topbarz\",\"the voting site\"]')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

const APPROVED_PUBLISH = "Hey Porter!\n\nApproved. Please publish the new site and the privacy pages, as directed in my last email. Keep Clarity off.\n\nPlease send the live links when complete.";
const QUIET_CHANGE = "Looks great to me — one thing, the footer still says 2025.";

describe("land / publish (#531)", () => {
  it("'Hey Porter! Approved. Please publish …': the first read's approve lands the preview now, over the keywords' rebuild", async () => {
    const p = await atPreview("fr land");
    await replies(p, APPROVED_PUBLISH, { kind: "approve" });
    const out = await tickFor(p.id);
    expect(out.summary).toMatch(/Landing approved after the preview; LAND queued/);
    const row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent, "no rebuild of a preview he approved").toBeNull();
    expect(row.land_approved_at).toBeTruthy();
    expect(row.land_approved_by).toBe("fu_scooter_taylor");
    expect((await liveJob(p.id))?.purpose).toMatch(/LAND/);
    expect((await decisionsLogged(p.id)).at(-1)).toMatchObject({ used: "FIRST_READ", first_read: "approve" });
  });

  it("with no first read nothing moves for ten minutes; then the keywords act (rebuild + landing approval) and say so", async () => {
    const p = await atPreview("fr land fallback");
    const inm = await replies(p, APPROVED_PUBLISH);
    expect(await sweepWouldStart(p.id), "his words wait for the first read").toBe(false);
    let row = (await readWebPropertyChange(env, p.id))!;
    expect([row.refresh_intent, row.land_approved_at]).toEqual([null, null]);
    await aged(p.id, inm, 11);
    await tickFor(p.id);
    row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent, "the keyword path: his words rebuilt").toBe("CHANGES");
    expect(row.land_approved_at, "…and it lands on green").toBeTruthy();
    expect((await decisionsLogged(p.id)).at(-1)).toMatchObject({ what: "the reply to the preview", used: "KEYWORD", first_read: null });
  });
});

describe("rebuild", () => {
  it("a quiet change the keywords read as go-ahead: the first read's change rebuilds, nothing lands", async () => {
    const p = await atPreview("fr rebuild");
    await replies(p, QUIET_CHANGE, { kind: "change" });
    await tickFor(p.id);
    const row = (await readWebPropertyChange(env, p.id))!;
    expect(row.refresh_intent).toBe("CHANGES");
    expect(row.land_approved_at, "a change lands nothing").toBeNull();
    expect((await decisionsLogged(p.id)).at(-1)).toMatchObject({ used: "FIRST_READ", first_read: "change", keyword: null });
  });

  it("with no first read it waits, then the keywords read it as go-ahead and land it, logged as the fallback", async () => {
    const p = await atPreview("fr rebuild fallback");
    const inm = await replies(p, QUIET_CHANGE);
    expect(await sweepWouldStart(p.id)).toBe(false);
    expect((await readWebPropertyChange(env, p.id))!.land_approved_at).toBeNull();
    await aged(p.id, inm, 11);
    await tickFor(p.id);
    expect((await readWebPropertyChange(env, p.id))!.land_approved_at).toBeTruthy();
    expect((await decisionsLogged(p.id)).at(-1)).toMatchObject({ used: "KEYWORD" });
  });
});

describe("hand-off refusal (#546)", () => {
  const notHandedOff = (from: number) => sent.slice(from).filter((m) => m.to === SCOOTER && /not handed off/i.test(m.subject));

  it("'Please move it to Productions dashboard project': the first read sees no hand-off, so no refusal and his change is built", async () => {
    const p = await atPreview("fr move");
    const before = sent.length;
    await replies(p, "Hey Porter!\n\nPlease move it to Productions dashboard project. Nothing about Top Barz should change.", { kind: "change", handOffTo: null });
    await tickFor(p.id);
    expect(notHandedOff(before), "never a 'not handed off' email").toHaveLength(0);
    expect((await readWebPropertyChange(env, p.id))!.refresh_intent).toBe("CHANGES");
    // The word lists never ran while the first read was there: no "hand to Productions" guess to overrule or log.
    const logged = await decisionsLogged(p.id);
    expect(logged.find((d) => d.what === "the hand-off"), "no keyword hand-off read").toBeUndefined();
    expect(logged.filter((d) => d.keyword !== null && d.used === "FIRST_READ"), "nothing the word lists read beside a first read").toEqual([]);
  });

  it("'Hand this to Bob.' with no first read: nothing is said at the door or before the wait; then the keywords refuse it", async () => {
    const p = await atPreview("fr bob");
    const before = sent.length;
    const inm = await replies(p, "Hand this to Bob.");
    expect(notHandedOff(before), "the door does not refuse before the first read").toHaveLength(0);
    expect(await sweepWouldStart(p.id)).toBe(false);
    expect(notHandedOff(before)).toHaveLength(0);
    await aged(p.id, inm, 11);
    // The first-read step finds no reader answered within the ten minutes: the keywords decide, logged. (Older emails
    // in the store are read first, a few a tick, so tick until his has settled.)
    for (let i = 0; i < 10 && !(await env.WP_OS_DB.prepare("SELECT 1 AS x FROM partner_understood WHERE inbound_message_id = ?1 AND state <> 'CLAIMED'").bind(inm).first()); i++) {
      await sweepOnce(env, new Date(), RUNNERS);
    }
    expect(notHandedOff(before), "refused once the wait is over").toHaveLength(1);
    expect((await card(p.id)).state, "a hand-off is never the answer: the preview still waits on him").toBe("BLOCKED");
    expect((await readWebPropertyChange(env, p.id))!.land_approved_at, "and nothing lands").toBeNull();
    expect((await decisionsLogged(p.id)).find((d) => d.what === "the hand-off")).toMatchObject({ used: "KEYWORD", keyword: "hand to Bob" });
  });
});

describe("plan approval (#546)", () => {
  const planReport = { phase: "PLAN", status: "ok", accounting: [{ ask: "quote tool", how: "build", done_when: ["it works on the preview"] }], document: "# Plan: quote tool", decided: [], asks: [{ question: "Contingency on owner hours?", recommended: "Yes." }], publish_ready: true, placeholders: [] };

  it("'Let me review the plan before anything is built': the first read's planApproved:false holds the plan the keywords would approve", async () => {
    const id = await opened("fr plan", `quote tool: westpeek.ventures. Let me review the plan before anything is built. package: https://drive.google.com/drive/folders/${FOLDER}frplan`);
    await hisEmail(id, new Date(Date.now() - 60_000).toISOString(), { kind: "change", planApproved: false });
    await tickFor(id);
    await macReports(id, planReport);
    await tickFor(id);
    expect((await card(id)).state).toBe("BLOCKED");
    expect((await readWebPropertyChange(env, id))!.plan_approved_at, "never approved on his behalf").toBeNull();
    expect((await decisionsLogged(id)).find((d) => d.what === "whether the plan waits for him")).toMatchObject({ used: "FIRST_READ", first_read: "waits for him", keyword: "approved" });
  });

  it("'Please confirm the plan' with no first read: the keywords hold the plan, logged as the fallback", async () => {
    const id = await opened("fr plan fallback", `quote tool: westpeek.ventures. Please confirm the plan and remaining gaps. package: https://drive.google.com/drive/folders/${FOLDER}frplfb`);
    await hisEmail(id, new Date(Date.now() - 11 * 60_000).toISOString());
    await tickFor(id);
    await macReports(id, planReport);
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.plan_approved_at).toBeNull();
    expect(String((await card(id)).description)).toMatch(/first read absent: keyword fallback \(whether the plan waits for him: waits for him\)/);
  });
});

describe("re-target the property (#542)", () => {
  /*
   * His 19 Nov words said "not connected to Top Barz"; the keywords now judge that whole sentence and no longer file it
   * there (tests/wholeSentence.test.ts). A mention the keywords still misread keeps the first read's proof honest.
   */
  const REQUEST = `Hey Porter!\n\nOne combined update for the Productions dashboard. Top Barz keeps its look as it is.\n\n1. Quote tool\n\npackage: https://drive.google.com/drive/folders/${FOLDER}`;

  it("the first read's property re-targets the job the keywords filed under Top Barz, before the plan is parked", async () => {
    const id = await opened("fr site", `${REQUEST}site01`);
    expect((await readWebPropertyChange(env, id))!.target_repo, "the keywords' pick").toBe("topbarz-voting");
    await hisEmail(id, new Date(Date.now() - 60_000).toISOString(), { kind: "change", property: "westpeekproductions.com" });
    await tickFor(id);
    const row = (await readWebPropertyChange(env, id))!;
    expect([row.target_repo, row.property_host]).toEqual(["join-west-peek-main", "westpeekproductions.com"]);
    expect(JSON.parse(String((await liveJob(id))?.job_json ?? "{}")).target_repo, "the PLAN is parked for the repo he meant").toBe("join-west-peek-main");
    expect((await decisionsLogged(id)).find((d) => d.what === "the site")).toMatchObject({ used: "FIRST_READ", first_read: "westpeekproductions.com", keyword: "voting.topbarz.xyz" });
  });

  it("with no first read the plan is not parked for ten minutes; then it goes where the keywords put it", async () => {
    const id = await opened("fr site fallback", `${REQUEST}site02`);
    const inm = await hisEmail(id, new Date().toISOString());
    expect(await sweepWouldStart(id)).toBe(false);
    expect(await liveJob(id), "nothing parked before the first read").toBeNull();
    await env.WP_OS_DB.prepare("UPDATE inbound_message SET received_at = ?2 WHERE id = ?1").bind(inm, new Date(Date.now() - 11 * 60_000).toISOString()).run();
    await tickFor(id);
    expect((await readWebPropertyChange(env, id))!.target_repo).toBe("topbarz-voting");
    expect(await liveJob(id)).not.toBeNull();
    expect((await decisionsLogged(id)).find((d) => d.what === "the site")).toMatchObject({ used: "KEYWORD", keyword: "voting.topbarz.xyz" });
  });
});
