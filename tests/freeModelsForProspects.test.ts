import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";
import { runAi, type RunAiInput } from "../src/worker/ai/runAi";
import { claimRun, recordHeartbeat, reportRun, type Seat } from "../src/worker/ai/subscriptionSeats";
import { classifyContent } from "../src/shared/ai/contentClass";
import { committedLps, isCommittedLp, meetingIsConfidential } from "../src/worker/ai/committedLps";
import { BRAVE_DAILY_QUERY_CAP, FREE_SEARCH_GROUNDED_MODELS, createFreeSearchAdapter } from "../src/worker/ai/providers/freeSearch";
import { credentialConfigured, credentialNote, credentialValueFor } from "../src/shared/ai/providerCredentials";
import { FREE_SEARCH_MODEL } from "../src/shared/ai/models";
import { servedBySearchLane } from "../src/worker/services/liveSearch";
import { writeWhyLine } from "../src/worker/services/meetingBrief";
import { routeFor, loadRoles } from "../scripts/lib/model-roles.mjs";

/**
 * PROSPECTS MAY USE FREE MODELS, LIVE RESEARCH FOR $0, AND IMPORTANT WORK THAT DOES NOT WAIT FOR EVER (5 Nov 2026).
 *
 *   FIX 1  Private-model-only is ONLY a committed LP's name, or deal terms / fund figures (owner ruling, 4 Nov 2026).
 *   FIX 2  At Free only a search call takes the $0 search lane: Gemini grounding → Brave + a free writer → named stop.
 *   FIX 3  Non-confidential important work waits at most 2 hours (or the owner's floor) for a seat, then a free model.
 *
 * Every person and firm named here is made up.
 */

let t: TestDb;
const ACTOR: Actor = { type: "HUMAN", firmUserId: "fu_pat_example", roles: ["MANAGING_PARTNER"], firmScopes: ["west-peek"] };
const KEYS = { OPENROUTER_API_KEY: "or", GEMINI_API_KEY: "g", BRAVE_SEARCH_API_KEY: "b" };
const env = (extra: Record<string, string> = {}): Env => makeTestEnv(t.db, { ...KEYS, ...extra });

const TRAINING_LANES = ["openrouter_free", "google_free", "free_search", "codex"];
const SOURCE_URL = "https://example.com/about";

async function setLever(lever: "FREE_ONLY" | "MODERATE" | "OPEN"): Promise<void> {
  await t.db
    .prepare(
      `INSERT INTO budget_policy (id, firm_scope, cost_mode, privacy_mode, daily_cap_usd, per_run_cap_usd, honours_pins, prefers_frontier, spend_lever, defer_non_critical, set_by)
       VALUES (?1, 'west-peek', 'NORMAL', 'FRONTIER', 500, 500, 1, 0, ?2, 0, 'fu_pat_example')`,
    )
    .bind(`bp_fmp_${crypto.randomUUID()}`, lever)
    .run();
}

interface Scenario {
  grounding: "ok" | "none" | "429";
  braveResults?: number;
  /** Models Google answers 404 "not found / retired" for (1 Dec 2026 and after). */
  retired?: string[];
  /** The free Gemini writers answer 429: the key's whole free allowance is gone. */
  writers429?: boolean;
  /** The cost OpenRouter reports for a `:free` writer call. */
  openRouterCost?: number;
}
interface Seen {
  calls: Array<{ host: string; model: string; grounded: boolean; geminiKey?: string; maxPrice?: unknown }>;
}

