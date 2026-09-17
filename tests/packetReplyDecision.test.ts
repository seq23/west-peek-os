import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { applyReplyDecision, tokenForPacket } from "../src/worker/services/packetReplyDecision";
import { expiryFor, howToAnswer, mintToken, newTextOf, readReply, tagFor, TOKEN_LENGTH } from "../src/shared/events/packetDecisionToken";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";

/**
 * DECIDING A PACKET BY REPLYING — the threat model, proved.
 *
 * Operator: "you can have Parker give us a special #hashtag to use and anything after that is the
 * reason?" — answered with a token minted PER PACKET, because the rule the whole inbound design
 * turns on is that "a hashtag is a public word … it may route but must never authorise."
 *
 * The cases below are the threat model one per test: a guessed code, a leaked code, a forged
 * sender, a replayed thread, an expired month, and — the one that matters most in practice — a
 * reply that cannot be read confidently, which must become a capture rather than a guess. A
 * misread that declines the wrong month costs a month; a human glancing at an email costs ten
 * seconds.
 */

let t: TestDb;
let env: Env;

const SEQUOIA = "sequoia@westpeek.ventures";
const PARTNER_FROM = `Sequoia Taylor <${SEQUOIA}>`;
/** The real header shape Google Workspace produces for the partners' own mail. */
const genuineFrom = (address: string): string =>
  `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104; ` +
  `dmarc=none header.from=${address.split("@")[1]} policy.dmarc=none; ` +
  `spf=pass (${TRUSTED_AUTHSERV_ID}: domain of ${address} designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=${address}; arc=none`;
const PASSES = genuineFrom(SEQUOIA);
const FAILS = `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`;

async function packet(month = "2026-11", id = `rpk_${crypto.randomUUID()}`): Promise<string> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO evt_room_packet (id, title, theme, status, proposed_for_month, format, target_min, target_max, firm_scope, origin, kind, created_by)
     VALUES (?1, ?2, 'Community', 'PROPOSED', ?3, 'WORKSHOP', 20, 60, 'west-peek', 'PARKER', 'WORKSHOP', 'aie_parker')`,
  ).bind(id, `Packet ${id}`, month).run();
  return id;
}

const status = async (id: string): Promise<string> =>
  (await env.WP_OS_DB.prepare("SELECT status FROM evt_room_packet WHERE id = ?1").bind(id).first<{ status: string }>())!.status;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // Sequoia has to be a person in the OS for a decision to record who made it.
  await env.WP_OS_DB.prepare(
    "INSERT OR IGNORE INTO firm_user (id, email, full_name, status) VALUES ('fu_sequoia_taylor', ?1, 'Sequoia Taylor', 'ACTIVE')",
  ).bind(SEQUOIA).run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the token itself", () => {
  it("is minted per packet, once, and re-reading gives the SAME live code", async () => {
    const id = await packet();
    const first = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const again = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    // A re-sent email must carry the code the first one carried, or the older mail is dead.
    expect(again.token).toBe(first.token);
    expect(first.keepTag).toBe(`#wpkeep-${first.token}`);
    expect(first.noTag).toBe(`#wpno-${first.token}`);
    const rows = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM evt_packet_decision_token WHERE packet_id = ?1").bind(id).first<{ n: number }>();
    expect(rows!.n).toBe(1);
  });

  it("two packets never share a code", async () => {
    const a = await tokenForPacket(env, { id: await packet(), proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const b = await tokenForPacket(env, { id: await packet(), proposed_for_month: "2026-11", firm_scope: "west-peek" });
    expect(a.token).not.toBe(b.token);
  });

  it("uses only characters a person can read off a screen and retype", () => {
    for (let i = 0; i < 200; i += 1) {
      const tok = mintToken();
      expect(tok).toHaveLength(TOKEN_LENGTH);
      // No O/0, no I/1/L — the pairs that produce a support ticket rather than a decision.
      expect(tok).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    }
  });

  it("expires with the month the packet is FOR, not with some rolling window", () => {
    expect(expiryFor("2026-11")).toBe("2026-12-01T00:00:00.000Z");
    expect(expiryFor("2026-12")).toBe("2027-01-01T00:00:00.000Z");
  });
});

