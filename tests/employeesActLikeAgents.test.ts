import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { appendEvent } from "../src/worker/events";
import { closeReplacedRunBlocks, nagAt, REASK_DAYS, resurfaceStaleBlocks } from "../src/worker/services/blocks";
import { HIRE_WIDENING, KEEP_GOING_AFTER, openHireSearchCard, runHireSearchCard } from "../src/worker/services/productionsHire";
import { sweepOnce } from "../src/worker/services/workSweep";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { ACTION_REQUIRED, renderExecEmail } from "../src/shared/email/execEmail";
import { doneNotice, planNotice, previewNotice, previewReplyForms, questionNotice, stuckNotice } from "../src/shared/work/porterNotices";
import type { ReplyIntentReader } from "../src/worker/services/replyIntent";
import { saidNothing } from "./helpers/interpret";

/**
 * OS EMPLOYEES ACT LIKE INTELLIGENT AGENTS (her ruling 21 Nov 2026). What is proven:
 *   1. a recurring search that finds 0–1 new people widens its next go and says so in one line; it never blocks;
 *   2. no reply to the last 3 result emails → the next note asks once whether to keep going; "stop" pauses the duty;
 *   3. ACTION REQUIRED and a bold ask with its default ride on exactly the emails that wait on the partner;
 *   4. an unanswered question is asked again at ~2d, ~9d, then every ~14d, shorter, never the same words; a reply stops it;
 *   5. a recurring job's stuck card replaced by a later run is closed, touching nothing else.
 * How it breaks: a stranger's reply never answers or stops reminders; closing W42 never touches other weeks; a send that
 * fails is retried on the next sweep and never sent twice.
 */

let t: TestDb;
let env: Env;
const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
let resendDown = false;

