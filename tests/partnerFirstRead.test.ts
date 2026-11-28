import { firstRead } from "./helpers/aiShapes";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { FIRST_READERS, FIRST_READ_WAIT_MINUTES, UNDERSTOOD_OUTPUT, maskedFreeRead, sendUnderstoodReplies, understand, type Reader } from "../src/worker/services/partnerUnderstood";
import { jsonSchemaOf } from "../src/worker/ai/structuredOutput";
import { NO_MODEL_READER } from "../src/shared/intake/inboundRead";
import { claimNextCard } from "../src/worker/services/workSweep";
import { practicesForCard } from "../src/worker/services/partnerConstraints";
import { handOffUnreadableMail } from "../src/worker/effects/inboundEmail";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { systemIdentity } from "../src/worker/services/dealIntake";
import { recordHeartbeat } from "../src/worker/ai/subscriptionSeats";

/**
 * EVERY PARTNER EMAIL GETS A FIRST READ (15 Nov 2026, west-peek-ventures brain: "Every partner email to os@ gets a
 * first read by Claude…", "How a partner email is handled", "Out of Claude usage never stops partner mail").
 *
 *   · the brief (every ask in his words, his holds, his files and what each is for) lands on the card before the
 *     employee starts, and the employee's own input carries the same brief;
 *   · the employee waits for it (up to ten minutes) while a reader that was there failed, and starts at ten minutes;
 *   · with every reader out, nobody waits: the Got it and the work come from the OS's own read at once;
 *   · through the real router: Workers AI reads it when Claude and Codex are out, and an email carrying a deal term
 *     never reaches the free Gemini lane (a route that trains);
 *   · the Mac fallback with its plan's usage spent goes straight to Sequoia's desk.
 *
 * Every word of the fixture is made up; it is shaped like a dashboard email (9 numbered changes, a questions
 * paragraph, a praise line), which is exactly ten asks.
 */

let t: TestDb;
let env: Env;
const store = new Map<string, Uint8Array>();
const sent: Array<{ to: string; subject: string; text: string }> = [];
const geminiCalls: string[] = [];
/** What the stubbed Gemini answers, given the request body it was sent; the default echoes one fixed ask. */
let geminiAnswer: ((body: string) => string) | null = null;
const SCOOTER = "scooter@westpeek.ventures";

const HOLDS = "Preview first, nothing live until I say so. No client names on it without my written OK.";
const DASHBOARD = [
  "Hey Porter!",
  "",
  "The pipeline home is in good shape. Nice work on the layout.",
  "",
  "Changes:",
  "",
  "1. Keep this pipeline studio-only.",
  "2. Rename \"New inquiries\" to \"Form submissions\".",
  "3. Start Discovery with a service picker.",
  "4. Rename \"Who is buying\" to \"Client\".",
  "5. Give me space to type answers on each Discovery step.",
  "6. Carry the selected services into the Quote, one line each.",
  "7. Let me choose flat or per-day pricing per service.",
  "8. Hide the venue fields for a livestream.",
  "9. Remove \"Source\" from the deal card.",
  "",
  "Before building the rest, let's clarify a Lead versus a Deal. Is a Lead anything that came in?",
  "",
  HOLDS,
].join("\n");
const FILES = ["wireframe.png", "pricing.xlsx"];

function readerSaying(name: string, text: string): Reader {
  return { name, read: async () => ({ ok: true, text, detail: "ok", reader: name }) };
}
const failing: Reader = { name: "CLAUDE", read: async () => ({ ok: false, text: "", detail: "the seat run timed out" }) };
const allOut: Reader[] = ["CLAUDE", "WORKERS_AI", "GEMINI"].map((name) => ({ name, read: async () => ({ ok: false, text: "", detail: "usage spent", out: true }) }));
const GOOD = firstRead({
  holds: ["Preview first, nothing live until I say so.", "No client names on it without my written OK."],
  files: [
    { filename: "wireframe.png", purpose: "the layout to follow for Discovery" },
    { filename: "pricing.xlsx", purpose: "the per-service prices for the Quote" },
  ],
  next: "Porter builds the nine changes on preview.",
});

