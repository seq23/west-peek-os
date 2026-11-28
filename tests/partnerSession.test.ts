import { replyIntent } from "./helpers/aiShapes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard, systemIdentity } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { parseReplyIntent, type ReplyIntentReader } from "../src/worker/services/replyIntent";
import { openChiefTurn, questionEmail, redirectSession, runPartnerSessionCard } from "../src/worker/services/partnerSession";
import { reportRun } from "../src/worker/ai/subscriptionSeats";
import { recordPartnerConstraints } from "../src/worker/services/partnerConstraints";
import { handleRequest } from "../src/worker/index";
import { PARTNERS } from "../src/shared/registry/partners";

/**
 * EMAILING THE OS FEELS LIKE TYPING TO CLAUDE (14 Nov 2026), steps 2 to 6: an email no fixed door claims becomes ONE
 * session on the Mac (a LOCAL_JOB with no router stopwatch), the unclear words are asked about with options while the
 * clear work keeps going, a correction redirects running work, and the partner's memory opens every prompt.
 */

const routerCalls: string[] = [];
const draftCalls: { providerKey: string; prompt: string; neverPaid: boolean }[] = [];
let geminiDraft: string | null = null;
vi.mock("../src/worker/ai/runAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker/ai/runAi")>();
  return {
    ...actual,
    runAi: async (_env: unknown, input: import("../src/worker/ai/runAi").RunAiInput) => {
      routerCalls.push(input.purpose);
      if (input.purpose === "Chief session draft after seat outage") {
        const providerKey = input.budgetContext?.providerKey ?? "";
        draftCalls.push({ providerKey, prompt: input.inputs.join("\n"), neverPaid: input.budgetContext?.neverPaid === true });
        if (providerKey === "google_free" && geminiDraft) return { run: { id: "run_draft", status: "COMPLETED", output_text: geminiDraft } };
      }
      return { run: { id: `run_${routerCalls.length}`, status: "FAILED", output_text: null, failure_reason: "no model in this test" } };
    },
  };
});

let t: TestDb;
let env: Env;
const SCOOTER = "scooter@westpeek.ventures";
const MAC = "mac-test-jobs";

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker', 'aie_wren', 'aie_wyatt')").run();
});
afterAll(async () => disposeTestDb(t));

const unclear: ReplyIntentReader = async (_env, input) => ({ ...parseReplyIntent(replyIntent({ intent: "CONTINUE", door: "ANSWER", reason: "several asks" }), input.text), aiRunId: null });

async function emailed(subject: string, body: string): Promise<string> {
  return openAssignmentCard(env, { subject, partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: body, limits: EMAILED_TASK_LIMITS, emlKey: null, readWords: unclear });
}
async function runs(cardId: string) {
  return ((await env.WP_OS_DB.prepare("SELECT id, status, run_kind, max_seconds, job_json FROM subscription_seat_run WHERE work_card_id = ?1 ORDER BY created_at, rowid").bind(cardId).all<{ id: string; status: string; run_kind: string; max_seconds: number; job_json: string }>()).results ?? []);
}
async function card(cardId: string) {
  return (await env.WP_OS_DB.prepare("SELECT id, title, kind, owner_id, state, COALESCE(work_attempts,0) AS work_attempts, firm_scope, requested_by_email FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; title: string; kind: string; owner_id: string; state: string; work_attempts: number; firm_scope: string; requested_by_email: string }>())!;
}
/** The Mac claims the run and reports what the session wrote. */
async function macReports(runId: string, report: unknown) {
  await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = ?2, claimed_at = ?3 WHERE id = ?1").bind(runId, MAC, new Date().toISOString()).run();
  return reportRun(env, { runId, deviceId: MAC, outputText: JSON.stringify(report) });
}
async function notices(cardId: string, kind: string) {
  return ((await env.WP_OS_DB.prepare("SELECT cause FROM work_card_notice WHERE work_card_id = ?1 AND kind = ?2").bind(cardId, kind).all<{ cause: string }>()).results ?? []);
}

describe("step 2 · the email becomes a working session", () => {
  it("a mixed-ask email no fixed door claims opens ONE partner-session card on the chief's desk, not a dead end", async () => {
    const id = await emailed("A few things", "Can you look up who runs seed at Hustle Fund, draft a thank-you to Maya for Tuesday, and tell me what is on for Thursday?");
    const cards = ((await env.WP_OS_DB.prepare("SELECT id, kind, owner_id FROM work_card WHERE id = ?1 OR assigned_from_card_id = ?1").bind(id).all<{ id: string; kind: string; owner_id: string }>()).results ?? []);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ kind: "PARTNER_SESSION", owner_id: "aie_walker" });
    const row = await env.WP_OS_DB.prepare("SELECT requested_by, request_text FROM partner_session WHERE work_card_id = ?1").bind(id).first<{ requested_by: string; request_text: string }>();
    expect(row?.requested_by).toBe(SCOOTER);
    expect(row?.request_text).toMatch(/Hustle Fund[\s\S]*Thursday/);
  });
});

