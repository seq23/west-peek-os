import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { steerFromReply } from "../src/worker/services/emailThread";
import { threadReference } from "../src/shared/email/thread";
import { replyToRequester } from "../src/worker/services/requestReply";
import { runWebPropertyChangeCard, sendStuck, type WebPropertyChangeCard } from "../src/worker/services/webPropertyChange";
import type { SweepCard } from "../src/worker/services/workSweep";
import { sendOrPreview } from "../src/worker/services/previewApproval";
import { lintExecEmail, renderExecEmail } from "../src/shared/email/execEmail";
import { PARTNERS } from "../src/shared/registry/partners";
import {
  canApprove,
  canForce,
  claimAck,
  decideClaim,
  decideHandOff,
  decideTakeBack,
  handOffAck,
  ownershipIntentIn,
  ownershipView,
  confirmsHandOff,
  handOffQuestion,
  roleOf,
  secondaryApprovalRefusal,
  secondaryNoteAck,
} from "../src/shared/work/partnerOwnership";
import { handOffEmail, trailLine } from "../src/shared/work/handOffEmail";
import { ackMessage } from "../src/client/pages/NotificationsPage";
import { trailSentence } from "../src/shared/work/cardTimeline";

/**
 * HAND A WORK CARD TO THE OTHER PARTNER, WITH PRIMARY AND SECONDARY OWNERS (owner, 23 Sep 2026;
 * migration 0241). The pure rules, then the three doors (route, note, reply), the one email, the cc,
 * the refusals, and the row-level triggers that hold the line whatever the code does.
 */

const SEQUOIA = "sequoia@westpeek.ventures";
const SCOOTER = "scooter@westpeek.ventures";
const sequoia = PARTNERS.find((p) => p.email === SEQUOIA)!;
const scooter = PARTNERS.find((p) => p.email === SCOOTER)!;
const GOOD_AUTH = (who: string) => `mx.cloudflare.net; spf=pass smtp.mailfrom=${who}; dkim=pass header.d=westpeek.ventures; dmarc=pass`;

let t: TestDb;
let env: Env;
const sent: Array<{ to: string[]; cc: string[] | undefined; subject: string; text: string; headers: Record<string, string> }> = [];

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
      const body = JSON.parse(String(init?.body)) as { to: string[]; cc?: string[]; subject: string; text: string; headers?: Record<string, string> };
      sent.push({ to: body.to, cc: body.cc, subject: body.subject, text: body.text, headers: body.headers ?? {} });
      return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await disposeTestDb(t);
});

const to = (who: string) => sent.filter((m) => m.to.includes(who));

