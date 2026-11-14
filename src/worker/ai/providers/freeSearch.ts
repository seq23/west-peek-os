import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "./outputCeiling";
import { finishReasonFrom } from "./finishReason";
import { FREE_SEARCH_MODEL } from "../../../shared/ai/models";

/**
 * LIVE RESEARCH FOR $0 (5 Nov 2026). One lane, three routes, tried in order inside one attempt:
 *
 *   1. GOOGLE GEMINI DIRECT with the `google_search` tool (grounding), down an ORDERED LIST of free-tier models
 *      (FREE_SEARCH_GROUNDED_MODELS, 6 Nov 2026). On 5 Nov only `gemini-2.5-flash` grounded on the free tier
 *      (grounding on gemini-3.x answered 429), and it retires on 1 Dec 2026 — so the model is never one pinned
 *      string. Each rung is tried until one returns grounding chunks with web URLs; a 404, a "retired / not found",
 *      a 429 or an answer without sources moves to the next rung, never to a hard failure. Only a rejected key
 *      (401/403) skips the rest, because every rung uses the same key.
 *   2. BRAVE SEARCH, then a FREE MODEL WRITING ONLY FROM THE FETCHED TEXT. Brave's web search finds the pages, the top
 *      results are fetched with a plain GET, and a free writer writes the answer from those pages alone, each fact with
 *      its URL. Writers: the free Gemini models, then OpenRouter `:free` models (6 Nov 2026), so the route still runs
 *      when the Gemini key's whole free allowance is gone. OpenRouter is asked with `max_price` 0 and its reported cost
 *      is read: any cost above 0 throws the answer away and stops the OpenRouter writers (`OPENROUTER_COST`). An answer
 *      that cites none of the fetched URLs is refused.
 *      HARD CAP: 20 Brave queries a day, counted in D1 (`free_search_quota`); over the cap is the next route, never an
 *      error.
 *   3. A NAMED STOP: `Couldn't research <name>: <reason>`. Never research from model memory — tested on 4 Nov 2026,
 *      three free models without search invented three different founders for the same firm.
 *
 * Past route 3 the router's own ladder carries the call (the Codex seat, then Claude Code, then the run's named stop).
 *
 * Every call is $0 (the unpaid Gemini quota, Brave's free plan and OpenRouter `:free` models), so the cost is reported as 0 and the money guard
 * counts this lane as free. Its terms permit training, so it is registered training-permitting with a PUBLIC-only data
 * policy and never sees confidential text (runAi 4b/4d remove it before any request is formed).
 */

/**
 * The grounded rungs, in order. Every id is a model Google's free tier bills nothing for (the same list Boss OS's
 * guard holds); gemini-4-argon and the 3.1 Pro previews are metered and are never here.
 */
export const FREE_SEARCH_GROUNDED_MODELS = [
  "gemini-3.8-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-3-flash-preview",
] as const;
export const FREE_SEARCH_WRITER_MODELS = ["gemini-3.6-flash", "gemini-3-flash-preview"] as const;
/**
 * OpenRouter writers for route 2: the PREFERRED order only. The live list wins (`liveFreeWriters`): on 6 Nov 2026,
 * the first live call found three of four pinned `:free` slugs answering 404 "unavailable for free", so a pinned list
 * would have died quietly. Each call reads OpenRouter's public model list and keeps only `:free` ids priced 0 for
 * both prompt and completion; preferred ids come first, then other live free ids. If the list cannot be read, these
 * are tried as they are. A slug without the suffix is refused before any request.
 */
export const FREE_SEARCH_OPENROUTER_WRITERS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3.5-super-vl:free",
  "google/gemma-4-26b-a4b-it:free",
] as const;
/** At most this many OpenRouter writers are tried in one write. */
const OPENROUTER_WRITER_TRIES = 4;
/** Smaller models are left out: they cannot write a cited answer from three fetched pages. */
const OPENROUTER_MIN_CONTEXT = 128_000;
export const FREE_SEARCH_OPENROUTER_BASE_URL = "https://openrouter.ai";
export const OPENROUTER_COST_STOP = "OPENROUTER_COST";
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_DAILY_QUERY_CAP = 20;
export const FREE_SEARCH_STOP = "free_search_named_stop";
const PAGES_TO_FETCH = 3;
/** Route 2 asks Brave up to this many questions for one search, each aimed at a different kind of source. */
export const BRAVE_QUERIES_PER_SEARCH = 3;
const SOURCES_PER_SEARCH = 18;

