import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { brandGateFor, contentHashes, contentTexts, runDrip } from "../src/worker/services/learningClub";
import { PAUSE_RAISED_SETTING, SEND_PAUSE_LOOP, applySendPauseApproval, changedLines } from "../src/worker/services/tlcSendPause";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { DRIP_DEPS } from "./helpers/tlcSamplesPdf";

/**
 * BRAND EMAILS NEVER STOP SILENTLY (owner, 4 Nov 2026). A pitch or playbook change voids her approval and closes the
 * send gate; she is told ONCE per new content, her "approve" reopens it, and the named stop clears. Fake data only.
 */
let t: TestDb;
let env: Env;
const sends: Array<{ to: string; subject: string; text: string }> = [];
/** What reached the Boss OS Open Loops intake, with the auth header it carried. */
const loops: Array<{ auth: string | null; body: Record<string, unknown> }> = [];
const SEQUOIA = "sequoia@westpeek.ventures";
const NOW = new Date("2026-11-05T15:00:00.000Z");
const auth = (a: string) => `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=${a.split("@")[1]} header.s=s1; spf=pass smtp.mailfrom=${a}; dmarc=pass header.from=${a.split("@")[1]}`;
const paused = () => sends.filter((s) => /Brand emails are paused/.test(s.subject));
const stops = async () => ((await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE event_type = 'tlc.send_paused' ORDER BY created_at, rowid").all<{ payload_json: string }>()).results ?? []).map((r) => JSON.parse(r.payload_json) as { loop: string; cleared: boolean });

beforeAll(async () => {
  t = await createTestDb();
  env = { ...makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_DOCUMENTS: t.docs } as Partial<Env>), RESEND_API_KEY: "re_test", WP_OS_EMAIL_SEND: "enabled", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_BOSS_OPEN_LOOPS_TOKEN: "fake-intake-token" } as Env;
  vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://boss.sequoiataylor.com/api/boss/open-loops/intake") {
      loops.push({ auth: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return new Response("{}", { status: 200 });
    }
    if (String(url).includes("api.resend.com")) {
      const b = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
      sends.push({ to: Array.isArray(b.to) ? b.to.join(",") : b.to, subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `re_${sends.length}` }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(url)}`);
  });
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')").bind(SEQUOIA).run();
  await env.WP_OS_DB.prepare("INSERT INTO tlc_event (id, month, event_date, slot, topic, angle, status, sponsor_categories_json, pitch_token) VALUES ('tlc_2027-03', '2027-03', '2027-03-18', 'EVENING', 'Build Your Own AI Agent', 'A hands-on evening.', 'TOPIC_READY', '[]', ?1)").bind("d".repeat(32)).run();
  // She approved the content as it stood, words kept.
  const h = await contentHashes(env);
  const w = await contentTexts(env);
  await env.WP_OS_DB.prepare("INSERT INTO tlc_setting (key, value) VALUES ('pitch_approved_hash', ?1), ('playbook_approved_hash', ?2), ('pitch_approved_text', ?3), ('playbook_approved_text', ?4), ('brand_send', 'on') ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(h.pitch, h.playbook, w.pitch, w.playbook).run();
  await env.WP_OS_DB.prepare("INSERT INTO outside_email_allow (item_type, item_id, allowed, changed_by) VALUES ('JOB','tlc_brand_sales',1,'test')").run();
});
afterEach(() => { sends.length = 0; });
afterAll(async () => { vi.unstubAllGlobals(); await disposeTestDb(t); });

describe("a pitch change pauses brand sending, and she is told once", () => {
  it("sending on: no notice, no stop", async () => {
    expect((await runDrip(env, NOW, "west-peek", DRIP_DEPS)).pause).toBe("sending is on");
    expect(paused()).toEqual([]);
    expect(await stops()).toEqual([]);
  });

  it("the pitch changes: exactly one notice per new content, naming the changed lines; the named stop is raised once", async () => {
    await env.WP_OS_DB.prepare("UPDATE tlc_event SET angle = 'A hands-on evening for builders.' WHERE id = 'tlc_2027-03'").run();
    expect((await brandGateFor(env)).open).toBe(false);
    const first = await runDrip(env, NOW, "west-peek", DRIP_DEPS);
    expect(first.pause).toMatch(/^paused; she was told \(TLP-[A-Z0-9]{6}\): the brand pitch changed \(open loops: 1 reported, 0 failed \(0 cleared\)\.\)$/);
    // One row on Boss OS Open Loops, by the one-call reporter: her words, the token by bearer, never in the body.
    expect(loops).toEqual([{ auth: "Bearer fake-intake-token", body: { repo: "seq23/west-peek-os", stop: "TLC_SEND_PAUSED", business: "west-peek-ventures", finish_line: "Learning Club brand emails are sending again", title: "Learning Club brand emails are paused", next_step: "Reply approve to Wynn's paused-emails email", owner: "sequoia" } }]);
    expect(paused()).toHaveLength(1);
    const mail = paused()[0]!;
    expect(mail.to).toBe(SEQUOIA);
    const flat = mail.text.replace(/=\r?\n/g, "").replace(/\*\*/g, "").replace(/\s+/g, " ");
    expect(flat).toContain("Brand emails are paused: the brand pitch changed on November 5, 2026. Reply 'approve' to restart.");
    expect(flat).toContain("Pitch · Now: A hands-on evening for builders.");
    expect(flat).toContain("Pitch · Was: A hands-on evening.");
    // The same content on the next passes: nothing more to her.
    await runDrip(env, new Date(NOW.getTime() + 20 * 60_000), "west-peek", DRIP_DEPS);
    await runDrip(env, new Date(NOW.getTime() + 40 * 60_000), "west-peek", DRIP_DEPS);
    expect(paused()).toHaveLength(1);
    expect(loops).toHaveLength(1);
    expect(await stops()).toEqual([expect.objectContaining({ loop: SEND_PAUSE_LOOP, cleared: false })]);
  });

  it("only her authenticated 'approve' on that thread counts; it reopens the gate, and the stop clears on the next pass", async () => {
    const ref = (await env.WP_OS_DB.prepare("SELECT value FROM tlc_setting WHERE key = ?1").bind(PAUSE_RAISED_SETTING).first<{ value: string }>())!.value;
    const reply = (from: string, body: string, a = auth(from)) => applySendPauseApproval(env, { fromHeader: `X <${from}>`, authenticationResults: a, subject: `Re: Wynn: Brand emails are paused · ${ref}`, body: `${body}\n\nRef ${ref}` });
    expect((await reply("someone@else.example", "approve")).handled).toBe(false);
    expect((await reply(SEQUOIA, "approve", "none")).handled).toBe(false);
    expect((await reply(SEQUOIA, "what changed exactly?")).handled).toBe(false);
    expect((await brandGateFor(env)).open).toBe(false);
    const ok = await reply(SEQUOIA, "approve");
    expect(ok).toMatchObject({ handled: true, ref });
    expect((await brandGateFor(env)).open).toBe(true);
    expect((await runDrip(env, new Date(NOW.getTime() + 60 * 60_000), "west-peek", DRIP_DEPS)).pause).toBe(`brand sending reopened; ${SEND_PAUSE_LOOP} cleared (open loops: 1 reported, 0 failed (1 cleared).)`);
    // The row closes: the reporter posts the known code as cleared.
    expect(loops.at(-1)).toEqual({ auth: "Bearer fake-intake-token", body: { repo: "seq23/west-peek-os", stop: "TLC_SEND_PAUSED", cleared: true } });
    expect((await stops()).map((s) => s.cleared)).toEqual([false, true]);
    expect(paused()).toEqual([]);
  });

  it("with no token here the reporter sends nothing and says so; a refused post never fails the caller", async () => {
    const { reportToOpenLoops } = await import("../src/worker/services/openLoops");
    const report = { repo: "seq23/west-peek-os", business: "west-peek-ventures", finish: "x", known: ["TLC_SEND_PAUSED"], stops: [] };
    const none = vi.fn();
    expect(await reportToOpenLoops(report, { token: "", fetchImpl: none })).toMatchObject({ sent: 0, skipped: 1, line: "open loops: not reported (no BOSS_OPEN_LOOPS_TOKEN here); 1 stop(s) would be sent." });
    expect(none).not.toHaveBeenCalled();
    expect(await reportToOpenLoops(report, { token: "t", fetchImpl: async () => new Response("no", { status: 401 }) })).toMatchObject({ sent: 0, failed: 1 });
  });

  it("lists the changed lines in plain words, and says so when the old words were not kept", () => {
    expect(changedLines("a\nb\nc", "a\nB\nc")).toEqual(["Now: B", "Was: b"]);
    expect(changedLines(null, "x")[0]).toMatch(/were not kept/);
  });
});