async function call(path: string, who: string, method = "GET", body?: unknown): Promise<{ status: number; body: any }> {
  const res = await handleRequest(
    new Request(`https://test.local${path}`, {
      method,
      headers: { "x-wpos-dev-user": who, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  );
  return { status: res.status, body: await res.json() };
}

async function card(id: string) {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, any>>())!;
}

const ASKS = [
  { question: "Orange: use the orange already live on westpeek.ventures (#c45a3c)?", recommended: "Yes, #c45a3c, held in one CSS token" },
  { question: "Fonts: Does West Peek's Maax licence cover self-hosting them as web fonts?", recommended: "Yes, self-host Maax" },
];
const ANSWERS = [
  "1. Yes, #c45a3c, held in one CSS token (approved as recommended)",
  "2. Maax self-hosted everywhere (solved: Sequoia confirmed the licence covers web use (Sep 23))",
];

/**
 * A community-site card shaped like wc_c9e36e8b: asked by Sequoia by email, plan approved, a green
 * preview waiting on her, three notices already sent to her (RECEIVED, PLAN, PREVIEW) and one reply.
 */
async function seedCard(id: string): Promise<{ previewThread: string }> {
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, requested_by_email, request_json, block_who, block_needed, block_reason, block_stopped, block_trying, block_actions_json, blocked_at, created_at)
     VALUES (?1, 'Change joinwestpeek.com: "Porter, We need to get started on the community site redesign"', 'x', 'AI', 'aie_porter', 'BLOCKED', 'NORMAL', 'INTERNAL', 'west-peek', 'test', 'WEB_PROPERTY_CHANGE', ?2, ?3, 'SEQUOIA', 'PREVIEW READY.', 'a_question_for_you', 'the preview', 'the community site redesign', '[{"key":"ANSWER","label":"Answer"}]', '2026-09-23T18:18:20.000Z', '2026-09-23T16:55:00.000Z')`,
  )
    .bind(id, SEQUOIA, JSON.stringify({ property_host: "joinwestpeek.com", ask: "the community site redesign" }))
    .run();
  await env.WP_OS_DB.prepare(
    `INSERT INTO web_property_change (work_card_id, target_repo, property_host, ask, phase, plan_filed_at, asks_json, answers_json, plan_approved_at, plan_approved_by,
                                      pr_url, branch, check_state, check_green_at, preview_url, preview_emailed_at, publish_ready, preview_only, placeholders_json)
     VALUES (?1, 'join-west-peek-main', 'joinwestpeek.com', 'community site redesign', 'BUILD', '2026-09-23T17:42:18.798Z', ?2, ?3, '2026-09-23T17:48:18.242Z', 'fu_sequoia_taylor',
             'https://github.com/seq23/join-west-peek-main/pull/21', 'work/wpc-c9e36e8b', 'GREEN', '2026-09-23T18:18:19.298Z',
             'https://fe42ec36.west-peek-community.pages.dev · https://work-wpc-c9e36e8b.west-peek-community.pages.dev', '2026-09-23T18:18:20.226Z', 0, 1, ?4)`,
  )
    .bind(id, JSON.stringify(ASKS), JSON.stringify(ANSWERS), JSON.stringify(["Sengo logo", "Episode 4 and 5 YouTube links"]))
    .run();
  const notices: Array<[string, string, string, string]> = [
    ["RECEIVED", "", "2026-09-23T16:55:29.448Z", `wpt_${"a".repeat(32)}`],
    ["PLAN", "2026-09-23T17:42:18.798Z", "2026-09-23T17:42:25.239Z", `wpt_${"b".repeat(32)}`],
    ["PREVIEW", "2026-09-23T18:18:19.298Z", "2026-09-23T18:18:25.296Z", `wpt_${id.slice(-8).replace(/[^0-9a-f]/g, "c").padEnd(32, "c")}`],
  ];
  for (const [kind, cause, at, token] of notices) {
    await env.WP_OS_DB.prepare("INSERT INTO work_card_notice (id, work_card_id, kind, cause, sent_to, message_id, sent, sent_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, ?7)")
      .bind(`wcn_${crypto.randomUUID()}`, id, kind, cause, SEQUOIA, token, at)
      .run();
    await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO email_thread (token, object_type, object_id, card_kind, employee, to_address, subject, firm_scope) VALUES (?1, 'work_card', ?2, 'WEB_PROPERTY_CHANGE', 'Porter', ?3, 'Porter: blocked', 'west-peek')")
      .bind(token, id, SEQUOIA)
      .run();
  }
  await env.WP_OS_DB.prepare("INSERT INTO work_card_note (id, work_card_id, author_id, body, created_at) VALUES (?1, ?2, 'fu_sequoia_taylor', ?3, '2026-09-23T17:47:52.804Z')")
    .bind(`wcn_${crypto.randomUUID()}`, id, "You asked what to do. The answer is: approved.\n\nOn Wed, Sep 23, 2026 at 12:42 PM Porter · West Peek <porter@joinwestpeek.com>\nwrote:")
    .run();
  return { previewThread: notices[2]![3] };
}

function replyFrom(who: string, written: string, token: string) {
  const raw = [`From: ${who}`, "To: os@joinwestpeek.com", "Subject: Re: Porter: blocked", "", written, "", "On Wed, 23 Sep 2026 at 13:18, Porter <porter@joinwestpeek.com> wrote:", "> Preview ready."].join("\n");
  return steerFromReply(env, { fromHeader: `<${who}>`, authenticationResults: GOOD_AUTH(who), subject: "Re: Porter: blocked", raw, inReplyTo: threadReference(token), references: null, emlKey: null });
}

// ── THE RULES ─────────────────────────────────────────────────────────────────────────────────

describe("the rules: partners only, the primary hands off, the secondary takes back", () => {
  const onlySequoia = { requested_by_email: SEQUOIA, secondary_partner_email: null };
  const handed = { requested_by_email: SCOOTER, secondary_partner_email: SEQUOIA };

  it("reads the words from the first written line only", () => {
    expect(ownershipIntentIn("hand this to Scooter")).toMatchObject({ kind: "HAND_OFF", to: { email: SCOOTER } });
    expect(ownershipIntentIn("Give this to Sequoia.")).toMatchObject({ kind: "HAND_OFF", to: { email: SEQUOIA } });
    expect(ownershipIntentIn("please pass it over to scooter@westpeek.ventures, thanks")).toMatchObject({ kind: "HAND_OFF", to: { email: SCOOTER } });
    expect(ownershipIntentIn("hand this to Bob")).toEqual({ kind: "HAND_OFF", to: null, named: "Bob" });
    expect(ownershipIntentIn("take this back")).toEqual({ kind: "TAKE_BACK" });
    expect(ownershipIntentIn("I'll take it back, thanks")).toEqual({ kind: "TAKE_BACK" });
    expect(ownershipIntentIn("approved")).toBeNull();
    expect(ownershipIntentIn("looks good\n\nwe may take this back to the drawing board later")).toBeNull();
    expect(ownershipIntentIn("> hand this to Scooter")).toBeNull();
  });

  it("only the current primary hands off, only to the other partner", () => {
    expect(decideHandOff(onlySequoia, SEQUOIA, "Scooter")).toMatchObject({ ok: true, primary: { email: SCOOTER }, secondary: { email: SEQUOIA } });
    expect(decideHandOff(onlySequoia, SCOOTER, "Scooter")).toMatchObject({ ok: false, status: 403, reason: "Only Sequoia can hand this card off." });
    expect(decideHandOff(onlySequoia, "bob@example.com", "Scooter")).toMatchObject({ ok: false, status: 403, reason: "Only a partner can hand a card off." });
    expect(decideHandOff(onlySequoia, SEQUOIA, "bob@example.com")).toMatchObject({ ok: false, status: 400 });
    expect(decideHandOff(onlySequoia, SEQUOIA, "Sequoia")).toMatchObject({ ok: false, status: 409 });
    expect(decideHandOff({ requested_by_email: null }, SEQUOIA, "Scooter")).toMatchObject({ ok: false, status: 409 });
    // The ex-primary, now secondary, cannot hand it on again.
    expect(decideHandOff(handed, SEQUOIA, "Sequoia")).toMatchObject({ ok: false, status: 403, reason: "Only Scooter can hand this card off. Reply 'take this back' to take it over." });
  });

  it("only the current secondary takes back, and the roles swap", () => {
    expect(decideTakeBack(handed, SEQUOIA)).toMatchObject({ ok: true, primary: { email: SEQUOIA }, secondary: { email: SCOOTER } });
    expect(decideTakeBack(handed, SCOOTER)).toMatchObject({ ok: false, status: 409 });
    expect(decideTakeBack(onlySequoia, SCOOTER)).toMatchObject({ ok: false, status: 403 });
    expect(decideTakeBack(handed, "bob@example.com")).toMatchObject({ ok: false, status: 403 });
  });

  it("only the primary approves or forces; a card no partner asked for is either partner's", () => {
    expect(canApprove(handed, SCOOTER)).toBe(true);
    expect(canApprove(handed, SEQUOIA)).toBe(false);
    expect(canApprove(handed, "fu_sequoia_taylor")).toBe(false);
    expect(canForce(handed, SEQUOIA)).toBe(false);
    expect(canApprove(handed, "bob@example.com")).toBe(false);
    expect(canApprove({ requested_by_email: null }, SEQUOIA)).toBe(true);
    expect(roleOf(handed, SEQUOIA)).toBe("SECONDARY");
    expect(roleOf(handed, "Scooter")).toBe("PRIMARY");
  });

  it("says it in her words", () => {
    expect(handOffAck(scooter)).toBe("Handed to Scooter. He'll get the next emails and owns the approvals and missing items. You're secondary: it stays on your card list, and you can take it back any time.");
    expect(secondaryApprovalRefusal(scooter)).toBe("Only Scooter can approve this now. Reply 'take this back' to take it over.");
  });

  it("the desk: primary first, then secondary", () => {
    expect(ownershipView(handed)).toEqual({
      primary_partner: { firm_user_id: "fu_scooter_taylor", email: SCOOTER, first_name: "Scooter", full_name: "Scooter Taylor" },
      secondary_partner: { firm_user_id: "fu_sequoia_taylor", email: SEQUOIA, first_name: "Sequoia", full_name: "Sequoia Taylor" },
      partner_owner_line: "Owner: Scooter · Secondary: Sequoia",
    });
    expect(ownershipView(onlySequoia).partner_owner_line).toBe("Owner: Sequoia");
    expect(ownershipView({ requested_by_email: null })).toEqual({ primary_partner: null, secondary_partner: null, partner_owner_line: null });
  });

  it("the email: current state first, in the exec format, and it lints clean", () => {
    const email = handOffEmail({
      action: "HAND_OFF",
      to: scooter,
      from: sequoia,
      title: "Community site redesign · joinwestpeek.com",
      job: "Community site redesign (joinwestpeek.com)",
      stands: "The preview is ready and waiting for your approval to go live.",
      previewLinks: ["community: https://work-wpc-c9e36e8b.west-peek-community.pages.dev"],
      missing: ["Sengo logo"],
      replyOptions: ['"approved" — it goes live'],
      decided: ["Fonts: Maax self-hosted everywhere. Solved: Sequoia confirmed the licence covers web use (Sep 23)"],
      trail: Array.from({ length: 8 }, (_, i) => ({ at: `2026-09-23T1${i}:00:00.000Z`, from: "Porter", to: "Sequoia", said: `note ${i}` })),
      cardLink: "https://os.joinwestpeek.com/#/work (card wc_x)",
    });
    const labels = email.sections.map((s) => s.label);
    expect(labels).toEqual(["The job", "Where it stands", "Current preview", "Still missing (optional)", "Your reply options", "Decided so far", "How we got here", "How we got here (cont.)", "The card"]);
    const r = renderExecEmail(email);
    expect(lintExecEmail(r.subject, r.text, "Porter")).toEqual([]);
    expect(r.subject).toBe("Porter: Community site redesign · joinwestpeek.com — now yours");
    expect(trailLine({ at: "2026-09-23T18:18:25.296Z", from: "Porter", to: "Sequoia", said: "Preview ready" })).toBe("Sep 23 · Porter → Sequoia: Preview ready");
  });
});

// ── THE DOORS, THE ONE EMAIL, THE CC ──────────────────────────────────────────────────────────

describe("a hand-off through the route, on a card with three prior notices", () => {
  const id = "wc_handoff_route";

  it("refuses anyone but the primary, and a non-partner target", async () => {
    await seedCard(id);
    sent.length = 0;
    const scooterTries = await call(`/api/work-cards/${id}/hand-off`, SCOOTER, "POST", { to: "Scooter" });
    expect(scooterTries.status).toBe(403);
    const toStranger = await call(`/api/work-cards/${id}/hand-off`, SEQUOIA, "POST", { to: "bob@example.com" });
    expect(toStranger.status).toBe(400);
    expect(toStranger.body.detail).toMatch(/not a partner/);
    const takeBackNobody = await call(`/api/work-cards/${id}/take-back`, SCOOTER, "POST", {});
    expect(takeBackNobody.status).toBe(403);
    expect(sent).toHaveLength(0);
    expect((await card(id)).requested_by_email).toBe(SEQUOIA);
  });

  it("moves primary and secondary, and sends exactly one email: To Scooter, Cc Sequoia", async () => {
    sent.length = 0;
    const out = await call(`/api/work-cards/${id}/hand-off`, SEQUOIA, "POST", { to: "scooter@westpeek.ventures" });
    expect(out.status).toBe(200);
    expect(out.body).toMatchObject({ ok: true, action: "HAND_OFF", primary: SCOOTER, secondary: SEQUOIA, sent: true });
    expect(out.body.message_id).toMatch(/^wpt_[0-9a-f]{32}$/);
    const c = await card(id);
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(c.secondary_partner_email).toBe(SEQUOIA);
    expect(c.block_who).toBe("SCOOTER");

    // THE NEW PRIMARY'S NOTICE COUNT IS EXACTLY ONE: no re-sends of RECEIVED / PLAN / PREVIEW.
    expect(to(SCOOTER)).toHaveLength(1);
    const mail = to(SCOOTER)[0]!;
    // THE PREVIOUS PRIMARY IS IN CC on the one email — her acknowledgement, and her last email.
    expect(mail.cc).toEqual([SEQUOIA]);
    // A NEW CONVERSATION, never a forward of hers: its References name only its own token.
    const refs = mail.headers.References ?? "";
    expect(refs).toContain(out.body.message_id);
    for (const theirs of ["a".repeat(32), "b".repeat(32)]) expect(refs).not.toContain(theirs);
    expect(refs.split(/\s+/)).toHaveLength(1);
    const text = mail.text;
    const order = ["The job", "Where it stands", "Current preview", "Still missing (optional)", "Your reply options", "Decided so far", "How we got here"].map((l) => text.indexOf(`**${l}**`));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("The preview is ready and waiting for your approval to go live.");
    expect(text).toMatch(/Current preview \(built [^)]*, \*{0,2}2\*{0,2} placeholders\): https:\/\/work-wpc-c9e36e8b\.west-peek-community\.pages\.dev/);
    expect(text).not.toContain("fe42ec36");
    // Each decision as "<topic>: <chosen answer, short>" — no backstory, no line cut mid-sentence.
    expect(text).toContain("• Fonts: Maax self-hosted everywhere\n");
    expect(text).toContain("• Orange: #c45a3c\n");
    expect(text).not.toMatch(/…\n/);
    expect(text).toContain("Sep 23 · Porter → Sequoia: Got it, on it");
    expect(text).toContain("Sep 23 · Porter → Sequoia: The plan, for approval");
    expect(text).toContain("Sep 23 · Porter → Sequoia: Preview ready");
    expect(text).toContain('Sep 23 · Sequoia → Porter: "approved."');
    // Her acknowledgement is folded into the one email she is copied on; no second email exists.
    expect(text).toContain(handOffAck(scooter));
    expect(to(SEQUOIA)).toHaveLength(0);
    expect(sent).toHaveLength(1);
    // Nothing was recorded as a re-sent notice.
    const notices = await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1 AND sent_to = ?2").bind(id, SCOOTER).first<{ n: number }>();
    expect(notices!.n).toBe(0);
    const row = await env.WP_OS_DB.prepare("SELECT * FROM work_card_hand_off WHERE work_card_id = ?1").bind(id).first<Record<string, any>>();
    expect(row).toMatchObject({ action: "HAND_OFF", by_email: SEQUOIA, primary_email: SCOOTER, secondary_email: SEQUOIA, via: "API", sent: 1, message_id: out.body.message_id });
  });

  it("the next notice goes to the new primary", async () => {
    sent.length = 0;
    const c = (await card(id)) as unknown as WebPropertyChangeCard;
    const out = await sendStuck(env, c, "run:after-hand-off", "the Mac went quiet", "It retries on the next tick.");
    expect(out.sent).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([SCOOTER]);
    // …in HIS conversation: under the one hand-off email he got, never under Sequoia's first notice.
    const handOff = await env.WP_OS_DB.prepare("SELECT message_id FROM work_card_hand_off WHERE work_card_id = ?1").bind(id).first<{ message_id: string }>();
    expect(sent[0]!.headers["In-Reply-To"]).toContain(handOff!.message_id);
    expect(sent[0]!.headers.References ?? "").not.toContain("a".repeat(32));
  });

  it("after the hand-off the secondary gets NO emails: not cc'd on a preview or the finished email", async () => {
    sent.length = 0;
    const c = await card(id);
    await sendOrPreview(env, {
      to: SCOOTER,
      email: { employee: "Porter", what: "preview ready", tldr: "Preview ready.", sections: [{ label: "Preview", bullets: ["link"] }, { label: "The card", bullets: ["card"] }], details: null },
      objectType: "work_card",
      objectId: id,
      workCardId: id,
      firmScope: "west-peek",
      cardAsked: false,
      finished: true,
    });
    expect(sent.at(-1)!.to).toEqual([SCOOTER]);
    expect(sent.at(-1)!.cc).toBeUndefined();
    await replyToRequester(env, { id, title: String(c.title), kind: null, requested_by_email: SCOOTER, firm_scope: "west-peek", preview_first: 0 }, "DONE", "Porter", "It is live.");
    const done = await env.WP_OS_DB.prepare("SELECT cc_emails FROM preview_approval WHERE work_card_id = ?1 ORDER BY created_at DESC").bind(id).first<{ cc_emails: string }>();
    const last = sent.at(-1)!;
    // The finished email either went (with no cc) or was filed for review first (with no cc frozen on it).
    if (last.to.includes(SCOOTER) && last.subject !== sent[0]!.subject) expect(last.cc).toBeUndefined();
    else expect(JSON.parse(done!.cc_emails)).toEqual([]);
    expect(sent.every((m) => !m.to.includes(SEQUOIA) && !(m.cc ?? []).includes(SEQUOIA))).toBe(true);
    // An explicit "cc Sequoia" from the primary still works as before.
    await env.WP_OS_DB.prepare("UPDATE work_card SET cc_emails = ?2 WHERE id = ?1").bind(id, JSON.stringify([SEQUOIA])).run();
    await sendOrPreview(env, {
      to: SCOOTER,
      email: { employee: "Porter", what: "preview ready", tldr: "Preview ready.", sections: [{ label: "Preview", bullets: ["link"] }, { label: "The card", bullets: ["card"] }], details: null },
      objectType: "work_card",
      objectId: id,
      workCardId: id,
      firmScope: "west-peek",
      cardAsked: false,
      finished: true,
    });
    expect(sent.at(-1)!.cc).toEqual([SEQUOIA]);
    await env.WP_OS_DB.prepare("UPDATE work_card SET cc_emails = '[]' WHERE id = ?1").bind(id).run();
  });

  it("the desk serves primary first, then secondary", async () => {
    const board = await call("/api/work-cards/by-owner", SEQUOIA);
    const row = board.body.cards.find((c: { id: string }) => c.id === id);
    expect(row.partner_owner_line).toBe("Owner: Scooter · Secondary: Sequoia");
    expect(row.primary_partner.email).toBe(SCOOTER);
    expect(row.secondary_partner.email).toBe(SEQUOIA);
    const one = await call(`/api/work-cards/${id}`, SEQUOIA);
    expect(one.body.partner_owner_line).toBe("Owner: Scooter · Secondary: Sequoia");
    expect(one.body.secondary_partner_email).toBe(SEQUOIA);
  });
});

describe("the secondary cannot approve, force or clear the block", () => {
  const id = "wc_handoff_secondary";
  let token = "";

  it("a secondary's 'approved' by reply is refused and answered, and nothing is approved", async () => {
    ({ previewThread: token } = await seedCard(id));
    await call(`/api/work-cards/${id}/hand-off`, SEQUOIA, "POST", { to: "Scooter" });
    sent.length = 0;
    const out = await replyFrom(SEQUOIA, "approved", token);
    expect(out.steered).toBe(true);
    expect(out.answered).toBe(false);
    expect(to(SEQUOIA)).toHaveLength(1);
    expect(to(SEQUOIA)[0]!.text).toContain("Only Scooter can approve this now. Reply 'take this back' to take it over.");
    expect(to(SCOOTER)).toHaveLength(0);
    const c = await card(id);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_answer ?? null).toBeNull();
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 ORDER BY created_at DESC LIMIT 1").bind(id).first<{ body: string }>();
    expect(note!.body).toMatch(/^\(From the secondary partner; read as context, not an approval\.\) approved/);
  });

  it("the card's button refuses the secondary too", async () => {
    const out = await call(`/api/work-cards/${id}/unblock`, SEQUOIA, "POST", { action: "ANSWER", text: "approved" });
    expect(out.status).toBe(403);
    expect(out.body.detail).toBe("Only Scooter can approve this now. Reply 'take this back' to take it over.");
    expect((await card(id)).state).toBe("BLOCKED");
  });

  it("the row refuses an approval or a force in the secondary's (the ex-primary's) name", async () => {
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET land_approved_at = '2026-09-23T20:00:00Z', land_approved_by = 'fu_sequoia_taylor' WHERE work_card_id = ?1").bind(id).run()).rejects.toThrow(/primary partner can approve the landing/);
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET land_approved_at = '2026-09-23T20:00:00Z', land_approved_by = ?2 WHERE work_card_id = ?1").bind(id, SEQUOIA).run()).rejects.toThrow(/primary partner/);
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET forced_by = 'fu_sequoia_taylor', forced_at = '2026-09-23T20:00:00Z' WHERE work_card_id = ?1").bind(id).run()).rejects.toThrow(/only the partner who asked/);
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET plan_approved_at = NULL WHERE work_card_id = ?1").bind(id).run();
    await expect(env.WP_OS_DB.prepare("UPDATE web_property_change SET plan_approved_at = '2026-09-23T20:00:00Z', plan_approved_by = 'fu_sequoia_taylor' WHERE work_card_id = ?1").bind(id).run()).rejects.toThrow(/primary partner can approve the plan/);
    // The primary can; Porter's own "nothing to ask" still can.
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET plan_approved_at = '2026-09-23T20:00:00Z', plan_approved_by = 'fu_scooter_taylor' WHERE work_card_id = ?1").bind(id).run();
    await env.WP_OS_DB.prepare("UPDATE web_property_change SET land_approved_at = '2026-09-23T20:01:00Z', land_approved_by = 'fu_scooter_taylor' WHERE work_card_id = ?1").bind(id).run();
    await expect(env.WP_OS_DB.prepare("UPDATE work_card SET secondary_partner_email = requested_by_email WHERE id = ?1").bind(id).run()).rejects.toThrow(/cannot also be the primary/);
  });

  it("take-back by reply swaps the roles and sends exactly one email", async () => {
    sent.length = 0;
    const out = await replyFrom(SEQUOIA, "take this back", token);
    expect(out.steered).toBe(true);
    const c = await card(id);
    expect(c.requested_by_email).toBe(SEQUOIA);
    expect(c.secondary_partner_email).toBe(SCOOTER);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([SEQUOIA]);
    expect(sent[0]!.cc, "the previous primary is copied on the one email").toEqual([SCOOTER]);
    expect(sent[0]!.subject).toMatch(/— yours again$/);
    expect(sent[0]!.text).toContain("You took this card back from Scooter");
    const rows = await env.WP_OS_DB.prepare("SELECT action, via FROM work_card_hand_off WHERE work_card_id = ?1 ORDER BY created_at").bind(id).all<{ action: string; via: string }>();
    expect(rows.results).toEqual([{ action: "HAND_OFF", via: "API" }, { action: "TAKE_BACK", via: "REPLY" }]);
  });

  it("a hand-off by note works, and a take-back by the primary is refused", async () => {
    sent.length = 0;
    const handed = await call(`/api/work-cards/${id}/notes`, SEQUOIA, "POST", { body: "hand this to Scooter" });
    expect(handed.status).toBe(201);
    expect(handed.body.ack).toBe(handOffAck(scooter));
    expect((await card(id)).requested_by_email).toBe(SCOOTER);
    expect(to(SCOOTER)).toHaveLength(1);
    const refused = await call(`/api/work-cards/${id}/take-back`, SCOOTER, "POST", {});
    expect(refused.status).toBe(409);
    const back = await call(`/api/work-cards/${id}/take-back`, SEQUOIA, "POST", {});
    expect(back.status).toBe(200);
    expect((await card(id)).requested_by_email).toBe(SEQUOIA);
  });
});

describe("the secondary's note is context, never a steer", () => {
  const id = "wc_handoff_note";

  it("Porter keeps it on the trail, answers who approves, and carries nothing into the next phase", async () => {
    await seedCard(id);
    await call(`/api/work-cards/${id}/hand-off`, SEQUOIA, "POST", { to: "Scooter" });
    const before = await env.WP_OS_DB.prepare("SELECT answers_json FROM web_property_change WHERE work_card_id = ?1").bind(id).first<{ answers_json: string }>();
    const posted = await call(`/api/work-cards/${id}/notes`, SEQUOIA, "POST", { body: "stop, use a darker orange" });
    expect(posted.status).toBe(201);
    const sweepCard = (await card(id)) as unknown as SweepCard;
    await runWebPropertyChangeCard(env, sweepCard);
    const note = await env.WP_OS_DB.prepare("SELECT response, acknowledged_at FROM work_card_note WHERE work_card_id = ?1 AND body = 'stop, use a darker orange'").bind(id).first<{ response: string; acknowledged_at: string | null }>();
    expect(note!.acknowledged_at).toBeTruthy();
    expect(note!.response).toBe(secondaryNoteAck(scooter));
    const c = await card(id);
    expect(String(c.description)).toContain('Context from Sequoia (secondary; not an approval): "stop, use a darker orange"');
    // Her "stop" held nothing — it is not hers to say now — and no answer was carried.
    expect(c.held_at ?? null).toBeNull();
    expect(String(c.description)).not.toContain("Held by");
    const after = await env.WP_OS_DB.prepare("SELECT answers_json FROM web_property_change WHERE work_card_id = ?1").bind(id).first<{ answers_json: string }>();
    expect(after!.answers_json).toBe(before!.answers_json);
  });
});

// ── "TAKE RESPONSIBILITY" ON A WORK CARD'S NOTIFICATION CLAIMS THE CARD ────────────────────────

describe("Take responsibility on a work card's notification claims the card", () => {
  const id = "wc_handoff_claim";

  async function notice(nid: string, cardId: string, objectType = "work_card") {
    await env.WP_OS_DB.prepare(
      "INSERT INTO notification (id, kind, severity, title, body, object_type, object_id, dedupe_key) VALUES (?1, 'EMPLOYEE_EXCEPTION', 'WARNING', 'Porter needs you', 'x', ?2, ?3, ?1)",
    )
      .bind(nid, objectType, cardId)
      .run();
  }

  it("the rule: the presser becomes primary, the other partner secondary; already primary only records", () => {
    expect(decideClaim({ requested_by_email: SEQUOIA }, SCOOTER)).toMatchObject({ ok: true, action: "CLAIM", primary: { email: SCOOTER }, secondary: { email: SEQUOIA } });
    expect(decideClaim({ requested_by_email: null }, SCOOTER)).toMatchObject({ ok: true, action: "CLAIM", primary: { email: SCOOTER }, secondary: { email: SEQUOIA } });
    expect(decideClaim({ requested_by_email: SEQUOIA }, SEQUOIA)).toMatchObject({ ok: true, already: true });
    expect(decideClaim({ requested_by_email: SEQUOIA }, "bob@example.com")).toMatchObject({ ok: false, status: 403 });
    expect(claimAck(scooter, "Community site redesign")).toBe("Scooter took responsibility for Community site redesign; you're secondary now: it stays on your card list, and you can take it back any time");
  });

  it("Scooter presses it on Sequoia's card: he is primary, she is secondary, and one context email goes To him, Cc her", async () => {
    await seedCard(id);
    await notice("ntf_claim_1", id);
    sent.length = 0;
    const res = await call("/api/notifications/ntf_claim_1/acknowledge", SCOOTER, "POST");
    expect(res.status).toBe(200);
    // The name and the time are recorded, as before.
    expect(res.body.acked_by).toBe("fu_scooter_taylor");
    expect(res.body.acked_at).toBeTruthy();
    expect(res.body.claim).toMatchObject({ ok: true, action: "CLAIM", primary: SCOOTER, secondary: SEQUOIA, sent: true });
    const c = await card(id);
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(c.secondary_partner_email).toBe(SEQUOIA);
    expect(sent).toHaveLength(1);
    expect(to(SCOOTER)).toHaveLength(1);
    expect(to(SCOOTER)[0]!.cc).toEqual([SEQUOIA]);
    expect(to(SCOOTER)[0]!.text).toContain("You took responsibility for this card");
    expect(to(SCOOTER)[0]!.text).toContain("**How we got here**");
    expect(to(SCOOTER)[0]!.text).toContain("**Decided so far**");
    expect(to(SEQUOIA)).toHaveLength(0);
    expect(to(SCOOTER)[0]!.text).toContain("Scooter took responsibility for Community site redesign");
    expect(to(SCOOTER)[0]!.text).toContain("you're secondary now: it stays on your card list, and you can take it back any time");
    const row = await env.WP_OS_DB.prepare("SELECT action, via, by_email FROM work_card_hand_off WHERE work_card_id = ?1").bind(id).first();
    expect(row).toEqual({ action: "CLAIM", via: "NOTIFICATION", by_email: SCOOTER });
  });

  it("already primary: it only records, and nothing is sent", async () => {
    await notice("ntf_claim_2", id);
    sent.length = 0;
    const res = await call("/api/notifications/ntf_claim_2/acknowledge", SCOOTER, "POST");
    expect(res.status).toBe(200);
    expect(res.body.acked_by).toBe("fu_scooter_taylor");
    expect(res.body.claim).toMatchObject({ ok: true, already_primary: true, sent: false });
    expect(sent).toHaveLength(0);
    expect((await card(id)).requested_by_email).toBe(SCOOTER);
  });

  it("the page says what happened: claimed, already yours, or only recorded", () => {
    expect(ackMessage(200, { claim: { ok: true } })).toMatch(/^Acknowledged, and the card is yours now: you're primary, and the other partner is secondary\./);
    expect(ackMessage(200, { claim: { ok: true, already_primary: true } })).toBe("Acknowledged. The card was already yours; your name and the time are on the record.");
    expect(ackMessage(200, {})).toBe("Acknowledged. Your name and the time are on the record against it.");
    expect(ackMessage(409, null)).toMatch(/Nothing was recorded/);
  });

  it("a notification about something that is not a work card only records", async () => {
    await notice("ntf_claim_3", "deal_1", "deal");
    sent.length = 0;
    const res = await call("/api/notifications/ntf_claim_3/acknowledge", SEQUOIA, "POST");
    expect(res.status).toBe(200);
    expect(res.body.claim).toBeUndefined();
    expect(sent).toHaveLength(0);
  });
});

// ── THE WIDER READER: MORE THAN "HAND THIS TO SCOOTER" (owner, 23 Sep 2026) ─────────────────────

describe("the reader hears a hand-off however she says it — and never guesses", () => {
  // Sequoia is primary and writing; Scooter is the other partner.
  const SHOULD_HAND_OFF = [
    "hand this to Scooter",
    "give this to Scooter",
    "pass it to Scooter",
    "Scooter will take it from here",
    "Scooter owns the rest",
    "let Scooter finish this",
    "Scooter can handle the missing items",
    "move this to Scooter",
    "assign to Scooter",
    "Scooter's got it",
    "Scooter\u2019s got it.",
    "over to Scooter",
    "Over to scooter.",
    "Hi Porter,\n\nScooter will take it from here. Thanks!",
    "please pass it over to scooter@westpeek.ventures",
    "SCOOTER OWNS THE REST",
    "reassign this to Scooter",
    "Scooter is taking over",
    "let Scooter take it",
    "It's Scooter's now",
  ];
  const SHOULD_NOT_HAND_OFF = [
    "cc Scooter",
    "cc: scooter@westpeek.ventures",
    "Please cc Scooter on the finished email",
    "hand this to Scooter, cc Scooter",
    "ask Scooter about the logo",
    "Scooter says the orange is fine",
    "Scooter liked the preview",
    "tell Scooter the preview is up",
    "let Scooter know it's live",
    "email Scooter the link",
    "loop in Scooter",
    "from Scooter: the orange is fine",
    "approved",
    "changes: make the logo bigger",
    "Sequoia will take it from here",
    "looks good\n\nScooter will take it from here next month maybe",
    "> hand this to Scooter",
    "I sent the fonts over to Scooter",
  ];

  it.each(SHOULD_HAND_OFF)("hands off: %s", (said) => {
    expect(ownershipIntentIn(said, SEQUOIA)).toMatchObject({ kind: "HAND_OFF", to: { email: SCOOTER } });
  });

  it.each(SHOULD_NOT_HAND_OFF)("does not hand off: %s", (said) => {
    expect(ownershipIntentIn(said, SEQUOIA)?.kind).not.toBe("HAND_OFF");
  });

  it("the talk-about-him and cc cases are not even a question", () => {
    for (const said of ["cc Scooter", "ask Scooter about the logo", "Scooter says the orange is fine", "tell Scooter the preview is up", "hand this to Scooter, cc Scooter"]) {
      expect(ownershipIntentIn(said, SEQUOIA)).toBeNull();
    }
  });

  it("GUARD: any message with a cc and a partner's name never hands off", () => {
    for (const said of SHOULD_HAND_OFF) {
      expect(ownershipIntentIn(`${said}. cc Scooter`, SEQUOIA)).toBeNull();
      expect(ownershipIntentIn(`cc: scooter@westpeek.ventures\n${said}`, SEQUOIA)).toBeNull();
    }
  });

  it("take-back, however it is said", () => {
    for (const said of ["take this back", "I'll take it back", "give it back to me", "I'm taking this over", "I've got it from here", "I'll take over", "it's mine again", "Take it back, thanks", "I\u2019ll take it back."]) {
      expect(ownershipIntentIn(said, SEQUOIA), said).toEqual({ kind: "TAKE_BACK" });
    }
    for (const said of ["we may take this back to the drawing board", "approved", "I've got a question about the logo"]) {
      expect(ownershipIntentIn(said, SEQUOIA)?.kind, said).not.toBe("TAKE_BACK");
    }
  });

  it("unsure is a question, never a hand-off", () => {
    for (const said of ["Scooter should probably own this", "maybe Scooter could handle it?", "I think this is more Scooter's area, he can take over", "Scooter will take a look"]) {
      expect(ownershipIntentIn(said, SEQUOIA), said).toMatchObject({ kind: "UNSURE_HAND_OFF", to: { email: SCOOTER } });
    }
    expect(handOffQuestion(scooter)).toBe("Did you mean hand this card to Scooter? Reply 'yes' and I will.");
    expect(confirmsHandOff("yes")).toBe(true);
    expect(confirmsHandOff("Yes please.")).toBe(true);
    expect(confirmsHandOff("yes but change the logo")).toBe(false);
  });
});

describe("unsure → Porter asks once; 'yes' performs it", () => {
  it("by reply: the question goes out once, nothing moves, and 'yes' on its thread hands off", async () => {
    const id = "wc_handoff_unsure_reply";
    const { previewThread } = await seedCard(id);
    sent.length = 0;
    await replyFrom(SEQUOIA, "Scooter should probably own this", previewThread);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([SEQUOIA]);
    expect(sent[0]!.text).toContain("Did you mean hand this card to Scooter? Reply 'yes' and I will.");
    let c = await card(id);
    expect(c.requested_by_email).toBe(SEQUOIA);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_answer ?? null, "an unsure message is never read as an answer").toBeNull();
    const asked = await env.WP_OS_DB.prepare("SELECT payload_json FROM event_record WHERE object_id = ?1 AND event_type = 'work_card.hand_off_confirm_asked'").bind(id).first<{ payload_json: string }>();
    const token = JSON.parse(asked!.payload_json).token as string;
    expect(token).toMatch(/^wpt_/);
    // A "yes" on some OTHER thread is not an answer to the question.
    sent.length = 0;
    await replyFrom(SEQUOIA, "yes", `wpt_${"a".repeat(32)}`);
    expect((await card(id)).requested_by_email).toBe(SEQUOIA);
    // "yes" on the question's thread performs it.
    sent.length = 0;
    await replyFrom(SEQUOIA, "yes", token);
    c = await card(id);
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(c.secondary_partner_email).toBe(SEQUOIA);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ to: [SCOOTER], cc: [SEQUOIA] });
  });

  it("by note: the ack is the question, and a 'yes' note performs it", async () => {
    const id = "wc_handoff_unsure_note";
    await seedCard(id);
    sent.length = 0;
    const asked = await call(`/api/work-cards/${id}/notes`, SEQUOIA, "POST", { body: "maybe Scooter could handle it?" });
    expect(asked.status).toBe(201);
    expect(asked.body.ack).toBe("Did you mean hand this card to Scooter? Reply 'yes' and I will.");
    expect(sent).toHaveLength(0);
    expect((await card(id)).requested_by_email).toBe(SEQUOIA);
    const yes = await call(`/api/work-cards/${id}/notes`, SEQUOIA, "POST", { body: "yes" });
    expect(yes.status).toBe(201);
    expect(yes.body.hand_off).toMatchObject({ ok: true, action: "HAND_OFF", primary: SCOOTER });
    expect((await card(id)).requested_by_email).toBe(SCOOTER);
  });

  it("a clear phrasing by reply hands off without asking; 'cc Scooter' only records a cc", async () => {
    const id = "wc_handoff_wide_reply";
    const { previewThread } = await seedCard(id);
    sent.length = 0;
    await replyFrom(SEQUOIA, "cc Scooter", previewThread);
    let c = await card(id);
    expect(c.requested_by_email).toBe(SEQUOIA);
    expect(JSON.parse(String(c.cc_emails))).toEqual([SCOOTER]);
    expect(sent.some((m) => /Did you mean/.test(m.text))).toBe(false);
    sent.length = 0;
    await replyFrom(SEQUOIA, "Scooter will take it from here", previewThread);
    c = await card(id);
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(sent).toHaveLength(1);
  });
});

// ── THE CARD SHOWS THE HAND-OFF AND THE EMAIL IT SENT (owner, 27 Sep 2026) ──────────────────────

describe("the card's trail shows the hand-off and the one email the new primary got", () => {
  it("GET message-trail carries both, after her reply and before nothing else — the desk and the card page speak them", async () => {
    const id = "wc_handoff_on_trail";
    const { previewThread } = await seedCard(id);
    sent.length = 0;
    await replyFrom(SEQUOIA, "Scooter will take it from here", previewThread);
    expect(sent).toHaveLength(1);
    const c = await card(id);
    expect(c.requested_by_email).toBe(SCOOTER);
    expect(c.block_who).toBe("SCOOTER");

    const res = await call(`/api/work-cards/${id}/message-trail`, SEQUOIA);
    expect(res.status).toBe(200);
    const trail = res.body.trail as Array<{ at: string; kind: string; who: string; what: string; via?: string; cc?: string | null }>;
    const hand = trail.find((e) => e.kind === "HAND_OFF");
    const mail = trail.find((e) => e.kind === "HAND_OFF_EMAIL");
    expect(hand).toMatchObject({ who: SEQUOIA, what: SCOOTER, via: "REPLY" });
    expect(mail).toMatchObject({ who: `told ${SCOOTER}`, cc: SEQUOIA });
    // Ordered: the three notices she got, then the change of hands, then its email; nothing after.
    const kinds = trail.map((e) => e.kind);
    expect(kinds.slice(0, 3)).toEqual(["RECEIVED", "PLAN", "PREVIEW"]);
    expect(kinds.indexOf("HAND_OFF")).toBeLessThan(kinds.indexOf("HAND_OFF_EMAIL"));
    expect(kinds.indexOf("HAND_OFF_EMAIL")).toBe(kinds.length - 1);
    // In words, as she reads it and as Scooter reads it.
    expect(trailSentence(hand!, "Porter", [SEQUOIA])).toBe("You handed this to Scooter (by reply).");
    expect(trailSentence(mail!, "Porter", [SEQUOIA])).toBe("Porter emailed Scooter where it stands, you in Cc.");
    expect(trailSentence(mail!, "Porter", [SCOOTER])).toBe("Porter emailed you where it stands, Sequoia in Cc.");
    // A take-back adds its own pair; the take-back email copies nobody.
    await call(`/api/work-cards/${id}/take-back`, SEQUOIA, "POST");
    const again = (await call(`/api/work-cards/${id}/message-trail`, SEQUOIA)).body.trail as Array<{ kind: string; cc?: string | null; who: string }>;
    expect(again.filter((e) => e.kind === "TAKE_BACK")).toHaveLength(1);
    expect(again.at(-1)).toMatchObject({ kind: "HAND_OFF_EMAIL", who: `told ${SEQUOIA}`, cc: null });
  });
});