/**
 * WHICH GROUNDED RUNGS THIS KEY CAN STILL USE (13 Nov 2026, wc_946f0b75…). Read from the lane's own earlier stops, so
 * no rung is asked a question its key has already answered: a model Google answered 404 for is gone for good, and one
 * that answered 429 today has no grounding allowance left today. Pure. `stops` are earlier stop texts with their time.
 */
export function groundedRungs(
  models: readonly string[],
  stops: readonly { at: string; reason: string }[],
  now: Date,
): { ask: string[]; gone: string[]; spentToday: string[] } {
  const today = now.toISOString().slice(0, 10);
  const gone: string[] = [];
  const spentToday: string[] = [];
  for (const model of models) {
    const said = new RegExp(`(?:^|[^a-z0-9.-])${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: provider_http_(\\d{3})`, "g");
    let isGone = false;
    let isSpent = false;
    for (const stop of stops) {
      for (const m of stop.reason.matchAll(said)) {
        if (m[1] === "404") isGone = true;
        if (m[1] === "429" && stop.at.slice(0, 10) === today) isSpent = true;
      }
    }
    if (isGone) gone.push(model);
    else if (isSpent) spentToday.push(model);
  }
  return { ask: models.filter((m) => !gone.includes(m) && !spentToday.includes(m)), gone, spentToday };
}
const PAGE_CHARS = 6_000;
const PAGE_TIMEOUT_MS = 8_000;

/** The Brave quota, counted in D1. `take` reserves one query and answers false when today's cap is reached. */
export interface BraveQuota {
  take(): Promise<boolean>;
}

export interface FreeSearchOptions {
  /** https://generativelanguage.googleapis.com */
  geminiBaseUrl: string;
  geminiApiKey?: string;
  braveApiKey?: string;
  /** OpenRouter, for the `:free` writers of route 2 only. */
  openRouterApiKey?: string;
  openRouterBaseUrl?: string;
  quota: BraveQuota;
  /** The lane's own earlier stops (newest first), so a rung this key cannot use is not asked again. See `groundedRungs`. */
  groundedStops?: () => Promise<readonly { at: string; reason: string }[]>;
  /** Tests only. */
  now?: () => Date;
  fetchImpl?: typeof fetch;
  /** Tests only; production uses the per-call deadline. */
  timeoutMs?: number;
}

interface GeminiBody {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
    finishReason?: string;
    groundingMetadata?: { groundingChunks?: Array<{ web?: { uri?: string; title?: string } }>; webSearchQueries?: string[] };
  }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

const textOf = (b: GeminiBody): string =>
  (b.candidates?.[0]?.content?.parts ?? []).map((p) => p.text).filter((t): t is string => typeof t === "string").join("");

/**
 * Does the answer cite this fetched page? The page's address as the search gave it, or the same address without its
 * query string and trailing slash: on 13 Nov 2026 a writer cited a profile exactly, less the "?_l=en" the search
 * result carried, and its sourced answer was thrown away as citing nothing.
 */
