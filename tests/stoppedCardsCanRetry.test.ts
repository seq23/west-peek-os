import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import { blockOf, handleRetryStoppedCards, releaseSpendSettingBlocks, retryAllStopped, spendStatePermits } from "../src/worker/services/blocks";
import { BLOCK_REASONS, RETRYABLE_BLOCK_REASONS, describeBlock, withRetryDoor } from "../src/shared/work/blocks";
import { recordHeartbeat, SEAT_SEARCH_CAPABILITY } from "../src/worker/ai/subscriptionSeats";
import type { FirmUserIdentity } from "../src/worker/auth";

/**
 * A STOPPED CARD CAN ALWAYS BE RETRIED, AND ONE THE SPEND SETTING STOPPED RESUMES BY ITSELF (1 Oct 2026).
 *
 * THE DEFECT. Parker's November Room card stopped on the spend setting. It read "tried three times and could
 * not get this done" and offered: answer, change, drop, send to an engineer. No "try it again" — and nothing
 * resumed it when the setting was fixed. #215 corrected NEW stops; this card had been stopped before it, and a
 * block stores its wording and doors as text when it stops, so it kept the old ones.
 *
 * EACH PROPERTY BELOW IS ONE LINK: the doors on a card stopped before today, the backfill matching the
 * catalogue's wording exactly, the auto-resume firing once per change and never looping, the bulk button, and
 * the whole flow through the real sweep.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-10-01T09:00:00.000Z");

const OLD_ACTIONS = JSON.stringify([
  { key: "ANSWER", label: "Answer it", hint: "x" },
  { key: "CHANGE", label: "Change what you asked for", hint: "x" },
  { key: "DROP", label: "Drop it", hint: "x" },
  { key: "ESCALATE", label: "Send it to an engineer", hint: "x" },
]);
const LEVER_NOTE = "• For an engineer, the last attempt reported: DISCOVER: sponsor discovery search failed: free_only_cannot_serve_protected_work:this call is marked 'search' and needs a paid model.";
/** The same refusal for a call that is NOT a search (a deck review, say) — a search seat could never have served it. */
const NON_SEARCH_LEVER_NOTE = "• For an engineer, the last attempt reported: free_only_cannot_serve_protected_work:this call is marked 'employee-work' and needs a paid model.";

const MP: FirmUserIdentity = { id: "fu_sequoia_taylor", email: "sequoia@westpeek.ventures", fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }] };
const SCOOTER: FirmUserIdentity = { id: "fu_scooter_taylor", email: "scooter@westpeek.ventures", fullName: "Scooter Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }] };
const ANALYST_OTHER_FIRM: FirmUserIdentity = { id: "fu_analyst", email: "analyst@example.invalid", fullName: "An Analyst", status: "ACTIVE", roles: ["ANALYST"], authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "some-other-firm" }] };