describe("reading a reply, and refusing to guess", () => {
  const TOK = "7Q4K";

  it("reads the answer and takes everything after the tag as the reason", () => {
    const r = readReply(`${tagFor("NO", TOK)} too close to the holidays, try January`);
    expect(r.decision).toBe("DECLINED");
    expect(r.token).toBe(TOK);
    expect(r.reason).toBe("too close to the holidays, try January");
    expect(r.unsure).toBeNull();
  });

  it("a bare tag with no reason is a complete answer", () => {
    const r = readReply(tagFor("KEEP", TOK));
    expect(r.decision).toBe("APPROVED");
    expect(r.reason).toBeNull();
  });

  /**
   * THE CASE THAT BREAKS A NAIVE PARSER, AND IT IS EVERY REPLY.
   *
   * Parker's email spells out BOTH tags with a worked example of each, because nobody should have
   * to remember the scheme. So every reply quotes both `#wpkeep-…` and `#wpno-…` below whatever
   * the partner typed. Scanning the whole body would find two contradictory answers in literally
   * every reply.
   */
  it("reads only the NEW text, ignoring the original quoted below it", () => {
    const body = [
      `${tagFor("NO", TOK)} not this month, the topic is too close to October's`,
      "",
      "On Wed, 1 Oct 2026 at 08:00, Parker <os@westpeek.ventures> wrote:",
      `> To keep it: reply with ${tagFor("KEEP", TOK)} — for example: "${tagFor("KEEP", TOK)} yes, book it".`,
      `> To say no: reply with ${tagFor("NO", TOK)} and your reason.`,
    ].join("\n");
    expect(newTextOf(body)).not.toContain("To keep it");
    const r = readReply(body);
    expect(r.decision).toBe("DECLINED");
    expect(r.reason).toBe("not this month, the topic is too close to October's");
  });

  it("handles the Outlook shape, which carries no 'On … wrote:' marker at all", () => {
    const body = [
      `${tagFor("KEEP", TOK)} yes`,
      "",
      "From: Parker <os@westpeek.ventures>",
      "Sent: Thursday, 1 October 2026 08:00",
      `Subject: your November Workshop`,
      `To say no: ${tagFor("NO", TOK)}`,
    ].join("\n");
    expect(readReply(body).decision).toBe("APPROVED");
  });

  it("UNSURE, NOT A GUESS: two different answers in the new text", () => {
    const r = readReply(`${tagFor("KEEP", TOK)} actually no ${tagFor("NO", TOK)} scrap it`);
    expect(r.decision).toBeNull();
    expect(r.unsure).toMatch(/both keep and no/);
  });

  it("UNSURE, NOT A GUESS: two different packets in one reply", () => {
    const r = readReply(`${tagFor("NO", TOK)} and also ${tagFor("NO", "9ABC")}`);
    expect(r.decision).toBeNull();
    expect(r.unsure).toMatch(/2 different codes/);
  });

  it("UNSURE, NOT A GUESS: the tag without the code", () => {
    const r = readReply("#wpno please, this one is not right");
    expect(r.decision).toBeNull();
    expect(r.unsure).toMatch(/without the code/);
  });

  it("an ordinary email is not a decision and is not an error either", () => {
    const r = readReply("Hi — can you send me last month's packet again? Thanks.");
    expect(r.decision).toBeNull();
    expect(r.unsure).toBeNull();
  });

  it("the email teaches the scheme: both answers worked through, and the code's limits stated", () => {
    const lines = howToAnswer({ token: TOK, what: "Workshop" }).join(" ");
    expect(lines).toContain(tagFor("KEEP", TOK));
    expect(lines).toContain(tagFor("NO", TOK));
    expect(lines).toMatch(/for example/i);
    expect(lines).toMatch(/works once/);
    expect(lines).toMatch(/stops working at the end of the month/);
    // No internal IDs a human has to copy.
    expect(lines).not.toMatch(/rpk_|packet_id|uuid/i);
  });
});

