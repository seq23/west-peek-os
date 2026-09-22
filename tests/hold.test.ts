import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal, handleGetWorkCard, handleHoldWorkCard, handleReleaseWorkCard, handleUpdateWorkCard, handleWorkByOwner } from "../src/worker/services/workCards";
import { sweepIdentity, claimNextCard, settleAbandonedCards } from "../src/worker/services/workSweep";
import { blockCard, resurfaceStaleBlocks } from "../src/worker/services/blocks";

/**
 * HELD (Wave D, 0227, 22 Sep 2026) — she can pull a card and save it for later, with her reason.
 *
 * Her words: "I should be able to pull a work card and save for later with a note … and the owner
 * of that card can relay that to anyone else who asks about it."
 *
 * THE SINGLE MOST IMPORTANT CORRECTNESS RULE IN THIS WAVE, proven negatively three ways: holding a
 * leased card clears the lease in the same write (not merely by convention — the row itself refuses
 * any write that would leave HELD and a live lease standing together), and a card that reads "held"
 * is never claimed again while it does.
 *
 * A HOLD IS SILENT, proven negatively too: a card that carries a stale, pre-hold block-nag clock
 * from before it was held is never resurfaced by `resurfaceStaleBlocks`, which only ever selects
 * `state = 'BLOCKED'`.
 */

let t: TestDb;
let env: Env;
const IDENTITY = sweepIdentity();
const SEQUOIA = {
  id: "fu_sequoia_taylor",
  email: "sequoia@westpeek.ventures",
  fullName: "Sequoia Taylor",
  status: "ACTIVE",
  roles: ["MANAGING_PARTNER"],
  authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }],
} as const;

async function card(title: string, owner = "aie_porter"): Promise<{ id: string }> {
  const c = await createWorkCardInternal(env, IDENTITY, {
    title,
    owner_type: "AI",
    owner_id: owner,
    priority: "NORMAL",
    firm_scope: "west-peek",
  });
  return { id: c.id };
}

async function row(id: string): Promise<Record<string, unknown>> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("holding a card", () => {
  it("moves OPEN, IN_PROGRESS or BLOCKED to HELD, with the reason, who and when", async () => {
    const c = await card("Draft the October newsletter");
    const out = await handleHoldWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request(`https://os.joinwestpeek.com/api/work-cards/${c.id}/hold`, { method: "POST", body: JSON.stringify({ reason: "Want to be at my desk for this one." }) }),
    } as never);
    expect(out.status).toBe(200);
    // THE API SYNTHESISES "HELD" for display (see displayState in workCards.ts) — the underlying
    // stored `state` column is untouched by design (0227) and stays whatever it legitimately was.
    const body = (await out.json()) as { state: string };
    expect(body.state).toBe("HELD");
    const stored = await row(c.id);
    expect(stored.state, "the stored column keeps its real value — HELD lives in held_at, not here").toBe("OPEN");
    expect(stored.held_reason).toBe("Want to be at my desk for this one.");
    expect(stored.held_by).toBe("fu_sequoia_taylor");
    expect(stored.held_at).toBeTruthy();
  });

  it("refuses a reason shorter than the minimum — a hold with no reason is the empty state this feature exists to prevent", async () => {
    const c = await card("Reason-less hold attempt");
    const out = await handleHoldWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request(`https://os.joinwestpeek.com/api/work-cards/${c.id}/hold`, { method: "POST", body: JSON.stringify({ reason: "" }) }),
    } as never);
    expect(out.status).toBeGreaterThanOrEqual(400);
    const stored = await row(c.id);
    expect(stored.held_at).toBeNull();
  });

  it("refuses to hold a card that is already DONE or CANCELLED — nothing to pull", async () => {
    const c = await card("Finished already");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(c.id).run();
    const out = await handleHoldWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "POST", body: JSON.stringify({ reason: "too late" }) }),
    } as never);
    expect(out.status).toBe(409);
  });

  it("refuses to hold a card that is already HELD", async () => {
    const c = await card("Already held");
    await holdRaw(c.id, "First reason");
    const out = await handleHoldWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "POST", body: JSON.stringify({ reason: "Second reason" }) }),
    } as never);
    expect(out.status).toBe(409);
    // Her first reason survives — a refused second hold does not overwrite it.
    expect((await row(c.id)).held_reason).toBe("First reason");
  });
});