export function citesPage(answer: string, url: string): boolean {
  const bare = url.split(/[?#]/)[0]!.replace(/\/+$/, "");
  return answer.includes(url) || (bare.length > "https://x.y".length && answer.includes(bare));
}

/** The subject named in a stop: the run's purpose, trimmed to something a person can read. */
function subjectOf(req: ProviderRequest): string {
  return (req.purpose || "this").replace(/\s+/g, " ").trim().slice(0, 120);
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function createFreeSearchAdapter(options: FreeSearchOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const base = options.geminiBaseUrl.replace(/\/$/, "");

  async function gemini(model: string, prompt: string, req: ProviderRequest, grounded: boolean): Promise<GeminiBody> {
    const res = await doFetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": options.geminiApiKey ?? "" },
      signal: AbortSignal.timeout(options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS),
      body: JSON.stringify({
        generationConfig: { maxOutputTokens: Math.min(req.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS, PROVIDER_MAX_OUTPUT_TOKENS) },
        system_instruction: { parts: [{ text: `West Peek OS governed task: ${req.purpose}` }] },
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        ...(grounded ? { tools: [{ google_search: {} }] } : {}),
      }),
    });
    if (!res.ok) throw await providerHttpError(res);
    return (await res.json()) as GeminiBody;
  }

  /** Route 1. Walks the grounded rungs; returns the first sourced answer, or throws with every rung's reason. */
  async function grounded(req: ProviderRequest): Promise<ProviderResponse> {
    const why: string[] = [];
    const stops = options.groundedStops ? await options.groundedStops().catch(() => []) : [];
    const rungs = groundedRungs(FREE_SEARCH_GROUNDED_MODELS, stops, options.now ? options.now() : new Date());
    if (rungs.gone.length) why.push(`no longer offered on this key, so not asked: ${rungs.gone.join(", ")}`);
    if (rungs.spentToday.length) why.push(`no grounding allowance left today, so not asked again: ${rungs.spentToday.join(", ")}`);
    for (const model of rungs.ask) {
      try {
        return await groundedOn(model, req);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        why.push(`${model}: ${msg}`);
        // The same key answers for every rung: a rejected key will not be accepted by the next model either.
        if (/^provider_http_40[13]\b/.test(msg)) break;
      }
    }
    throw new Error(why.join("; "));
  }

  async function groundedOn(model: string, req: ProviderRequest): Promise<ProviderResponse> {
    const body = await gemini(model, req.inputs.join("\n\n"), req, true);
    const text = textOf(body);
    const urls = [
      ...new Set(
        (body.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [])
          .map((c) => c.web?.uri)
          .filter((u): u is string => typeof u === "string" && /^https?:\/\//.test(u)),
      ),
    ];
    if (!text) throw new Error("grounding returned no answer");
    if (urls.length === 0) throw new Error("grounding unavailable: the answer carried no web sources");
    // The caller's own check (14 Nov 2026): an answer in the wrong shape is this rung's failure, and the next rung is asked.
    const refused = req.verify?.(text);
    if (refused) throw new Error(`refused by the caller's check: ${refused}`);
    return {
      text: `${text}\n\nSources:\n${urls.map((u) => `- ${u}`).join("\n")}\n\nSearched with: Google Search grounding on ${model}`,
      model: FREE_SEARCH_MODEL,
      finishReason: finishReasonFrom(body.candidates?.[0]?.finishReason),
      usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0, costUsd: 0 },
    };
  }

  interface Written {
    text: string;
    writer: string;
    finishReason: ProviderResponse["finishReason"];
    inputTokens: number;
    outputTokens: number;
  }

  /** One OpenRouter `:free` call: price held at 0, and any reported cost refuses the answer. */
  async function openRouterFree(model: string, prompt: string, req: ProviderRequest): Promise<Written> {
    if (!model.endsWith(":free")) throw new Error(`${model} is not a :free model`);
    const orBase = (options.openRouterBaseUrl ?? FREE_SEARCH_OPENROUTER_BASE_URL).replace(/\/$/, "");
    const res = await doFetch(`${orBase}/api/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.openRouterApiKey ?? ""}` },
      signal: AbortSignal.timeout(options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        max_tokens: Math.min(req.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS, PROVIDER_MAX_OUTPUT_TOKENS),
        messages: [
          { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
          { role: "user", content: prompt },
        ],
        provider: { max_price: { prompt: 0, completion: 0 } },
        usage: { include: true },
      }),
    });
    if (!res.ok) throw await providerHttpError(res);
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number; total_cost?: number };
    };
    const cost = Number(body.usage?.cost ?? body.usage?.total_cost ?? 0);
    if (Number.isFinite(cost) && cost > 0) {
      throw new Error(`${OPENROUTER_COST_STOP}: ${model} reported a cost of $${cost}; a :free writer must cost nothing, so its answer is not used`);
    }
    const text = body.choices?.[0]?.message?.content ?? "";
    return {
      text,
      writer: `openrouter/${model}`,
      finishReason: finishReasonFrom(body.choices?.[0]?.finish_reason ?? undefined),
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    };
  }

  /** OpenRouter's live `:free` list, priced 0 both ways, preferred ids first. The pinned list when it cannot be read. */
  async function liveFreeWriters(req: ProviderRequest): Promise<string[]> {
    const preferred: string[] = [...FREE_SEARCH_OPENROUTER_WRITERS];
    try {
      const orBase = (options.openRouterBaseUrl ?? FREE_SEARCH_OPENROUTER_BASE_URL).replace(/\/$/, "");
      const res = await doFetch(`${orBase}/api/v1/models`, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(Math.min(options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS, PAGE_TIMEOUT_MS)),
      });
      if (!res.ok) return preferred;
      const data = ((await res.json()) as { data?: Array<{ id?: string; context_length?: number; pricing?: { prompt?: string; completion?: string } }> }).data;
      if (!Array.isArray(data)) return preferred;
      const free = data
        .filter(
          (m) =>
            typeof m.id === "string" &&
            m.id.endsWith(":free") &&
            Number(m.pricing?.prompt) === 0 &&
            Number(m.pricing?.completion) === 0 &&
            Number(m.context_length ?? 0) >= OPENROUTER_MIN_CONTEXT,
        )
        .map((m) => m.id!);
      if (free.length === 0) return preferred;
      const live = new Set(free);
      return [...preferred.filter((id) => live.has(id)), ...free.filter((id) => !preferred.includes(id))];
    } catch {
      return preferred;
    }
  }

  /**
   * One free writer call: each free Gemini model, then each OpenRouter `:free` model, in turn. `refuse` is the
   * caller's own check on the answer (13 Nov 2026): a writer whose answer it refuses has failed, and the NEXT
   * writer is asked, so one writer that cites no page is not the end of the route.
   */
  async function write(prompt: string, req: ProviderRequest, refuse: (text: string) => string | null = () => null): Promise<Written> {
    const why: string[] = [];
    const usable = (model: string, text: string): boolean => {
      if (!text) return why.push(`${model} returned nothing`) < 0;
      const refused = refuse(text);
      return refused ? why.push(`${model}: ${refused}`) < 0 : true;
    };
    if (options.geminiApiKey) {
      for (const model of FREE_SEARCH_WRITER_MODELS) {
        try {
          const body = await gemini(model, prompt, req, false);
          const text = textOf(body);
          if (usable(model, text)) {
            return {
              text,
              writer: model,
              finishReason: finishReasonFrom(body.candidates?.[0]?.finishReason),
              inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
              outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
            };
          }
        } catch (err) {
          why.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (options.openRouterApiKey) {
      for (const model of (await liveFreeWriters(req)).slice(0, OPENROUTER_WRITER_TRIES)) {
        try {
          const out = await openRouterFree(model, prompt, req);
          if (usable(model, out.text)) return out;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          why.push(`${model}: ${msg}`);
          // A cost on a :free lane stops every OpenRouter writer: the next one is not trusted to be free either.
          if (msg.startsWith(OPENROUTER_COST_STOP)) break;
        }
      }
    } else {
      why.push("OpenRouter writers: OPENROUTER_API_KEY is not set");
    }
    throw new Error(`no free writer answered (${why.join("; ")})`);
  }

  /** Route 2. Brave finds, plain fetch reads, a free Gemini model writes only from what was read. */
  async function braveRoute(req: ProviderRequest): Promise<ProviderResponse> {
    if (!options.braveApiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");
    const task = req.inputs.join("\n\n");
    /*
     * SEVERAL QUESTIONS, EACH FOR WHAT THE TASK WANTS FOUND (13 Nov 2026, wc_946f0b75…). Walker's hire search failed
     * here twelve times: ONE query was written, about the agency that was hiring, so the three pages fetched were about
     * the agency, held no candidate, and every writer truthfully answered with an empty list that cited nothing.
     */
    const queries = [
      ...new Set(
        (
          await write(
            `Write up to ${BRAVE_QUERIES_PER_SEARCH} web search queries, one per line, each at most 12 words, that together would find what this ` +
              "research task asks for. Search for the people, organisations or facts the task wants FOUND, never for whoever is " +
              "asking or who the work is for. When the task lists several kinds of source, aim each query at a different one. " +
              "When it wants people found, write queries that return individual people's own public pages, not company service pages. " +
              // The ask is usually at the END of a long brief: the first 4,000 characters of Walker's were who he is and what
              // the agency sells, so the query writer never saw the role it was searching for.
              `Output only the queries.\n\nTASK:\n${task.length > 6000 ? `${task.slice(0, 1500)}\n[…]\n${task.slice(-4500)}` : task}`,
            req,
          )
        ).text
          .split("\n")
          .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").replace(/^["'\s]+|["'\s]+$/g, "").slice(0, 380))
          .filter((l) => l.length > 0),
      ),
    ].slice(0, BRAVE_QUERIES_PER_SEARCH);
    if (queries.length === 0) throw new Error("no search query could be written");

    type Found = { title?: string; url?: string; description?: string; extra_snippets?: string[] };
    const perQuery: Found[][] = [];
    for (const q of queries) {
      if (!(await options.quota.take())) {
        if (perQuery.length === 0) throw new Error(`today's ${BRAVE_DAILY_QUERY_CAP} Brave queries are used up`);
        break;
      }
      const res = await doFetch(`${BRAVE_SEARCH_URL}?q=${encodeURIComponent(q)}&count=8`, {
        method: "GET",
        headers: { accept: "application/json", "X-Subscription-Token": options.braveApiKey },
        signal: AbortSignal.timeout(options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS),
      });
      if (!res.ok) {
        // The first question's refusal is the route's; a later one (Brave's free plan answers one a second) keeps what was found.
        if (perQuery.length === 0) throw await providerHttpError(res);
        break;
      }
      const found = ((await res.json()) as { web?: { results?: Found[] } }).web?.results ?? [];
      perQuery.push(found.filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url!)));
    }
    // Every question's best result first, then its second, and so on: each kind of source is represented.
    const results: Found[] = [];
    for (let rank = 0; results.length < SOURCES_PER_SEARCH && perQuery.some((list) => rank < list.length); rank += 1) {
      for (const list of perQuery) {
        const r = list[rank];
        if (r && !results.some((x) => x.url === r.url) && results.length < SOURCES_PER_SEARCH) results.push(r);
      }
    }
    if (results.length === 0) throw new Error(`Brave found nothing for ${queries.map((q) => `"${q}"`).join(", ")}`);

    // The first pages are read in full; the rest stand as what the search result itself showed.
    const sources: Array<{ url: string; title: string; text: string }> = [];
    for (const [i, r] of results.entries()) {
      let text = "";
      if (i < PAGES_TO_FETCH) {
        try {
          const page = await doFetch(r.url!, { method: "GET", headers: { accept: "text/html,text/plain" }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
          const type = page.headers.get("content-type") ?? "";
          if (page.ok && /text\/html|text\/plain/i.test(type)) text = htmlToText(await page.text()).slice(0, PAGE_CHARS);
        } catch {
          /* the snippet below stands in for a page that would not load */
        }
      }
      const snippet = [r.description ?? "", ...(r.extra_snippets ?? [])].join(" ").replace(/<[^>]+>/g, "").trim();
      const body = text || snippet;
      if (body) sources.push({ url: r.url!, title: r.title ?? r.url!, text: body });
    }
    if (sources.length === 0) throw new Error("none of the pages Brave found could be read");

    const prompt = [
      "Answer the research task below using ONLY the SOURCES that follow. They were fetched from the live web just now",
      "(the first few as whole pages, the rest as what the search result showed).",
      "Rules: every fact you state must carry, in brackets, the URL of the source it came from. Do not use anything you know",
      "from memory. If the sources do not say something, write that it was not found in the sources. Never invent a name,",
      "a number, a date or a URL.",
      "",
      "TASK:",
      task,
      "",
      "SOURCES:",
      ...sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.text}`),
      "",
      // The task's own output format has the last word (14 Nov 2026, wc_bd8b68cb): with the sources after it, a long brief's
      // "Return ONLY JSON" was thousands of characters back, and a writer answered the partner's note as a letter instead.
      "Now answer the TASK above in exactly the output format it specifies (when it asks for JSON, return only that JSON,",
      "with each URL in its own field). You are not writing to anyone: no greeting, no letter, no status update.",
    ].join("\n");
    // The route's own check, applied to EACH writer: an answer that cites none of the fetched pages is that writer's
    // failure, and the next free writer is asked before the route gives up.
    const written = await write(prompt, req, (answer) =>
      sources.some((s) => citesPage(answer, s.url))
        ? // And the caller's own check (14 Nov 2026): a cited answer in the wrong shape — a letter where a list was asked
          // for — is that writer's failure too, so the next free writer is asked before the route gives up.
          (req.verify?.(answer) ?? null)
        : "cited none of the fetched pages, so its answer cannot be shown to come from them",
    );
    const text = written.text;
    return {
      text: `${text}\n\nSources:\n${sources.map((s) => `- ${s.url}`).join("\n")}\n\nSearched with: Brave Search, written by ${written.writer}`,
      model: FREE_SEARCH_MODEL,
      finishReason: written.finishReason,
      usage: { inputTokens: written.inputTokens, outputTokens: written.outputTokens, costUsd: 0 },
    };
  }

  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      // Route 2 can run on Brave + OpenRouter alone, so only a lane with neither route is unconfigured.
      if (!options.geminiApiKey && !(options.braveApiKey && options.openRouterApiKey)) throw new Error("credential_missing:free_search");
      if (req.images?.length || req.documents?.length) throw new Error("provider_cannot_read_files:free_search");
      const why: string[] = [];
      if (options.geminiApiKey) {
        try {
          return await grounded(req);
        } catch (err) {
          why.push(`Gemini search grounding: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        why.push("Gemini search grounding: no Gemini key is set");
      }
      try {
        return await braveRoute(req);
      } catch (err) {
        why.push(`Brave search: ${err instanceof Error ? err.message : String(err)}`);
      }
      // Route 3. Nothing is written from model memory.
      throw new Error(`${FREE_SEARCH_STOP}:Couldn't research ${subjectOf(req)}: ${why.join("; ")}`);
    },
  };
}
