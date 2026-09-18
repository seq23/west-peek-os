import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { createWorkCardInternal } from "../src/worker/services/workCards";
import { MAX_WORK_ATTEMPTS, sweepIdentity, sweepOnce } from "../src/worker/services/workSweep";
import { answerBlock, blockOf, LANE_PAUSE_HOURS, LANE_STAND_DOWN_HOURS, TECHNICAL_BLOCK_NAG_HOURS } from "../src/worker/services/blocks";
import { attemptsAllowedFor, readLaneFailure } from "../src/shared/ai/laneFailure";
import { readVendorWords } from "../src/worker/ai/providers/httpError";
import { laneIsStoodDown } from "../src/worker/ai/routing";

/**
 * A WORK CARD SAYS WHY IT STOPPED, AND SHE CAN FIX IT (17 Sep 2026).
 *
 * WHAT HAPPENED. Parker's card "Draft event kit: October workshop with Kirx Diaz" failed three
 * times over fourteen minutes. Two steps completed on OpenRouter each time; the third routed to the
 * direct Anthropic lane and was refused — "your credit balance is too low to access the Anthropic
 * API". The step deferred, the card went back to OPEN, the sweep picked it up again.
 *
 * WHAT SHE SAW: "Open · queued — picked up within 5 min." Three times. "without you I can't fix
 * anything that goes wrong in work cards."
 *
 * Every assertion below is one link in that chain, made impossible — with no model, no network and
 * no browser. The one that matters is the last group: SHE COULD HAVE FIXED IT HERSELF.
 */

let t: TestDb;
let env: Env;
const NOW = new Date("2026-09-17T21:00:00.000Z");

/** The body Anthropic actually returns when the account is empty. */
const ANTHROPIC_EMPTY_ACCOUNT =
  '{"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

async function card(title: string, owner = "aie_parker"): Promise<string> {
  const c = await createWorkCardInternal(env, sweepIdentity(), {
    title,
    description: "test",
    owner_type: "AI",
    owner_id: owner,
    firm_scope: "west-peek",
  });
  return c.id;
}

async function row(id: string): Promise<Record<string, unknown>> {
  return (await env.WP_OS_DB.prepare("SELECT * FROM work_card WHERE id = ?1").bind(id).first<Record<string, unknown>>())!;
}

/**
 * The failed run as `runAi` would have left it: BLOCKED_DEFERRED against the Anthropic provider row,
 * attributed to this card. This is the row that existed on 17 Sep and that nothing on the card path
 * ever read.
 */
let runSeq = 0;
async function recordRefusedRun(cardId: string, failureReason: string, providerId = "prov_anthropic"): Promise<void> {
  const id = `air_test_${(runSeq += 1)}`;
  await env.WP_OS_DB.prepare(
    `INSERT INTO ai_run (id, purpose, actor_type, actor_id, sensitivity, privacy_mode, cost_mode, provider_id, model,
                         status, input_hash, trace_id, failure_reason, firm_scope, created_at)
     VALUES (?1, 'Parker working the event kit', 'SYSTEM', 'work_sweep', 'INTERNAL', 'STANDARD', 'NORMAL', ?2,
             'claude-sonnet-4', 'BLOCKED_DEFERRED', 'h', ?3, ?4, 'west-peek', ?5)`,
  )
    .bind(id, providerId, `trc_test_${runSeq}`, failureReason, new Date(NOW.getTime() + runSeq * 1000).toISOString())
    .run();
  await env.WP_OS_DB.prepare("INSERT OR IGNORE INTO ai_run_attribution (ai_run_id, machine_id, work_card_id, category) VALUES (?1, NULL, ?2, 'OPERATIONS')")
    .bind(id, cardId)
    .run();
}

/** A runner that dies the way the third step of the event kit died. */
function refusedRunner(cardId: string, failureReason: string, providerId = "prov_anthropic") {
  return async () => {
    await recordRefusedRun(cardId, failureReason, providerId);
    return { finished: false, blocked: false, detail: failureReason, steps: [{ action: "failed", detail: failureReason }] };
  };
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
  // The two lanes in the incident. Anthropic is the one that refused.
  await env.WP_OS_DB.prepare("UPDATE provider_registry SET enabled = 1 WHERE provider_key IN ('anthropic','openrouter')").run();
});
afterAll(async () => {
  await disposeTestDb(t);
});

describe("the vendor's own sentence survives the wire", () => {
  it("lifts the message out of the body Anthropic actually sends", () => {
    expect(readVendorWords(ANTHROPIC_EMPTY_ACCOUNT)).toBe("Your credit balance is too low to access the Anthropic API.");
  });

  it("does not paste an HTML error page onto a work card", () => {
    expect(readVendorWords("<html><body><h1>502 Bad Gateway</h1></body></html>")).toBe("");
  });
});