describe("step 3 · no stopwatch", () => {
  it("records a shared block and never queues a session assigned to the wrong chief", async () => {
    const id = await emailed("Office request", "Draft an outline from the attached material.");
    await env.WP_OS_DB.prepare("UPDATE work_card SET owner_id = 'aie_wren' WHERE id = ?1").bind(id).run();
    expect(await runPartnerSessionCard(env, await card(id))).toMatchObject({ finished: false, blocked: true });
    expect(await runs(id)).toHaveLength(0);
    const blocked = await env.WP_OS_DB.prepare("SELECT state, block_reason FROM work_card WHERE id = ?1").bind(id).first();
    expect(blocked).toEqual({ state: "BLOCKED", block_reason: "the_brief_is_missing" });
  });

  it("accepts the partner's page message with default firm scope and refuses the other partner", async () => {
    const path = "https://test.local/api/workforce/employees/aie_walker/messages";
    const message = "Prepare an outline for tomorrow.";
    const call = (email: string, method: "GET" | "POST") => handleRequest(new Request(path, {
      method, headers: { "x-wpos-dev-user": email, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify({ message }) : undefined,
    }), env);
    const otherPartner = PARTNERS.find((partner) => partner.email !== SCOOTER)!;
    const accepted = await call(SCOOTER, "POST");
    expect(accepted.status).toBe(202);
    const { id } = await accepted.json() as { id: string };
    expect(await (await call(SCOOTER, "GET")).json()).toMatchObject({ messages: [{ id, source: "PAGE", request_text: message }] });
    expect((await call(otherPartner.email, "GET")).status).toBe(404);
    expect((await call(otherPartner.email, "POST")).status).toBe(404);
  });

  it("parking a session makes ONE LOCAL_JOB run under the two-hour ceiling, with no deadline and no router call", async () => {
    const id = await emailed("Research", "Find three Memphis angels who back consumer brands.");
    routerCalls.length = 0;
    const out = await runPartnerSessionCard(env, await card(id));
    expect(out).toMatchObject({ finished: false, blocked: false, held: true });
    const parked = await runs(id);
    expect(parked).toHaveLength(1);
    expect(parked[0]).toMatchObject({ status: "QUEUED", run_kind: "LOCAL_JOB", max_seconds: 7200 });
    const job = JSON.parse(parked[0]!.job_json);
    expect(job).toMatchObject({ card_kind: "PARTNER_SESSION", phase: "SESSION", script: "scripts/duties/partner-session.mjs" });
    expect(Object.keys(job).some((k) => /deadline/i.test(k))).toBe(false);
    // Held while the Mac has it: a second tick parks nothing more and calls nothing.
    await runPartnerSessionCard(env, await card(id));
    expect(await runs(id)).toHaveLength(1);
    expect(routerCalls).toEqual([]);
  });

  const seatsOut = { phase: "SESSION", status: "failed", reason: "Neither seat could take the turn.", waits_seconds: 1800, model_unavailable: true, routing: ["Claude Code was out of usage.", "Codex was out of usage."] };

  it("queues a free-route draft for seat review without closing the chief's request", async () => {
    const id = await openChiefTurn(env, systemIdentity(), "aie_walker", "SCHEDULE", "Sort the $25 community event tickets by section.", "west-peek");
    const withFreeRoutes = { ...env, WP_OS_CHIEF_WORKERS_AI_FREE_ONLY: "true", WP_GEMINI_API_KEY: "fixture-key" };
    draftCalls.length = 0;
    geminiDraft = "Group balcony tickets before floor tickets.";
    try {
      await runPartnerSessionCard(env, await card(id));
      const [first] = await runs(id);
      expect((await macReports(first!.id, seatsOut)).accepted).toBe(true);
      expect(await runPartnerSessionCard(withFreeRoutes, await card(id))).toMatchObject({ finished: false, held: true });
      expect(draftCalls.map((call) => call.providerKey)).toEqual(["workers_ai", "google_free"]);
      expect(draftCalls.every((call) => call.neverPaid && call.prompt.includes("$25 community event tickets"))).toBe(true);
      expect((await card(id)).state).toBe("IN_PROGRESS");
      expect(await notices(id, "DONE")).toHaveLength(0);
      const page = await handleRequest(new Request("https://test.local/api/workforce/employees/aie_walker/messages", { headers: { "x-wpos-dev-user": SCOOTER } }), env);
      const { messages } = await page.json() as { messages: { id: string }[] };
      expect(messages.find((message) => message.id === id)).toMatchObject({
        source: "SCHEDULE",
        report: { reply: expect.stringContaining("Gemini prepared a text draft for the next subscription seat to verify.") },
      });
      await runPartnerSessionCard(env, await card(id));
      expect(JSON.parse((await runs(id))[1]!.job_json).fallback_draft).toBe(geminiDraft);
    } finally {
      geminiDraft = null;
    }
  });

  it("retains and retries the exact request when every model is unavailable", async () => {
    const request = "Draft notes from the planning discussion.";
    const id = await emailed("All models out", request);
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    const initialRequest = JSON.parse(first!.job_json).request;
    expect(initialRequest).toContain(request);
    await macReports(first!.id, seatsOut);
    expect(await runPartnerSessionCard(env, await card(id))).toMatchObject({ finished: false, blocked: false, held: true });
    expect(await notices(id, "DONE")).toHaveLength(0);
    const session = await env.WP_OS_DB.prepare("SELECT run_count, request_text FROM partner_session WHERE work_card_id = ?1").bind(id).first();
    expect(session).toEqual({ run_count: 0, request_text: initialRequest });
    await runPartnerSessionCard(env, await card(id));
    expect(JSON.parse((await runs(id))[1]!.job_json)).toMatchObject({ request: initialRequest });
  });
});

describe("step 4 · start the clear parts, ask about the rest", () => {
  it("a half-clear email gets ONE question with options, the card is not blocked, and the clear ask keeps running", async () => {
    const id = await emailed("Two things", "Pull the Q3 pipeline numbers, and set up the thing with the Nashville folks.");
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    const report = {
      phase: "SESSION",
      status: "ok",
      asks: [
        { words: "Pull the Q3 pipeline numbers", status: "IN_PROGRESS", why: "half the companies read; the rest next", options: [] },
        { words: "the thing with the Nashville folks", status: "QUESTION", why: "two Nashville threads are open", options: ["the Nashville sponsor dinner", "the Nashville LP coffee"] },
      ],
    };
    expect((await macReports(first!.id, report)).accepted).toBe(true);
    const out = await runPartnerSessionCard(env, await card(id));
    expect(out.blocked).toBe(false);
    expect((await card(id)).state).toBe("IN_PROGRESS");
    const asked = await notices(id, "QUESTION");
    expect(asked).toHaveLength(1);
    const sent = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'QUESTION' AND sent_to = ?2").bind(id, SCOOTER).first<{ n: number }>();
    expect(sent!.n).toBe(1);
    // The clear ask is parked again at once: it keeps running while he answers.
    const after = await runs(id);
    expect(after).toHaveLength(2);
    expect(after[1]!.status).toBe("QUEUED");
    expect(JSON.parse(after[1]!.job_json).earlier_asks.map((a: { status: string }) => a.status)).toEqual(["IN_PROGRESS", "QUESTION"]);
    // The same question is never emailed twice.
    await macReports(after[1]!.id, report);
    await runPartnerSessionCard(env, await card(id));
    expect(await notices(id, "QUESTION")).toHaveLength(1);
  });

  it("every unclear item is asked, numbered, one email per round: his next email is a new round, the same one read again is not", async () => {
    const id = await emailed("Four things", "Pull the Q3 pipeline numbers, set up the Nashville thing, book the usual room, and send the deck to the new folks.");
    await runPartnerSessionCard(env, await card(id));
    const ask = (words: string) => ({ words, status: "QUESTION", why: `which ${words} he means`, options: ["one reading", "another reading"] });
    const going = { words: "Pull the Q3 pipeline numbers", status: "IN_PROGRESS", why: "half read", options: [] };
    const three = [ask("the Nashville thing"), ask("the usual room"), ask("the new folks")];
    const queued = async () => (await runs(id)).find((r) => r.status === "QUEUED")!;

    await macReports((await queued()).id, { phase: "SESSION", status: "ok", asks: [going, ...three] });
    await runPartnerSessionCard(env, await card(id));
    expect(await notices(id, "QUESTION"), "three unclear items: one email").toHaveLength(1);
    const email = questionEmail(three as never, [going] as never);
    expect(email.sections.filter((x) => /^\d+\. /.test(x.label)).map((x) => x.label)).toEqual(['1. "the Nashville thing"', '2. "the usual room"', '3. "the new folks"']);
    expect(email.sections[0]!.bullets[0]).toBe("What is missing: which the Nashville thing he means");

    // The same email read again, with a new unclear item found: still the same round, no second email.
    await macReports((await queued()).id, { phase: "SESSION", status: "ok", asks: [going, ...three, ask("the deck")] });
    await runPartnerSessionCard(env, await card(id));
    expect(await notices(id, "QUESTION"), "the same round never sends twice").toHaveLength(1);

    // His next email on the card raises something new: a new round, a second email.
    await env.WP_OS_DB.prepare(
      `INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope, work_card_id)
       VALUES ('inm_round_two', 'round-two@mail.test', 'inbound-email/2026-11-15/round-two.eml', ?1, 'os@joinwestpeek.com', 'Re: Four things', ?2, 10, ?3, 'west-peek', ?4)`,
    ).bind(SCOOTER, new Date().toISOString(), JSON.stringify({ passed: true, partner: SCOOTER }), id).run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(id).run();
    const next = await queued().catch(() => null);
    if (!next) await runPartnerSessionCard(env, await card(id));
    await macReports((await queued()).id, { phase: "SESSION", status: "ok", asks: [going, ask("the Memphis venue")] });
    await runPartnerSessionCard(env, await card(id));
    expect(await notices(id, "QUESTION"), "a new partner email is a new round").toHaveLength(2);
  });

  it("past five unclear items the email says the request reads several ways and gives a best reading for each, all listed", () => {
    const six = ["a", "b", "c", "d", "e", "f"].map((c) => ({ words: `item ${c}`, status: "QUESTION", why: `which ${c}`, options: [`best ${c}`, `other ${c}`] }));
    const email = questionEmail(six as never, []);
    expect(email.tldr).toMatch(/reads several ways/);
    const numbered = email.sections.filter((x) => /^\d+\. /.test(x.label));
    expect(numbered).toHaveLength(6);
    expect(numbered.map((x) => x.bullets)).toEqual(six.map((q) => [`What is missing: ${q.why}`, `My best reading: ${q.options[0]}`]));
  });

  it("an ask-first question from a page message is emailed to the chief's partner, never left only on the page (hard stop 11)", async () => {
    const accepted = await handleRequest(new Request("https://test.local/api/workforce/employees/aie_walker/messages", {
      method: "POST", headers: { "x-wpos-dev-user": SCOOTER, "content-type": "application/json" },
      body: JSON.stringify({ message: "Book the venue we talked about for the fixture showcase." }),
    }), env);
    const { id } = await accepted.json() as { id: string };
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    await macReports(first!.id, { phase: "SESSION", status: "ok", asks: [
      { words: "Book the venue", status: "QUESTION", why: "booking commits money, so it is yours to decide", options: ["I hold it and you pay", "skip it"] },
    ] });
    await runPartnerSessionCard(env, await card(id));
    const sent = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND kind = 'QUESTION' AND sent_to = ?2").bind(id, SCOOTER).first<{ n: number }>();
    expect(sent!.n).toBe(1);
    expect((await card(id)).state).toBe("IN_PROGRESS");
  });

  it("a report that asks without options is refused, never emailed as a question", async () => {
    const id = await emailed("Vague", "Handle the usual.");
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    await macReports(first!.id, { phase: "SESSION", status: "ok", asks: [{ words: "the usual", status: "QUESTION", why: "?", options: [] }] });
    const out = await runPartnerSessionCard(env, await card(id));
    expect(out.finished).toBe(false);
    expect(await notices(id, "QUESTION")).toHaveLength(0);
  });
});

describe("step 5 · a correction redirects running work", () => {
  it("a mid-run reply leaves one ABANDONED run, one new run with his words above the brief, a Changed course note, and no stale result", async () => {
    const id = await emailed("Deck notes", "Write up notes on the February deck for Scooter's call.");
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = ?2, claimed_at = ?3 WHERE id = ?1").bind(first!.id, MAC, new Date().toISOString()).run();
    const out = await redirectSession(env, id, "Use the March deck, not February.", SCOOTER);
    expect(out?.abandoned).toBe(first!.id);
    const all = await runs(id);
    expect(all.map((r) => r.status)).toEqual(["ABANDONED", "QUEUED"]);
    const job = JSON.parse(all[1]!.job_json);
    expect(job.corrections[0]).toBe("Use the March deck, not February.");
    // The abandoned run's late report is refused, so nothing it made can reach him.
    expect((await reportRun(env, { runId: first!.id, deviceId: MAC, outputText: JSON.stringify({ phase: "SESSION", status: "ok", asks: [{ words: "notes", status: "DONE", why: "February" }], reply: "Here are the February notes" }) })).accepted).toBe(false);
    const changed = await notices(id, "RECEIVED");
    expect(changed.filter((n) => n.cause.startsWith("changed-course:"))).toHaveLength(1);
    expect(await notices(id, "PREVIEW")).toHaveLength(0);
    expect(await notices(id, "DONE")).toHaveLength(0);
  });

  it("with partner email switched on, the Changed course note actually leaves (it failed the two-section format before 20 Nov 2026)", async () => {
    const live = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
    const out: string[] = [];
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.resend.com")) {
        out.push(String((JSON.parse(String(init?.body)) as { to: string[] }).to[0]));
        return new Response(JSON.stringify({ id: `re_${out.length}` }), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    });
    try {
      const id = await emailed("Pack", "Draft the diligence sheet.");
      await runPartnerSessionCard(live, await card(id));
      const [first] = await runs(id);
      await live.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = ?2, claimed_at = ?3 WHERE id = ?1").bind(first!.id, MAC, new Date().toISOString()).run();
      await redirectSession(live, id, "Also build the data room index.", SCOOTER);
      const went = await live.WP_OS_DB.prepare("SELECT sent, detail FROM work_card_notice WHERE work_card_id = ?1 AND cause LIKE 'changed-course:%'").bind(id).first<{ sent: number; detail: string | null }>();
      expect(went?.detail ?? "").not.toContain("does not meet the format");
      expect(went?.sent).toBe(1);
      expect(out).toEqual([SCOOTER]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a note typed on the card steers the live session the same way (a note is never accepted into a void)", async () => {
    const id = await emailed("Pack notes", "Draft the diligence sheet from the attached answers.");
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET status = 'CLAIMED', claimed_by = ?2, claimed_at = ?3 WHERE id = ?1").bind(first!.id, MAC, new Date().toISOString()).run();
    const note = (email: string) => handleRequest(new Request(`https://test.local/api/work-cards/${id}/notes`, {
      method: "POST", headers: { "x-wpos-dev-user": email, "content-type": "application/json" },
      body: JSON.stringify({ body: "Also build the data room index." }),
    }), env);
    expect((await note(PARTNERS.find((partner) => partner.email !== SCOOTER)!.email)).status).toBe(404);
    expect((await runs(id)).map((run) => run.status)).toEqual(["CLAIMED"]);
    const res = await note(SCOOTER);
    expect(res.status).toBe(201);
    const all = await runs(id);
    expect(all.map((r) => r.status)).toEqual(["ABANDONED", "QUEUED"]);
    expect(JSON.parse(all[1]!.job_json).corrections[0]).toBe("Also build the data room index.");
  });
});

describe("step 6 · per-partner memory", () => {
  it("a stored hold opens the parked prompt, and a remember line naming an LP is refused while a clean one is kept", async () => {
    await recordPartnerConstraints(env, SCOOTER, ["Never email the Atlanta sponsor list without asking me"], "test");
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, created_by) VALUES ('lp_oak','Oak Family Office','FAMILY_OFFICE','fu_scooter_taylor')").run();
    const id = await emailed("Memory", "Remember I like bullet points, and summarise the Oak Family Office call.");
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    expect(JSON.parse(first!.job_json).memory).toMatch(/Never email the Atlanta sponsor list/);
    await macReports(first!.id, { phase: "SESSION", status: "ok", asks: [{ words: "summarise the call", status: "DONE", why: "summary in the reply" }], reply: "Summary below.", remember: ["Scooter likes bullet points", "Oak Family Office is sensitive"] });
    const out = await runPartnerSessionCard(env, await card(id));
    expect(out.finished).toBe(true);
    const kept = ((await env.WP_OS_DB.prepare("SELECT body FROM partner_profile_line WHERE partner_email = ?1 AND kind = 'NOTE'").bind(SCOOTER).all<{ body: string }>()).results ?? []).map((r) => r.body);
    expect(kept).toContain("Scooter likes bullet points");
    expect(kept.some((b) => /Oak/.test(b))).toBe(false);
    // The next session he starts carries the kept line in its memory.
    const next = await emailed("Next", "Draft a two-line note to Wren about Friday.");
    await runPartnerSessionCard(env, await card(next));
    expect(JSON.parse((await runs(next))[0]!.job_json).memory).toMatch(/bullet points/);
  });
});

describe("step 7's guard meets a seat outage", () => {
  it("no seat to mark his asks is a wait: the attempt is handed back, the card is never Blocked, and no new session is parked", async () => {
    const { sweepOnce } = await import("../src/worker/services/workSweep");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')").run();
    const id = await emailed("Seat outage", "Send me the list of Memphis angels you found.");
    await env.WP_OS_DB.prepare("INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope) VALUES ('inm_outage', 'outage@x', 'k', ?1, 'os@joinwestpeek.com', 'Seat outage', ?2, 1, '{}', 'west-peek')").bind(SCOOTER, new Date().toISOString()).run();
    // His ask as the Got it stored it, in words the report does not repeat, so only the (failing) seat could mark it.
    await env.WP_OS_DB.prepare("INSERT INTO partner_ask (id, work_card_id, inbound_message_id, seq, words) VALUES ('pask_outage', ?1, 'inm_outage', 1, 'the angels list')").bind(id).run();
    await runPartnerSessionCard(env, await card(id));
    const [first] = await runs(id);
    await macReports(first!.id, { phase: "SESSION", status: "ok", asks: [{ words: "Memphis investors", status: "DONE", why: "eight names in the reply" }], reply: "Eight names below." });
    await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(id).run();
    let at = Date.now();
    for (let tick = 0; tick < 5; tick++) {
      at += 15 * 60_000; // past each seat wait
      await sweepOnce(env, new Date(at));
      const c = await card(id);
      expect(c.state, `tick ${tick}`).not.toBe("BLOCKED");
      expect(c.work_attempts, `tick ${tick}: no attempt spent on a seat outage`).toBeLessThanOrEqual(1);
      await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(id).run();
    }
    expect((await card(id)).state).toBe("IN_PROGRESS");
    expect(String((await env.WP_OS_DB.prepare("SELECT waiting_for FROM work_card WHERE id = ?1").bind(id).first<{ waiting_for: string }>())!.waiting_for)).toMatch(/^Waiting for a seat to mark each ask/);
    expect(await runs(id), "the finished work is offered again, never re-run").toHaveLength(1);
    expect(await notices(id, "DONE")).toHaveLength(0);
    expect(await notices(id, "STUCK")).toHaveLength(0);
  });
});
