import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { handleRequest } from "../src/worker/index";
import { mergeCard } from "../src/worker/services/mergeCards";
import { claimNextCard } from "../src/worker/services/workSweep";
import { mergeRefusal, orderMergeTargets } from "../src/shared/work/mergeCards";
import { formedStamp } from "../src/shared/work/formedStamp";

/**
 * MERGE ONE WORK CARD INTO ANOTHER (owner, 27 Sep 2026; migration 0242). The pure rules, the route
 * and its refusals, what moves and what stays, the survivor's trail reading the merged-in card as
 * its own, the picker's order, and the negative proof that a merged card is out of the sweep's reach
 * and cannot be reopened.
 */

const SEQUOIA = "sequoia@westpeek.ventures";
const SCOOTER = "scooter@westpeek.ventures";
const MEMBER = "member-merge@westpeek.ventures";

let t: TestDb;
let env: Env;

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await env.WP_OS_DB.prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_merge_member', ?1, 'Merge Member', 'ACTIVE')").bind(MEMBER).run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

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

const row = async (id: string) => (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, any>>())!;
const count = async (sql: string, ...binds: unknown[]) => (await env.WP_OS_DB.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

let seq = 0;
async function card(
  id: string,
  opts: { state?: string; owner?: string | null; ownerType?: string; by?: string | null; createdAt?: string; kind?: string | null; title?: string } = {},
): Promise<string> {
  seq += 1;
  // A BLOCKED card must say what stopped it and how to clear it (0173's trigger), as a real one does.
  const block = (opts.state ?? "OPEN") === "BLOCKED"
    ? ", block_who, block_needed, block_reason, block_stopped, block_trying, block_actions_json, blocked_at) VALUES (?1, ?2, 'opened', ?3, ?4, ?5, 'NORMAL', 'INTERNAL', 'west-peek', 'test', ?6, ?7, ?8, 'SEQUOIA', 'PREVIEW READY.', 'a_question_for_you', 'the preview', 'the community site', '[{\"key\":\"ANSWER\",\"label\":\"Answer\"}]', ?8)"
    : ") VALUES (?1, ?2, 'opened', ?3, ?4, ?5, 'NORMAL', 'INTERNAL', 'west-peek', 'test', ?6, ?7, ?8)";
  await env.WP_OS_DB.prepare(
    `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, privacy_label, firm_scope, created_by, kind, requested_by_email, created_at${block}`,
  )
    .bind(
      id,
      opts.title ?? `Card ${id}`,
      opts.ownerType ?? (opts.owner === null ? "UNASSIGNED" : "AI"),
      opts.owner === undefined ? "aie_porter" : opts.owner,
      opts.state ?? "OPEN",
      opts.kind ?? "WEB_PROPERTY_CHANGE",
      opts.by === undefined ? SEQUOIA : opts.by,
      opts.createdAt ?? `2026-09-27T10:${String(seq).padStart(2, "0")}:00.000Z`,
    )
    .run();
  return id;
}

describe("the pure rules (shared/work/mergeCards.ts)", () => {
  const open = { id: "a", state: "OPEN" };
  it("refuses the same card, a finished target, a card already merged, and a target that was itself merged", () => {
    expect(mergeRefusal(open, open)).toMatchObject({ ok: false, status: 400 });
    expect(mergeRefusal({ id: "b", state: "BLOCKED" }, { id: "a", state: "DONE" })).toMatchObject({ ok: false, status: 409 });
    expect(mergeRefusal({ id: "b", state: "BLOCKED" }, { id: "a", state: "CANCELLED" })).toMatchObject({ ok: false, status: 409 });
    expect(mergeRefusal({ id: "b", state: "CANCELLED", merged_into_card_id: "z" }, open)).toMatchObject({ ok: false, status: 409 });
    expect(mergeRefusal({ id: "b", state: "OPEN" }, { id: "a", state: "OPEN", merged_into_card_id: "z" })).toMatchObject({ ok: false, status: 409 });
    expect(mergeRefusal(null, open)).toMatchObject({ ok: false, status: 404 });
    expect(mergeRefusal(open, null)).toMatchObject({ ok: false, status: 404 });
  });
  it("allows a finished or cancelled FROM card into an open target — that is the whole point of the stray Walker cards", () => {
    expect(mergeRefusal({ id: "b", state: "DONE" }, open)).toEqual({ ok: true });
    expect(mergeRefusal({ id: "b", state: "CANCELLED" }, open)).toEqual({ ok: true });
  });
  it("orders the picker: never itself, never a finished card, the same primary partner first, then newest first", () => {
    const self = { id: "self", requested_by_email: "Sequoia@westpeek.ventures" };
    const cards = [
      { id: "self", title: "me", state: "OPEN", requested_by_email: SEQUOIA, created_at: "2026-09-27T12:00:00Z" },
      { id: "old-mine", title: "x", state: "BLOCKED", requested_by_email: SEQUOIA, created_at: "2026-09-23T12:00:00Z" },
      { id: "new-his", title: "x", state: "OPEN", requested_by_email: SCOOTER, created_at: "2026-09-27T11:00:00Z" },
      { id: "done-mine", title: "x", state: "DONE", requested_by_email: SEQUOIA, created_at: "2026-09-27T11:30:00Z" },
      { id: "new-mine", title: "x", state: "IN_PROGRESS", requested_by_email: SEQUOIA, created_at: "2026-09-27T11:20:00Z" },
      { id: "nobody", title: "x", state: "OPEN", requested_by_email: null, created_at: "2026-09-27T11:40:00Z" },
    ];
    expect(orderMergeTargets(self, cards).map((c) => c.id)).toEqual(["new-mine", "old-mine", "nobody", "new-his"]);
    // No primary on the card being merged: plain newest first.
    expect(orderMergeTargets({ id: "self", requested_by_email: null }, cards).map((c) => c.id)).toEqual(["nobody", "new-mine", "new-his", "old-mine"]);
  });
});

describe("when a card was formed (formedStamp)", () => {
  it("two cards from the same day, an hour apart, read apart — and both carry the date", () => {
    const a = formedStamp("2026-09-27T10:33:00.000Z");
    const b = formedStamp("2026-09-27T11:55:00.000Z");
    expect(a).not.toEqual(b);
    const day = new Date("2026-09-27T10:33:00.000Z").toLocaleDateString(undefined, { day: "numeric", month: "short" });
    expect(a.startsWith(day)).toBe(true);
    expect(b.startsWith(day)).toBe(true);
    expect(a).toMatch(/\d{1,2}:\d{2}/);
    expect(formedStamp(null)).toBe("");
    expect(formedStamp("garbage")).toBe("garbage");
  });
});

describe("POST /api/work-cards/:id/merge-into", () => {
  it("is a partner's door: a firm member who is not a partner is refused with 403", async () => {
    const from = await card("wc_m_notpartner_from");
    const into = await card("wc_m_notpartner_into");
    const res = await call(`/api/work-cards/${from}/merge-into`, MEMBER, "POST", { into });
    expect(res.status).toBe(403);
    expect((await row(from)).state).toBe("OPEN");
  });

  it("refuses the same card (400), a finished target (409), and a card already merged (409); says which card to merge into (400)", async () => {
    const from = await card("wc_m_refuse_from");
    const done = await card("wc_m_refuse_done", { state: "DONE" });
    const into = await card("wc_m_refuse_into");
    expect((await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", { into: from })).status).toBe(400);
    expect((await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", {})).status).toBe(400);
    expect((await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", { into: done })).status).toBe(409);
    expect((await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", { into: "wc_nope" })).status).toBe(404);
    expect((await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", { into })).status).toBe(200);
    // Already merged into `into`: the same request again is idempotent, not a refusal…
    const again = await call(`/api/work-cards/${from}/merge-into`, SCOOTER, "POST", { into });
    expect(again.status).toBe(200);
    expect(again.body.already).toBe(true);
    // …but into a DIFFERENT card it is refused, and a merged card is refused as a target.
    const other = await card("wc_m_refuse_other");
    expect((await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", { into: other })).status).toBe(409);
    expect((await call(`/api/work-cards/${other}/merge-into`, SEQUOIA, "POST", { into: from })).status).toBe(409);
    expect(await count("SELECT COUNT(*) AS n FROM work_card_merge WHERE from_card_id = ?1", from)).toBe(1);
  });

  it("moves the emails, the thread and the attachments, abandons the queued Mac run, writes both trail bullets, the history row and the event — and sends nothing", async () => {
    const from = await card("wc_m_move_from", { state: "BLOCKED", createdAt: "2026-09-23T16:55:00.000Z" });
    const into = await card("wc_m_move_into", { createdAt: "2026-09-27T11:33:00.000Z" });
    await env.WP_OS_DB.prepare(
      "INSERT INTO inbound_message (id, message_id, r2_key, from_address, subject, received_at, work_card_id) VALUES ('inm_m1', '<m1@x>', 'inbound/m1.eml', ?1, 'Re: the community site', '2026-09-27T11:20:00.000Z', ?2)",
    )
      .bind(SCOOTER, from)
      .run();
    await env.WP_OS_DB.prepare("INSERT INTO email_thread (token, object_type, object_id, to_address, subject) VALUES ('wpt_m1', 'work_card', ?1, ?2, 'Preview ready')").bind(from, SEQUOIA).run();
    await env.WP_OS_DB.prepare("INSERT INTO request_attachment (id, work_card_id, filename, media_type, bytes, eml_key) VALUES ('att_m1', ?1, 'logo.png', 'image/png', 10, 'inbound/m0.eml')").bind(from).run();
    // The same photo from the same stored message on BOTH cards (the matcher read the reply onto the
    // survivor before the stray was merged): the survivor's copy is the one, the stray's twin stays put.
    await env.WP_OS_DB.prepare("INSERT INTO request_attachment (id, work_card_id, filename, media_type, bytes, eml_key, source) VALUES ('att_m_twin_from', ?1, 'image0.jpeg', 'image/jpeg', 336435, 'inbound/m1.eml', 'REQUEST')").bind(from).run();
    await env.WP_OS_DB.prepare("INSERT INTO request_attachment (id, work_card_id, filename, media_type, bytes, eml_key, source) VALUES ('att_m_twin_into', ?1, 'image0.jpeg', 'image/jpeg', 336435, 'inbound/m1.eml', 'REPLY')").bind(into).run();
    await env.WP_OS_DB.prepare("INSERT INTO work_card_notice (id, work_card_id, kind, cause, sent_to, sent_at) VALUES ('wcn_m1', ?1, 'RECEIVED', '', ?2, '2026-09-23T16:55:29.000Z')").bind(from, SEQUOIA).run();
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card_hand_off (id, work_card_id, action, by_email, primary_email, secondary_email, via, sent, created_at) VALUES ('wcho_m1', ?1, 'HAND_OFF', ?2, ?3, ?2, 'REPLY', 1, '2026-09-26T09:00:00.000Z')",
    )
      .bind(from, SEQUOIA, SCOOTER)
      .run();
    await env.WP_OS_DB.prepare("INSERT INTO subscription_seat_run (id, seat, purpose, prompt, work_card_id, run_kind, status) VALUES ('ssr_m1', 'CLAUDE_CODE', 'build', 'x', ?1, 'LOCAL_JOB', 'QUEUED')").bind(from).run();
    const eventsBefore = await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.merged'");

    const res = await call(`/api/work-cards/${from}/merge-into`, SEQUOIA, "POST", { into, reason: "a reply too large for the matcher opened it" });
    expect(res.status).toBe(200);
    expect(res.body.moved).toEqual({ messages: 1, threads: 1, files: 1, runs_abandoned: 1 });

    const f = await row(from);
    expect(f.state).toBe("CANCELLED");
    expect(f.merged_into_card_id).toBe(into);
    expect(f.lease_until).toBeNull();
    expect(f.description).toContain(`• Merged into card ${into}`);
    expect(f.description).toContain("by Sequoia");
    const i = await row(into);
    expect(i.state).toBe("OPEN");
    expect(i.merged_into_card_id).toBeNull();
    expect(i.description).toContain(`• Folded in card ${from}`);
    expect(i.description).toContain("1 email, 1 thread and 1 file moved here");
    expect(i.description).toContain("Reason: a reply too large for the matcher opened it");

    expect((await env.WP_OS_DB.prepare("SELECT work_card_id FROM inbound_message WHERE id = 'inm_m1'").first<{ work_card_id: string }>())!.work_card_id).toBe(into);
    expect((await env.WP_OS_DB.prepare("SELECT object_id FROM email_thread WHERE token = 'wpt_m1'").first<{ object_id: string }>())!.object_id).toBe(into);
    expect((await env.WP_OS_DB.prepare("SELECT work_card_id FROM request_attachment WHERE id = 'att_m1'").first<{ work_card_id: string }>())!.work_card_id).toBe(into);
    expect((await env.WP_OS_DB.prepare("SELECT work_card_id FROM request_attachment WHERE id = 'att_m_twin_from'").first<{ work_card_id: string }>())!.work_card_id, "a twin of a file the survivor already holds is not moved").toBe(from);
    expect(await count("SELECT COUNT(*) AS n FROM request_attachment WHERE work_card_id = ?1 AND eml_key = 'inbound/m1.eml' AND filename = 'image0.jpeg'", into), "the survivor lists the photo once").toBe(1);
    // The notices and hand-offs STAY on the row they were sent for; the trail reads them across.
    expect(await count("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1", from)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM work_card_hand_off WHERE work_card_id = ?1", from)).toBe(1);
    expect((await env.WP_OS_DB.prepare("SELECT status FROM subscription_seat_run WHERE id = 'ssr_m1'").first<{ status: string }>())!.status).toBe("ABANDONED");

    const merge = await env.WP_OS_DB.prepare("SELECT * FROM work_card_merge WHERE from_card_id = ?1").bind(from).first<Record<string, any>>();
    expect(merge).toMatchObject({ into_card_id: into, by: "fu_sequoia_taylor", moved_messages: 1, moved_threads: 1, moved_files: 1 });
    expect(merge!.reason).toContain("too large");
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.merged' AND object_id = ?1", into)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.merged'")).toBe(eventsBefore + 1);
    // Nothing was emailed: no notice and no hand-off was written by the merge.
    expect(await count("SELECT COUNT(*) AS n FROM work_card_notice WHERE work_card_id = ?1", into)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM work_card_hand_off WHERE work_card_id = ?1", into)).toBe(0);

    // THE SURVIVOR'S TRAIL reads as one conversation: the stray's notice, its hand-off and its email,
    // each marked with the card it came from, then the merge itself.
    const trail = await call(`/api/work-cards/${into}/message-trail`, SEQUOIA);
    expect(trail.status).toBe(200);
    const kinds = trail.body.trail.map((e: any) => e.kind);
    expect(kinds).toEqual(["RECEIVED", "HAND_OFF", "HAND_OFF_EMAIL", "RECEIVED_EMAIL", "MERGED"]);
    const ats = trail.body.trail.map((e: any) => e.at);
    expect([...ats].sort()).toEqual(ats);
    // The notice and the hand-off still live on the stray's row and say so; the email MOVED, so it
    // is the survivor's own now and carries no from_card.
    expect(trail.body.trail.filter((e: any) => ["RECEIVED", "HAND_OFF", "HAND_OFF_EMAIL"].includes(e.kind)).every((e: any) => e.from_card === from)).toBe(true);
    expect(trail.body.trail.find((e: any) => e.kind === "MERGED")).toMatchObject({ who: "Sequoia", from_card: from });
    expect(trail.body.trail.find((e: any) => e.kind === "RECEIVED_EMAIL")).toMatchObject({ who: SCOOTER, hasMessage: true });
    expect(trail.body.trail.find((e: any) => e.kind === "RECEIVED_EMAIL").from_card).toBeUndefined();
    // The stray's own trail is unchanged in shape: its notice and hand-off, its email gone to the survivor.
    const strayTrail = await call(`/api/work-cards/${from}/message-trail`, SEQUOIA);
    expect(strayTrail.body.trail.map((e: any) => e.kind)).toEqual(["RECEIVED", "HAND_OFF", "HAND_OFF_EMAIL"]);
  });

  it("the script's actor is recorded as system:script and named in the bullet", async () => {
    const from = await card("wc_m_script_from", { state: "DONE", owner: "aie_walker" });
    const into = await card("wc_m_script_into");
    const out = await mergeCard(env, { fromCardId: from, intoCardId: into, actor: "system:script", reason: "27 Sep strays" });
    expect(out).toMatchObject({ ok: true, status: 200, from, into });
    expect((await row(into)).description).toContain("by the merge script");
    expect((await env.WP_OS_DB.prepare("SELECT by FROM work_card_merge WHERE from_card_id = ?1").bind(from).first<{ by: string }>())!.by).toBe("system:script");
    expect(await count("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.merged' AND actor_type = 'system' AND object_id = ?1", into)).toBe(1);
  });
});

describe("GET /api/work-cards/:id/merge-targets", () => {
  it("lists open cards only, never itself, the same primary partner first, newest first; partners only", async () => {
    // Fresh state for this ordering test: every earlier card is finished (CANCELLED: 0219 guards DONE on a web property card).
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')").run();
    const self = await card("wc_t_self", { createdAt: "2026-09-27T12:00:00.000Z" });
    await card("wc_t_his_new", { by: SCOOTER, createdAt: "2026-09-27T11:59:00.000Z" });
    await card("wc_t_mine_old", { state: "BLOCKED", createdAt: "2026-09-23T16:55:00.000Z" });
    await card("wc_t_mine_new", { state: "IN_PROGRESS", createdAt: "2026-09-27T11:33:00.000Z" });
    await card("wc_t_done", { state: "DONE", createdAt: "2026-09-27T11:50:00.000Z" });
    const res = await call(`/api/work-cards/${self}/merge-targets`, SEQUOIA);
    expect(res.status).toBe(200);
    expect(res.body.targets.map((c: any) => c.id)).toEqual(["wc_t_mine_new", "wc_t_mine_old", "wc_t_his_new"]);
    expect(res.body.targets[0]).toMatchObject({ title: "Card wc_t_mine_new", state: "IN_PROGRESS", requested_by_email: SEQUOIA });
    expect(res.body.targets[0].privacy_label).toBeUndefined();
    expect((await call(`/api/work-cards/${self}/merge-targets`, MEMBER)).status).toBe(403);
    expect((await call(`/api/work-cards/wc_nope/merge-targets`, SEQUOIA)).status).toBe(404);
  });
});

describe("a merged card is finished for good", () => {
  it("the sweep cannot pick it up (negative proof), and it cannot be reopened — 0242's trigger holds the line at the row", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN', 'IN_PROGRESS', 'BLOCKED')").run();
    // The stray is the ONLY sweep-eligible card: AI-owned, OPEN, unleased, no attempts.
    const from = await card("wc_s_from", { createdAt: "2026-09-27T09:00:00.000Z" });
    const into = await card("wc_s_into", { owner: "fu_sequoia_taylor", ownerType: "HUMAN", createdAt: "2026-09-27T09:30:00.000Z" });
    // Before the merge the sweep WOULD take it — proving the proof below has teeth.
    const eligible = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM work_card WHERE owner_type = 'AI' AND state IN ('OPEN', 'IN_PROGRESS') AND held_at IS NULL AND lease_until IS NULL",
    ).first<{ n: number }>();
    expect(eligible!.n).toBe(1);

    const out = await mergeCard(env, { fromCardId: from, intoCardId: into, actor: "fu_scooter_taylor" });
    expect(out.ok).toBe(true);

    const claimed = await claimNextCard(env, new Date());
    expect(claimed).toBeNull();
    expect((await row(from)).state).toBe("CANCELLED");

    // Reopen, by the route and by hand: the ROW refuses (0242's trigger), whatever the caller, and
    // the card is unchanged. The page never offers "Reopen" on a merged card; it offers the survivor.
    await expect(call(`/api/work-cards/${from}`, SEQUOIA, "PATCH", { state: "OPEN" })).rejects.toThrow(/merged into another/);
    await expect(env.WP_OS_DB.prepare("UPDATE work_card SET state = 'OPEN' WHERE id = ?1").bind(from).run()).rejects.toThrow(/merged into another/);
    expect((await row(from)).state).toBe("CANCELLED");
    // …and a card can never point at itself.
    await expect(env.WP_OS_DB.prepare("UPDATE work_card SET merged_into_card_id = ?1 WHERE id = ?1").bind(into).run()).rejects.toThrow(/into itself/);
    // The survivor, HUMAN-owned and OPEN, is untouched by the sweep and by the merge.
    expect((await row(into)).state).toBe("OPEN");
  });
});
