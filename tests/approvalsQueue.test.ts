import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { ApprovalError, consumeApprovalCard, reopenApproval } from "../src/worker/services/approvals";

/**
 * Item 3: changing a decision after it is made, and a block that is not a rejection.
 *
 * WHAT THIS SUITE IS ACTUALLY GUARDING. Both features are only worth anything if the record they
 * leave behind cannot be edited afterwards, so most of what is asserted here is what the system
 * REFUSES: you cannot rewrite a decision, you cannot delete a block, you cannot release the same
 * block twice, you cannot reopen something that already happened, and you cannot execute a card the
 * firm has put on hold. A feature that records who changed their mind and why, and then lets the
 * row be edited, is worse than not having it.
 *
 * The state-machine basics (drafted → pending_review → decided, and the illegal transitions) live
 * in tests/authority.test.ts §8 and are not repeated here.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const MEMBER = { "x-wpos-dev-user": "member@westpeek.ventures" }; // INVESTMENT_TEAM, not an approver

const AI_ACTOR: Actor = { type: "AI", aiEmployeeId: "Pierce", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };

/** An MP-reserved action, so "you do not hold the role" is testable with a real card. */
const RESERVED = "governance.policy_change";

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function newCard(title: string, actionKey = RESERVED): Promise<string> {
  const res = await handleRequest(
    req("/api/approvals", MP, "POST", {
      action_key: actionKey,
      object_type: "provider_registry",
      object_id: "anthropic",
      title,
      submit: true,
    }),
    env,
  );
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function decide(cardId: string, decision: string, note?: string, headers = MP): Promise<Response> {
  return handleRequest(req(`/api/approvals/${cardId}/decide`, headers, "POST", { decision, note }), env);
}

async function cardState(cardId: string): Promise<string> {
  const row = await t.db.prepare("SELECT state FROM approval_card WHERE id = ?1").bind(cardId).first<{ state: string }>();
  return row!.state;
}

async function trail(cardId: string): Promise<Array<{ id: string; decision: string; note: string | null; supersedes_decision_id: string | null }>> {
  const rows = await t.db
    .prepare("SELECT id, decision, note, supersedes_decision_id FROM approval_decision WHERE approval_card_id = ?1 ORDER BY created_at, id")
    .bind(cardId)
    .all<{ id: string; decision: string; note: string | null; supersedes_decision_id: string | null }>();
  return rows.results ?? [];
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  await t.db
    .prepare("INSERT INTO firm_user (id, email, full_name, status) VALUES ('fu_test_member', 'member@westpeek.ventures', 'Test Member', 'ACTIVE')")
    .run();
  await t.db
    .prepare("INSERT INTO firm_user_role (firm_user_id, role_id) VALUES ('fu_test_member', 'role_investment_team')")
    .run();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("changing a decision after it has been made", () => {
  it("records a NEW decision that supersedes the old one, and leaves the original untouched", async () => {
    const card = await newCard("reopen: the rejection that was wrong");
    expect((await decide(card, "rejected", "no, the terms are off")).status).toBe(200);
    const [rejection] = await trail(card);

    const reopened = await handleRequest(
      req(`/api/approvals/${card}/reopen`, MP, "POST", { reason: "the terms changed and my no was based on the old ones" }),
      env,
    );
    expect(reopened.status).toBe(200);

    const rows = await trail(card);
    expect(rows).toHaveLength(2);
    // The original is byte-for-byte what it was. This is the assertion the whole feature turns on.
    expect(rows[0]).toEqual(rejection);
    expect(rows[1]!.decision).toBe("reopened");
    expect(rows[1]!.supersedes_decision_id).toBe(rejection!.id);
    expect(rows[1]!.note).toContain("the terms changed");

    // Back in front of a person, with no decision currently standing on the card.
    expect(await cardState(card)).toBe("pending_review");
    const mirrored = await t.db
      .prepare("SELECT decided_by, decided_at, decision_note FROM approval_card WHERE id = ?1")
      .bind(card)
      .first<{ decided_by: string | null; decided_at: string | null; decision_note: string | null }>();
    expect(mirrored).toEqual({ decided_by: null, decided_at: null, decision_note: null });

    // And it can now be answered the other way, which is the point of reopening it.
    expect((await decide(card, "approved", "revised terms accepted")).status).toBe(200);
    expect(await cardState(card)).toBe("approved");
    expect(await trail(card)).toHaveLength(3);
  });

  it("refuses without a reason, and records nothing", async () => {
    const card = await newCard("reopen: no reason given");
    expect((await decide(card, "approved")).status).toBe(200);

    const blank = await handleRequest(req(`/api/approvals/${card}/reopen`, MP, "POST", { reason: "  " }), env);
    expect(blank.status).toBe(400);
    expect(((await blank.json()) as { detail: string }).detail).toMatch(/say what changed/i);
    expect(await cardState(card)).toBe("approved");
    expect(await trail(card)).toHaveLength(1);
  });

  it("refuses to reopen something that already happened, and says why", async () => {
    const card = await newCard("reopen: already executed");
    expect((await decide(card, "approved", "yes")).status).toBe(200);
    await consumeApprovalCard(env, card, { actorId: "fu_scooter_taylor" });
    expect(await cardState(card)).toBe("executed");

    const res = await handleRequest(req(`/api/approvals/${card}/reopen`, MP, "POST", { reason: "I changed my mind" }), env);
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe("already_carried_out");
    expect(body.detail).toMatch(/already happened/i);
    expect(await cardState(card)).toBe("executed");
  });

  it("refuses a reader who does not hold the approver role, and an AI outright", async () => {
    const card = await newCard("reopen: wrong hands");
    expect((await decide(card, "approved", "yes")).status).toBe(200);

    const asMember = await handleRequest(
      req(`/api/approvals/${card}/reopen`, MEMBER, "POST", { reason: "I disagree with this" }),
      env,
    );
    expect(asMember.status).toBe(403);

    // An AI holding the role name in its actor record still cannot: the check is on actor TYPE
    // first, so a mis-scoped employee can never take back a partner's decision.
    await expect(reopenApproval(env, AI_ACTOR, card, "the model reconsidered")).rejects.toBeInstanceOf(ApprovalError);
    expect(await cardState(card)).toBe("approved");
  });

  it("says there is nothing to change when nothing has been decided", async () => {
    const card = await newCard("reopen: nothing decided yet");
    const res = await handleRequest(req(`/api/approvals/${card}/reopen`, MP, "POST", { reason: "just checking" }), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe("nothing_decided");
  });
});

describe("a block is not a rejection", () => {
  it("names what it is waiting on, stops execution, and is not a verdict on the request", async () => {
    const card = await newCard("block: waiting on counsel");
    const blocked = await handleRequest(
      req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "counsel has to clear the side letter" }),
      env,
    );
    expect(blocked.status).toBe(201);
    expect(((await blocked.json()) as { waiting_on: string }).waiting_on).toContain("side letter");
    expect(await cardState(card)).toBe("blocked");

    // The list carries the blocker, so "Blocked" is never the only thing a partner is told.
    const list = (await (await handleRequest(req("/api/approvals?state=blocked", MP), env)).json()) as {
      approvals: Array<{ id: string; blocked_waiting_on: string | null }>;
    };
    expect(list.approvals.find((a) => a.id === card)!.blocked_waiting_on).toContain("side letter");

    // It is on the same chronology as the decisions, not hidden in a side table nobody reads.
    expect((await trail(card)).map((d) => d.decision)).toEqual(["blocked"]);
  });

  it("refuses a block that cannot say what it is waiting for", async () => {
    const card = await newCard("block: unnamed blocker");
    const res = await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "" }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toMatch(/waiting on/i);
    expect(await cardState(card)).toBe("pending_review");
  });

  it("refuses a second block and repeats what the standing one is waiting for", async () => {
    const card = await newCard("block: twice");
    expect((await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "the audited accounts" }), env)).status).toBe(201);
    const again = await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "something else" }), env);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { detail: string }).detail).toContain("the audited accounts");
  });

  it("puts the card back exactly where it was — a block pauses, it never decides", async () => {
    const card = await newCard("block: an approved card still has to run");
    expect((await decide(card, "approved", "yes, subject to the wire clearing")).status).toBe(200);
    expect((await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "the wire has to clear" }), env)).status).toBe(201);
    expect(await cardState(card)).toBe("blocked");

    // While blocked, no execution path may consume it. This is what makes a block real rather than
    // a note on a card that carries on regardless.
    await expect(consumeApprovalCard(env, card, { actorId: "fu_scooter_taylor" })).rejects.toBeInstanceOf(ApprovalError);

    const released = await handleRequest(req(`/api/approvals/${card}/release`, MP, "POST", { reason: "the wire landed" }), env);
    expect(released.status).toBe(200);
    // Approved again — NOT sent back for a second yes. Blocking is not a decision, so releasing
    // cannot become one.
    expect(await cardState(card)).toBe("approved");
    await consumeApprovalCard(env, card, { actorId: "fu_scooter_taylor" });
    expect(await cardState(card)).toBe("executed");
  });

  it("refuses a release that cannot say what resolved it, and a release with nothing to release", async () => {
    const card = await newCard("block: release needs a reason");
    expect((await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "the cap table" }), env)).status).toBe(201);

    const blank = await handleRequest(req(`/api/approvals/${card}/release`, MP, "POST", { reason: "" }), env);
    expect(blank.status).toBe(400);
    expect(await cardState(card)).toBe("blocked");

    const other = await newCard("block: nothing blocking this");
    const none = await handleRequest(req(`/api/approvals/${other}/release`, MP, "POST", { reason: "nothing to do" }), env);
    expect(none.status).toBe(409);
    expect(((await none.json()) as { error: string }).error).toBe("not_blocked");
  });

  it("refuses to block something that already ran or was already turned down", async () => {
    const executed = await newCard("block: already executed");
    expect((await decide(executed, "approved", "yes")).status).toBe(200);
    await consumeApprovalCard(env, executed, { actorId: "fu_scooter_taylor" });
    const late = await handleRequest(req(`/api/approvals/${executed}/block`, MP, "POST", { waiting_on: "too late" }), env);
    expect(late.status).toBe(409);
    expect(((await late.json()) as { detail: string }).detail).toMatch(/already happened/i);

    const rejected = await newCard("block: already rejected");
    expect((await decide(rejected, "rejected", "no")).status).toBe(200);
    const pointless = await handleRequest(req(`/api/approvals/${rejected}/block`, MP, "POST", { waiting_on: "pointless" }), env);
    expect(pointless.status).toBe(409);
  });

  it("is human-reserved and role-gated like a decision", async () => {
    const card = await newCard("block: wrong hands");
    const asMember = await handleRequest(req(`/api/approvals/${card}/block`, MEMBER, "POST", { waiting_on: "anything" }), env);
    expect(asMember.status).toBe(403);
    expect(await cardState(card)).toBe("pending_review");
  });
});

