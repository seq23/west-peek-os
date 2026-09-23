import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { openAssignmentCard } from "../src/worker/services/dealIntake";
import { EMAILED_TASK_LIMITS } from "../src/shared/intake/partnerAuthority";
import { replyToRequester } from "../src/worker/services/requestReply";
import { recordCcFrom } from "../src/worker/services/ccPartners";
import { decidePreview, sendOrPreview } from "../src/worker/services/previewApproval";
import { sendPartnerEmail } from "../src/worker/services/execEmail";
import { ccAck, ccAsksIn, ccForSend, ccList, isOnlyACc, resolveCc } from "../src/shared/work/ccPartners";
import { assertPreviewLane, SendBlocked } from "../src/worker/effects/emailTransport";

/**
 * "CC SCOOTER" (owner, 23 Sep 2026: "yes add cc support"). A partner copied on the finished email —
 * partners only, only when the partner who asked says so, and only on finished work.
 */

let t: TestDb;
let env: Env;
const SEQUOIA = "sequoia@westpeek.ventures";
const SCOOTER = "scooter@westpeek.ventures";
const sent: Array<{ to: string[]; cc: string[] | undefined; subject: string }> = [];

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
      const body = JSON.parse(String(init?.body)) as { to: string[]; cc?: string[]; subject: string };
      sent.push({ to: body.to, cc: body.cc, subject: body.subject });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