let seq = 0;
async function partnerEmail(label: string, minutesAgo = 0, words = DASHBOARD): Promise<{ cardId: string; inm: string }> {
  seq += 1;
  const card = await createWorkCardInternal(env, systemIdentity(), { title: `Porter: dashboard ${label}`, description: "x", owner_type: "AI", owner_id: "aie_porter", priority: "NORMAL", firm_scope: "west-peek", next_action: "x" });
  await env.WP_OS_DB.prepare("UPDATE work_card SET requested_by_email = ?2 WHERE id = ?1").bind(card.id, SCOOTER).run();
  const key = `inbound-email/2026-11-15/first-read-${label}.eml`;
  store.set(key, new TextEncoder().encode([`From: Scooter Taylor <${SCOOTER}>`, "Subject: Re: Porter: dashboard", "", words].join("\r\n")));
  const inm = `inm_first_read_${label}`;
  const at = new Date(Date.now() - minutesAgo * 60_000 - 1_000).toISOString();
  await env.WP_OS_DB.prepare(
    `INSERT INTO inbound_message (id, message_id, r2_key, from_address, to_address, subject, received_at, bytes, mail_authority_json, firm_scope, work_card_id)
     VALUES (?1, ?2, ?3, ?4, 'os@joinwestpeek.com', 'Re: Porter: dashboard', ?5, 100, ?6, 'west-peek', ?7)`,
  ).bind(inm, `first-read-${label}-${seq}@mail.test`, key, `Scooter Taylor <${SCOOTER}>`, at, JSON.stringify({ passed: true, partner: SCOOTER }), card.id).run();
  for (const f of FILES) {
    await env.WP_OS_DB.prepare("INSERT INTO request_attachment (id, work_card_id, filename, media_type, bytes, eml_key) VALUES (?1, ?2, ?3, 'application/octet-stream', 10, ?4)").bind(`ra_${label}_${f}`, card.id, f, key).run();
  }
  return { cardId: card.id, inm };
}

/** Only this card is in reach of the sweep's claim: every other card is leased far away. */
async function claimable(cardId: string): Promise<boolean> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = '2999-01-01T00:00:00.000Z' WHERE id <> ?1").bind(cardId).run();
  await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL WHERE id = ?1").bind(cardId).run();
  const card = await claimNextCard(env, new Date());
  if (card) await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = NULL, work_attempts = 0, state = 'OPEN' WHERE id = ?1").bind(card.id).run();
  return card?.id === cardId;
}

const understoodRow = (inm: string) => env.WP_OS_DB.prepare("SELECT state, via, reader, brief_json, detail FROM partner_understood WHERE inbound_message_id = ?1").bind(inm).first<{ state: string; via: string | null; reader: string | null; brief_json: string | null; detail: string | null }>();
const gotIts = (from: number) => sent.slice(from).filter((m) => m.to === SCOOTER && /got it/i.test(m.subject));

beforeAll(async () => {
  t = await createTestDb();
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url instanceof Request ? url.url : url);
    if (u.includes("api.resend.com")) {
      const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string; text: string };
      sent.push({ to: body.to[0]!, subject: body.subject, text: body.text });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    if (u.includes("generativelanguage.googleapis.com")) {
      geminiCalls.push(String(init?.body ?? ""));
      const said = geminiAnswer ? geminiAnswer(String(init?.body ?? "")) : firstRead({ asks: ["Keep this pipeline studio-only."] });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: said }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }), { status: 200 });
    }
    throw new Error(`unexpected fetch in test: ${u}`);
  });
  env = makeTestEnv(t.db, {
    WP_OS_AI_EMAIL_PARTNERS: "enabled",
    WP_OS_EMAIL_SEND: "enabled",
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_DOCUMENTS: {
      put: async (key: string, body: Uint8Array | string) => { store.set(key, typeof body === "string" ? new TextEncoder().encode(body) : body); return { key }; },
      get: async (key: string) => { const b = store.get(key); return b ? { text: async () => new TextDecoder().decode(b), arrayBuffer: async () => b.slice().buffer } : null; },
    } as never,
  } as Partial<Env>);
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

