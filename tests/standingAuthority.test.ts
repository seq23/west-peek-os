import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleRequest } from "../src/worker/index";
import { authorize } from "../src/worker/services/authorize";
import { endsAt } from "../src/worker/services/standingAuthority";
import type { Env } from "../src/worker/env";

/**
 * ADR-018 — approving something once and not being asked again, within bounds.
 *
 * The suite is ordered by how badly each failure would hurt.
 *
 * 1. **A standing grant can never reach a reserved action or an external effect.** This is the rule
 *    the whole tier rests on. Reserved actions are reserved because the judgement IS the work, and
 *    external effects leave the building — including the operator's standing line that no AI
 *    employee emails anybody yet. It is enforced by WHERE the check sits in `authorize()`, after the
 *    branches that return for those cases, so it holds even if a row somehow says otherwise.
 * 2. **All three bounds are required.** Scope, a use count, and an expiry. A grant missing any one
 *    is how a reasonable arrangement becomes a dangerous one.
 * 3. **Uses are spent and then run out.** A limit that is not enforced is a comment.
 * 4. **Expiry and revocation both stop it**, and revocation needs no reason — stopping is safe.
 * 5. **A task grant dies with the task**, which is the whole reason it is the recommended option.
 */

let t: TestDb;
let env: Env;

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