const SCOOTER = "scooter@westpeek.ventures";
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=${who.split("@")[1]}; dmarc=pass`;
const DAY = 86_400_000;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as Partial<Env>);
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("api.resend.com")) {
      if (resendDown) return new Response(JSON.stringify({ message: "service unavailable" }), { status: 503 });
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string; html: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text, html: body.html });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    return new Response("ok", { status: 200 });
  });
  await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_walker')").run();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

beforeEach(() => {
  sent.length = 0;
  resendDown = false;
});

// ── 3 · ACTION REQUIRED ─────────────────────────────────────────────────────────────────────────

describe("ACTION REQUIRED and the bold ask ride on exactly the emails that wait on the partner", () => {
  const base = { cardId: "wc_x", previewLine: "https://p.example", title: "Homepage headline" };
  const waiting = [
    planNotice({ ...base, asks: [{ question: "Which photo?", options: [], recommendation: null } as never], missing: [] }),
    previewNotice({ ...base, placeholders: [] }),
    questionNotice({ ...base, question: ["Which photo?"], missing: [] }),
  ];
  const informing = [doneNotice({ ...base, liveUrls: ["https://live.example"], missing: [] } as never), stuckNotice({ ...base, blockedBy: "the Mac is off", next: "it runs when it wakes" })];

  it("every waiting notice: subject starts ACTION REQUIRED, the TL;DR opens with the reply in <strong> and the default", () => {
    for (const n of waiting) {
      const r = renderExecEmail({ employee: "Porter", ...n });
      expect(r.subject, n.what).toMatch(/^ACTION REQUIRED: Porter: /);
      expect(r.html).toMatch(/<strong>TL;DR:<\/strong> <strong>Reply [^<]+\.<\/strong> If I don't hear back, [^<]+\./);
      expect(r.text, "plain-text fallback").toMatch(/\*\*TL;DR:\*\* \*\*Reply [^*]+\.\*\* If I don't hear back, /);
    }
  });

  it("an email that needs nothing never says it", () => {
    for (const n of informing) {
      const r = renderExecEmail({ employee: "Porter", ...n });
      expect(r.subject).not.toContain(ACTION_REQUIRED.trim());
      expect(r.text).not.toMatch(/If I don't hear back/);
    }
  });
});

// ── 4 · the re-ask cadence, and how it breaks ───────────────────────────────────────────────────

const T0 = new Date("2026-11-20T12:00:00.000Z");
const CARD = "wc_cadence";

async function seedPorterBlock(id: string, blockedAt: Date): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, requested_by_email,
                            block_who, block_needed, block_reason, block_stopped, block_trying, block_actions_json, blocked_at, block_nag_at, block_nags, created_at)
     VALUES (?1, 'Build westpeekproductions.com: the dashboard', 'x', 'AI', 'aie_porter', 'BLOCKED', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'WEB_PROPERTY_CHANGE', ?2,
             'SCOOTER', 'Waiting on: your answer on which tracker tab to read. Why: two tabs look like the pipeline. To clear it by email: reply with the tab name.', 'a_question_for_you', 'two tabs look like the pipeline', 'the dashboard', '[{"key":"ANSWER","label":"Answer"}]', ?3, ?4, 0, ?3)`,
  ).bind(id, SCOOTER, blockedAt.toISOString(), nagAt(blockedAt, "a_question_for_you", 0)).run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, preview_only) VALUES (?1, 'join-west-peek-main', 'westpeekproductions.com', 'the dashboard', 'PLAN', 1)`,
  ).bind(id).run();
}

async function cardState(id: string) {
  return env.WP_OS_DB.prepare("SELECT state, block_nags, block_nag_at, block_answered_at FROM work_card WHERE id = ?1").bind(id).first<{ state: string; block_nags: number; block_nag_at: string | null; block_answered_at: string | null }>();
}

async function reply(from: string, cardId: string, words: string) {
  const token = (await env.WP_OS_DB.prepare("SELECT token FROM email_thread WHERE object_id = ?1 ORDER BY created_at ASC LIMIT 1").bind(cardId).first<{ token: string }>())!.token;
  return steerFromReply(env, { fromHeader: `<${from}>`, authenticationResults: GOOD_AUTH(from), subject: "Re: Porter: the dashboard", raw: `${words}\n`, inReplyTo: threadReference(token), references: null, emlKey: null, messageId: `${crypto.randomUUID()}@mail.example` });
}

describe("an unanswered question is asked again on the cadence", () => {
  it("re-asks at ~2d, ~9d and every ~14d after, each shorter and never the same words; a card is never left with no next re-ask", async () => {
    expect(REASK_DAYS).toEqual([2, 7, 14]);
    await seedPorterBlock(CARD, T0);
    // Each sweep runs a minute later than the one before it is due, so the clock it sets is always just passed.
    const at = (days: number, k = 0) => new Date(T0.getTime() + days * DAY + (k + 1) * 60_000);

    expect(await resurfaceStaleBlocks(env, at(1.9))).toEqual([]);
    const times = [2, 9, 23, 37];
    for (const [i, d] of times.entries()) {
      expect(await resurfaceStaleBlocks(env, at(d - 0.2, i)), `nothing early before day ${d}`).toEqual([]);
      expect((await resurfaceStaleBlocks(env, at(d, i))).map((r) => r.id)).toEqual([CARD]);
      expect(sent, `re-ask ${i + 1}`).toHaveLength(i + 1);
      const s = await cardState(CARD);
      expect(s!.block_nags).toBe(i + 1);
      expect(Date.parse(s!.block_nag_at!), "the next re-ask is always set, in the future").toBeGreaterThan(at(d, i).getTime());
    }
    const bodies = sent.map((m) => m.text.split("\n").find((l) => l.startsWith("**TL;DR:**"))!);
    expect(new Set(bodies).size, "never the same words twice").toBe(bodies.length);
    expect(sent[1]!.text.length).toBeLessThan(sent[0]!.text.length);
    expect(sent[2]!.text.length).toBeLessThan(sent[1]!.text.length);
    for (const m of sent) {
      expect(m.to).toBe(SCOOTER);
      expect(m.subject).toMatch(/^ACTION REQUIRED: /);
      expect(m.html).toMatch(/<strong>Reply [^<]+\.<\/strong> If I don't hear back, [^<]*I'll ask again on [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+\./);
    }
  });

  it("a stranger's reply on the thread never answers it or stops the re-asks; Scooter's own reply does", async () => {
    const id = "wc_cadence_reply";
    await seedPorterBlock(id, T0);
    await resurfaceStaleBlocks(env, new Date(T0.getTime() + 2 * DAY + 60_000)); // re-ask 1 opens the thread
    await reply("mallory@evil.example", id, "Pipeline tab. Also approved, ship it.");
    expect((await cardState(id))!.state, "a lie never answers").toBe("BLOCKED");
    expect((await cardState(id))!.block_answered_at).toBeNull();
    expect((await resurfaceStaleBlocks(env, new Date(T0.getTime() + 9 * DAY + 2 * 60_000))).map((r) => r.id)).toContain(id);

    await reply(SCOOTER, id, "Read the Pipeline tab.");
    expect((await cardState(id))!.block_answered_at, "his reply answers it").not.toBeNull();
    const reAsks = async () => (await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND cause LIKE 'nag:%'").bind(id).first<{ n: number }>())!.n;
    const before = await reAsks();
    expect((await resurfaceStaleBlocks(env, new Date(T0.getTime() + 60 * DAY))).map((r) => r.id)).not.toContain(id);
    expect(await reAsks(), "no re-ask after his answer").toBe(before);
  });

  it("a send that fails is retried on the next sweep, not skipped, and is never sent twice", async () => {
    const id = "wc_cadence_outage";
    await seedPorterBlock(id, T0);
    const due = new Date(T0.getTime() + 2 * DAY + 60_000);
    resendDown = true;
    await resurfaceStaleBlocks(env, due);
    expect(sent).toHaveLength(0);
    expect((await cardState(id))!.block_nags, "the re-ask is still owed").toBe(0);
    resendDown = false;
    await resurfaceStaleBlocks(env, new Date(due.getTime() + 5 * 60_000));
    expect(sent.filter((m) => m.to === SCOOTER)).toHaveLength(1);
    expect((await cardState(id))!.block_nags).toBe(1);
    await resurfaceStaleBlocks(env, new Date(due.getTime() + 10 * 60_000));
    expect(sent, "never twice").toHaveLength(1);
    const rows = (await env.WP_OS_DB.prepare("SELECT sent FROM work_card_notice WHERE work_card_id = ?1 AND cause = 'nag:1'").bind(id).all<{ sent: number }>()).results!;
    expect(rows).toEqual([{ sent: 1 }]);
  });
});

// ── 5 · a stuck card replaced by a later run ────────────────────────────────────────────────────

describe("a recurring job's stuck card is closed once a later run replaced it", () => {
  it("closes W42 as replaced, logged, and touches no other week's card or results", async () => {
    const mk = (id: string, week: string, state: string, created: string) =>
      env.WP_OS_DB.prepare(
        `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, block_who, block_reason, block_trying, block_stopped, block_needed, block_actions_json, blocked_at, block_nag_at, block_nags, created_at)
         VALUES (?1, ?2, 'x', 'AI', 'aie_walker', ?3, 'NORMAL', 'INTERNAL', 'west-peek', 'system:job', 'PRODUCTIONS_HIRE_SEARCH',
                 CASE WHEN ?3 = 'BLOCKED' THEN 'SCOOTER' END, CASE WHEN ?3 = 'BLOCKED' THEN 'nothing_new_since_last_time' END,
                 CASE WHEN ?3 = 'BLOCKED' THEN 'the hire search' END, CASE WHEN ?3 = 'BLOCKED' THEN 'every name was already sent' END,
                 CASE WHEN ?3 = 'BLOCKED' THEN 'say whether to widen' END, CASE WHEN ?3 = 'BLOCKED' THEN '[{"key":"ANSWER","label":"Answer"}]' END, ?4, ?4, 37, ?4)`,
      ).bind(id, `Walker: West Peek Productions hire search (${week})`, state, created).run();
    await mk("wc_w42", "2026-W42", "BLOCKED", "2026-10-12T14:00:00.000Z");
    await mk("wc_w45", "2026-W45", "DONE", "2026-11-03T14:00:00.000Z");
    await env.WP_OS_DB.prepare(
      `INSERT INTO productions_candidate (id, url, name, title, company, city, why, opening_line, fit_score, first_seen, last_seen, week, last_card_id, status, firm_scope)
       VALUES ('pc_w45', 'https://kept.example', 'Kept Person', 'Producer', 'x', 'NYC', 'sold sponsorships', 'hi', 8, '2026-11-03', '2026-11-03', '2026-W45', 'wc_w45', 'NEW', 'west-peek')`,
    ).run();
    const before = await env.WP_OS_DB.prepare("SELECT (SELECT COUNT(*) FROM productions_candidate) AS c, (SELECT state FROM work_card WHERE id = 'wc_w45') AS s").first<{ c: number; s: string }>();

    expect(await closeReplacedRunBlocks(env, T0)).toEqual(["wc_w42"]);
    const w42 = await env.WP_OS_DB.prepare("SELECT state, description, next_action FROM work_card WHERE id = 'wc_w42'").first<{ state: string; description: string; next_action: string }>();
    expect(w42!.state).toBe("CANCELLED");
    expect(w42!.description).toMatch(/closed as replaced by a later run \(card wc_w45\)/);
    const logged = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'work_card.replaced_by_later_run' AND object_id = 'wc_w42'").first<{ payload_json: string }>();
    expect(JSON.parse(logged!.payload_json)).toEqual({ later_card_id: "wc_w45" });
    const after = await env.WP_OS_DB.prepare("SELECT (SELECT COUNT(*) FROM productions_candidate) AS c, (SELECT state FROM work_card WHERE id = 'wc_w45') AS s").first<{ c: number; s: string }>();
    expect(after, "other weeks untouched").toEqual(before);
    expect(await closeReplacedRunBlocks(env, T0), "once").toEqual([]);
    await env.WP_OS_DB.prepare("DELETE FROM work_card WHERE id IN ('wc_w42', 'wc_w45')").run();
    await env.WP_OS_DB.prepare("DELETE FROM productions_candidate WHERE id = 'pc_w45'").run();
  });
});

// ── 1 + 2 · the hire search widens itself, asks once to keep going, pauses on stop ────────────

const REPEAT = { name: "Repeat Person", title: "Senior Experiential Producer (freelance)", company: "Independent", city: "Atlanta, GA", profile_url: "https://repeat.example", why: "Site lists sponsorship deals sold for three festivals.", opening_line: "Your festival work.", fit: 8 };
const keepAll = async (_e: unknown, _a: unknown, prompt: string) => {
  const start = prompt.indexOf("CANDIDATES:\n");
  const end = prompt.lastIndexOf("Return ONLY JSON");
  const body = JSON.parse(prompt.slice(start + "CANDIDATES:\n".length, end)) as Array<{ name: string; fit: number }>;
  return { ok: true, text: JSON.stringify({ verdicts: body.map((b) => ({ name: b.name, keep: true, fit: b.fit, reason: "fits the archetype" })) }), detail: "ok" };
};

async function runWeek(when: Date, search: (p: string) => string, readIntent?: ReplyIntentReader) {
  await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')").run();
  const opened = await openHireSearchCard(env, when);
  const prompts: string[] = [];
  const out = await sweepOnce(env, new Date(when.getTime() + 5 * 60_000), {
    productionsHire: (e, card) => runHireSearchCard(e, card, { search: async (_e, _a, p) => { prompts.push(p); return { ok: true, text: search(p), detail: "ok" }; }, judge: keepAll, urlStatus: async () => 200, now: new Date(when.getTime() + 5 * 60_000), readIntent, interpret: saidNothing }),
  });
  return { out, cardId: opened.cardId, prompts };
}

describe("the hire search acts on its own results", () => {
  it("a run whose only find is one repeat candidate widens its next go and says so in one line, never a BLOCKED card", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO productions_candidate (id, url, name, title, company, city, why, opening_line, fit_score, first_seen, last_seen, week, last_card_id, status, firm_scope)
       VALUES ('pc_repeat', 'https://repeat.example', 'Repeat Person', 'Producer', 'x', 'Atlanta', 'sold sponsorships', 'hi', 8, '2026-10-05', '2026-10-05', '2026-W41', 'wc_old', 'SEEN', 'west-peek')`,
    ).run();
    const { out, cardId, prompts } = await runWeek(new Date("2026-11-24T15:00:00.000Z"), () => JSON.stringify({ results: [REPEAT] }));
    expect(out.outcome, out.summary).toBe("DONE");
    expect(prompts[0]).not.toContain("WIDEN THIS SEARCH");
    expect(prompts[1]).toContain(HIRE_WIDENING.prompt);
    expect((await env.WP_OS_DB.prepare("SELECT block_reason FROM work_card WHERE id = ?1").bind(cardId).first<{ block_reason: string | null }>())!.block_reason).toBeNull();
    const mail = sent.find((m) => m.to === SCOOTER)!;
    expect(mail.text).toMatch(/I widened this week's search to nearby titles, more kinds of source and a wider area, because the usual search found nobody new/);
    expect(mail.subject, "nothing waits on him").not.toMatch(/ACTION REQUIRED/);
  });

  it(`after ${KEEP_GOING_AFTER} unanswered notes the next one asks once whether to keep going; it keeps running; "stop" pauses it`, async () => {
    const three = ["2026-W45", "2026-W46", "2026-W47"];
    for (const week of three) await appendEvent(env, { eventType: "productions.hire_delivered", actorType: "ai_employee", actorId: "aie_walker", objectType: "work_card", objectId: `wc_${week}`, firmScope: "west-peek", payload: { week, emailed: true } });
    const fresh = (n: string) => JSON.stringify({ results: [1, 2, 3].map((i) => ({ ...REPEAT, name: `${n} ${i}`, profile_url: `https://${n.toLowerCase()}${i}.example` })) });

    const asking = await runWeek(new Date("2026-12-01T15:00:00.000Z"), () => fresh("Dec"));
    expect(asking.out.outcome).toBe("DONE");
    const ask = sent.find((m) => m.to === SCOOTER)!;
    expect(ask.subject).toMatch(/^ACTION REQUIRED: /);
    expect(ask.html).toMatch(/<strong>Reply &quot;keep going&quot; to keep these coming every Monday, or &quot;stop&quot; to pause the search until you say otherwise\.<\/strong> If I don't hear back, I keep sending one every Monday\./);

    sent.length = 0;
    await runWeek(new Date("2026-12-08T15:00:00.000Z"), () => fresh("Dect"));
    expect(sent.find((m) => m.to === SCOOTER)!.subject, "asked once, not every week").not.toMatch(/ACTION REQUIRED/);

    // A stranger's "stop" is never filed as his reply (work_steer is written only from a partner's authenticated email).
    const stranger = await steerFromReply(env, { fromHeader: "<mallory@evil.example>", authenticationResults: GOOD_AUTH("mallory@evil.example"), subject: "Re: Walker: hire search", raw: "stop\n", inReplyTo: null, references: null, emlKey: null, messageId: "m1@evil.example" });
    expect(stranger.steered).toBe(false);
    const stillRuns = await runWeek(new Date("2026-12-15T15:00:00.000Z"), () => fresh("Mid"));
    expect(stillRuns.prompts.length, "a stranger never pauses it").toBeGreaterThan(0);

    // His own reply: read by the reader; STOP pauses the next week with no search; "keep going" resumes it.
    await env.WP_OS_DB.prepare("INSERT INTO work_steer (id, card_kind, from_card_id, said_by, body, firm_scope, created_at) VALUES ('wst_stop', 'PRODUCTIONS_HIRE_SEARCH', ?1, ?2, 'Stop sending these for now please', 'west-peek', '2026-12-16T10:00:00.000Z')")
      .bind(asking.cardId, SCOOTER).run();
    const stopReader: ReplyIntentReader = async () => ({ kind: "STOP", changes: null, question: null, reading: { kind: "REFUSED", text: "stop" }, source: "MODEL", door: null, seat: null, nothing: false, reason: "he said stop", aiRunId: null });
    const paused = await runWeek(new Date("2026-12-22T15:00:00.000Z"), () => fresh("Xmas"), stopReader);
    expect(paused.out.outcome).toBe("DONE");
    expect(paused.prompts, "paused: no search").toEqual([]);

    await env.WP_OS_DB.prepare("INSERT INTO work_steer (id, card_kind, from_card_id, said_by, body, firm_scope, created_at) VALUES ('wst_go', 'PRODUCTIONS_HIRE_SEARCH', ?1, ?2, 'keep going', 'west-peek', '2026-12-23T10:00:00.000Z')")
      .bind(asking.cardId, SCOOTER).run();
    const goReader: ReplyIntentReader = async () => ({ kind: "CONTINUE", changes: null, question: null, reading: { kind: "ANSWERS", text: "" }, source: "MODEL", door: null, seat: null, nothing: false, reason: "keep going", aiRunId: null });
    const resumed = await runWeek(new Date("2026-12-29T15:00:00.000Z"), () => fresh("Nye"), goReader);
    expect(resumed.prompts.length, "resumed").toBeGreaterThan(0);
  });
});