describe("the brief comes first, and the employee waits for it", () => {
  it("a reader that failed holds the card; a reader that answers writes every ask, the holds and the files, then the card starts from them", async () => {
    const { cardId, inm } = await partnerEmail("waits");
    expect(await claimable(cardId), "nobody starts before the first read").toBe(false);

    const before = sent.length;
    await sendUnderstoodReplies(env, new Date(), [failing, ...allOut.slice(1)]);
    expect(gotIts(before), "no Got it before a real read").toHaveLength(0);
    expect((await understoodRow(inm))!.detail).toMatch(/^WAITING_FOR_READER/);
    expect(await claimable(cardId), "the employee keeps waiting while the reader is retried").toBe(false);

    await sendUnderstoodReplies(env, new Date(), [readerSaying("CLAUDE", GOOD)]);
    const asks = (await env.WP_OS_DB.prepare("SELECT words FROM partner_ask WHERE inbound_message_id = ?1 ORDER BY seq").bind(inm).all<{ words: string }>()).results!.map((a) => a.words);
    expect(asks, "nine numbered changes plus one questions item; the praise line and the holds are not asks").toHaveLength(10);
    expect(asks[0]).toBe("Keep this pipeline studio-only.");
    expect(asks[8]).toBe('Remove "Source" from the deal card.');
    const row = (await understoodRow(inm))!;
    expect(row.state).toBe("SENT");
    expect(row.reader).toBe("CLAUDE");
    const brief = JSON.parse(row.brief_json!) as { holds: string[]; files: Array<{ filename: string; purpose: string | null }> };
    expect(brief.holds).toEqual(["Preview first, nothing live until I say so.", "No client names on it without my written OK."]);
    expect(brief.files).toEqual([{ filename: "wireframe.png", purpose: "the layout to follow for Discovery" }, { filename: "pricing.xlsx", purpose: "the per-service prices for the Quote" }]);

    const got = gotIts(before);
    expect(got).toHaveLength(1);
    expect(got[0]!.text).toMatch(/\b10\b\** things you asked/);
    expect(got[0]!.text).toContain('"No client names on it without my written OK."');

    // The employee's own input is the same brief the Got it told him.
    const practices = await practicesForCard(env, cardId);
    for (const a of asks) expect(practices).toContain(a);
    expect(practices).toContain("No client names on it without my written OK.");
    expect(practices).toContain("pricing.xlsx: the per-service prices for the Quote");
    expect(practices).toContain("read by CLAUDE");
    expect(await claimable(cardId), "the brief is on the card, so the employee starts").toBe(true);
  });

  it(`at ${FIRST_READ_WAIT_MINUTES} minutes with no read, the card starts and the Got it comes from the OS's own read`, async () => {
    const { cardId, inm } = await partnerEmail("ten", FIRST_READ_WAIT_MINUTES + 1);
    // Held until the first-read step has reached his email (it also decides what the reply says about the card:
    // firstReadDecides.ts#decideReplyWords); past ten minutes that step settles it from the OS's own read at once.
    expect(await claimable(cardId), "not before the first-read step has reached it").toBe(false);
    const before = sent.length;
    await sendUnderstoodReplies(env, new Date(), [failing]);
    expect(await claimable(cardId), "past ten minutes nothing more holds the employee").toBe(true);
    expect(gotIts(before)).toHaveLength(1);
    const row = (await understoodRow(inm))!;
    expect([row.state, row.via, row.reader]).toEqual(["SENT", "FALLBACK", "OS"]);
    expect((JSON.parse(row.brief_json!) as { holds: string[] }).holds, "the OS's own read still finds his holds").toEqual(HOLDS.split(/(?<=\.) /));
  });

  it("with every reader out, nobody waits: the Got it goes at once from the OS's read and the employee starts", async () => {
    const { cardId, inm } = await partnerEmail("allout");
    const before = sent.length;
    await sendUnderstoodReplies(env, new Date(), allOut);
    expect(gotIts(before), "the Got it is not held for a reader that is not there").toHaveLength(1);
    expect(gotIts(before)[0]!.text).toMatch(/\b10\b\** things you asked/);
    const row = (await understoodRow(inm))!;
    expect([row.state, row.reader]).toEqual(["SENT", "OS"]);
    expect(await claimable(cardId)).toBe(true);
  });
});