function req(path: string, headers: Record<string, string> = {}, method = "GET", body?: unknown): Request {
  return new Request(`https://test.local${path}`, {
    method,
    headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call<T = any>(path: string, headers: Record<string, string>, method = "GET", body?: unknown): Promise<{ status: number; body: T }> {
  const res = await handleRequest(req(path, headers, method, body), env);
  return { status: res.status, body: (await res.json()) as T };
}

const partner = { type: "HUMAN" as const, firmUserId: "fu_sequoia_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const target = { objectType: "work_card", objectId: "wc_standing_test", firmScope: "west-peek" };

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("what can never be delegated", () => {
  it("refuses to record a grant over a reserved action, and says why rather than just no", async () => {
    const res = await call<{ error: string; detail: string }>("/api/standing-authority", MP, "POST", {
      action_key: "investment.approve",
      window: "TODAY",
      reason: "trying to skip the committee",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_delegable");
    // A partner told "the judgement is the work" learns the shape of the system. "Forbidden" does not.
    expect(res.body.detail).toMatch(/judgement is the work|comes back to you/i);
  });

  it("refuses to record a grant over an external effect — the operator's no-outbound line", async () => {
    const res = await call<{ error: string; detail: string }>("/api/standing-authority", MP, "POST", {
      action_key: "effect.email.send",
      window: "THIS_WEEK",
      reason: "sending the LP update every week",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("not_delegable");
    expect(res.body.detail).toMatch(/leaves the building/i);
  });

  it("still refuses at the choke point even when a row says otherwise", async () => {
    /*
     * The one that matters. The service refuses to WRITE such a row; this proves that if one existed
     * anyway — inserted by hand, by an older migration, or by a key that became reserved after the
     * grant was made — `authorize()` would not honour it, because the reserved branch returns before
     * the standing check is ever reached.
     */
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority (id, action_key, ends_at, max_uses, granted_by, reason)
       VALUES ('sta_forged', 'investment.approve', '2099-01-01T00:00:00.000Z', 50, 'fu_sequoia_taylor', 'planted by a test')`,
    ).run();

    /*
     * ASSERTED AT THE SEAM THAT EXISTS. This used to check `authorize()` never returned the reason
     * "standing_authority" — trivially true, because the standing branch was moved OUT of authorize()
     * to the approval queue and no such reason is ever returned there. The test would have passed
     * with the feature deleted, which is the definition of an assertion that holds nothing.
     *
     * It now proves the thing that matters: a forged grant over a reserved action does not get a card
     * waved through. And the check is on the LIVE flags rather than on what was true when the grant
     * was written, so a key that becomes reserved LATER stops being coverable immediately.
     */
    const card = await call<{ id: string }>("/api/approvals", MP, "POST", {
      action_key: "investment.approve",
      object_type: "canonical_company",
      object_id: "cc_forged",
      title: "deciding with a forged grant",
    });
    const submitted = await call<{ state: string }>(`/api/approvals/${card.body.id}/submit`, MP, "POST", {});
    expect(submitted.body.state, "a reserved action still waits for a partner").toBe("pending_review");

    const spent = await env.WP_OS_DB.prepare("SELECT uses FROM standing_authority WHERE id = 'sta_forged'")
      .first<{ uses: number }>();
    expect(spent!.uses, "and the forged grant was never even touched").toBe(0);
  });

  it("stops covering an action the moment that action becomes reserved", async () => {
    /*
     * The case migration 0130 was written for and the code had stopped honouring: a grant made while
     * a key was ordinary must die the instant the key becomes reserved, with nobody remembering to
     * revoke it. Checked against the LIVE flags at spend time rather than captured at grant time.
     */
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority (id, action_key, ends_at, max_uses, granted_by, reason)
       VALUES ('sta_later', 'company.update', '2099-01-01T00:00:00.000Z', 10, 'fu_sequoia_taylor', 'granted while ordinary')`,
    ).run();

    const raise = async (objectId: string) => {
      const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
        action_key: "company.update",
        object_type: "canonical_company",
        object_id: objectId,
        title: `deciding ${objectId}`,
      });
      const res = await call<{ state: string }>(`/api/approvals/${created.body.id}/submit`, MP, "POST", {});
      return res.body.state;
    };

    expect(await raise("cc_before"), "ordinary: the grant covers it").toBe("approved");

    // The firm decides this needs a partner every time. Nothing revokes the grant.
    await env.WP_OS_DB.prepare("UPDATE action_type SET is_reserved = 1 WHERE key = 'company.update'").run();
    expect(await raise("cc_after"), "reserved now: the grant must stop covering it").toBe("pending_review");

    await env.WP_OS_DB.prepare("UPDATE action_type SET is_reserved = 0 WHERE key = 'company.update'").run();
    /*
     * REVOKED, because a live grant left behind is shared state and the next test in this file is
     * about a grant running out. A test that leaves authority lying around makes the one after it
     * pass or fail for reasons it never mentions — which is the brittleness this suite has been
     * having removed all day.
     */
    await env.WP_OS_DB.prepare(
      "UPDATE standing_authority SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'sta_later'",
    ).run();
  });
});

describe("a grant is bounded three ways", () => {
  it("will not last until a task is done without being given the task", async () => {
    const res = await call<{ error: string; detail: string }>("/api/standing-authority", MP, "POST", {
      action_key: "work_card.create",
      window: "THIS_TASK",
      reason: "clearing the intake backlog",
    });
    expect(res.status).toBe(400);
    expect(res.body.detail).toMatch(/needs the task/i);
  });

  it("will not take a grant with no reason", async () => {
    const res = await call("/api/standing-authority", MP, "POST", {
      action_key: "work_card.create",
      window: "TODAY",
      reason: "ok",
    });
    expect(res.status).toBe(400);
  });

  it("honours the object-type scope, which was decorative", async () => {
    /*
     * The bound that read as a narrowing and was not one. `object_type` was consulted only inside
     * the branch requiring a non-null `object_id`, so a grant scoped to a TYPE matched every object
     * of every type — and that is exactly the shape the delegate control sends. Every grant made
     * through the product was a blanket grant while the row said otherwise, which is worse than an
     * honest blanket grant: the operator could see a scope she did not have.
     */
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority (id, action_key, object_type, ends_at, max_uses, granted_by, reason)
       VALUES ('sta_typed', 'company.update', 'canonical_company', '2099-01-01T00:00:00.000Z', 10, 'fu_sequoia_taylor', 'companies only')`,
    ).run();

    const submit = async (objectType: string, objectId: string) => {
      const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
        action_key: "company.update",
        object_type: objectType,
        object_id: objectId,
        title: `deciding ${objectId}`,
      });
      const res = await call<{ state: string }>(`/api/approvals/${created.body.id}/submit`, MP, "POST", {});
      return res.body.state;
    };

    expect(await submit("canonical_company", "cc_in_scope"), "the type it was granted for").toBe("approved");
    expect(await submit("work_card", "wc_out_of_scope"), "a different type is NOT covered").toBe("pending_review");

    // Left revoked: a live grant is shared state, and the next test is about a grant running out.
    await env.WP_OS_DB.prepare(
      "UPDATE standing_authority SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'sta_typed'",
    ).run();
  });

  it("ends today at the end of today, and this week at the end of Sunday", () => {
    // A Wednesday.
    const wed = new Date("2026-08-19T14:00:00.000Z");
    expect(endsAt("TODAY", wed)).toBe("2026-08-19T23:59:59.999Z");
    expect(endsAt("THIS_WEEK", wed)).toBe("2026-08-23T23:59:59.999Z");
    // A Sunday grant lasts that day, not eight more — `getUTCDay()` is 0 and the modulo holds.
    const sun = new Date("2026-08-23T09:00:00.000Z");
    expect(endsAt("THIS_WEEK", sun)).toBe("2026-08-23T23:59:59.999Z");
  });
});

describe("a delegated card does not wait in the queue", () => {
  /*
   * THE INTEGRATION POINT, and getting it wrong the first time is worth recording. The check began
   * life inside `authorize()`, where it was INERT wherever it was safe — only reserved actions and
   * external effects return REQUIRE_APPROVAL there, and neither is delegable — and DANGEROUS where
   * it was not: it would have satisfied a role-gated action for any identity at all, including the
   * read-only service account. Delegating an approval is about the QUEUE, so it belongs at the
   * queue, and the card is still written, still attributed, still on the spine. It simply does not
   * sit there waiting.
   */
  async function raise(actionKey: string, objectId: string): Promise<string> {
    const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
      action_key: actionKey,
      object_type: "canonical_company",
      object_id: objectId,
      title: `deciding ${objectId}`,
    });
    expect(created.status).toBe(201);
    return created.body.id;
  }

  it("auto-approves against a live grant, records the use, and says so on the card", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority (id, action_key, ends_at, max_uses, granted_by, reason)
       VALUES ('sta_two', 'company.update', '2099-01-01T00:00:00.000Z', 2, 'fu_sequoia_taylor', 'tidying the register today')`,
    ).run();

    const first = await raise("company.update", "cc_sa_1");
    const submitted = await call<{ state: string; decision_note: string }>(`/api/approvals/${first}/submit`, MP, "POST", {});
    expect(submitted.status).toBe(200);
    // Approved, not pending. That is the whole ask.
    expect(submitted.body.state).toBe("approved");
    expect(submitted.body.decision_note).toMatch(/standing authority/i);
  });

  it("runs out, and the next one waits like any other", async () => {
    const second = await raise("company.update", "cc_sa_2");
    await call(`/api/approvals/${second}/submit`, MP, "POST", {});

    // Two uses granted, two spent. The third is a normal card again.
    const third = await raise("company.update", "cc_sa_3");
    const res = await call<{ state: string }>(`/api/approvals/${third}/submit`, MP, "POST", {});
    expect(res.body.state).toBe("pending_review");
  });

  it("records every use, so a grant can be audited rather than only counted", async () => {
    const uses = await env.WP_OS_DB.prepare(
      "SELECT COUNT(*) AS n FROM standing_authority_use WHERE authority_id = 'sta_two'",
    ).first<{ n: number }>();
    expect(uses!.n).toBe(2);
  });

  it("cannot be widened after the fact", async () => {
    // Raising the ceiling on a live grant is how a bounded permission quietly becomes an unbounded
    // one, so the database refuses it rather than trusting every future caller.
    await expect(
      env.WP_OS_DB.prepare("UPDATE standing_authority SET max_uses = 500 WHERE id = 'sta_two'").run(),
    ).rejects.toThrow();
  });
});

describe("stopping is always safe", () => {
  async function raiseAndSubmit(objectId: string): Promise<string> {
    const created = await call<{ id: string }>("/api/approvals", MP, "POST", {
      action_key: "company.update",
      object_type: "canonical_company",
      object_id: objectId,
      title: `deciding ${objectId}`,
    });
    const res = await call<{ state: string }>(`/api/approvals/${created.body.id}/submit`, MP, "POST", {});
    return res.body.state;
  }

  it("revokes without a reason and takes effect immediately", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority (id, action_key, ends_at, max_uses, granted_by, reason)
       VALUES ('sta_live', 'company.update', '2099-01-01T00:00:00.000Z', 10, 'fu_sequoia_taylor', 'a grant to revoke')`,
    ).run();
    expect(await raiseAndSubmit("cc_rev_1")).toBe("approved");

    // No reason, no approval needed. The same rule that governs pausing an employee: a control that
    // makes the system do LESS must never be harder to reach than the one that made it do more.
    const revoked = await call("/api/standing-authority/sta_live/revoke", MP, "POST", {});
    expect(revoked.status).toBe(200);

    expect(await raiseAndSubmit("cc_rev_2")).toBe("pending_review");
  });

  it("dies with the task it was tied to", async () => {
    await env.WP_OS_DB.prepare(
      `INSERT INTO work_card (id, title, state, created_by) VALUES ('wc_sa_task', 'A task', 'OPEN', 'fu_sequoia_taylor')`,
    ).run();
    await env.WP_OS_DB.prepare(
      `INSERT INTO standing_authority (id, action_key, work_card_id, ends_at, max_uses, granted_by, reason)
       VALUES ('sta_task', 'company.update', 'wc_sa_task', '2099-01-01T00:00:00.000Z', 10, 'fu_sequoia_taylor', 'while this task runs')`,
    ).run();
    expect(await raiseAndSubmit("cc_task_1")).toBe("approved");

    // Closing the card ends the authority with nobody deciding it should. That is the entire reason
    // "until this task is done" is the recommended window rather than a clock that runs overnight.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = 'wc_sa_task'").run();
    expect(await raiseAndSubmit("cc_task_2")).toBe("pending_review");
  });
});