describe("holding an already-claimed card releases the claim — the correctness rule this wave exists for", () => {
  it("clears a live lease in the same write as the hold", async () => {
    const c = await card("Mid-flight when she pulls it");
    // Simulate the Mac holding the claim: a lease in the future, an attempt under way.
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', lease_until = ?2, work_attempts = 1 WHERE id = ?1").bind(c.id, future).run();
    expect((await row(c.id)).lease_until, "the lease is genuinely live before the hold").toBe(future);

    const out = await handleHoldWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "POST", body: JSON.stringify({ reason: "Big job — want to watch it." }) }),
    } as never);
    expect(out.status).toBe(200);
    const body = (await out.json()) as { state: string };
    expect(body.state, "the caller sees HELD, synthesised from held_at").toBe("HELD");

    const stored = await row(c.id);
    expect(stored.state, "the stored column keeps its real underlying value").toBe("IN_PROGRESS");
    // THE RULE: the Mac cannot keep executing a card that now reads "held".
    expect(stored.lease_until, "the claim is released in the same write as the hold").toBeNull();
    expect(stored.held_at, "held_at is the actual fact — this is what every skip query reads").toBeTruthy();
  });

  /*
   * HELD IS held_at IS NOT NULL, NOT A state VALUE (0227) — `work_card.state` carries a CHECK
   * constraint from migration 0003 that only ever allowed the original five values, and widening it
   * would mean rebuilding a table referenced by roughly twenty others (the exact failure class
   * migration 0189 already hit once, on a far smaller table). So the two negative proofs below go
   * around the service by writing `held_at` directly, the same as any future caller would.
   */
  it("the row itself refuses a live lease standing beside held_at, whoever writes it — proven by going around the service", async () => {
    const c = await card("A future caller who forgets to clear the lease");
    const future = new Date(Date.now() + 10 * 60_000).toISOString();
    await env.WP_OS_DB.prepare("UPDATE work_card SET lease_until = ?2, held_reason = 'x', held_by = 'fu_sequoia_taylor' WHERE id = ?1").bind(c.id, future).run();
    await expect(
      env.WP_OS_DB.prepare("UPDATE work_card SET held_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(c.id).run(),
    ).rejects.toThrow(/live lease/i);
  });

  it("the row itself refuses held_at with no reason, whoever writes it", async () => {
    const c = await card("A future caller who forgets the reason");
    await expect(
      env.WP_OS_DB.prepare("UPDATE work_card SET held_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), held_by = 'fu_sequoia_taylor' WHERE id = ?1").bind(c.id).run(),
    ).rejects.toThrow(/reason/i);
  });

  it("the row itself refuses held_at on a finished or dropped card, whoever writes it", async () => {
    const c = await card("A future caller who tries to hold finished work");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'DONE' WHERE id = ?1").bind(c.id).run();
    await expect(
      env.WP_OS_DB.prepare("UPDATE work_card SET held_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), held_reason = 'x', held_by = 'fu_sequoia_taylor' WHERE id = ?1").bind(c.id).run(),
    ).rejects.toThrow(/finished or dropped/i);
  });

  it("a held card is never claimed by the sweep, whatever its attempt count", async () => {
    const c = await card("Held, and also at the attempt cap");
    // 0194 refuses an OPEN card sitting at its attempt cap (nothing could pick it up and nothing
    // would say why) — IN_PROGRESS at the cap is the legitimate "still on its last attempt" shape,
    // so the fixture matches the one a real spent-attempts card would actually be in.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'IN_PROGRESS', work_attempts = 3 WHERE id = ?1").bind(c.id).run();
    await holdRaw(c.id, "She is watching this one");
    const claimed = await claimNextCard(env, new Date());
    expect(claimed?.id).not.toBe(c.id);
    const settled = await settleAbandonedCards(env, new Date());
    expect(settled.map((s) => s.id)).not.toContain(c.id);
    // Untouched by the sweep entirely: held_at still set, never blocked out from under her.
    const stored = await row(c.id);
    expect(stored.held_at, "still held — the sweep never touched it").toBeTruthy();
    expect(stored.state, "never auto-blocked while held").toBe("IN_PROGRESS");
  });
});