describe("applying a reply — two independent facts are required, and neither is enough", () => {
  it("a token AND an authenticated partner decides it, exactly where the button does", async () => {
    const id = await packet();
    const { token } = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const out = await applyReplyDecision(env, {
      fromHeader: PARTNER_FROM,
      authenticationResults: PASSES,
      subject: "Re: Parker: your November 2026 Workshop",
      body: `${tagFor("NO", token)} the angle is right but not for November`,
    });
    expect(out.capture, "the reply was refused").toBeNull();
    expect(out.decided).toBe(true);
    expect(out.packetId).toBe(id);
    expect(await status(id)).toBe("DECLINED");

    // THE SAME DOOR: decidePacket's own event and note, not a second decision path's.
    const ev = (await env.WP_OS_DB.prepare(
      "SELECT event_type FROM event_record WHERE object_id = ?1 ORDER BY created_at",
    ).bind(id).all<{ event_type: string }>()).results!.map((r) => r.event_type);
    expect(ev).toContain("room_packet.declined");
    expect(ev).toContain("room_packet.decided_by_email");
    const note = await env.WP_OS_DB.prepare("SELECT decision_note, decided_by FROM evt_room_packet WHERE id = ?1").bind(id).first<{ decision_note: string; decided_by: string }>();
    expect(note!.decision_note).toMatch(/the angle is right but not for November — decided by email from sequoia@westpeek.ventures/);
    expect(note!.decided_by).toBe("fu_sequoia_taylor");
  });

  it("A LEAKED TOKEN ALONE DOES NOTHING — a real code from an unauthenticated sender", async () => {
    const id = await packet();
    const { token } = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const out = await applyReplyDecision(env, {
      fromHeader: PARTNER_FROM, authenticationResults: FAILS, subject: "Re: your November Workshop",
      body: `${tagFor("NO", token)} cancel it`,
    });
    expect(out.decided).toBe(false);
    expect(out.capture).toMatch(/not accepted as coming from a Managing Partner/);
    expect(await status(id)).toBe("PROPOSED");
    // Unspent: the partner's own code still works afterwards.
    const row = await env.WP_OS_DB.prepare("SELECT used_at FROM evt_packet_decision_token WHERE token = ?1").bind(token).first<{ used_at: string | null }>();
    expect(row!.used_at).toBeNull();
  });

  it("A REAL PARTNER WITHOUT A CODE DOES NOTHING — authority is not the second half on its own", async () => {
    const out = await applyReplyDecision(env, {
      fromHeader: PARTNER_FROM, authenticationResults: PASSES, subject: "Re: November", body: `${tagFor("NO", "ZZZZ")} no thanks`,
    });
    expect(out.decided).toBe(false);
    expect(out.capture).toMatch(/do not recognise/);
    // And it says nothing about how close the guess was: there is nothing to probe against.
    expect(out.capture).not.toMatch(/expired|already used/);
  });

  it("AN AUTHENTICATED NON-PARTNER DOES NOTHING, even holding a real code", async () => {
    const id = await packet();
    const { token } = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const out = await applyReplyDecision(env, {
      fromHeader: "Contractor <someone@elsewhere.example>",
      authenticationResults: genuineFrom("someone@elsewhere.example"),
      subject: "Re: November", body: `${tagFor("NO", token)} killing this`,
    });
    expect(out.decided).toBe(false);
    expect(await status(id)).toBe("PROPOSED");
  });

  it("SINGLE USE: a replayed thread decides nothing the second time", async () => {
    const id = await packet();
    const { token } = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const msg = { fromHeader: PARTNER_FROM, authenticationResults: PASSES, subject: "Re: November", body: `${tagFor("KEEP", token)} yes` };
    expect((await applyReplyDecision(env, msg)).decided).toBe(true);
    expect(await status(id)).toBe("APPROVED");
    const replay = await applyReplyDecision(env, msg);
    expect(replay.decided).toBe(false);
    expect(replay.capture).toMatch(/already used/);
    expect(await status(id)).toBe("APPROVED");
  });

  it("EXPIRES WITH ITS MONTH: an old thread cannot decide a later one", async () => {
    const id = await packet("2026-01");
    const { token } = await tokenForPacket(env, { id, proposed_for_month: "2026-01", firm_scope: "west-peek" });
    const out = await applyReplyDecision(env, {
      fromHeader: PARTNER_FROM, authenticationResults: PASSES, subject: "Re: January", body: `${tagFor("NO", token)} no`,
    });
    expect(out.decided).toBe(false);
    expect(out.capture).toMatch(/expired with 2026-01/);
    expect(await status(id)).toBe("PROPOSED");
  });

  /**
   * THE PATH ITEM 7 SINGLES OUT: "Unsure means Porter, never a guess. … Test this path explicitly."
   */
  it("UNSURE GOES TO A HUMAN AND CHANGES NOTHING — even from an authenticated partner", async () => {
    const id = await packet();
    const { token } = await tokenForPacket(env, { id, proposed_for_month: "2026-11", firm_scope: "west-peek" });
    const out = await applyReplyDecision(env, {
      fromHeader: PARTNER_FROM, authenticationResults: PASSES, subject: "Re: November",
      body: `${tagFor("KEEP", token)} hmm actually ${tagFor("NO", token)} no`,
    });
    expect(out.decided).toBe(false);
    expect(out.attempted).toBe(true);
    expect(out.capture).toMatch(/both keep and no/);
    expect(await status(id)).toBe("PROPOSED");
    const unspent = await env.WP_OS_DB.prepare("SELECT used_at FROM evt_packet_decision_token WHERE token = ?1").bind(token).first<{ used_at: string | null }>();
    expect(unspent!.used_at).toBeNull();
  });

  it("every refusal is on the spine — a check that records nothing when it refuses never ran", async () => {
    const refusals = (await env.WP_OS_DB.prepare(
      "SELECT payload_json FROM event_record WHERE event_type = 'room_packet.reply_decision_refused'",
    ).all<{ payload_json: string }>()).results!;
    // RULE 0: this suite has produced refusals above; zero here means the recording is inert.
    expect(refusals.length).toBeGreaterThan(0);
    for (const r of refusals) {
      const payload = JSON.parse(r.payload_json) as { why: string; spf: string; dmarc: string; partner_authenticated: boolean };
      expect(payload.why.length).toBeGreaterThan(10);
      expect(payload.spf).toBeTruthy();
      expect(payload.dmarc).toBeTruthy();
      expect(typeof payload.partner_authenticated).toBe("boolean");
    }
  });

  it("an ordinary email is left entirely alone for the rest of the inbound ladder", async () => {
    const out = await applyReplyDecision(env, {
      fromHeader: PARTNER_FROM, authenticationResults: PASSES, subject: "#wpdealflow Northwind", body: "Worth a look.",
    });
    expect(out).toEqual({ decided: false, packetId: null, decision: null, capture: null, attempted: false });
  });
});