async function setLever(lever: "FREE_ONLY" | "MODERATE" | "OPEN"): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, ?2, 0, 'fu_sequoia_taylor')`,
    )
    .bind(`bp_retry_${crypto.randomUUID()}`, lever)
    .run();
}

async function card(title: string, owner = "aie_parker"): Promise<string> {
  const c = await createWorkCardInternal(env, sweepIdentity(), { title, description: "test", owner_type: "AI", owner_id: owner, firm_scope: "west-peek" });
  return c.id;
}

/** A card exactly as it was left on 1 Oct: blocked with the OLD wording and doors, the lever refusal in its note. */
async function staleLeverCard(title: string, note = LEVER_NOTE, owner = "aie_parker"): Promise<string> {
  const id = await card(title, owner);
  await t.db
    .prepare(
      `UPDATE work_card SET state = 'BLOCKED', block_reason = 'tried_and_could_not_finish', block_trying = ?2,
              block_stopped = 'Parker tried three times and could not get this done.',
              block_needed = 'Tell Parker what to do differently, change what you asked for, or drop it.',
              block_who = 'SEQUOIA', block_actions_json = ?3, blocked_at = ?4, work_attempts = 3,
              description = COALESCE(description, '') || char(10) || ?5
        WHERE id = ?1`,
    )
    .bind(id, title, OLD_ACTIONS, NOW.toISOString(), note)
    .run();
  return id;
}

const row = async (id: string): Promise<Record<string, unknown>> => (await t.db.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;

/** The backfill statement, read out of the migration file itself so a test of it can never drift from it. */
function backfillSql(): string {
  const sql = readFileSync("migrations/0247_stopped_cards_can_be_retried_and_resume.sql", "utf8");
  const start = sql.indexOf("UPDATE work_card");
  return sql.slice(start, sql.indexOf("INSERT OR IGNORE INTO schema_version")).trim().replace(/;$/, "");
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});
afterAll(async () => {
  await disposeTestDb(t);
});
beforeEach(async () => {
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
});

describe("a stopped card always offers a retry", () => {
  it("every reason that is not a question describes itself with the door; the questions do not get one", () => {
    for (const reason of BLOCK_REASONS) {
      const b = describeBlock(reason, { trying: "build the November Room", employee: "Parker", lane: "Anthropic", laneKind: "CREDIT" });
      const has = b.actions.some((a) => a.key === "RETRY");
      expect(has, `${reason}`).toBe(RETRYABLE_BLOCK_REASONS.includes(reason));
    }
    // And the ones that exist to ask her something are exactly these five.
    expect(BLOCK_REASONS.filter((r) => !RETRYABLE_BLOCK_REASONS.includes(r)).sort()).toEqual(
      ["a_question_for_you", "asked_for_something_this_work_cannot_do", "permission_to_open_a_page", "the_brief_is_missing", "the_request_is_gone"].sort(),
    );
  });

  it("a card stopped BEFORE this existed gets the door when it is read back — its stored doors are the old four", async () => {
    const id = await staleLeverCard("Parker: build the November 2026 Room packet");
    const b = blockOf(await row(id) as never)!;
    expect(b.actions.map((a) => a.key)).toEqual(["RETRY", "ANSWER", "CHANGE", "DROP", "ESCALATE"]);
    // The stored column itself is untouched — the door is added on the way out.
    expect(JSON.parse(String((await row(id)).block_actions_json)).map((a: { key: string }) => a.key)).not.toContain("RETRY");
  });

  it("is idempotent, and never adds the door to a question", () => {
    const once = withRetryDoor(JSON.parse(OLD_ACTIONS), "tried_and_could_not_finish");
    expect(withRetryDoor(once, "tried_and_could_not_finish")).toEqual(once);
    expect(withRetryDoor(JSON.parse(OLD_ACTIONS), "a_question_for_you").some((a) => a.key === "RETRY")).toBe(false);
  });

  it("pressing it puts the card back in the queue with its attempts reset", async () => {
    const id = await staleLeverCard("Parker: build the November 2026 Room packet — retry door");
    const { answerBlock } = await import("../src/worker/services/blocks");
    const out = await answerBlock(env, id, "fu_sequoia_taylor", { action: "RETRY" });
    expect(out.ok).toBe(true);
    const c = await row(id);
    expect(c.state).toBe("OPEN");
    expect(c.work_attempts).toBe(0);
  });
});

describe("the backfill re-reads a card the spend setting stopped, in the catalogue's own words", () => {
  it("rewrites the wording, doors and marker — and they are IDENTICAL to what a new stop writes", async () => {
    const id = await staleLeverCard("Parker: build the November 2026 Room packet — backfill");
    const other = await card("Parker: something that stopped for another reason");
    await t.db.prepare("UPDATE work_card SET state = 'BLOCKED', block_reason = 'tried_and_could_not_finish', block_trying = 'a job', block_stopped = 'Parker tried three times and could not get this done.', block_needed = 'Tell Parker what to do differently.', block_who = 'SEQUOIA', block_actions_json = ?2, description = 'a real model failure' WHERE id = ?1").bind(other, OLD_ACTIONS).run();

    await t.db.prepare(backfillSql()).run();

    const fresh = describeBlock("a_lane_refused_the_work", { trying: "x", employee: "Parker", laneKind: "LEVER", who: "SEQUOIA" });
    const c = await row(id);
    expect(c.block_reason).toBe("a_lane_refused_the_work");
    expect(c.block_stopped).toBe(fresh.stopped);
    expect(c.block_needed).toBe(fresh.needed);
    expect(JSON.parse(String(c.block_actions_json))).toEqual(fresh.actions);
    expect(c.block_lane).toBe("spend_lever");
    expect(JSON.parse(String(c.block_context))).toEqual({ lever: "FREE_ONLY", seat_search: false, search_call: true });
    expect(c.state, "still stopped — resuming is the sweep's job, once the setting changes").toBe("BLOCKED");
    expect(String(c.description)).toMatch(/Re-read 1 Oct 2026/);

    const untouched = await row(other);
    expect(untouched.block_stopped, "a stop for any other reason is left exactly as it was").toBe("Parker tried three times and could not get this done.");
    expect(untouched.block_lane).toBeNull();
  });

  it("cannot abort a release: an old card with no 'trying' or 'who' is still rewritten, because the statement fills them", async () => {
    const id = await staleLeverCard("Parker: a card from before the block standard");
    // The trigger (0173) refuses to SAVE a blocked card with these blank, so build the shape an old row would have:
    // lift the trigger, blank the two fields, put the trigger back EXACTLY as it was, then run the backfill under it.
    const trig = await t.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'work_card_block_must_be_readable_update'").first<{ sql: string }>();
    await t.db.prepare("DROP TRIGGER work_card_block_must_be_readable_update").run();
    await t.db.prepare("UPDATE work_card SET block_trying = '  ', block_who = NULL WHERE id = ?1").bind(id).run();
    await t.db.prepare(trig!.sql).run();
    expect((await row(id)).block_who).toBeNull();

    await t.db.prepare(backfillSql()).run(); // would throw (0173) if the statement left either blank

    const c = await row(id);
    expect(String(c.block_trying).trim()).toBe("Parker: a card from before the block standard");
    expect(c.block_who).toBe("SEQUOIA");
    expect(c.block_lane).toBe("spend_lever");
  });

  it("is safe to run twice", async () => {
    const id = await staleLeverCard("Parker: build the November 2026 Room packet — twice");
    await t.db.prepare(backfillSql()).run();
    const first = String((await row(id)).description);
    await t.db.prepare(backfillSql()).run();
    expect(String((await row(id)).description), "the second run changes nothing").toBe(first);
  });
});

describe("a card the spend setting stopped resumes by itself — once per change, never in a loop", () => {
  async function leverBlocked(title: string, lever = "FREE_ONLY"): Promise<string> {
    const id = await staleLeverCard(title);
    await t.db.prepare(backfillSql()).run();
    if (lever !== "FREE_ONLY") await t.db.prepare("UPDATE work_card SET block_context = ?2 WHERE id = ?1").bind(id, JSON.stringify({ lever, seat_search: false })).run();
    return id;
  }

  it("does nothing while the setting is still Free only and no seat can search", async () => {
    await setLever("FREE_ONLY");
    const id = await leverBlocked("auto-release: still free only");
    expect(await releaseSpendSettingBlocks(env, NOW)).toEqual([]);
    expect((await row(id)).state).toBe("BLOCKED");
  });

  it("puts the card back in the queue when the setting moves to Moderate, with attempts reset and the event recorded", async () => {
    await setLever("FREE_ONLY");
    const id = await leverBlocked("auto-release: moved to moderate");
    await setLever("MODERATE");
    expect(await releaseSpendSettingBlocks(env, NOW)).toContain(id);
    const c = await row(id);
    expect(c.state).toBe("OPEN");
    expect(c.work_attempts).toBe(0);
    expect(String(c.next_action)).toMatch(/Moderate/);
    const ev = await t.db.prepare("SELECT payload_json FROM event_record WHERE event_type = 'work_card.auto_released' AND object_id = ?1").bind(id).first<{ payload_json: string }>();
    expect(JSON.parse(ev!.payload_json)).toMatchObject({ reason: "spend_setting_changed", was: { lever: "FREE_ONLY" }, now: { lever: "MODERATE" } });
  });

  it("also resumes when a seat that can search wakes up, even with the setting still Free only", async () => {
    await setLever("FREE_ONLY");
    const id = await leverBlocked("auto-release: a search seat woke");
    await recordHeartbeat(env, { seat: "codex", deviceId: "mac-test", hostname: "her-mac", capabilities: [SEAT_SEARCH_CAPABILITY] });
    expect(await releaseSpendSettingBlocks(env, new Date())).toContain(id);
  });

  it("does NOT loop: a card that stopped again in the new state is left alone", async () => {
    await setLever("MODERATE");
    // It stopped in a state that already permitted the work (a different cause) — nothing changed, nothing to release.
    const id = await leverBlocked("auto-release: stopped under moderate", "MODERATE");
    expect(await releaseSpendSettingBlocks(env, NOW)).toEqual([]);
    expect((await row(id)).state).toBe("BLOCKED");
  });

  it("does not guess when it has no record of what stopped the card", async () => {
    await setLever("MODERATE");
    const id = await leverBlocked("auto-release: no context");
    await t.db.prepare("UPDATE work_card SET block_context = NULL WHERE id = ?1").bind(id).run();
    expect(await releaseSpendSettingBlocks(env, NOW)).toEqual([]);
  });

  it("the permission rule is the one the router uses: a paid setting, or — for a SEARCH call — a search-capable seat", () => {
    expect(spendStatePermits({ lever: "FREE_ONLY", seatSearch: false }, true)).toBe(false);
    expect(spendStatePermits({ lever: "FREE_ONLY", seatSearch: true }, true)).toBe(true);
    expect(spendStatePermits({ lever: "MODERATE", seatSearch: false })).toBe(true);
    expect(spendStatePermits({ lever: "OPEN", seatSearch: false })).toBe(true);
  });
});

describe("through the real sweep: stop → fix the setting → it continues, no button pressed", () => {
  it("a card stopped by the spend setting names the setting, records the state, and resumes when the setting moves", async () => {
    await setLever("FREE_ONLY");
    // Earlier cases leave cards behind; the sweep claims the oldest, so this case starts from a clean desk.
    await t.db.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE state IN ('OPEN','IN_PROGRESS','BLOCKED')").run();
    const id = await card("Parker: build the November 2026 Room packet — sweep flow");
    const FREE_ONLY =
      "DISCOVER: sponsor discovery search failed: free_only_cannot_serve_protected_work:this call is marked 'search' and needs a paid model, and the lever is set to FREE_ONLY.";
    let calls = 0;
    const runner = async () => {
      calls += 1;
      return { finished: false, blocked: false, detail: FREE_ONLY, steps: [{ action: "failed", detail: FREE_ONLY }] };
    };
    await sweepOnce(env, new Date(NOW.getTime() + 60_000), { general: runner });
    await sweepOnce(env, new Date(NOW.getTime() + 120_000), { general: runner });
    const blocked = await row(id);
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.block_lane).toBe("spend_lever");
    expect(blocked.block_lane_name).toBe("the spend setting");
    expect(String(blocked.block_stopped)).toMatch(/spend setting is on Free only/);
    expect(JSON.parse(String(blocked.block_context))).toEqual({ lever: "FREE_ONLY", seat_search: false, search_call: true });
    expect(blockOf(blocked as never)!.actions.map((a) => a.key)).toEqual(["RETRY", "HAND_ON", "DROP"]);
    const before = calls;

    // She fixes the setting. The next sweep tick — with nobody pressing anything — puts it back and works it.
    await setLever("MODERATE");
    const ok = async () => {
      calls += 1;
      return { finished: true, blocked: false, detail: "built", steps: [{ action: "done", detail: "built" }] };
    };
    const out = await sweepOnce(env, new Date(NOW.getTime() + 180_000), { general: ok });
    expect(calls, "the card was claimed and run again on that very tick").toBe(before + 1);
    expect(out.card?.id).toBe(id);
    expect(out.outcome).toBe("DONE");
  }, 60_000);
});

describe("the bulk door", () => {
  it("retries every stopped card a retry can help, and leaves questions and engineer-escalated cards alone", async () => {
    const stale = await staleLeverCard("bulk: stale one");
    const question = await card("bulk: a question");
    await t.db.prepare("UPDATE work_card SET state = 'BLOCKED', block_reason = 'a_question_for_you', block_trying = 'a job', block_stopped = 'Parker needs something.', block_needed = 'An answer.', block_who = 'SEQUOIA', block_actions_json = '[{\"key\":\"ANSWER\"}]' WHERE id = ?1").bind(question).run();
    const escalated = await staleLeverCard("bulk: sent to an engineer");
    await t.db.prepare("UPDATE work_card SET block_who = 'ENGINEER' WHERE id = ?1").bind(escalated).run();

    const out = await retryAllStopped(env, MP);
    expect(out.ids).toContain(stale);
    expect(out.ids).not.toContain(question);
    expect(out.ids).not.toContain(escalated);
    expect((await row(stale)).state).toBe("OPEN");
    expect((await row(question)).state).toBe("BLOCKED");
    expect((await row(escalated)).state).toBe("BLOCKED");
  });

  it("is a person's door: an employee identity is refused", async () => {
    const res = await handleRetryStoppedCards({ env, request: new Request("https://x/api/work-cards/retry-stopped", { method: "POST" }), identity: null, params: {} } as never);
    expect(res.status).toBe(403);
  });
});

/**
 * REVIEW OF #217 — three findings, each pinned.
 */
describe("the bulk door is scoped and authorized like the single door", () => {
  it("a user scoped to another firm, or without the privacy label, retries nothing here", async () => {
    const id = await staleLeverCard("scope: a card in west-peek", LEVER_NOTE, "aie_wyatt");
    const out = await retryAllStopped(env, ANALYST_OTHER_FIRM);
    expect(out.ids).not.toContain(id);
    expect((await row(id)).state).toBe("BLOCKED");
  });

  it("a card's SECONDARY partner does not clear its block in bulk any more than one at a time (0241)", async () => {
    const id = await staleLeverCard("scope: sequoia's card, scooter is secondary", LEVER_NOTE, "aie_wyatt");
    await t.db.prepare("UPDATE work_card SET requested_by_email = 'sequoia@westpeek.ventures', secondary_partner_email = 'scooter@westpeek.ventures' WHERE id = ?1").bind(id).run();
    const asSecondary = await retryAllStopped(env, SCOOTER);
    expect(asSecondary.ids).not.toContain(id);
    expect(asSecondary.skipped).toBeGreaterThan(0);
    expect((await row(id)).state).toBe("BLOCKED");
    const asPrimary = await retryAllStopped(env, MP);
    expect(asPrimary.ids).toContain(id);
  });

  it("a user in the right firm WITHOUT access to a card's privacy label cannot retry that card in bulk", async () => {
    const id = await staleLeverCard("scope: a restricted-label card", LEVER_NOTE, "aie_wyatt");
    await t.db.prepare("UPDATE work_card SET privacy_label = 'BANKING_RESTRICTED' WHERE id = ?1").bind(id).run();
    const analystSameFirm: FirmUserIdentity = { ...ANALYST_OTHER_FIRM, authorityScopes: [{ scopeKey: "firm_scope", scopeValue: "west-peek" }] };
    const out = await retryAllStopped(env, analystSameFirm);
    expect(out.ids, "the board would not show it to her, so the bulk door must not touch it").not.toContain(id);
    expect((await row(id)).state).toBe("BLOCKED");
    // Granted the label, she may.
    const granted: FirmUserIdentity = { ...analystSameFirm, authorityScopes: [...analystSameFirm.authorityScopes, { scopeKey: "privacy_label", scopeValue: "BANKING_RESTRICTED" }] };
    expect((await retryAllStopped(env, granted)).ids).toContain(id);
  });

  it("the route says how many were not hers to clear, instead of silently doing less", async () => {
    const id = await staleLeverCard("scope: route message", LEVER_NOTE, "aie_wyatt");
    await t.db.prepare("UPDATE work_card SET requested_by_email = 'sequoia@westpeek.ventures', secondary_partner_email = 'scooter@westpeek.ventures' WHERE id = ?1").bind(id).run();
    const res = await handleRetryStoppedCards({ env, request: new Request("https://x/api/work-cards/retry-stopped", { method: "POST" }), identity: SCOOTER, params: {} } as never);
    const body = (await res.json()) as { skipped: number; said: string };
    expect(body.skipped).toBeGreaterThan(0);
    expect(body.said).toMatch(/not yours to clear/);
    await t.db.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });
});

describe("a search-capable seat only releases a card whose refused call was a search call", () => {
  it("a stop on some OTHER call is not released by a seat waking — only by the setting — and is not misjudged as already permitted", async () => {
    await setLever("FREE_ONLY");
    const other = await staleLeverCard("search-call: a non-search call", NON_SEARCH_LEVER_NOTE, "aie_wyatt");
    await t.db.prepare(backfillSql()).run();
    expect(JSON.parse(String((await row(other)).block_context)).search_call).toBe(false);

    await recordHeartbeat(env, { seat: "codex", deviceId: "mac-test", hostname: "her-mac", capabilities: [SEAT_SEARCH_CAPABILITY] });
    expect(await releaseSpendSettingBlocks(env, new Date()), "a seat that can only search cannot serve this call").not.toContain(other);
    expect((await row(other)).state).toBe("BLOCKED");

    // And the context that was recorded WITH a seat awake does not make the card look already-permitted, so the
    // setting moving still releases it (the failure mode the review described).
    await t.db.prepare("UPDATE work_card SET block_context = ?2 WHERE id = ?1").bind(other, JSON.stringify({ lever: "FREE_ONLY", seat_search: true, search_call: false })).run();
    await setLever("MODERATE");
    expect(await releaseSpendSettingBlocks(env, new Date())).toContain(other);
  });

  it("a SEARCH call is released by the seat, as before", async () => {
    await setLever("FREE_ONLY");
    const search = await staleLeverCard("search-call: a search call", LEVER_NOTE, "aie_wyatt");
    await t.db.prepare(backfillSql()).run();
    await recordHeartbeat(env, { seat: "codex", deviceId: "mac-test", hostname: "her-mac", capabilities: [SEAT_SEARCH_CAPABILITY] });
    expect(await releaseSpendSettingBlocks(env, new Date())).toContain(search);
  });

  it("the permission rule: the seat clause needs a search call", () => {
    expect(spendStatePermits({ lever: "FREE_ONLY", seatSearch: true }, false)).toBe(false);
    expect(spendStatePermits({ lever: "FREE_ONLY", seatSearch: true }, true)).toBe(true);
    expect(spendStatePermits({ lever: "MODERATE", seatSearch: false }, false)).toBe(true);
  });
});

describe("a held card is not released", () => {
  it("keeps its blocked state and emits nothing while it is held", async () => {
    await setLever("FREE_ONLY");
    const id = await staleLeverCard("held: a held card", LEVER_NOTE, "aie_wyatt");
    await t.db.prepare(backfillSql()).run();
    await t.db.prepare("UPDATE work_card SET held_at = ?2, held_by = 'fu_sequoia_taylor', held_reason = 'waiting for the lever' WHERE id = ?1").bind(id, NOW.toISOString()).run();
    await setLever("MODERATE");
    expect(await releaseSpendSettingBlocks(env, new Date())).not.toContain(id);
    const c = await row(id);
    expect(c.state, "its underlying state is unchanged while held").toBe("BLOCKED");
    const ev = await t.db.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.auto_released' AND object_id = ?1").bind(id).first<{ n: number }>();
    expect(ev!.n).toBe(0);

    // Released from the hold, it is eligible again on the next tick.
    await t.db.prepare("UPDATE work_card SET held_at = NULL, held_by = NULL, held_reason = NULL WHERE id = ?1").bind(id).run();
    expect(await releaseSpendSettingBlocks(env, new Date())).toContain(id);
  });
});