describe("a failed run is read as a thing she can fix", () => {
  const lifted = "provider_failure:provider_http_400: Your credit balance is too low to access the Anthropic API.";

  it("reads the 17 Sep failure as an empty account, and as one not worth repeating", () => {
    const f = readLaneFailure(lifted);
    expect(f.kind).toBe("CREDIT");
    expect(f.transient).toBe(false);
    expect(attemptsAllowedFor(f, MAX_WORK_ATTEMPTS)).toBe(2);
  });

  it("still gives a rate limit and an outage all three goes — those clear themselves", () => {
    for (const reason of ["provider_failure:provider_http_429: rate limit exceeded", "provider_failure:provider_http_503: upstream unavailable"]) {
      expect(attemptsAllowedFor(readLaneFailure(reason), MAX_WORK_ATTEMPTS)).toBe(MAX_WORK_ATTEMPTS);
    }
  });

  it("does not dress an employee's own dead end as a broken lane", () => {
    expect(readLaneFailure("the employee did not choose a usable action").kind).toBe("NONE");
  });
});

describe("the card stops, and it says why", () => {
  let id: string;

  it("the FIRST failed attempt is already visible — this is what 'queued' was hiding", async () => {
    id = await card("Draft event kit: October workshop with Kirx Diaz");
    const out = await sweepOnce(env, new Date(NOW.getTime() + 60_000), {
      general: refusedRunner(id, "provider_failure:provider_http_400: Your credit balance is too low to access the Anthropic API."),
    });
    expect(out.outcome).toBe("FAILED");
    const c = await row(id);
    expect(c.state, "still being retried, not yet blocked").toBe("IN_PROGRESS");
    // THE FIX FOR "IT LOOKED EXACTLY LIKE A WAITING CARD".
    expect(String(c.work_last_failure)).toMatch(/Attempt 1 of 2 was refused by the Anthropic lane/);
    expect(String(c.work_last_failure)).toMatch(/run out of credit/);
    expect(c.work_last_failure_at).toBeTruthy();
    // And no status code anywhere she reads.
    expect(String(c.work_last_failure)).not.toMatch(/400/);
  });

  it("the second attempt stops it — an empty account does not get a third go", async () => {
    const out = await sweepOnce(env, new Date(NOW.getTime() + 120_000), {
      general: refusedRunner(id, "provider_failure:provider_http_400: Your credit balance is too low to access the Anthropic API."),
    });
    expect(out.outcome).toBe("BLOCKED");
    const c = await row(id);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_reason).toBe("a_lane_refused_the_work");
    expect(c.block_lane).toBe("anthropic");
    expect(c.block_lane_name).toBe("Anthropic");
  });

  it("the block reads the way it should have read that night", async () => {
    const block = blockOf(await row(id))!;
    expect(block.trying).toBe("Draft event kit: October workshop with Kirx Diaz");
    // THE VENDOR'S OWN WORDS, and no error code as the headline.
    expect(block.stopped).toBe(
      'The Anthropic lane refused the work — "Your credit balance is too low to access the Anthropic API".',
    );
    expect(block.stopped).not.toMatch(/400|provider_http|provider_failure/);
    expect(block.needed).toMatch(/Send it to a different model, or put more credit on the Anthropic account/);
    // It is HERS. Every fix that night was.
    expect(block.who).toBe("SEQUOIA");
    expect(block.actions.map((a) => a.key)).toEqual(["ANOTHER_LANE", "PAUSE_LANE", "RETRY", "HAND_ON", "DROP"]);
    // The raw text is kept, and is not the explanation.
    expect(String(block.raw)).toMatch(/provider_http_400/);
  });

  it("it nags on the gentler technical interval, not the decision one", async () => {
    const c = await row(id);
    const hours = (Date.parse(String(c.block_nag_at)) - Date.parse(String(c.blocked_at))) / 3_600_000;
    expect(Math.round(hours)).toBe(TECHNICAL_BLOCK_NAG_HOURS);
  });

  it("and it is not picked up again while it is blocked", async () => {
    const next = await sweepOnce(env, new Date(NOW.getTime() + 600_000), { general: refusedRunner(id, "x") });
    expect(next.card?.id).not.toBe(id);
  });
});

/**
 * ── THE TEST THIS FEATURE IS JUDGED ON ────────────────────────────────────────────────────────
 *
 * She could have fixed 17 Sep from the card, without an engineer. Each door is pressed here and
 * each one has to do the real thing AND put the work back in the queue — a door that records an
 * intention and leaves the card BLOCKED is invisible to the sweep, which is the same "runs but
 * inert" defect answering a question used to be.
 */