describe("a hold is silent — no nag, ever, pinned against the resurfacing sweep", () => {
  it("resurfaceStaleBlocks never selects a HELD card, even one carrying a stale pre-hold block clock", async () => {
    const c = await card("Blocked, then held with the block clock still stale");
    // Give it a real block first, with the nag clock already due — the exact shape that would
    // resurface if this card were still BLOCKED.
    await blockCard(env, { id: c.id, title: "Blocked, then held with the block clock still stale", firm_scope: "west-peek", owner_id: "aie_porter" }, {
      reason: "a_question_for_you",
      trying: "Draft the October newsletter",
      employee: "Porter",
    }, new Date(Date.now() - 100 * 3_600_000));
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_nag_at = ?2 WHERE id = ?1").bind(c.id, new Date(Date.now() - 3_600_000).toISOString()).run();

    // Confirm the setup: while still BLOCKED, it WOULD resurface.
    const beforeHold = await resurfaceStaleBlocks(env, new Date());
    expect(beforeHold.map((r) => r.id)).toContain(c.id);

    // Now hold it — the row keeps its old block_* columns and its BLOCKED state (nothing clears
    // them; see migration 0227's comment), which is exactly the case that must not fool the
    // resurfacing sweep now that it has to check held_at explicitly.
    await holdRaw(c.id, "Watching this one myself");
    const afterHold = await resurfaceStaleBlocks(env, new Date());
    expect(afterHold.map((r) => r.id), "a HELD card must never be resurfaced, whatever its stale block columns say").not.toContain(c.id);
  });
});

describe("releasing a held card", () => {
  it("puts it back to OPEN with attempts and steps reset, and clears the hold fields together", async () => {
    const c = await card("Ready to come back");
    await env.WP_OS_DB.prepare("UPDATE work_card SET work_attempts = 2, work_steps = 5 WHERE id = ?1").bind(c.id).run();
    await holdRaw(c.id, "Waiting for the right moment");

    const out = await handleReleaseWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "POST" }),
    } as never);
    expect(out.status).toBe(200);

    const stored = await row(c.id);
    expect(stored.state, "re-queues fresh, never mid-step").toBe("OPEN");
    expect(stored.work_attempts).toBe(0);
    expect(stored.work_steps).toBe(0);
    expect(stored.lease_until).toBeNull();
    expect(stored.held_reason).toBeNull();
    expect(stored.held_by).toBeNull();
    expect(stored.held_at).toBeNull();
  });

  it("refuses to release a card that is not held", async () => {
    const c = await card("Never held");
    const out = await handleReleaseWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "POST" }),
    } as never);
    expect(out.status).toBe(409);
  });

  it("a released card is claimable by the sweep again", async () => {
    const c = await card("Released and ready");
    await holdRaw(c.id, "For later");
    await handleReleaseWorkCard({ env, identity: SEQUOIA as never, params: { id: c.id }, request: new Request("https://os.joinwestpeek.com/x", { method: "POST" }) } as never);
    // `claimNextCard` is FIFO oldest-first over every eligible AI-owned card, and this file's
    // earlier tests leave other unclaimed OPEN cards behind — so rather than assert THIS card wins
    // the race, assert directly that it now meets every condition `claimNextCard`'s own WHERE
    // clause checks, which is the actual fact "released cards are claimable again" is about.
    const stored = await row(c.id);
    expect(stored.state).toBe("OPEN");
    expect(stored.held_at).toBeNull();
    expect(stored.lease_until).toBeNull();
    expect(stored.work_attempts).toBe(0);
    const claimed = await claimNextCard(env, new Date());
    expect(claimed, "some card is claimable — the sweep is not jammed").not.toBeNull();
  });
});