/** One stub for every vendor, routed by host. Records which host and model each call reached. */
function vendors(sc: Scenario = { grounding: "ok" }): { fetchImpl: typeof fetch; seen: Seen } {
  const seen: Seen = { calls: [] };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const host = new URL(url).host;
    const body = (() => {
      try {
        return JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    const ok = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
    if (host === "generativelanguage.googleapis.com") {
      const model = decodeURIComponent(url.split("/models/")[1]!.split(":")[0]!);
      const grounded = Array.isArray(body.tools);
      seen.calls.push({ host, model, grounded, geminiKey: new Headers(init?.headers).get("x-goog-api-key") ?? "" });
      if (sc.retired?.includes(model)) {
        return new Response(JSON.stringify({ error: { code: 404, message: `models/${model} is not found for API version v1beta, or is not supported for generateContent.`, status: "NOT_FOUND" } }), { status: 404 });
      }
      if (!grounded && sc.writers429) return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
      if (grounded) {
        if (sc.grounding === "429") return new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 });
        return ok({
          candidates: [
            {
              content: { parts: [{ text: `Pat Example founded Example Ventures [${SOURCE_URL}].` }] },
              finishReason: "STOP",
              groundingMetadata: sc.grounding === "ok" ? { groundingChunks: [{ web: { uri: SOURCE_URL, title: "About" } }] } : {},
            },
          ],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 },
        });
      }
      const prompt = JSON.stringify(body.contents ?? "");
      const text = prompt.includes("Write ONE web search query") ? "Example Ventures founder" : `GEMINI ANSWER (${model}) — Pat Example is the founder [${SOURCE_URL}].`;
      return ok({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 10 } });
    }
    if (host === "api.search.brave.com") {
      seen.calls.push({ host, model: "brave", grounded: false });
      const n = sc.braveResults ?? 2;
      return ok({ web: { results: Array.from({ length: n }, (_, i) => ({ title: `Result ${i}`, url: i === 0 ? SOURCE_URL : `https://example.com/p${i}`, description: "Pat Example founded Example Ventures." })) } });
    }
    if (host === "example.com") {
      seen.calls.push({ host, model: "page", grounded: false });
      return new Response("<html><body><h1>About</h1><p>Pat Example founded Example Ventures in 2019.</p></body></html>", { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.endsWith("/api/v1/models")) {
      seen.calls.push({ host, model: "models-list", grounded: false });
      // One preferred id has stopped being free (priced), one never-pinned id is live and free.
      return ok({
        data: [
          { id: "nvidia/nemotron-3-ultra-550b-a55b:free", context_length: 1_000_000, pricing: { prompt: "0.0000004", completion: "0.000001" } },
          { id: "example/live-writer:free", context_length: 262_144, pricing: { prompt: "0", completion: "0" } },
        ],
      });
    }
    // OpenRouter (and anything else): the OpenAI shape.
    const model = String(body.model ?? "");
    seen.calls.push({ host, model, grounded: false, maxPrice: (body.provider as { max_price?: unknown } | undefined)?.max_price });
    const asked = JSON.stringify(body.messages ?? "");
    const content = asked.includes("Write ONE web search query")
      ? "Example Ventures founder"
      : asked.includes("SOURCES:")
        ? `OPENROUTER ANSWER (${model}) — Pat Example is the founder [${SOURCE_URL}].`
        : `ANSWER FROM ${model}`;
    return ok({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 10, ...(sc.openRouterCost ? { cost: sc.openRouterCost } : {}) } });
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

const awake = (seat: Seat, search = false): Promise<void> =>
  recordHeartbeat(env(), { seat, deviceId: "mac-test", hostname: "test-mac", capabilities: search ? ["web_search"] : [] });

function claimer(seats: Seat[]): { stop: () => Promise<void>; handled: string[] } {
  const handled: string[] = [];
  let live = true;
  const loop = (async () => {
    while (live) {
      const run = await claimRun(env(), "mac-test", seats, new Date(), ["ANSWER"], false);
      if (!run) {
        await new Promise((r) => setTimeout(r, 20));
        continue;
      }
      handled.push(run.seat);
      await reportRun(env(), { runId: run.id, deviceId: "mac-test", outputText: `SEAT ANSWER (${run.seat})` });
    }
  })();
  return { handled, stop: async () => { live = false; await loop; } };
}

const providerOf = async (runId: string): Promise<string | null> =>
  (await t.db.prepare("SELECT p.provider_key FROM ai_run r JOIN provider_registry p ON p.id = r.provider_id WHERE r.id = ?1").bind(runId).first<{ provider_key: string }>())?.provider_key ?? null;
const routingOf = async (runId: string) =>
  (await t.db.prepare("SELECT explanation, attempts_json FROM ai_run_routing WHERE ai_run_id = ?1").bind(runId).first<{ explanation: string; attempts_json: string }>())!;

beforeAll(async () => {
  t = await createTestDb();
  await t.db.prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lp_prospect', 'Example Prospect Office', 'FAMILY_OFFICE', 'ENGAGED', 'fu_pat_example')").run();
  await t.db.prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lp_committed', 'Example Committed Trust', 'FAMILY_OFFICE', 'COMMITTED', 'fu_pat_example')").run();
  await t.db.prepare("INSERT OR IGNORE INTO lp_record (id, legal_name, lp_type, status, created_by) VALUES ('lp_engaged_yes', 'Example Yes Foundation', 'INSTITUTION', 'ENGAGED', 'fu_pat_example')").run();
  await t.db.prepare("INSERT OR IGNORE INTO lp_engagement (lp_record_id, state, updated_by) VALUES ('lp_engaged_yes', 'COMMITTED', 'fu_pat_example')").run();
});
afterAll(async () => {
  await disposeTestDb(t);
});
beforeEach(async () => {
  await t.db.prepare("DELETE FROM subscription_seat_device").run();
  await t.db.prepare("DELETE FROM subscription_seat_run").run();
  await t.db.prepare("DELETE FROM provider_lane_health").run();
  await t.db.prepare("DELETE FROM free_search_quota").run();
  await t.db.prepare("DELETE FROM task_quality_floor").run();
  await t.db.prepare("UPDATE provider_model SET quality_tier = 'UNMEASURED'").run();
  await setLever("FREE_ONLY");
});
afterEach(() => {
  vi.unstubAllGlobals();
});

// ── FIX 1 ───────────────────────────────────────────────────────────────────────────────────────
describe("Fix 1: only a committed LP, or deal terms and fund figures, are confidential", () => {
  it("reads a commitment from the records that hold one", async () => {
    expect(await isCommittedLp(env(), "lp_prospect")).toBe(false);
    expect(await isCommittedLp(env(), "lp_committed")).toBe(true);
    expect(await isCommittedLp(env(), "lp_engaged_yes"), "lp_engagement COMMITTED counts").toBe(true);
    expect(await isCommittedLp(env(), "lp_nobody"), "an LP the records do not hold fails closed").toBe(true);
    expect(await meetingIsConfidential(env(), { lp_record_id: "lp_prospect" })).toBe(false);
    const list = await committedLps(env(), "west-peek");
    expect(list.readable).toBe(true);
    expect(list.names).toEqual(expect.arrayContaining(["Example Committed Trust", "Example Yes Foundation"]));
    expect(list.names).not.toContain("Example Prospect Office");
  });

  it("the words LP, limited partner and investor no longer make content private; a deal term or a committed LP's name does", () => {
    const lp = { declaredPublicModelApproved: true, machineKey: "lp_fundraising" } as const;
    expect(classifyContent({ ...lp, inputs: ["Intro email to an LP prospect: limited partner, investor in two emerging managers."] }).publicModelApproved).toBe(true);
    expect(classifyContent({ machineKey: "lp_fundraising", inputs: ["Meeting prep for the prospect."] }).publicModelApproved, "LP prospect pipeline work is on the allow-list").toBe(true);
    for (const text of ["Their commitment amount is 2m.", "Draft the side letter.", "The term sheet says 8m pre-money.", "Fund size is 50m with a 2% management fee and 20% carry.", "Next capital call is in May."]) {
      expect(classifyContent({ ...lp, inputs: [text] }).publicModelApproved, text).toBe(false);
    }
    expect(classifyContent({ ...lp, inputs: ["Thank Example Committed Trust for the call."], committedLpNames: ["Example Committed Trust"] }).publicModelApproved).toBe(false);
    expect(classifyContent({ ...lp, inputs: ["anything"], committedLpListReadable: false }).publicModelApproved, "unreadable records fail closed").toBe(false);
    // Everyday English is not a fund figure.
    expect(classifyContent({ ...lp, inputs: ["Can you carry the boxes? The fund raiser is on Friday."] }).publicModelApproved).toBe(true);
  });

  it("a prospect's meeting prep (the meeting brief's own call) routes to a free lane at Free only with the seats away", async () => {
    const v = vendors();
    vi.stubGlobal("fetch", v.fetchImpl);
    const meeting = { id: "mtg_prospect", title: "Intro with Example Prospect Office", meeting_type: "LP", scheduled_at: null, lp_record_id: "lp_prospect", privacy_label: "INTERNAL" };
    const brief = { prepared_by: "Meeting Buddy", record: { about: "LP", name: "Example Prospect Office", stage: "IN_CONVERSATION" }, find_out: [], last_time: { firm: [], counterparty: [] }, diligence: null };
    const out = await writeWhyLine(env(), ACTOR, meeting as never, brief as never);
    expect(out.ai_run_id).not.toBeNull();
    const run = (await t.db.prepare("SELECT status, failure_reason FROM ai_run WHERE id = ?1").bind(out.ai_run_id).first<{ status: string; failure_reason: string | null }>())!;
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(["openrouter_free", "google_free"]).toContain(await providerOf(out.ai_run_id!));
  }, 60_000);

  it("a brand email (naming investors, which is not confidential) routes to a free lane", async () => {
    const v = vendors();
    const { run } = await runAi(env(), BRAND_EMAIL(false), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(["openrouter_free", "google_free"]).toContain(await providerOf(run.id));
  }, 60_000);

  it("text naming a committed LP never reaches a training-permitting lane — not a free model, not Codex", async () => {
    // Codex awake and claiming: it must not be given the run.
    await awake("codex");
    const c = claimer(["codex"]);
    const v = vendors();
    const { run } = await runAi(env(), NAMES_COMMITTED_LP(), { fetchImpl: v.fetchImpl });
    await c.stop();
    expect(c.handled, "Codex never took it").toEqual([]);
    expect(run.status).not.toBe("COMPLETED");
    expect(v.seen.calls, "no vendor that trains was called").toEqual([]);
    // At MODERATE it may go to a paid no-training lane, but never to one that trains.
    await setLever("MODERATE");
    const v2 = vendors();
    const { run: paid } = await runAi(env(), NAMES_COMMITTED_LP(), { fetchImpl: v2.fetchImpl });
    expect(TRAINING_LANES).not.toContain(await providerOf(paid.id));
    const attempts = paid.status === "COMPLETED" ? (JSON.parse((await routingOf(paid.id)).attempts_json) as Array<{ provider_key: string }>) : [];
    for (const a of attempts) expect(TRAINING_LANES).not.toContain(a.provider_key);
  }, 60_000);

  it("text carrying a commitment amount never reaches a training-permitting lane either", async () => {
    const v = vendors();
    const { run } = await runAi(env(), { ...NAMES_COMMITTED_LP(), inputs: ["Follow up with the prospect: their commitment amount is 2m."] }, { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(run.failure_reason ?? "").toMatch(/^seat_wait_important_work:.*never a free lane/);
    expect(v.seen.calls).toEqual([]);
  }, 60_000);

  it("the Mac keeps a job that names a committed LP on Claude, and lets prospect and brand work go to Codex", () => {
    const roles = loadRoles();
    const base = { kind: "WEB_PROPERTY_CHANGE", phase: "BUILD", materialDirs: [] };
    expect(routeFor({ ...base, prompt: "Add a page for LP prospects and investors." }, roles).role).toBe("worker");
    expect(routeFor({ ...base, prompt: "Add the TLC brand page for the kids' workshop." }, roles).role).toBe("worker");
    expect(routeFor({ ...base, prompt: "Publish the cap table." }, roles).role).toBe("brain");
    expect(routeFor({ ...base, prompt: "Thank our LP.", privateModelOnly: true }, roles).role).toBe("brain");
  });
});

const BRAND_EMAIL = (important: boolean, extra: Partial<RunAiInput["budgetContext"]> = {}): RunAiInput => ({
  purpose: important ? "The Learning Club: the brand email" : "draft the brand outreach email",
  actor: ACTOR,
  inputs: ["Draft a short email to a sponsor brand about the spring family workshop. Mention investors who attended last year."],
  sensitivity: "PUBLIC" as never,
  budgetContext: { judgement: true, expectedOutputTokens: 300, ...(important ? { important: true } : {}), ...extra },
  routing: { category: "INTELLIGENCE" },
});
const NAMES_COMMITTED_LP = (): RunAiInput => ({
  purpose: "thank-you note",
  actor: ACTOR,
  inputs: ["Draft a thank-you note to Example Committed Trust for the call."],
  sensitivity: "PUBLIC" as never,
  budgetContext: { judgement: true, expectedOutputTokens: 200, publicModelApproved: true },
  routing: { category: "OPERATIONS" },
});
const SEARCH = (extra: Partial<RunAiInput["budgetContext"]> = {}, inputs = ["Who founded Example Ventures? Cite sources."]): RunAiInput => ({
  purpose: "Research Example Ventures",
  actor: ACTOR,
  inputs,
  sensitivity: "PUBLIC" as never,
  budgetContext: { requiresSearch: true, expectedOutputTokens: 800, preferredModel: "perplexity/sonar", providerKey: "openrouter", ...extra },
  routing: { category: "INTELLIGENCE" },
});

// ── FIX 2 ───────────────────────────────────────────────────────────────────────────────────────
describe("Fix 2: live research for $0", () => {
  it("route 1: Gemini 2.5 Flash with grounding answers, cited, at $0 — and a search caller accepts it", async () => {
    const v = vendors({ grounding: "ok" });
    const { run } = await runAi(env(), SEARCH({ important: true }), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.failure_reason ?? "").not.toContain("free_only_cannot_serve_protected_work");
    expect(run.model).toBe(FREE_SEARCH_MODEL);
    expect(servedBySearchLane(run.model)).toBe(true);
    expect(run.output_text).toContain(SOURCE_URL);
    expect(v.seen.calls[0]).toMatchObject({ model: "gemini-2.5-flash", grounded: true });
    expect(v.seen.calls.some((c) => c.host === "api.search.brave.com")).toBe(false);
    const cost = (await t.db.prepare("SELECT cost_estimate_json FROM ai_run WHERE id = ?1").bind(run.id).first<{ cost_estimate_json: string }>())!;
    expect((JSON.parse(cost.cost_estimate_json) as { estimated_cost_usd: number }).estimated_cost_usd, "the money guard counts it as free").toBe(0);
  }, 60_000);

  it("route 2: grounding unavailable → Brave, the pages are fetched, a free Gemini model writes only from them", async () => {
    const v = vendors({ grounding: "none" });
    const { run } = await runAi(env(), SEARCH(), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain(SOURCE_URL);
    expect(v.seen.calls.filter((c) => c.host === "api.search.brave.com")).toHaveLength(1);
    expect(v.seen.calls.some((c) => c.host === "example.com"), "the top results were fetched").toBe(true);
    expect(v.seen.calls.some((c) => c.model === "gemini-3.6-flash" && !c.grounded)).toBe(true);
    const q = (await t.db.prepare("SELECT brave_queries FROM free_search_quota").first<{ brave_queries: number }>())!;
    expect(q.brave_queries, "the Brave query was counted in D1").toBe(1);
  }, 60_000);

  it("a 429 on grounding also moves to Brave", async () => {
    const v = vendors({ grounding: "429" });
    const { run } = await runAi(env(), SEARCH(), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(v.seen.calls.some((c) => c.host === "api.search.brave.com")).toBe(true);
  }, 60_000);

  it("route 3: Brave's daily cap reached → a named stop, never an answer from memory", async () => {
    await t.db.prepare("INSERT INTO free_search_quota (day, brave_queries) VALUES (?1, ?2)").bind(new Date().toISOString().slice(0, 10), BRAVE_DAILY_QUERY_CAP).run();
    const v = vendors({ grounding: "none" });
    const { run } = await runAi(env(), SEARCH(), { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(run.failure_reason).toContain("Couldn't research Research Example Ventures:");
    expect(run.failure_reason).toContain(`today's ${BRAVE_DAILY_QUERY_CAP} Brave queries are used up`);
    expect(v.seen.calls.some((c) => c.host === "api.search.brave.com"), "the 21st query is never sent").toBe(false);
    expect(run.output_text ?? null).toBeNull();
  }, 60_000);

  it("the adapter itself: a writer that cites none of the fetched pages is refused", async () => {
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.search.brave.com")) return new Response(JSON.stringify({ web: { results: [{ url: SOURCE_URL, title: "x", description: "y" }] } }), { status: 200 });
      if (url.startsWith("https://example.com")) return new Response("<p>y</p>", { status: 200, headers: { "content-type": "text/html" } });
      const body = JSON.parse(String(init?.body)) as { tools?: unknown; contents: unknown };
      const text = body.tools ? "no sources" : JSON.stringify(body.contents).includes("Write ONE web search query") ? "q" : "An answer with no URL at all.";
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const adapter = createFreeSearchAdapter({ geminiBaseUrl: "https://generativelanguage.googleapis.com", geminiApiKey: "g", braveApiKey: "b", quota: { take: async () => true }, fetchImpl });
    await expect(adapter.complete({ purpose: "Example Ventures", inputs: ["who"], model: null })).rejects.toThrow(/^free_search_named_stop:Couldn't research Example Ventures: .*cited none of the fetched pages/);
  });

  it("1 Dec 2026: gemini-2.5-flash answers 404 and research still completes on the next grounded rung, on West Peek OS's own key", async () => {
    // No Brave key: before 6 Nov the 404 went straight to Brave, so this run stopped instead of researching.
    const v = vendors({ grounding: "ok", retired: ["gemini-2.5-flash"] });
    const { run } = await runAi(env({ BRAVE_SEARCH_API_KEY: "", WP_GEMINI_API_KEY: "wp" }), SEARCH(), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(servedBySearchLane(run.model)).toBe(true);
    expect(run.output_text).toContain(SOURCE_URL);
    const grounded = v.seen.calls.filter((c) => c.grounded).map((c) => c.model);
    expect(grounded.slice(0, 2)).toEqual(["gemini-2.5-flash", FREE_SEARCH_GROUNDED_MODELS[1]]);
    expect(run.output_text).toContain(`Searched with: Google Search grounding on ${FREE_SEARCH_GROUNDED_MODELS[1]}`);
    expect(v.seen.calls.every((c) => c.host !== "generativelanguage.googleapis.com" || c.geminiKey === "wp"), "its own key, not the shared one").toBe(true);
  }, 60_000);

  it("no free grounded model left and the Gemini allowance spent: Brave + an OpenRouter :free writer carries it at $0, and a reported cost stops it", async () => {
    const v = vendors({ grounding: "429", writers429: true });
    const { run } = await runAi(env(), SEARCH(), { fetchImpl: v.fetchImpl });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.output_text).toContain(SOURCE_URL);
    expect(run.output_text).toMatch(/Searched with: Brave Search, written by openrouter\/.+:free/);
    const or = v.seen.calls.filter((c) => c.host === "openrouter.ai" && c.model !== "models-list");
    expect(or.length).toBeGreaterThan(0);
    // The live list wins: a pinned id that is no longer priced 0 is never asked; a live free id carries it.
    expect(or.map((c) => c.model)).not.toContain("nvidia/nemotron-3-ultra-550b-a55b:free");
    expect(run.output_text).toContain("written by openrouter/example/live-writer:free");
    for (const c of or) {
      expect(c.model.endsWith(":free")).toBe(true);
      expect(c.maxPrice).toEqual({ prompt: 0, completion: 0 });
    }
    // Any cost on a :free writer: the answer is not used, no other OpenRouter writer is tried, the lane stops by name.
    await t.db.prepare("DELETE FROM free_search_quota").run();
    const priced = vendors({ grounding: "429", writers429: true, openRouterCost: 0.0004 });
    const { run: stopped } = await runAi(env(), SEARCH(), { fetchImpl: priced.fetchImpl });
    expect(stopped.status).not.toBe("COMPLETED");
    expect(stopped.failure_reason).toContain("free_search_named_stop:Couldn't research");
    expect(stopped.failure_reason).toContain("OPENROUTER_COST");
    expect(priced.seen.calls.filter((c) => c.host === "openrouter.ai" && c.model !== "models-list")).toHaveLength(1);
  }, 60_000);

  it("a search naming a committed LP reaches none of the new rungs: no grounded model, no Brave, no OpenRouter writer", async () => {
    const v = vendors({ grounding: "ok", retired: ["gemini-2.5-flash"], writers429: true });
    const { run } = await runAi(env({ WP_GEMINI_API_KEY: "wp" }), SEARCH({}, ["Who runs the investment office at Example Committed Trust? Cite sources."]), { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(v.seen.calls, "no training-permitting route was called").toEqual([]);
  }, 60_000);

  it("the Gemini lanes read WP_GEMINI_API_KEY first; until it exists they use GEMINI_API_KEY and say so, never fail", () => {
    expect(credentialValueFor({ WP_GEMINI_API_KEY: "wp", GEMINI_API_KEY: "g" }, "free_search")).toBe("wp");
    expect(credentialValueFor({ GEMINI_API_KEY: "g" }, "free_search")).toBe("g");
    expect(credentialConfigured({ GEMINI_API_KEY: "g" }, "google_free")).toBe(true);
    expect(credentialNote({ GEMINI_API_KEY: "g" }, "free_search")).toMatch(/WP_GEMINI_API_KEY is not set yet/);
    expect(credentialNote({ WP_GEMINI_API_KEY: "wp", GEMINI_API_KEY: "g" }, "free_search")).toBeNull();
  });

  it("a confidential search call never reaches the $0 search lane", async () => {
    const v = vendors({ grounding: "ok" });
    const { run } = await runAi(env(), SEARCH({ confidential: true }), { fetchImpl: v.fetchImpl });
    expect(run.status).not.toBe("COMPLETED");
    expect(v.seen.calls).toEqual([]);
  }, 60_000);

  it("registers the verified free-tier Gemini ids on google_free, never gemini-4-argon or gemini-3.1-pro-preview*, and leaves paid OpenAI off", async () => {
    const rows = (await t.db.prepare("SELECT m.model, m.max_data_class, p.training_permitted FROM provider_model m JOIN provider_registry p ON p.id = m.provider_id WHERE p.provider_key = 'google_free' AND m.status = 'ACTIVE'").all<{ model: string; max_data_class: string; training_permitted: number }>()).results ?? [];
    const ids = rows.map((r) => r.model);
    for (const id of ["gemini-2.5-flash", "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3-flash-preview"]) expect(ids).toContain(id);
    for (const r of rows) expect(r).toMatchObject({ max_data_class: "PUBLIC", training_permitted: 1 });
    const forbidden = (await t.db.prepare("SELECT m.model FROM provider_model m JOIN provider_registry p ON p.id = m.provider_id WHERE p.training_permitted = 1 AND (m.model LIKE '%gemini-4-argon%' OR m.model LIKE '%gemini-3.1-pro-preview%')").all()).results ?? [];
    expect(forbidden).toEqual([]);
    const openai = (await t.db.prepare("SELECT enabled FROM provider_registry WHERE provider_key = 'openai'").first<{ enabled: number }>())!;
    expect(openai.enabled, "the paid OpenAI provider stays disabled").toBe(0);
  });
});

// ── FIX 3 ───────────────────────────────────────────────────────────────────────────────────────
describe("Fix 3: important work that waits for a seat", () => {
  const later = (h: number) => new Date(Date.now() + h * 3_600_000);

  it("non-confidential important work waits, then after 2 hours the best free model carries it, and the reason is recorded", async () => {
    const v = vendors();
    const first = (await runAi(env(), BRAND_EMAIL(true), { fetchImpl: v.fetchImpl })).run;
    expect(first.failure_reason ?? "").toMatch(/^seat_wait_important_work:.*waited 0 of at most 120 minutes/);
    const early = (await runAi(env(), BRAND_EMAIL(true), { fetchImpl: v.fetchImpl, now: later(1) })).run;
    expect(early.failure_reason ?? "", "still inside the wait").toMatch(/^seat_wait_important_work:.*of at most 120 minutes/);
    await t.db.prepare("UPDATE provider_model SET quality_tier = 'FULL' WHERE provider_id = 'prov_google_free' AND model = 'gemini-3.8-flash'").run();
    const { run } = await runAi(env(), BRAND_EMAIL(true), { fetchImpl: v.fetchImpl, now: later(2.1) });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(["openrouter_free", "google_free"]).toContain(await providerOf(run.id));
    const routing = await routingOf(run.id);
    expect(routing.explanation).toContain("seat_wait_free_fallback");
    expect(routing.explanation).toMatch(/waited 12\d minutes/);
  }, 60_000);

  it("the owner's per-task floor is honoured: SEAT_ONLY keeps it waiting; a shorter wait and a FULL floor pick only a FULL model", async () => {
    const v = vendors();
    await t.db.prepare("INSERT INTO task_quality_floor (id, task_key, min_free_tier, max_wait_minutes, set_by) VALUES ('tqf_1', 'The Learning Club: the brand email', 'SEAT_ONLY', NULL, 'fu_pat_example')").run();
    const purpose = "The Learning Club: the brand email";
    await runAi(env(), { ...BRAND_EMAIL(true), purpose }, { fetchImpl: v.fetchImpl });
    const held = (await runAi(env(), { ...BRAND_EMAIL(true), purpose }, { fetchImpl: v.fetchImpl, now: later(5) })).run;
    expect(held.failure_reason ?? "").toMatch(/^seat_wait_important_work:.*quality floor for this task is a seat only/);

    await t.db.prepare("INSERT INTO task_quality_floor (id, task_key, min_free_tier, max_wait_minutes, version_no, set_by) VALUES ('tqf_2', ?1, 'FULL', 30, 2, 'fu_pat_example')").bind(purpose).run();
    const noFull = (await runAi(env(), { ...BRAND_EMAIL(true), purpose }, { fetchImpl: v.fetchImpl, now: later(5) })).run;
    expect(noFull.failure_reason ?? "", "no FULL free model yet").toMatch(/no free model passes the owner's quality floor \(FULL\)/);
    await t.db.prepare("UPDATE provider_model SET quality_tier = 'FULL' WHERE provider_id = 'prov_google_free' AND model = 'gemini-3.6-flash'").run();
    const { run } = await runAi(env(), { ...BRAND_EMAIL(true), purpose }, { fetchImpl: v.fetchImpl, now: later(5) });
    expect(run.status, run.failure_reason ?? "").toBe("COMPLETED");
    expect(run.model).toBe("gemini-3.6-flash");
  }, 60_000);

  it("confidential important work keeps waiting for the Claude Code seat, however long", async () => {
    const v = vendors();
    const call = { ...BRAND_EMAIL(true), purpose: "note on the fund", budgetContext: { judgement: true, important: true, confidential: true } };
    await runAi(env(), call, { fetchImpl: v.fetchImpl });
    const { run } = await runAi(env(), call, { fetchImpl: v.fetchImpl, now: later(30) });
    expect(run.failure_reason ?? "").toMatch(/^seat_wait_important_work:.*never a free lane/);
    expect(v.seen.calls).toEqual([]);
  }, 60_000);
});