describe("the reader ladder, through the real router", () => {
  beforeAll(async () => {
    await t.db
      .prepare(
        `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
         VALUES ('bp_first_read', 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, 'FREE_ONLY', 0, 'fu_sequoia_taylor')`,
      )
      .run();
    // Claude and Codex are awake and out of usage.
    for (const seat of ["claude_code", "codex"] as const) await recordHeartbeat(env, { seat, deviceId: "mac-test", hostname: "test-mac", capabilities: [] });
    await t.db.prepare("UPDATE subscription_seat_device SET exhausted_until = '2999-01-01T00:00:00.000Z', exhausted_reason = 'usage limit reached'").run();
  });

  const routed = (extra: Partial<Env>): Env => makeTestEnv(t.db, { GEMINI_API_KEY: "g", ...extra } as Partial<Env>);

  it("Workers AI reads it when Claude and Codex are out, and no free lane is asked", async () => {
    const seen: string[] = [];
    const ai = { run: async (model: string) => { seen.push(model); return { response: firstRead({ asks: ["Hide the venue fields for a livestream."], holds: ["Preview first, nothing live until I say so."], next: "On it." }) }; } };
    const out = await understand(routed({ AI: ai as unknown as Env["AI"] }), { subject: "venue", written: "Hide the venue fields for a livestream. Preview first, nothing live until I say so.", read: FIRST_READERS, employeeId: null, firmScope: "west-peek" });
    expect(out.brief.reader).toBe("WORKERS_AI");
    expect(seen.length).toBe(1);
    expect(out.asks).toEqual(["Hide the venue fields for a livestream."]);
    expect(out.brief.holds).toEqual(["Preview first, nothing live until I say so."]);
    expect(geminiCalls, "the free lane was never reached").toHaveLength(0);
  });

  /*
   * MASKED, NEVER BLOCKED (owner ruling, 19 Nov 2026). Gemini reads every partner email; deal terms and committed LPs'
   * names are stood in for before the request and put back in the brief. Rewritten from "never reaches Gemini" to the
   * new truth, at least as strictly: the request body is read and must carry none of them.
   */
  it("an email carrying a deal term is read by free Gemini with the terms masked, and the brief has them back", async () => {
    const before = geminiCalls.length;
    geminiAnswer = (body) => {
      const sheet = /\[deal term \d+\]/.exec(body)?.[0] ?? "?";
      return firstRead({ asks: [`Send the ${sheet} summary to the founder.`] });
    };
    const out = await understand(routed({}), { subject: "terms", written: "Send the term sheet summary to the founder. Keep the pre-money out of it.", read: FIRST_READERS, employeeId: null, firmScope: "west-peek" });
    geminiAnswer = null;
    expect(geminiCalls.length - before, "Gemini read it").toBe(1);
    const body = geminiCalls.at(-1)!;
    expect(body).not.toMatch(/term sheet/i);
    expect(body).not.toMatch(/pre-?money/i);
    expect(body).toMatch(/\[deal term 1\]/);
    expect(out.brief.reader).toBe("GEMINI");
    expect(out.asks, "the stand-in is mapped back to his words").toContain("Send the term sheet summary to the founder.");
  });

  it("a committed LP's name never appears in the Gemini request body, and the brief carries it back", async () => {
    await t.db.prepare("INSERT INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lpr_masked', 'Quillfeather Family Office', 'FAMILY_OFFICE', 'COMMITTED', 'test')").run();
    const before = geminiCalls.length;
    geminiAnswer = (body) => {
      const who = /\[Investor [A-Z]+\]/.exec(body)?.[0] ?? "?";
      return firstRead({ asks: [`Add ${who} to the welcome page.`], holds: [`Nothing live until I say so.`] });
    };
    const written = "Add Quillfeather Family Office to the welcome page. Nothing live until I say so.";
    const out = await understand(routed({}), { subject: "welcome", written, read: FIRST_READERS, employeeId: null, firmScope: "west-peek" });
    geminiAnswer = null;
    await t.db.prepare("DELETE FROM lp_record WHERE id = 'lpr_masked'").run();
    expect(geminiCalls.length - before, "Gemini read it, masked").toBe(1);
    expect(geminiCalls.at(-1)!).not.toMatch(/quillfeather/i);
    expect(geminiCalls.at(-1)!).toContain("[Investor A]");
    expect(out.brief.reader).toBe("GEMINI");
    expect(out.asks).toEqual(["Add Quillfeather Family Office to the welcome page."]);
  });

  it("free Gemini reads an email the privacy router clears, when Claude, Codex and Workers AI are out", async () => {
    const before = geminiCalls.length;
    const out = await understand(routed({}), { subject: "pipeline", written: "Keep this pipeline studio-only.", read: FIRST_READERS, employeeId: null, firmScope: "west-peek" });
    expect(out.brief.reader).toBe("GEMINI");
    expect(geminiCalls.length - before).toBe(1);
  });

  it("routes ordinary chief text unchanged and masks actual committed LPs and deal figures in the provider request", async () => {
    await t.db.prepare("INSERT INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lpr_chief_masked', 'Larkspur Lantern Holdings', 'FAMILY_OFFICE', 'COMMITTED', 'test')").run();
    const read = (prompt: string) => maskedFreeRead(routed({ WP_GEMINI_API_KEY: "fixture-key" }), { prompt, firmScope: "west-peek", employeeId: null, purpose: "Chief session draft after seat outage" }, "google_free", "chief-draft");
    try {
      const everyday = "Group the $25 community event tickets by section.";
      expect(await read(everyday)).toMatchObject({ ok: true, reader: "GEMINI" });
      expect(geminiCalls.at(-1)).toContain(everyday);
      const before = geminiCalls.length;
      geminiAnswer = () => "Draft for [Investor A].";
      expect(await read("Summarize the term sheet for Larkspur Lantern Holdings. It calls for a management fee of 1.75%.")).toMatchObject({ ok: true, text: "Draft for Larkspur Lantern Holdings." });
      expect(geminiCalls.length).toBe(before + 1);
      expect(geminiCalls.at(-1)).toContain("[Investor A]");
      expect(geminiCalls.at(-1)).not.toMatch(/Larkspur|term sheet|management fee|1\.75/i);
    } finally {
      geminiAnswer = null;
      await t.db.prepare("DELETE FROM lp_record WHERE id = 'lpr_chief_masked'").run();
    }
  });

  it("skips the free lane before dispatch if the LP records could not be read", async () => {
    const before = geminiCalls.length;
    const unreadable = routed({ WP_GEMINI_API_KEY: "fixture-key" });
    unreadable.WP_OS_DB = new Proxy(unreadable.WP_OS_DB, {
      get(target, key) {
        if (key === "prepare") return (sql: string) => {
          if (sql.includes("FROM lp_record r")) throw new Error("fixture DB read outage");
          return target.prepare(sql);
        };
        return Reflect.get(target, key);
      },
    });
    const result = await maskedFreeRead(unreadable, { prompt: "Summarize the notes.", firmScope: "west-peek", employeeId: null, purpose: "Chief session draft after seat outage" }, "google_free", "chief-draft");
    expect(result).toMatchObject({ ok: false, out: true, detail: expect.stringContaining("unreadable") });
    expect(geminiCalls).toHaveLength(before);
  });

  it("requires a verified free-only provider for chief fallback drafts", async () => {
    const ai = { run: vi.fn(async () => ({ response: "This binding would bill." })) };
    const input = { prompt: "Draft the event schedule.", firmScope: "west-peek", employeeId: null, purpose: "Chief session draft after seat outage" };
    const out = await maskedFreeRead(routed({ AI: ai as unknown as Env["AI"] }), input, "workers_ai", "chief-draft");
    expect(out.ok).toBe(false);
    expect(ai.run).not.toHaveBeenCalled();
    const before = geminiCalls.length;
    expect(await maskedFreeRead(routed({}), input, "google_free", "chief-draft")).toMatchObject({ ok: false, out: true });
    expect(geminiCalls).toHaveLength(before);
    const capped = await maskedFreeRead(routed({ AI: ai as unknown as Env["AI"], WP_CHIEF_WORKERS_AI_FREE_ONLY: "true" }), input, "workers_ai", "chief-draft");
    expect(capped).toMatchObject({ ok: true, reader: "WORKERS_AI" });
    expect(ai.run).toHaveBeenCalledTimes(1);
    ai.run.mockRejectedValue(new Error("Workers Free quota exhausted"));
    const quota = await maskedFreeRead(routed({ AI: ai as unknown as Env["AI"], WP_CHIEF_WORKERS_AI_FREE_ONLY: "true" }), input, "workers_ai", "chief-draft");
    expect(quota.ok).toBe(false);
    expect(geminiCalls).toHaveLength(before);
  });
});