async function card(id: string) {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

describe("the reader: partners only, by the registry", () => {
  it("reads a name, an address, a list, and nothing inside another word", () => {
    expect(ccAsksIn("cc Scooter")).toEqual(["scooter"]);
    expect(ccAsksIn("update the footer. cc scooter@westpeek.ventures.")).toEqual(["scooter@westpeek.ventures"]);
    expect(ccAsksIn("cc: Scooter, Sequoia and bob@x.com")).toEqual(["scooter", "sequoia", "bob@x.com"]);
    expect(ccAsksIn("that is accurate and a success")).toEqual([]);
  });

  it("resolves partners, refuses everyone else by name, and never adds the writer", () => {
    const r = resolveCc(["scooter", "bob@x.com", "info@westpeek.ventures", "him", "sequoia", "me"], SEQUOIA);
    expect(r.add.map((p) => p.email)).toEqual([SCOOTER]);
    expect(r.refused).toEqual(["bob@x.com", "info@westpeek.ventures", "him"]);
    expect(ccAck(r, true, "Sequoia")).toMatch(/^Noted: Scooter will be cc'd on the finished email\. Not cc'd: bob@x\.com, info@westpeek\.ventures, him/);
    expect(ccAck(r, false, "Sequoia")).toBe("No cc added: only Sequoia can add a cc to this card.");
  });

  it("a stored list can widen nothing: non-partners are dropped on read, and the recipient is never copied", () => {
    expect(ccList(JSON.stringify([SCOOTER, "evil@example.com", "INFO@westpeek.ventures"]))).toEqual([SCOOTER]);
    expect(ccList("not json")).toEqual([]);
    expect(ccForSend(JSON.stringify([SCOOTER]), SCOOTER)).toEqual([]);
  });

  it("knows a note that is only a cc from one that also says something", () => {
    expect(isOnlyACc("cc Scooter")).toBe(true);
    expect(isOnlyACc("please cc scooter@westpeek.ventures on this, thanks")).toBe(true);
    expect(isOnlyACc("swap the logo, and cc Scooter")).toBe(false);
    expect(isOnlyACc("swap the logo")).toBe(false);
  });
});

describe("recorded from the requesting partner's own words", () => {
  let id = "";
  it("the opening request's \"cc Scooter\" is on the card, with the ack on its trail; an outsider in the same line is refused", async () => {
    id = await openAssignmentCard(env, { subject: "summary of the week", partnerAddress: SEQUOIA, chiefOfStaff: "Wren", raw: "Wren, a summary of this week's pipeline please. cc Scooter and bob@example.com", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const c = await card(id);
    expect(JSON.parse(String(c.cc_emails))).toEqual([SCOOTER]);
    expect(String(c.description)).toMatch(/Noted: Scooter will be cc'd on the finished email\./);
    expect(String(c.description)).toMatch(/Not cc'd: bob@example\.com/);
  });

  it("the other partner cannot add a cc to a card they did not ask for", async () => {
    const other = await openAssignmentCard(env, { subject: "a note", partnerAddress: SCOOTER, chiefOfStaff: "Walker", raw: "Walker, draft a note to the team.", limits: EMAILED_TASK_LIMITS, emlKey: null });
    const out = await recordCcFrom(env, other, "cc Sequoia", SEQUOIA);
    expect(out.added).toEqual([]);
    expect(out.ack).toBe("No cc added: only Scooter can add a cc to this card.");
    expect(JSON.parse(String((await card(other)).cc_emails))).toEqual([]);
  });

  it("the finished email goes To the requester with the partner in Cc; a question does not copy anyone", async () => {
    const c = await card(id);
    const base = { id, title: String(c.title), kind: null, requested_by_email: SEQUOIA, firm_scope: "west-peek", preview_first: 0 };
    sent.length = 0;
    await replyToRequester(env, base, "BLOCKED", "Wren", "Which week — this one or last?");
    expect(sent.at(-1)?.to).toEqual([SEQUOIA]);
    expect(sent.at(-1)?.cc, "a question is not finished work").toBeUndefined();
    await replyToRequester(env, base, "DONE", "Wren", "Here is the summary.");
    expect(sent.at(-1)?.to).toEqual([SEQUOIA]);
    expect(sent.at(-1)?.cc).toEqual([SCOOTER]);
  });

  it("a finished email filed for her keeps its cc, and \"Send it\" carries it", async () => {
    const out = await sendOrPreview(env, {
      to: SEQUOIA,
      email: { employee: "Wren", what: "done — summary of the week", tldr: "Finished: the summary.", sections: [{ label: "What I found", bullets: ["Three new companies."] }], details: null },
      objectType: "work_card",
      objectId: id,
      workCardId: id,
      firmScope: "west-peek",
      cardAsked: true,
      tickedByFirmUserId: "fu_sequoia_taylor",
      finished: true,
    });
    expect(out.previewed).toBe(true);
    const row = await env.WP_OS_DB.prepare("SELECT cc_emails FROM preview_approval WHERE id = ?1").bind(out.approvalId!).first<{ cc_emails: string }>();
    expect(JSON.parse(row!.cc_emails)).toEqual([SCOOTER]);
    sent.length = 0;
    const decided = await decidePreview(env, out.approvalId!, { action: "SEND", byFirmUserId: "fu_sequoia_taylor", via: "HOME" });
    expect(decided.sent).toBe(true);
    expect(sent.at(-1)?.to).toEqual([SEQUOIA]);
    expect(sent.at(-1)?.cc).toEqual([SCOOTER]);
  });
});

describe("the send refuses a cc a To could not have", () => {
  it("sendPartnerEmail sends nothing when a cc is not a partner", async () => {
    sent.length = 0;
    const out = await sendPartnerEmail(env, { to: SEQUOIA, cc: ["someone@example.com"], email: { employee: "Wren", what: "x", tldr: "x.", sections: [], details: null }, objectType: "work_card", objectId: "wc_x", firmScope: "west-peek" });
    expect(out.sent).toBe(false);
    expect(out.reason).toMatch(/cc someone@example\.com is not one of the two partner addresses/);
    expect(sent).toHaveLength(0);
  });

  it("the transport's lane counts a cc as a recipient: an outsider in Cc is blocked", () => {
    expect(() => assertPreviewLane({}, { to: SEQUOIA, cc: ["someone@example.com"], subject: "s", text: "t" })).toThrow(SendBlocked);
    expect(() => assertPreviewLane({}, { to: SEQUOIA, cc: [SCOOTER], subject: "s", text: "t" })).not.toThrow();
  });
});
