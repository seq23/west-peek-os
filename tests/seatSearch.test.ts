import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi, type RunAiInput } from "../src/worker/ai/runAi";
import {
  claimRun,
  markSeatExhausted,
  recordHeartbeat,
  reportRun,
  SEAT_SEARCH_CAPABILITY,
  type Seat,
  type SeatRunRow,
} from "../src/worker/ai/subscriptionSeats";
import { SEARCH_MODEL, searchQuestion, servedBySearchLane } from "../src/worker/services/liveSearch";
import { parseClaudeSearch, parseCodexSearch, searchOutcome } from "../scripts/lib/seat-search.mjs";
import { readFileSync } from "node:fs";

/**
 * A SUBSCRIPTION SEAT MAY RUN A LIVE WEB SEARCH, AND A SEARCH IS ONLY BELIEVED WITH PROOF (1 Oct 2026).
 *
 * THE FAILURE THIS ANSWERS. Parker's November Room stopped at DISCOVER under Free only: a search call
 * was never offered to a seat, and the one lane that could search was paid. The owner's rule is that
 * when Claude Code is out of usage, Codex takes the work — any work. A probe on her Mac showed Codex
 * searches the live web on her ChatGPT seat and records each search in its own JSON stream.
 *
 * WHAT IS PROVEN HERE (local D1, stubbed vendors, a simulated claimer): who may be parked a search row,
 * who may claim it, that an answer with no counted searches is refused and the chain moves on, that the
 * Free-only collision from Parker's card now resolves to a seat, and that every caller accepts a seat
 * that proved it searched while a general model answering from memory is still refused.
 *
 * NOT PROVEN HERE, labelled in the ledger: that the live CLIs behave as the fixtures show, how long a
 * real search takes against the router's wait, and anything about Claude Code's own search (its plan
 * was out of usage until 2 Oct 8am CT, so no successful stream has been captured).
 */

let t: TestDb;

const MP_ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_scooter_taylor", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const env = (): Env => makeTestEnv(t.db, { OPENROUTER_API_KEY: "or", WP_ANTHROPIC_API_KEY: "ant", GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });

async function setLever(lever: "FREE_ONLY" | "MODERATE" | "OPEN"): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, ?2, 0, 'fu_sequoia_taylor')`,
    )
    .bind(`bp_seatsearch_${crypto.randomUUID()}`, lever)
    .run();
}

/** A seat that checked in. `canSearch` is what its claimer put in the heartbeat's capabilities. */
const awake = (seat: Seat, canSearch: boolean): Promise<void> =>
  recordHeartbeat(env(), { seat, deviceId: "mac-test", hostname: "her-mac", ...(canSearch ? { capabilities: [SEAT_SEARCH_CAPABILITY] } : { capabilities: [] }) });

/** Every vendor call recorded; the search model answers with text a test can recognise. */
function vendors(): { fetchImpl: typeof fetch; models: string[] } {
  const models: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    let model = "";
    try {
      model = String((JSON.parse(String(init?.body ?? "{}")) as { model?: string }).model ?? "");
    } catch {
      /* not JSON */
    }
    models.push(model);
    return new Response(JSON.stringify({ model, choices: [{ message: { content: "PAID SEARCH ANSWER" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, models };
}

/**
 * PLAY A SEARCH-CAPABLE CLAIMER. `events` is what it reports it counted; `outOfUsage` seats report the
 * failure the real claimer sends when a CLI says its plan is spent.
 */
function claimer(seats: Seat[], opts: { answer?: string; events?: number; outOfUsage?: Seat[]; canSearch?: boolean } = {}): { stop: () => Promise<void>; handled: SeatRunRow[] } {
  const handled: SeatRunRow[] = [];
  let live = true;
  const loop = (async () => {
    while (live) {
      const run = await claimRun(env(), "mac-test", seats, new Date(), ["ANSWER"], opts.canSearch ?? true);
      if (!run) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      handled.push(run);
      if (opts.outOfUsage?.includes(run.seat as Seat)) {
        await reportRun(env(), { runId: run.id, deviceId: "mac-test", error: `${run.seat} has run out of usage and said: usage limit reached` });
        await markSeatExhausted(env(), { seat: run.seat as Seat, deviceId: "mac-test", retryAfterSeconds: 3600, reason: "usage limit reached" });
      } else {
        await reportRun(env(), {
          runId: run.id,
          deviceId: "mac-test",
          outputText: opts.answer ?? `SEAT SEARCH ANSWER (${run.seat})`,
          searchEvents: opts.events ?? 5,
          searchQueries: ["2026 Black Bar Association event sponsors", "https://bwla.org/events/x"],
        });
      }
    }
  })();
  return { handled, stop: async () => { live = false; await loop; } };
}

/** The shape every one of the eight search call sites uses. */
const SEARCH_CALL = (): RunAiInput => ({
  purpose: "Parker: Room sponsor research",
  actor: MP_ACTOR,
  inputs: ["Find the organisations that pay to be in front of this audience."],
  sensitivity: "PUBLIC" as never,
  budgetContext: { requiresSearch: true, expectedOutputTokens: 200, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
  routing: { category: "INTELLIGENCE" as const },
});

const rows = async (): Promise<Array<{ id: string; seat: string; status: string; needs_search: number; search_events: number | null; error: string | null; search_queries_json: string | null }>> =>
  ((await t.db.prepare("SELECT id, seat, status, needs_search, search_events, error, search_queries_json FROM subscription_seat_run ORDER BY created_at").all()).results ?? []) as never;

beforeAll(async () => {
  t = await createTestDb();
});
afterAll(async () => {
  await disposeTestDb(t);
});
beforeEach(async () => {
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
  await t.db.prepare("DELETE FROM subscription_seat_run").run();
  await t.db.prepare("DELETE FROM provider_lane_health").run();
});

describe("Parker's collision, resolved: Free only, a search call, a seat that can search", () => {
  beforeEach(() => setLever("FREE_ONLY"));

  it("is served by the Codex seat at $0, with the counted searches on the row, and no vendor is called", async () => {
    await awake("codex", true);
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT SEARCH ANSWER (codex)");
    expect(run.model).toBe("codex-local");
    expect(v.models, "the paid search model was never asked").toEqual([]);
    const [row] = await rows();
    expect(row).toMatchObject({ seat: "codex", status: "REPORTED", needs_search: 1, search_events: 5 });
    expect(JSON.parse(row!.search_queries_json!)).toContain("2026 Black Bar Association event sponsors");
  }, 60_000);

  it("a real caller accepts it — searchQuestion returns the seat's answer instead of 'routed to a model that cannot search'", async () => {
    await awake("codex", true);
    const c = claimer(["codex"]);
    const out = await searchQuestion(env(), MP_ACTOR, "Who sponsors the National Bar Association convention?");
    await c.stop();
    expect(out.ok).toBe(true);
    expect(out.text).toContain("SEAT SEARCH ANSWER (codex)");
  }, 60_000);

  it("a seat that did NOT say it can search is never parked a search row — the original stop is preserved", async () => {
    await awake("codex", false);
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(run.failure_reason).toContain("free_only_cannot_serve_protected_work");
    expect(await rows(), "nothing was parked on a seat that cannot search").toEqual([]);
    expect(v.models).toEqual([]);
  }, 60_000);

  it("an answer with NO counted searches is thrown away, and at Free only the run fails rather than accept memory", async () => {
    await awake("codex", true);
    const c = claimer(["codex"], { events: 0, answer: "A fluent answer from memory." });
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).not.toBe("COMPLETED");
    expect(run.output_text ?? "").not.toContain("from memory");
    const [row] = await rows();
    expect(row!.status).toBe("FAILED");
    expect(row!.error).toMatch(/without running a single web search/);
    expect(row!.search_events).toBe(0);
  }, 60_000);
});

describe("MODERATE — the ladder for a search call: Claude Code, then Codex, then the paid search model", () => {
  beforeEach(() => setLever("MODERATE"));

  it("Codex takes a search call when Claude Code is out of usage, in the same run", async () => {
    await awake("claude_code", true);
    await awake("codex", true);
    const c = claimer(["claude_code", "codex"], { outOfUsage: ["claude_code"] });
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("SEAT SEARCH ANSWER (codex)");
    expect(c.handled.map((r) => r.seat)).toEqual(["claude_code", "codex"]);
    expect(v.models, "no money was spent").toEqual([]);
  }, 60_000);

  it("falls through to the paid search model when the seat answers without searching — never to memory", async () => {
    await awake("codex", true);
    const c = claimer(["codex"], { events: 0, answer: "From memory." });
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(run.status).toBe("COMPLETED");
    expect(run.output_text).toContain("PAID SEARCH ANSWER");
    expect(v.models).toContain(SEARCH_MODEL);
    expect((await rows())[0]!.status).toBe("FAILED");
  }, 60_000);

  it("with no seat awake the call goes straight to the paid search model, exactly as before", async () => {
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    expect(run.status).toBe("COMPLETED");
    expect(v.models).toContain(SEARCH_MODEL);
    expect(await rows()).toEqual([]);
  }, 60_000);
});

/**
 * SEAT-ONLY SEARCH (review of #216). Every search call site pins OpenRouter; a disabled, stood-down or
 * kill-switched OpenRouter used to block the call before a healthy search-capable seat was considered,
 * which made the free search lane depend on the paid one being switched on.
 */
describe("a search seat survives an unavailable paid pin", () => {
  const breakPin = (how: "disabled" | "standdown" | "kill") =>
    t.db
      .prepare(
        how === "disabled"
          ? "UPDATE provider_registry SET enabled = 0 WHERE provider_key = 'openrouter'"
          : how === "kill"
            ? "UPDATE provider_registry SET kill_switched = 1 WHERE provider_key = 'openrouter'"
            : `UPDATE provider_registry SET paused_until = '${new Date(Date.now() + 3_600_000).toISOString()}', paused_reason = 't', paused_by = 'fu_sequoia_taylor' WHERE provider_key = 'openrouter'`,
      )
      .run();
  const mend = () => t.db.prepare("UPDATE provider_registry SET enabled = 1, kill_switched = 0, paused_until = NULL, paused_reason = NULL, paused_by = NULL WHERE provider_key = 'openrouter'").run();

  for (const how of ["disabled", "standdown", "kill"] as const) {
    for (const lever of ["MODERATE", "FREE_ONLY"] as const) {
      it(`${lever}: OpenRouter ${how}, a search-capable seat awake — the seat serves the call`, async () => {
        await setLever(lever);
        await awake("codex", true);
        await breakPin(how);
        const c = claimer(["codex"]);
        const v = vendors();
        const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
        await c.stop();
        await mend();
        expect(run.status).toBe("COMPLETED");
        expect(run.output_text).toContain("SEAT SEARCH ANSWER (codex)");
        expect(v.models, "no vendor was asked").toEqual([]);
      }, 60_000);
    }
  }

  it("with the pin down and NO search-capable seat, the original block stands", async () => {
    await setLever("MODERATE");
    await awake("codex", false);
    await breakPin("disabled");
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: vendors().fetchImpl });
    await mend();
    expect(run.status).not.toBe("COMPLETED");
    expect(run.failure_reason).toContain("provider_disabled:openrouter");
  }, 60_000);

  it("seat-only means seat-only: a seat that answers without searching is NOT backed by a general model", async () => {
    await setLever("MODERATE");
    await awake("codex", true);
    await breakPin("disabled");
    const c = claimer(["codex"], { events: 0, answer: "From memory." });
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    await mend();
    expect(run.status).not.toBe("COMPLETED");
    expect(run.output_text ?? "").not.toContain("From memory");
    expect(v.models, "nothing that cannot search was asked").toEqual([]);
  }, 60_000);
});

describe("the owner's stand-down still applies", () => {
  it("a seat she stood down with 'Stop using this one' is not offered a search call", async () => {
    await setLever("MODERATE");
    await awake("codex", true);
    await t.db.prepare("UPDATE provider_registry SET paused_until = ?1, paused_reason = 'test', paused_by = 'fu_sequoia_taylor' WHERE provider_key = 'codex'").bind(new Date(Date.now() + 3_600_000).toISOString()).run();
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), SEARCH_CALL(), { fetchImpl: v.fetchImpl });
    await c.stop();
    await t.db.prepare("UPDATE provider_registry SET paused_until = NULL, paused_reason = NULL, paused_by = NULL WHERE provider_key = 'codex'").run();
    expect(c.handled, "the stood-down seat was never handed the run").toEqual([]);
    expect(run.output_text).toContain("PAID SEARCH ANSWER");
  }, 60_000);
});

describe("the adapter is a wall of its own", () => {
  it("refuses to park a search row on a seat whose claimer cannot search, and parks nothing", async () => {
    const { createSubscriptionSeatAdapter } = await import("../src/worker/ai/providers/subscriptionSeat");
    await awake("codex", false);
    const adapter = createSubscriptionSeatAdapter({ env: env(), seat: "codex", modelAccess: "PUBLIC_MODEL_APPROVED", needsSearch: true, waitMs: 50, pollMs: 5 });
    await expect(adapter.complete({ purpose: "search", inputs: ["find"], model: "codex-local", maxOutputTokens: 100 } as never)).rejects.toThrow(/has not said it can search the web/);
    expect(await rows(), "nothing was parked, so nothing waits and nothing can be claimed later").toEqual([]);
  });

  it("parks a search row, and only a search row, for a seat that can", async () => {
    const { createSubscriptionSeatAdapter } = await import("../src/worker/ai/providers/subscriptionSeat");
    await awake("codex", true);
    const adapter = createSubscriptionSeatAdapter({ env: env(), seat: "codex", modelAccess: "PUBLIC_MODEL_APPROVED", needsSearch: true, waitMs: 60, pollMs: 5 });
    // Nobody claims it, so it times out and is closed — but it was parked as a search row first.
    await expect(adapter.complete({ purpose: "search", inputs: ["find"], model: "codex-local", maxOutputTokens: 100 } as never)).rejects.toThrow();
    const [row] = await rows();
    expect(row).toMatchObject({ seat: "codex", needs_search: 1, status: "ABANDONED" });
  });
});

describe("the queue itself", () => {
  it("a claimer that did not say it can search is never handed a search row; one that did is", async () => {
    const { parkRun } = await import("../src/worker/ai/subscriptionSeats");
    await awake("codex", true);
    const id = await parkRun(env(), { seat: "codex", purpose: "search", prompt: "find", modelAccess: "PUBLIC_MODEL_APPROVED", needsSearch: true });
    expect(await claimRun(env(), "mac-test", ["codex"], new Date(), ["ANSWER"], false), "an older claimer is never handed it").toBeNull();
    const taken = await claimRun(env(), "mac-test", ["codex"], new Date(), ["ANSWER"], true);
    expect(taken?.id).toBe(id);
    expect(taken?.needs_search).toBe(1);
  });

  it("the claim route's own heartbeat does not wipe the declared capability", async () => {
    await awake("codex", true);
    // What handleSubscriptionSeatClaim does on every poll: a heartbeat that says nothing about capabilities.
    await recordHeartbeat(env(), { seat: "codex", deviceId: "mac-test" });
    const row = await t.db.prepare("SELECT capabilities_json FROM subscription_seat_device WHERE seat = 'codex'").first<{ capabilities_json: string }>();
    expect(JSON.parse(row!.capabilities_json)).toContain(SEAT_SEARCH_CAPABILITY);
    // And an explicit empty list DOES clear it: a claimer that stops being able to search says so.
    await recordHeartbeat(env(), { seat: "codex", deviceId: "mac-test", capabilities: [] });
    const cleared = await t.db.prepare("SELECT capabilities_json FROM subscription_seat_device WHERE seat = 'codex'").first<{ capabilities_json: string }>();
    expect(JSON.parse(cleared!.capabilities_json)).toEqual([]);
  });

  it("an ordinary (non-search) row is unaffected: no proof is demanded and none is stored", async () => {
    const { parkRun } = await import("../src/worker/ai/subscriptionSeats");
    await awake("codex", false);
    const id = await parkRun(env(), { seat: "codex", purpose: "answer", prompt: "q", modelAccess: "PRIVATE_MODEL_ONLY" });
    const run = await claimRun(env(), "mac-test", ["codex"]);
    expect(run?.id).toBe(id);
    const r = await reportRun(env(), { runId: id, deviceId: "mac-test", outputText: "an answer" });
    expect(r.accepted).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({ status: "REPORTED", needs_search: 0, search_events: null });
  });
});

/**
 * A TURN THAT DID NOT FINISH IS NOT AN ANSWER (review of #216). The stream must END well: `turn.completed`.
 * Searches plus narrating text followed by a failed or cut-off turn is not a proven answer.
 */
describe("the claimer's reading of a seat's search stream", () => {
  const real = readFileSync("tests/fixtures/codex-search-probe.jsonl", "utf8");
  const without = (type: string) => real.split("\n").filter((l) => !l.includes(`"type":"${type}"`)).join("\n");

  it("the real Codex capture finished: five counted searches and the last message as the answer", () => {
    const p = parseCodexSearch(real);
    expect(p).toMatchObject({ events: 5, terminal: "completed" });
    expect(searchOutcome(p, "Codex CLI")).toMatchObject({ ok: true, searchEvents: 5 });
  });

  it("searches + partial text + a FAILED turn is a failure, not a proven answer", () => {
    const failed = `${without("turn.completed")}\n{"type":"turn.failed","error":{"message":"quota exceeded"}}`;
    const p = parseCodexSearch(failed);
    expect(p.events).toBe(5);
    expect(p.answer).not.toBe("");
    const o = searchOutcome(p, "Codex CLI");
    expect(o.ok).toBe(false);
    expect((o as { error: string }).error).toMatch(/quota exceeded/);
  });

  it("a stream cut off before the turn ended is a failure even though it has text and searches", () => {
    const o = searchOutcome(parseCodexSearch(without("turn.completed")), "Codex CLI");
    expect(o.ok).toBe(false);
    expect((o as { error: string }).error).toMatch(/ended without finishing/);
  });

  it("a non-fatal `error` event (a reconnect) before a completed turn does NOT fail the answer", () => {
    const withRetry = `{"type":"error","message":"Reconnecting... 1/5"}\n${real}`;
    expect(searchOutcome(parseCodexSearch(withRetry), "Codex CLI").ok).toBe(true);
  });

  it("Claude: a result that is_error is a failure whatever was streamed before it", () => {
    const stream = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"WebSearch","input":{"query":"x"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}]}}',
      '{"type":"result","is_error":true,"result":"overloaded","usage":{"server_tool_use":{"web_search_requests":1}}}',
    ].join("\n");
    const p = parseClaudeSearch(stream);
    expect(p.events).toBeGreaterThan(0);
    expect(searchOutcome(p, "Claude Code").ok).toBe(false);
  });
});

describe("the shared check every search caller uses", () => {
  it("accepts the search model and the seats; refuses a general model and nothing", () => {
    expect(servedBySearchLane(SEARCH_MODEL)).toBe(true);
    expect(servedBySearchLane("codex-local")).toBe(true);
    expect(servedBySearchLane("claude-code-local")).toBe(true);
    // The 14 Sep failure: a general model's "I have no web access" taken as a finding.
    expect(servedBySearchLane("openai/gpt-5-mini")).toBe(false);
    expect(servedBySearchLane("anthropic/claude-sonnet-4.6")).toBe(false);
    expect(servedBySearchLane(null)).toBe(false);
    expect(servedBySearchLane(undefined)).toBe(false);
  });
});
