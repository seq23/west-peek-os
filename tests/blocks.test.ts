import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { answerBlock, blockCard, blockOf, resurfaceStaleBlocks } from "../src/worker/services/blocks";
import { claimNextCard, sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import { auditCatalogue, BLOCK_REASONS, describeBlock, plainLanguageProblems } from "../src/shared/work/blocks";

/**
 * A BLOCK SHE CAN CLEAR HERSELF (16 Sep 2026).
 *
 * Operator: "parker is blocked on an assignment i gave him and i dont understand what he is blocked
 * on and how to help him myself … the reasoning sounds too technical." This proves, without a model
 * and without a network, the four things that claim rests on:
 *
 *   1. every block the system can write says what was being done, what stopped it, what would clear
 *      it and who can provide that — in prose with no stack trace, error code, table name or
 *      internal stage name in it;
 *   2. a block that does NOT say those things cannot be written at all: the row is refused by the
 *      database, whoever wrote the UPDATE;
 *   3. THE ANSWER REACHES THE NEXT RUN. Block → she answers → the sweep claims the card again →
 *      the employee's prompt carries her words. An answer that is recorded and never read is worse
 *      than no button, so this is the test that matters;
 *   4. nothing stays stuck silently: an unanswered block rings again rather than ageing out.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-09-16T12:00:00.000Z");
const PARTNER = "fu_sequoia_taylor";

async function card(title: string, owner = "aie_parker"): Promise<{ id: string; title: string; firm_scope: string; owner_id: string }> {
  const c = await createWorkCardInternal(env, sweepIdentity(), {
    title,
    owner_type: "AI",
    owner_id: owner,
    priority: "NORMAL",
    firm_scope: "west-peek",
  });
  return { id: c.id, title, firm_scope: "west-peek", owner_id: owner };
}

async function row(id: string) {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => { await disposeTestDb(t); });

describe("every block reads as one plain sentence", () => {
  it("the whole catalogue passes its own standard", () => {
    const audited = auditCatalogue();
    // HARD-FAIL ON AN EMPTY LOOP: a catalogue that shrank to nothing would otherwise pass here by
    // examining no items, which is the defect class this repo names as "runs but inert".
    expect(audited.length, "the catalogue must not be empty").toBe(BLOCK_REASONS.length);
    expect(audited.length).toBeGreaterThan(5);
    for (const a of audited) expect(a.problems, `${a.reason}: ${a.problems.join("; ")}`).toEqual([]);
  });

  it("refuses the sentences that were actually on cards before this", () => {
    // Every one of these is a real stored reason from this repo or from production.
    const real = [
      "DISCOVER: the judgement pass failed: the judgement was routed to the search model.",
      "asset_id null on evt_deck.",
      "The deck could not be rendered: TypeError: browser is undefined.",
      "This card is marked BLOG_HELP but carries no parsed request.",
      "runDeckRework() returned no document.",
      "The provider returned HTTP 429 and the run was retried.",
    ];
    for (const s of real) expect(plainLanguageProblems(s), s).not.toEqual([]);
    expect(plainLanguageProblems("Parker needs something from you before this can go any further.")).toEqual([]);
  });

  it("names who can clear it, and never asks her for something only an engineer can give", () => {
    const render = describeBlock("the_file_would_not_build", { trying: "Rebuild the deck", employee: "Preston" });
    expect(render.who).toBe("ENGINEER");
    expect(render.actions.map((a) => a.key)).toContain("ESCALATE");
    expect(render.actions.map((a) => a.key)).not.toContain("ANSWER");
    const question = describeBlock("a_question_for_you", { trying: "Deal flow", employee: "Wyatt", detail: "Is $2M pre-seed in the mandate?" });
    expect(question.who).toBe("SEQUOIA");
    expect(question.needed).toBe("Is $2M pre-seed in the mandate?");
  });
});

describe("a block with no reason cannot be written", () => {
  it("the database refuses it, whoever writes the UPDATE", async () => {
    const c = await card("A card that stops for no stated reason");
    await expect(
      env.WP_OS_DB.prepare("UPDATE work_card SET state = 'BLOCKED', next_action = 'it broke' WHERE id = ?1").bind(c.id).run(),
    ).rejects.toThrow(/a block must say what was being done/);
    expect((await row(c.id)).state).toBe("OPEN");
  });

  it("and a reason that is not fit to read is refused before it reaches the database", async () => {
    const c = await card("A card with an engineer's sentence on it");
    // The catalogue is the only way in, so this is proven by asking it for a reason it does not
    // have rather than by hand-rolling a bad one — which is the point.
    await expect(
      blockCard(env, c, { reason: "not_a_real_reason" as never, trying: c.title, employee: "Parker" }),
    ).rejects.toThrow();
    expect((await row(c.id)).state).toBe("OPEN");
  });
});

describe("the owner clears it herself", () => {
  it("BLOCK → SHE ANSWERS → THE EMPLOYEE'S NEXT RUN READS HER ANSWER", async () => {
    // One card in the queue, so "the sweep claimed THIS one" means what it says.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS')").run();
    const c = await card("Find out whether Helios Grid is still raising");
    await blockCard(env, c, {
      reason: "a_question_for_you",
      trying: c.title,
      employee: "Parker",
      detail: "Is a $2M pre-seed inside the mandate?",
    }, NOW);

    const blocked = await row(c.id);
    expect(blocked.state).toBe("BLOCKED");
    expect(blockOf(blocked as never)!.actions.map((a) => a.key)).toEqual(["ANSWER", "CHANGE", "DROP"]);
    // A blocked card is invisible to the sweep — which is exactly why an answer has to reopen it.
    expect(await claimNextCard(env, NOW)).toBeNull();

    const out = await answerBlock(env, c.id, PARTNER, { action: "ANSWER", text: "Yes — anything up to $3M is in the mandate." });
    expect(out.ok).toBe(true);
    expect(out.state).toBe("OPEN");

    const reopened = await row(c.id);
    expect(reopened.work_attempts, "a card she answered starts its attempts again").toBe(0);
    expect(reopened.block_answer).toMatch(/up to \$3M/);

    // AND THE EMPLOYEE ACTUALLY READS IT. The general loop re-reads unanswered notes on every step
    // and places them above the original brief; the prompt is the proof, not the row.
    let promptSeen = "";
    const swept = await sweepOnce(env, new Date(NOW.getTime() + 60_000), {
      general: async (e, _ctx, cardId) => {
        const notes = await e.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1 AND acknowledged_at IS NULL")
          .bind(cardId)
          .all<{ body: string }>();
        promptSeen = (notes.results ?? []).map((n) => n.body).join("\n");
        return { finished: true, blocked: false, detail: "done", steps: [{ action: "done", detail: "done" }] };
      },
    });
    expect(swept.card?.id, "the sweep picks the answered card up again").toBe(c.id);
    expect(promptSeen, "her answer is in front of the employee on its next step").toMatch(/up to \$3M/);
  });

  it("saying yes to a page grants the permission, not just the sentiment", async () => {
    const c = await card("Check whether Sensori still lists a VP of Sales");
    await blockCard(env, c, {
      reason: "permission_to_open_a_page",
      trying: c.title,
      employee: "Wyatt",
      url: "https://sensori.example/team",
    }, NOW);
    expect((await row(c.id)).allows_browser).toBe(0);

    const out = await answerBlock(env, c.id, PARTNER, { action: "ANSWER", choice: "allow_page" });
    expect(out.ok).toBe(true);
    const after = await row(c.id);
    expect(after.allows_browser, "yes means the page can be opened, with no second button anywhere").toBe(1);
    expect(after.state).toBe("OPEN");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(c.id).run();
  });

  it("dropping it needs a reason and keeps it — a decision not to act is a decision", async () => {
    const c = await card("Something not worth doing");
    await blockCard(env, c, { reason: "a_question_for_you", trying: c.title, employee: "Parker", detail: "Which month?" }, NOW);
    const refused = await answerBlock(env, c.id, PARTNER, { action: "DROP" });
    expect(refused.ok).toBe(false);
    expect((await row(c.id)).state).toBe("BLOCKED");

    const out = await answerBlock(env, c.id, PARTNER, { action: "DROP", text: "We are not running this series." });
    expect(out.ok).toBe(true);
    const after = await row(c.id);
    expect(after.state).toBe("CANCELLED");
    expect(after.description).toMatch(/not running this series/);
  });

  it("escalating does NOT clear the work — it changes who is being asked, and says so", async () => {
    const c = await card("Rebuild the deck");
    await blockCard(env, c, { reason: "the_file_would_not_build", trying: c.title, employee: "Preston" }, NOW);
    const out = await answerBlock(env, c.id, PARTNER, { action: "ESCALATE", text: "The PDF never comes out." });
    expect(out.ok).toBe(true);
    const after = await row(c.id);
    expect(after.state, "a block sent to an engineer is still a block").toBe("BLOCKED");
    expect(after.block_who).toBe("ENGINEER");
    expect(after.block_nag_at, "and it keeps ringing until they have fixed it").not.toBeNull();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(c.id).run();
  });
});

describe("nothing stays stuck silently", () => {
  it("an unanswered block rings again the next day, and keeps ringing", async () => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET block_nag_at = NULL WHERE state = 'BLOCKED'").run();
    const c = await card("Something nobody has looked at");
    await blockCard(env, c, { reason: "a_question_for_you", trying: c.title, employee: "Parker", detail: "Which month?" }, NOW);

    // Same day: nothing rings twice.
    expect((await resurfaceStaleBlocks(env, new Date(NOW.getTime() + 3_600_000))).map((r) => r.id)).not.toContain(c.id);

    const later = new Date(NOW.getTime() + 26 * 3_600_000);
    const rung = await resurfaceStaleBlocks(env, later);
    expect(rung.map((r) => r.id)).toContain(c.id);
    expect((await row(c.id)).block_nags).toBe(1);
    const notices = await env.WP_OS_DB.prepare(
      "SELECT title, body FROM notification WHERE object_id = ?1 ORDER BY created_at DESC",
    ).bind(c.id).all<{ title: string; body: string }>();
    expect(notices.results![0]!.title).toMatch(/Still waiting on you/);
    expect(notices.results![0]!.body).toMatch(/What would clear it/);

    // Answered, it stops ringing.
    await answerBlock(env, c.id, PARTNER, { action: "ANSWER", text: "October." });
    expect((await resurfaceStaleBlocks(env, new Date(later.getTime() + 48 * 3_600_000))).map((r) => r.id)).not.toContain(c.id);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(c.id).run();
  });
});