// ── follow-ups (21 Nov 2026): a clean preview offers two replies; every employee re-asks the same way ──────────

describe("a preview with no placeholders offers only approved / changes", () => {
  it("0 placeholders: two options, no 'placeholders included', no 'Missing items'; with placeholders, all four", () => {
    const clean = renderExecEmail({ employee: "Porter", ...previewNotice({ title: "Homepage headline", previewLine: "https://p.example", placeholders: [], cardId: "wc_x" }) });
    expect(clean.text).not.toMatch(/placeholders included|Missing items/);
    expect(clean.text).toMatch(/• \*\*approved\*\*: publish this preview\.\n• \*\*changes: …\*\*: I'll make them and send you a new preview\.\n\n/);
    expect(previewReplyForms(0)).toHaveLength(2);
    const gaps = renderExecEmail({ employee: "Porter", ...previewNotice({ title: "Homepage headline", previewLine: "https://p.example", placeholders: ["the logo", "the photo"], cardId: "wc_x" }) });
    expect(gaps.text).toMatch(/placeholders included/);
    expect(gaps.text.match(/Missing items \+/g)).toHaveLength(2);
  });
});

async function seedEmployeeBlock(id: string, owner: string, who: "SCOOTER" | "SEQUOIA", kind: string | null): Promise<void> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind,
                            block_who, block_needed, block_reason, block_stopped, block_trying, block_actions_json, blocked_at, block_nag_at, block_nags, created_at)
     VALUES (?1, 'Productions November leads note', 'x', 'AI', ?2, 'BLOCKED', 'NORMAL', 'INTERNAL', 'west-peek', 'system:job', ?3,
             ?4, 'Waiting on: which two organisations to lead with. Why: six fit equally. To clear it by email: reply with the two names.', 'a_question_for_you', 'six fit equally', 'the leads note', '[{"key":"ANSWER","label":"Answer"}]', ?5, ?6, 0, ?5)`,
  ).bind(id, owner, kind, who, T0.toISOString(), nagAt(T0, "a_question_for_you", 0)).run();
}

describe("every employee's card that waits on a partner is re-asked the same way, in that employee's name", () => {
  it("Walker's card (no requester email) waiting on Scooter: ACTION REQUIRED re-asks at ~2d and ~9d, from Walker, shorter, on the ledger", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state = 'BLOCKED'").run();
    await seedEmployeeBlock("wc_walker_wait", "aie_walker", "SCOOTER", null);
    await resurfaceStaleBlocks(env, new Date(T0.getTime() + 1.5 * DAY));
    expect(sent, "nothing before two days").toHaveLength(0);
    await resurfaceStaleBlocks(env, new Date(T0.getTime() + 2 * DAY + 60_000));
    await resurfaceStaleBlocks(env, new Date(T0.getTime() + 9 * DAY + 2 * 60_000));
    expect(sent.map((m) => m.to)).toEqual([SCOOTER, SCOOTER]);
    for (const m of sent) {
      expect(m.subject).toMatch(/^ACTION REQUIRED: Walker: Productions November leads note: still waiting on you/);
      expect(m.html).toMatch(/<strong>I need which two organisations to lead with: Reply with the two names\.<\/strong> If I don't hear back, I keep it where it is, carry on with anything that does not need you, and ask again on [A-Z][a-z]{2}, [A-Z][a-z]{2} \d+\./);
      expect(m.text, "spoken as Walker").toMatch(/— Walker/);
      expect(m.text).not.toMatch(/Porter/);
    }
    expect(sent[1]!.text).not.toBe(sent[0]!.text);
    const ledger = (await env.WP_OS_DB.prepare("SELECT kind, cause, sent FROM work_card_notice WHERE work_card_id = 'wc_walker_wait' ORDER BY cause").all<{ kind: string; cause: string; sent: number }>()).results!;
    expect(ledger).toEqual([{ kind: "QUESTION", cause: "nag:1", sent: 1 }, { kind: "QUESTION", cause: "nag:2", sent: 1 }]);
  });

  it("Preston's card waiting on Sequoia goes to Sequoia in Preston's name; a fault on our side is never emailed as a question", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state = 'BLOCKED'").run();
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id = 'aie_preston'").run();
    await seedEmployeeBlock("wc_preston_wait", "aie_preston", "SEQUOIA", null);
    await resurfaceStaleBlocks(env, new Date(T0.getTime() + 2 * DAY + 60_000));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("sequoia@westpeek.ventures");
    expect(sent[0]!.subject).toMatch(/^ACTION REQUIRED: Preston: /);

    sent.length = 0;
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state = 'BLOCKED'").run();
    await seedEmployeeBlock("wc_preston_fault", "aie_preston", "SEQUOIA", null);
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_reason = 'stopped_part_way' WHERE id = 'wc_preston_fault'").run();
    await resurfaceStaleBlocks(env, new Date(T0.getTime() + 3 * DAY));
    expect(sent, "a fault rings in the app, never as a question by email").toHaveLength(0);
  });

  it("a send that fails for a non-Porter card is retried on the next sweep and sent once", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state = 'BLOCKED'").run();
    await seedEmployeeBlock("wc_walker_outage", "aie_walker", "SCOOTER", null);
    const due = new Date(T0.getTime() + 2 * DAY + 60_000);
    resendDown = true;
    await resurfaceStaleBlocks(env, due);
    resendDown = false;
    await resurfaceStaleBlocks(env, new Date(due.getTime() + 5 * 60_000));
    await resurfaceStaleBlocks(env, new Date(due.getTime() + 10 * 60_000));
    expect(sent.filter((m) => m.to === SCOOTER)).toHaveLength(1);
  });
});