describe("she can fix it herself", () => {
  async function blockedCard(title: string): Promise<string> {
    const id = await card(title);
    const runner = refusedRunner(id, "provider_failure:provider_http_400: Your credit balance is too low to access the Anthropic API.");
    await sweepOnce(env, new Date(NOW.getTime() + 60_000), { general: runner });
    await sweepOnce(env, new Date(NOW.getTime() + 120_000), { general: runner });
    expect((await row(id)).state).toBe("BLOCKED");
    return id;
  }

  async function lane(key: string): Promise<{ paused_until: string | null; paused_reason: string | null; paused_by: string | null }> {
    return (await env.WP_OS_DB.prepare("SELECT paused_until, paused_reason, paused_by FROM provider_registry WHERE provider_key = ?1").bind(key).first())!;
  }

  it("'send it to a different model' stands the lane down for six hours and requeues the work", async () => {
    const id = await blockedCard("Event kit — another model");
    const out = await answerBlock(env, id, "fu_sequoia_taylor", { action: "ANOTHER_LANE" });
    expect(out.ok).toBe(true);
    expect(out.state).toBe("OPEN");
    expect(out.said).toMatch(/Anthropic is stood down for six hours/);

    const l = await lane("anthropic");
    const hours = (Date.parse(String(l.paused_until)) - Date.now()) / 3_600_000;
    expect(Math.round(hours)).toBe(LANE_STAND_DOWN_HOURS);
    // The database refuses a pause with nobody's name on it (0185), so these cannot be empty.
    expect(l.paused_by).toBe("fu_sequoia_taylor");
    expect(l.paused_reason).toMatch(/Event kit/);
    expect(laneIsStoodDown(l)).toBe(true);

    const c = await row(id);
    expect(c.state).toBe("OPEN");
    expect(c.work_attempts).toBe(0);
    // The stale failure line goes with it: the card is no longer failing, it is queued.
    expect(c.work_last_failure).toBeNull();
    await env.WP_OS_DB.prepare("UPDATE provider_registry SET paused_until = NULL, paused_reason = NULL, paused_by = NULL WHERE provider_key = 'anthropic'").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });

  it("'stop using this one' stands it down for a week, for every card", async () => {
    const id = await blockedCard("Event kit — stop using it");
    const out = await answerBlock(env, id, "fu_sequoia_taylor", { action: "PAUSE_LANE" });
    expect(out.ok).toBe(true);
    const l = await lane("anthropic");
    expect(Math.round((Date.parse(String(l.paused_until)) - Date.now()) / 3_600_000)).toBe(LANE_PAUSE_HOURS);
    expect((await row(id)).state).toBe("OPEN");
    await env.WP_OS_DB.prepare("UPDATE provider_registry SET paused_until = NULL, paused_reason = NULL, paused_by = NULL WHERE provider_key = 'anthropic'").run();
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });

  it("'try it again now' requeues without touching any lane", async () => {
    const id = await blockedCard("Event kit — retry");
    const out = await answerBlock(env, id, "fu_sequoia_taylor", { action: "RETRY" });
    expect(out.ok).toBe(true);
    expect((await lane("anthropic")).paused_until).toBeNull();
    const c = await row(id);
    expect(c.state).toBe("OPEN");
    expect(c.work_attempts).toBe(0);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });

  it("'give it to somebody else' moves the seat, requeues it, and leaves them a note", async () => {
    const id = await blockedCard("Event kit — hand on");
    const other = (await env.WP_OS_DB.prepare("SELECT id FROM ai_employee WHERE id <> 'aie_parker' AND status = 'ACTIVE' LIMIT 1").first<{ id: string }>())!;
    const out = await answerBlock(env, id, "fu_sequoia_taylor", { action: "HAND_ON", choice: other.id });
    expect(out.ok).toBe(true);
    const c = await row(id);
    expect(c.owner_id).toBe(other.id);
    expect(c.state).toBe("OPEN");
    expect(c.work_attempts).toBe(0);
    const note = await env.WP_OS_DB.prepare("SELECT body FROM work_card_note WHERE work_card_id = ?1").bind(id).first<{ body: string }>();
    expect(note?.body).toMatch(/moved to you from Parker/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });

  it("refuses a hand-on to nobody, rather than silently doing nothing", async () => {
    const id = await blockedCard("Event kit — hand on to nobody");
    const out = await answerBlock(env, id, "fu_sequoia_taylor", { action: "HAND_ON", choice: "aie_not_employed" });
    expect(out.ok).toBe(false);
    expect((await row(id)).state, "a refused door leaves the block exactly as it was").toBe("BLOCKED");
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });
});

describe("nothing left to try is its own block", () => {
  it("everything switched off says so, and does not blame the employee", async () => {
    const id = await card("Event kit — no lanes at all");
    const runner = refusedRunner(id, "provider_disabled:no_enabled_providers", "prov_openrouter");
    await sweepOnce(env, new Date(NOW.getTime() + 60_000), { general: runner });
    await sweepOnce(env, new Date(NOW.getTime() + 120_000), { general: runner });
    const c = await row(id);
    expect(c.state).toBe("BLOCKED");
    expect(c.block_reason).toBe("no_lane_could_take_the_work");
    expect(String(c.block_stopped)).toMatch(/every model the firm can use is switched off or unavailable/);
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id = ?1").bind(id).run();
  });
});