describe("the generic PATCH refuses to hold or release a card by hand", () => {
  it("cannot set state: HELD at all — it was never a real state value, so the schema itself refuses it", async () => {
    const c = await card("No hand-rolled holds");
    const out = await handleUpdateWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "PATCH", body: JSON.stringify({ state: "HELD" }) }),
    } as never);
    // "HELD" is not a member of WORK_CARD_STATES (0227) — the door is POST .../hold, which asks for
    // the required reason this generic handler has no field for. zod refuses it before any of this
    // handler's own logic runs.
    expect(out.status).toBe(400);
    const body = (await out.json()) as { error?: string };
    expect(body.error).toBe("invalid_input");
    expect((await row(c.id)).held_at).toBeNull();
  });

  it("cannot walk a HELD card back to OPEN through the generic PATCH — that would leave a stale reason", async () => {
    const c = await card("No hand-rolled releases");
    await holdRaw(c.id, "For later");
    const out = await handleUpdateWorkCard({
      env,
      identity: SEQUOIA as never,
      params: { id: c.id },
      request: new Request("https://os.joinwestpeek.com/x", { method: "PATCH", body: JSON.stringify({ state: "OPEN" }) }),
    } as never);
    expect(out.status).toBe(409);
    const body = (await out.json()) as { error?: string };
    expect(body.error).toBe("cannot_release_by_hand");
    expect((await row(c.id)).held_reason).toBe("For later");
  });
});

describe("held facts are readable wherever the card is — the owner can relay them", () => {
  it("GET /api/work-cards/:id carries held_reason, held_by_name and held_at", async () => {
    const c = await card("Readable when held");
    await holdRaw(c.id, "I want to be at my desk for this one — it is a big job.");
    const res = await handleGetWorkCard({ env, identity: SEQUOIA as never, params: { id: c.id }, request: new Request("https://os.joinwestpeek.com/x") } as never);
    const body = (await res.json()) as { held_reason: string; held_by_name: string | null; held_at: string };
    expect(body.held_reason).toBe("I want to be at my desk for this one — it is a big job.");
    expect(body.held_by_name).toBe("Sequoia Taylor");
    expect(body.held_at).toBeTruthy();
  });

  it("the board (/api/work-cards/by-owner) still carries a held card, with the same three facts", async () => {
    const c = await card("On the board while held");
    await holdRaw(c.id, "Watching this one");
    const res = await handleWorkByOwner({ env, identity: SEQUOIA as never, params: {}, request: new Request("https://os.joinwestpeek.com/x") } as never);
    const body = (await res.json()) as { cards: Array<{ id: string; state: string; held_reason: string | null; held_by_name: string | null }> };
    const found = body.cards.find((x) => x.id === c.id);
    expect(found, "a held card is still live work — the board must not drop it").toBeDefined();
    expect(found?.state).toBe("HELD");
    expect(found?.held_reason).toBe("Watching this one");
    expect(found?.held_by_name).toBe("Sequoia Taylor");
  });
});

describe("visibility is checked, not assumed — the same guard as every other card route", () => {
  it("holding and releasing 404 for a card outside the caller's firm scope", async () => {
    const c = await card("Out of scope for this caller");
    await env.WP_OS_DB.prepare("UPDATE work_card SET firm_scope = 'another-firm' WHERE id = ?1").bind(c.id).run();
    const holdOut = await handleHoldWorkCard({ env, identity: SEQUOIA as never, params: { id: c.id }, request: new Request("https://os.joinwestpeek.com/x", { method: "POST", body: JSON.stringify({ reason: "nope" }) }) } as never);
    expect(holdOut.status).toBe(404);
    const releaseOut = await handleReleaseWorkCard({ env, identity: SEQUOIA as never, params: { id: c.id }, request: new Request("https://os.joinwestpeek.com/x", { method: "POST" }) } as never);
    expect(releaseOut.status).toBe(404);
  });
});

/** Hold a card directly through the real write path (not raw SQL), for tests that need a held fixture. */
async function holdRaw(id: string, reason: string): Promise<void> {
  const out = await handleHoldWorkCard({
    env,
    identity: SEQUOIA as never,
    params: { id },
    request: new Request("https://os.joinwestpeek.com/x", { method: "POST", body: JSON.stringify({ reason }) }),
  } as never);
  if (out.status !== 200) throw new Error(`fixture hold failed: ${out.status} ${await out.text()}`);
}