describe("the block record cannot be rewritten", () => {
  it("rejects DELETE, a second release, and any edit to what it was waiting on", async () => {
    const card = await newCard("block: the record is final");
    expect((await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "the audit" }), env)).status).toBe(201);
    const row = await t.db
      .prepare("SELECT id FROM approval_block WHERE approval_card_id = ?1")
      .bind(card)
      .first<{ id: string }>();

    await expect(
      t.db.prepare("UPDATE approval_block SET waiting_on = 'something more convenient' WHERE id = ?1").bind(row!.id).run(),
    ).rejects.toThrow(/cannot be rewritten/);
    await expect(t.db.prepare("DELETE FROM approval_block WHERE id = ?1").bind(row!.id).run()).rejects.toThrow(/append-only/);

    expect((await handleRequest(req(`/api/approvals/${card}/release`, MP, "POST", { reason: "the audit came back" }), env)).status).toBe(200);
    // Once released it is finished: the release facts are write-once.
    await expect(
      t.db.prepare("UPDATE approval_block SET release_note = 'actually it did not' WHERE id = ?1").bind(row!.id).run(),
    ).rejects.toThrow(/final/);

    const intact = await t.db
      .prepare("SELECT waiting_on, release_note FROM approval_block WHERE id = ?1")
      .bind(row!.id)
      .first<{ waiting_on: string; release_note: string }>();
    expect(intact).toEqual({ waiting_on: "the audit", release_note: "the audit came back" });
  });

  it("keeps every block on the card, released ones included", async () => {
    const card = await newCard("block: twice over its life");
    await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "first blocker" }), env);
    await handleRequest(req(`/api/approvals/${card}/release`, MP, "POST", { reason: "first one cleared" }), env);
    await handleRequest(req(`/api/approvals/${card}/block`, MP, "POST", { waiting_on: "second blocker" }), env);

    const detail = (await (await handleRequest(req(`/api/approvals/${card}`, MP), env)).json()) as {
      state: string;
      blocks: Array<{ waiting_on: string; released_at: string | null }>;
      decisions: Array<{ decision: string }>;
    };
    expect(detail.state).toBe("blocked");
    expect(detail.blocks.map((b) => b.waiting_on)).toEqual(["first blocker", "second blocker"]);
    expect(detail.blocks[0]!.released_at).not.toBeNull();
    expect(detail.blocks[1]!.released_at).toBeNull();
    expect(detail.decisions.map((d) => d.decision)).toEqual(["blocked", "unblocked", "blocked"]);
  });
});