describe("the Mac fallback with usage out", () => {
  it("goes straight to Sequoia's desk with the reason, and opens no session nobody can start", async () => {
    const { inm } = await partnerEmail("mac");
    const msg = (await env.WP_OS_DB.prepare("SELECT message_id FROM inbound_message WHERE id = ?1").bind(inm).first<{ message_id: string }>())!.message_id;
    const cardsBefore = Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n);
    const card = await handOffUnreadableMail(env, { messageId: msg, sender: SCOOTER, subject: "Re: Porter: dashboard", headers: new Headers({ from: SCOOTER }) });
    expect(card).toBeNull();
    expect(Number((await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card").first<{ n: number }>())!.n)).toBe(cardsBefore);
    const desk = await env.WP_OS_DB.prepare("SELECT title, body FROM notification WHERE firm_user_id = 'fu_sequoia_taylor' AND dedupe_key = ?1").bind(`inbound_email_hand_off_usage_out:${msg}`).first<{ title: string; body: string }>();
    expect(desk!.title).toMatch(/out of usage/);
    expect(desk!.body).toContain("usage is spent");
  });
});

describe("holds are constraints; his open questions are a list of their own", () => {
  it("the reader decides holds and questions; the word lists decide only when no model answered", async () => {
    const written = [
      "Don't delete or change those tracker rows.",
      "Whether to keep a separate livestream rate card is still open.",
      "I'm also questioning whether we need the Scale field.",
      "Is a Lead anything that came in?",
    ].join("\n");
    const open = ["Whether to keep a separate livestream rate card is still open.", "I'm also questioning whether we need the Scale field.", "Is a Lead anything that came in?"];
    // The reader is told what a hold and a question are (the shape's field descriptions), so the rule is the model's.
    const shape = JSON.stringify(jsonSchemaOf(UNDERSTOOD_OUTPUT));
    expect(shape).toContain("never a question or something he leaves open");
    expect(shape).toContain("including lines with no question mark");
    // A model read lands as the model said; a line it put in both lists lands once, as a question.
    const said = firstRead({ asks: ["Don't delete or change those tracker rows."], holds: ["Don't delete or change those tracker rows.", "Is a Lead anything that came in?"], questions: open });
    const read = await understand(env, { subject: "q", written, read: [readerSaying("CLAUDE", said)], employeeId: null, firmScope: "west-peek" });
    expect(read.brief.holds).toEqual(["Don't delete or change those tracker rows."]);
    expect(read.brief.questions).toEqual(open);
    // No regex is merged into a model read: what the model left out stays out.
    const fewer = await understand(env, { subject: "q", written, read: [readerSaying("CLAUDE", firstRead({ asks: ["Don't delete or change those tracker rows."], holds: ["Don't delete or change those tracker rows."], questions: ["Is a Lead anything that came in?"] }))], employeeId: null, firmScope: "west-peek" });
    expect(fewer.brief.questions).toEqual(["Is a Lead anything that came in?"]);
    // No model answered: the word lists read his sentences, a question is never a hold, and the log says so.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const os = await understand(env, { subject: "q", written, read: allOut, employeeId: null, firmScope: "west-peek" });
    expect(warn.mock.calls.some(([m]) => String(m).includes(NO_MODEL_READER))).toBe(true);
    warn.mockRestore();
    for (const q of open) expect(os.brief.holds, "the word lists' read: no question is a hold").not.toContain(q);
    expect(os.brief.questions).toEqual(open);
  });
});

describe("what the reader could not pin down", () => {
  it("an UNCLEAR line reaches the brief and the employee's input, which says to ask every item, numbered, and build the rest", async () => {
    const words = "Swap the hero photo for the new one. Move the pricing below the case studies.";
    const said = firstRead({ asks: ["Swap the hero photo for the new one.", "Move the pricing below the case studies."], unclear: [{ words: "Swap the hero photo for the new one", missing: "two new photos are attached and he does not say which" }, { words: "words he never wrote", missing: "dropped" }] });
    const { cardId, inm } = await partnerEmail("unclear", 0, words);
    await sendUnderstoodReplies(env, new Date(), [readerSaying("CLAUDE", said)]);
    const brief = JSON.parse((await understoodRow(inm))!.brief_json!) as { unclear: Array<{ words: string; missing: string }> };
    expect(brief.unclear).toEqual([{ words: "Swap the hero photo for the new one", missing: "two new photos are attached and he does not say which" }]);
    const practices = await practicesForCard(env, cardId);
    expect(practices).toContain("Before asking, try to resolve each one from the brain");
    expect(practices).toContain("numbered, in one email; never merge, drop or guess");
    expect(practices).toContain("say in your result how each one was resolved");
    expect(practices).toContain('"Swap the hero photo for the new one": two new photos are attached and he does not say which');
  });
});

describe("nothing he said is dropped", () => {
  it("twelve questions all reach the brief and the employee's input", async () => {
    const twelve = Array.from({ length: 12 }, (_, i) => `Should item ${i + 1} stay on the page?`);
    const { cardId, inm } = await partnerEmail("twelve", 0, ["Tidy the page.", ...twelve].join("\n"));
    await sendUnderstoodReplies(env, new Date(), [readerSaying("CLAUDE", firstRead({ asks: ["Tidy the page."], questions: twelve }))]);
    const brief = JSON.parse((await understoodRow(inm))!.brief_json!) as { questions: string[] };
    expect(brief.questions).toEqual(twelve);
    const practices = await practicesForCard(env, cardId);
    for (const q of twelve) expect(practices).toContain(q);
  });
});

describe("his questions are steady", () => {
  it("with no model the dashboard email gives the same questions every read; a model read's questions are only his words", async () => {
    const os = await understand(env, { subject: "d", written: DASHBOARD, read: allOut, employeeId: null, firmScope: "west-peek" });
    const again = await understand(env, { subject: "d", written: DASHBOARD, read: allOut, employeeId: null, firmScope: "west-peek" });
    expect(os.brief.questions.length).toBeGreaterThan(0);
    expect(again.brief.questions).toEqual(os.brief.questions);
    const model = await understand(env, { subject: "d", written: DASHBOARD, read: [readerSaying("CLAUDE", firstRead({ asks: ["The pipeline home is in good shape."], questions: ["Is a Lead anything that came in?", "Should the chart show every month since 2019?"] }))], employeeId: null, firmScope: "west-peek" });
    const asked = model.brief.questions.filter((q) => q.startsWith("Did you mean this as a hold? "));
    expect(model.brief.questions.filter((q) => !asked.includes(q)), "a question he never wrote is dropped").toEqual(["Is a Lead anything that came in?"]);
    // The holds he typed that this reader left out are asked, never lost (review of #574), each quoting his own line.
    expect(asked).toEqual(['Did you mean this as a hold? "Preview first, nothing live until I say so."', 'Did you mean this as a hold? "No client names on it without my written OK."']);
    for (const q of asked) expect(DASHBOARD).toContain(/"(.*)"$/.exec(q)![1]!);
  });
});

describe("what the firm already knows is never asked", () => {
  it("an unclear item a settled fact answers never reaches the brief, the employee's input or a question", async () => {
    // What the OS holds about him: his two businesses are separate, each with its own site.
    await env.WP_OS_DB.prepare("INSERT OR REPLACE INTO partner_profile (partner_email, firm_scope, who) VALUES (?1, 'west-peek', ?2)")
      .bind(SCOOTER, "Runs West Peek Productions (its own site) and, separately, the Top Barz contest site.").run();
    let sawFacts = false;
    const reader: Reader = {
      name: "CLAUDE",
      read: async (_e, input) => {
        sawFacts = input.prompt.includes("separately, the Top Barz contest site");
        // A reader that sees the email alone cannot tell the two apart; one that sees the settled facts can.
        return { ok: true, detail: "ok", reader: "CLAUDE", text: sawFacts ? firstRead({ asks: ["Keep this pipeline studio-only."] }) : firstRead({ asks: ["Keep this pipeline studio-only."], unclear: [{ words: "Keep this pipeline studio-only", missing: "is Top Barz part of the studio?" }] }) };
      },
    };
    const { cardId, inm } = await partnerEmail("settled", 0, "Keep this pipeline studio-only. Leave the Top Barz rows out.");
    await sendUnderstoodReplies(env, new Date(), [reader]);
    expect(sawFacts, "the reader's prompt carries what the firm already knows").toBe(true);
    expect((JSON.parse((await understoodRow(inm))!.brief_json!) as { unclear: unknown[] }).unclear).toEqual([]);
    expect(await practicesForCard(env, cardId)).not.toContain("Unclear.");
  });
});
