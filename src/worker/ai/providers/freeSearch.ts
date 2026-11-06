import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "./outputCeiling";
import { finishReasonFrom } from "./finishReason";
import { FREE_SEARCH_MODEL } from "../../../shared/ai/models";

/**
 * LIVE RESEARCH FOR $0 (5 Nov 2026). One lane, three routes, tried in order inside one attempt:
 *
 *   1. GOOGLE GEMINI DIRECT, `gemini-2.5-flash` with the `google_search` tool (grounding). Verified live on the
 *      owner's own key: the ONLY free-tier model where grounding works (`gemini-2.5-flash-lite` is closed to new
 *      users; grounding on gemini-3.x answers 429 on the free tier). An answer counts only when Google returned
 *      grounding chunks with web URLs — an answer without them is the model talking, not a search. `gemini-2.5-flash`
 *      retires on 1 Dec 2026, which is why route 2 exists.
 *   2. BRAVE SEARCH, then a FREE GEMINI MODEL WRITING ONLY FROM THE FETCHED TEXT. Brave's web search finds the pages,
 *      the top results are fetched with a plain GET, and `gemini-3.6-flash` (then `gemini-3-flash-preview`) writes the
 *      answer from those pages alone, each fact with its URL. An answer that cites none of the fetched URLs is refused.
 *      HARD CAP: 20 Brave queries a day, counted in D1 (`free_search_quota`); over the cap is the next route, never an
 *      error.
 *   3. A NAMED STOP: `Couldn't research <name>: <reason>`. Never research from model memory — tested on 4 Nov 2026,
 *      three free models without search invented three different founders for the same firm.
 *
 * Every call is $0 (the unpaid Gemini quota and Brave's free plan), so the cost is reported as 0 and the money guard
 * counts this lane as free. Its terms permit training, so it is registered training-permitting with a PUBLIC-only data
 * policy and never sees confidential text (runAi 4b/4d remove it before any request is formed).
 */

export const FREE_SEARCH_GROUNDED_MODEL = "gemini-2.5-flash";
export const FREE_SEARCH_WRITER_MODELS = ["gemini-3.6-flash", "gemini-3-flash-preview"] as const;
export const BRAVE_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_DAILY_QUERY_CAP = 20;
export const FREE_SEARCH_STOP = "free_search_named_stop";
const PAGES_TO_FETCH = 3;
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
  quota: BraveQuota;
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

  /** Route 1. Returns the answer, or throws with the reason grounding was not available. */
  async function grounded(req: ProviderRequest): Promise<ProviderResponse> {
    const body = await gemini(FREE_SEARCH_GROUNDED_MODEL, req.inputs.join("\n\n"), req, true);
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
    return {
      text: `${text}\n\nSources:\n${urls.map((u) => `- ${u}`).join("\n")}`,
      model: FREE_SEARCH_MODEL,
      finishReason: finishReasonFrom(body.candidates?.[0]?.finishReason),
      usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0, costUsd: 0 },
    };
  }

  /** One free writer call, trying each writer model in turn. */
  async function write(prompt: string, req: ProviderRequest): Promise<{ text: string; body: GeminiBody }> {
    const why: string[] = [];
    for (const model of FREE_SEARCH_WRITER_MODELS) {
      try {
        const body = await gemini(model, prompt, req, false);
        const text = textOf(body);
        if (text) return { text, body };
        why.push(`${model} returned nothing`);
      } catch (err) {
        why.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new Error(`no free writer answered (${why.join("; ")})`);
  }

  /** Route 2. Brave finds, plain fetch reads, a free Gemini model writes only from what was read. */
  async function braveRoute(req: ProviderRequest): Promise<ProviderResponse> {
    if (!options.braveApiKey) throw new Error("BRAVE_SEARCH_API_KEY is not set");
    const task = req.inputs.join("\n\n");
    const q = (
      await write(
        `Write ONE web search query, at most 12 words, that would find the facts this research task needs. Output only the query.\n\nTASK:\n${task.slice(0, 4000)}`,
        req,
      )
    ).text
      .split("\n")[0]!
      .replace(/^["'\s]+|["'\s]+$/g, "")
      .slice(0, 380);
    if (!q) throw new Error("no search query could be written");
    if (!(await options.quota.take())) throw new Error(`today's ${BRAVE_DAILY_QUERY_CAP} Brave queries are used up`);

    const res = await doFetch(`${BRAVE_SEARCH_URL}?q=${encodeURIComponent(q)}&count=8`, {
      method: "GET",
      headers: { accept: "application/json", "X-Subscription-Token": options.braveApiKey },
      signal: AbortSignal.timeout(options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS),
    });
    if (!res.ok) throw await providerHttpError(res);
    const found = ((await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string; extra_snippets?: string[] }> } }).web?.results ?? [];
    const results = found.filter((r) => typeof r.url === "string" && /^https?:\/\//.test(r.url!));
    if (results.length === 0) throw new Error(`Brave found nothing for "${q}"`);

    const sources: Array<{ url: string; title: string; text: string }> = [];
    for (const r of results.slice(0, PAGES_TO_FETCH)) {
      let text = "";
      try {
        const page = await doFetch(r.url!, { method: "GET", headers: { accept: "text/html,text/plain" }, signal: AbortSignal.timeout(PAGE_TIMEOUT_MS) });
        const type = page.headers.get("content-type") ?? "";
        if (page.ok && /text\/html|text\/plain/i.test(type)) text = htmlToText(await page.text()).slice(0, PAGE_CHARS);
      } catch {
        /* the snippet below stands in for a page that would not load */
      }
      const snippet = [r.description ?? "", ...(r.extra_snippets ?? [])].join(" ").replace(/<[^>]+>/g, "").trim();
      const body = text || snippet;
      if (body) sources.push({ url: r.url!, title: r.title ?? r.url!, text: body });
    }
    if (sources.length === 0) throw new Error("none of the pages Brave found could be read");

    const prompt = [
      "Answer the research task below using ONLY the SOURCES that follow. They were fetched from the live web just now.",
      "Rules: every fact you state must carry, in brackets, the URL of the source it came from. Do not use anything you know",
      "from memory. If the sources do not say something, write that it was not found in the sources. Never invent a name,",
      "a number, a date or a URL.",
      "",
      "TASK:",
      task,
      "",
      "SOURCES:",
      ...sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n${s.text}`),
    ].join("\n");
    const { text, body } = await write(prompt, req);
    const cited = sources.filter((s) => text.includes(s.url));
    if (cited.length === 0) throw new Error("the writer cited none of the fetched pages, so its answer cannot be shown to come from them");
    return {
      text: `${text}\n\nSources:\n${sources.map((s) => `- ${s.url}`).join("\n")}`,
      model: FREE_SEARCH_MODEL,
      finishReason: finishReasonFrom(body.candidates?.[0]?.finishReason),
      usage: { inputTokens: body.usageMetadata?.promptTokenCount ?? 0, outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0, costUsd: 0 },
    };
  }

  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.geminiApiKey) throw new Error("credential_missing:free_search");
      if (req.images?.length || req.documents?.length) throw new Error("provider_cannot_read_files:free_search");
      const why: string[] = [];
      try {
        return await grounded(req);
      } catch (err) {
        why.push(`Gemini search grounding: ${err instanceof Error ? err.message : String(err)}`);
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
