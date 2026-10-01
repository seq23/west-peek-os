import { SEAT_REGISTRY, SEATS } from "../ai/subscriptionSeats";
import type { Env } from "../env";
import { runAi } from "../ai/runAi";
import type { Actor } from "./authorize";

/**
 * Live web search, through the governed boundary (P49).
 *
 * WHY THIS EXISTS. Market mapping and Research both read only the corpus the sweeps have gathered,
 * so a sector nobody has swept produces a thin answer. Both already declared a WEB_SEARCH source
 * that nothing populated. This populates it.
 *
 * WHY SONAR SPECIFICALLY, AND NOT JUST "ASK A MODEL". A search-grounded model answers from live
 * results and returns the URLs it used. An ordinary model asked "who else is in this space" produces
 * fluent, plausible companies that do not exist — and on a market map an invented company is
 * indistinguishable from research until someone tries to contact it.
 *
 * NO NEW CALL PATH. This goes through run_ai like everything else: budget preflight, kill switch,
 * privacy policy, ai_run ledger. The model row is capped at PUBLIC data class because the query
 * leaves for a search engine, and the policy layer enforces that rather than this module
 * remembering to.
 */

export const SEARCH_MODEL = "perplexity/sonar";

/**
 * DID A LANE THAT CAN SEARCH THE LIVE WEB ANSWER THIS CALL? (0246, 1 Oct 2026)
 *
 * Before, the only such lane was the search model, so every caller asked `run.model !== SEARCH_MODEL`.
 * A subscription seat can now serve a search call, and its model id is `codex-local` or
 * `claude-code-local` — so that question would have thrown away a good answer. What makes a seat's
 * answer a SEARCH answer is not its name but its proof: the Worker records a search run on a seat as
 * REPORTED only when the claimer counted search events in the CLI's own record (`reportRun`), and an
 * answer without them is a failure the chain moves past. So a COMPLETED search call whose model is a
 * seat has, by construction, searched. A general model answering from memory still fails this check,
 * which is the 14 Sep failure the check exists for.
 */
export function servedBySearchLane(model: string | null | undefined): boolean {
  if (!model) return false;
  return model === SEARCH_MODEL || SEATS.some((seat) => SEAT_REGISTRY[seat].model === model);
}

export interface SearchHit {
  name: string;
  description: string | null;
  url: string | null;
}

export interface SearchResult {
  ok: boolean;
  hits: SearchHit[];
  /** Every URL the model reported using. Citations come from the search, never from prose. */
  citations: string[];
  aiRunId: string | null;
  detail: string;
}

/** Pull URLs out of the answer. A hit with no URL is dropped rather than shown unsourced. */
function extractUrls(text: string): string[] {
  return Array.from(new Set((text.match(/https?:\/\/[^\s)\]"'<>]+/g) ?? []).map((u) => u.replace(/[.,;]+$/, ""))));
}

/**
 * Parse the model's JSON answer.
 *
 * A hit without a URL is discarded. That is the whole discipline of this module: the value of a
 * search-grounded model over a plain one is the citation, so a result that arrives without one has
 * thrown away the only reason to use it.
 */
export function parseHits(raw: string): SearchHit[] {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: { results?: unknown };
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed.results)) return [];

  const out: SearchHit[] = [];
  for (const r of parsed.results as Array<Record<string, unknown>>) {
    const name = typeof r.name === "string" ? r.name.trim() : "";
    const url = typeof r.url === "string" && /^https?:\/\//.test(r.url) ? r.url : null;
    if (!name || !url) continue;
    out.push({ name, url, description: typeof r.description === "string" ? r.description.trim() : null });
  }
  return out;
}

/**
 * Find companies operating in a sector.
 *
 * Deliberately narrow: it asks for companies and nothing else. Asking one search for companies AND
 * their funding AND their stage produces confident numbers with no provenance — funding figures come
 * from SEC filings and swept news, which can be checked.
 */
export async function findCompanies(
  env: Env,
  actor: Actor,
  sector: string,
  limit = 25,
): Promise<SearchResult> {
  const prompt = [
    `List companies currently operating in: ${sector}`,
    "",
    "RULES:",
    "- Only real companies you can cite a source for. If you are unsure it exists, leave it out.",
    "- A one-line description of what each actually does.",
    "- Do NOT state funding amounts, valuations or stages. Those are verified elsewhere and a",
    "  number without provenance is worse than no number.",
    `- At most ${limit} companies. Fewer, all real, beats more with guesses.`,
    "",
    'Return ONLY JSON: {"results":[{"name":"…","description":"…","url":"https://…"}]}',
  ].join("\n");

  try {
    const { run } = await runAi(env, {
      purpose: `live company search: ${sector}`,
      actor,
      inputs: [prompt],
      // PUBLIC and never raised: the query leaves this system for a search engine.
      sensitivity: "PUBLIC" as never,
      budgetContext: { requiresSearch: true, expectedOutputTokens: 1200, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
      routing: { category: "INTELLIGENCE" },
    });

    if (run.status !== "COMPLETED" || !run.output_text) {
      return { ok: false, hits: [], citations: [], aiRunId: run.id, detail: run.failure_reason ?? `run ${run.status}` };
    }
    const hits = parseHits(run.output_text);
    return {
      ok: true,
      hits: hits.slice(0, limit),
      citations: extractUrls(run.output_text),
      aiRunId: run.id,
      detail: `${hits.length} result(s)`,
    };
  } catch (err) {
    // Search failing degrades the caller; it never fails it. Both callers have other sources.
    return { ok: false, hits: [], citations: [], aiRunId: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Answer a research question from live sources, with the URLs it used. */
export async function searchQuestion(
  env: Env,
  actor: Actor,
  question: string,
): Promise<{ ok: boolean; text: string; citations: string[]; aiRunId: string | null; detail: string }> {
  try {
    const { run } = await runAi(env, {
      purpose: `live research search: ${question.slice(0, 80)}`,
      actor,
      inputs: [[
        `Research this question using current sources: ${question}`,
        "",
        "Answer concisely and factually. Cite the URL for every substantive claim.",
        "If current sources do not answer part of it, say which part — that is more useful than a guess.",
      ].join("\n")],
      sensitivity: "PUBLIC" as never,
      budgetContext: { requiresSearch: true, expectedOutputTokens: 1500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
      routing: { category: "INTELLIGENCE" },
    });
    if (run.status !== "COMPLETED" || !run.output_text) {
      return { ok: false, text: "", citations: [], aiRunId: run.id, detail: run.failure_reason ?? `run ${run.status}` };
    }
    // A SEARCH ANSWERED BY A MODEL THAT CANNOT SEARCH IS A TOOL FAILURE, NOT A RESULT. On 14 Sep
    // 2026 every search was routed to a general model (the search model had no price row) and its
    // "I have no web access" was handed to the employee as a finding, who then reported companies
    // as not existing. The run records which model answered; anything but the search model is
    // refused here so the employee sees the tool fail rather than a confident nothing.
    if (!servedBySearchLane(run.model)) {
      return {
        ok: false, text: "", citations: [], aiRunId: run.id,
        detail: `search was routed to ${run.model ?? "an unknown model"}, which cannot search the web; ${SEARCH_MODEL} was unavailable to routing. The result is not a finding about the question.`,
      };
    }
    return { ok: true, text: run.output_text, citations: extractUrls(run.output_text), aiRunId: run.id, detail: "ok" };
  } catch (err) {
    return { ok: false, text: "", citations: [], aiRunId: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Find candidate venues for a Room.
 *
 * Separate from findCompanies() only in its prompt. Same discipline and the same reason for it: a
 * venue without a citation is dropped, because the packet's whole promise is that a partner can act
 * on it without re-checking, and a confidently wrong private-dining number is discovered by someone
 * standing on a phone rather than sitting at a desk.
 */
export async function findVenues(
  env: Env,
  actor: Actor,
  city: string,
  brief: string,
  limit = 12,
): Promise<SearchResult> {
  const prompt = [
    `Find real venues in ${city} suitable for: ${brief}`,
    "",
    "RULES:",
    "- Only venues you can cite a live page for. If you cannot source it, leave it out.",
    "- Prefer venues with a private dining room, a private floor, or an events page.",
    "- One line on why the space suits a seated conversation of 25-35 people.",
    "- Do NOT state prices or phone numbers here. Those are read off the cited page later.",
    `- At most ${limit}. Fewer, all real, beats more with guesses.`,
    "",
    'Return ONLY JSON: {"results":[{"name":"…","description":"…","url":"https://…"}]}',
  ].join("\n");

  try {
    const { run } = await runAi(env, {
      purpose: `venue search: ${city}`,
      actor,
      inputs: [prompt],
      sensitivity: "PUBLIC" as never,
      budgetContext: { requiresSearch: true, expectedOutputTokens: 1200, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
      routing: { category: "INTELLIGENCE" },
    });
    if (run.status !== "COMPLETED" || !run.output_text) {
      return { ok: false, hits: [], citations: [], aiRunId: run.id, detail: run.failure_reason ?? `run ${run.status}` };
    }
    const hits = parseHits(run.output_text);
    return {
      ok: true,
      hits: hits.slice(0, limit),
      citations: extractUrls(run.output_text),
      aiRunId: run.id,
      detail: `${hits.length} venue(s)`,
    };
  } catch (err) {
    return { ok: false, hits: [], citations: [], aiRunId: null, detail: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Today's market levels, and the calendar the day turns on.
 *
 * WHY THIS EXISTS. The morning brief was written from swept RSS, which carries headlines and no
 * numbers, so it could never say where the ten-year sits or that Housing Starts print at 7:30.
 * Those are the two things a partner actually opens a brief for, and their absence is why it read
 * as a news digest rather than an intelligence report.
 *
 * WHY IT IS SEARCH AND NOT A MARKET-DATA VENDOR. A quotes API was the obvious answer and the wrong
 * one for this firm: the capability was already here and already paid for. A search-grounded model
 * returns the level AND the source it read it from, which is the same discipline the rest of this
 * file follows — the value over an ordinary model is the citation, so a figure that arrives without
 * one is discarded rather than shown.
 *
 * WHAT IT IS NOT. Not a price feed and not a trading input. Levels are indicative, minutes old at
 * best, and the report says so where they are shown. They exist to frame a morning, not to mark a
 * position — which is exactly why they never touch the deal-math path, where every number is
 * verified arithmetic over recorded inputs.
 */

export interface MarketLevel {
  /** What it is, in the words a partner would use — "10-year Treasury", not "US10Y". */
  instrument: string;
  /** The level as read, verbatim. A string because "above $91" and "4.73%" are both real answers. */
  level: string;
  /** Direction if the source stated one. Never inferred. */
  move: string | null;
}

export interface CalendarItem {
  /** "Housing Starts", "Home Depot earnings". */
  event: string;
  /** When, as stated by the source. */
  when: string;
  /** Why a venture partner should care — one line, from the source's framing. */
  why: string | null;
}

export interface MarketRead {
  ok: boolean;
  levels: MarketLevel[];
  calendar: CalendarItem[];
  citations: string[];
  aiRunId: string | null;
  detail: string;
}

/** Pull the market JSON out of whatever the model wrapped it in. Shape errors degrade to empty. */
export function parseMarketRead(raw: string): { levels: MarketLevel[]; calendar: CalendarItem[] } {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced?.[1] ?? raw).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return { levels: [], calendar: [] };

  let parsed: { levels?: unknown; calendar?: unknown };
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return { levels: [], calendar: [] };
  }

  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

  const levels = Array.isArray(parsed.levels)
    ? (parsed.levels as Array<Record<string, unknown>>)
        .map((l) => ({ instrument: str(l.instrument), level: str(l.level), move: str(l.move) }))
        // An instrument with no level is the failure this whole module guards against: a name with
        // a confident-looking blank beside it reads as "unchanged" rather than as "unknown".
        .filter((l): l is MarketLevel => Boolean(l.instrument && l.level))
    : [];

  const calendar = Array.isArray(parsed.calendar)
    ? (parsed.calendar as Array<Record<string, unknown>>)
        .map((c) => ({ event: str(c.event), when: str(c.when), why: str(c.why) }))
        .filter((c): c is CalendarItem => Boolean(c.event && c.when))
    : [];

  return { levels, calendar };
}

export async function readMarket(env: Env, actor: Actor, watchlist: readonly string[] = []): Promise<MarketRead> {
  const extra = watchlist.length > 0 ? `\nAlso, if publicly traded: ${watchlist.slice(0, 5).join(", ")}.` : "";
  const prompt = [
    "Report today's market levels and today's economic calendar, for a venture investor's morning briefing.",
    "",
    "LEVELS — report only what you can read from a source right now:",
    "- S&P 500 and Nasdaq futures or index level",
    "- The US 10-year and 30-year Treasury yields",
    "- Brent crude",
    extra,
    "",
    "CALENDAR — scheduled releases and earnings for TODAY only, with the time as published.",
    "",
    "RULES:",
    "- Report the level as your source states it. Do NOT round, convert or interpolate.",
    "- If you cannot find a current level for something, OMIT it. An omitted line is honest;",
    "  a stale or guessed one is not, and the reader cannot tell the difference.",
    "- Do not forecast, do not recommend, and do not explain what the market will do next.",
    "",
    'Return ONLY JSON: {"levels":[{"instrument":"…","level":"…","move":"…"}],',
    ' "calendar":[{"event":"…","when":"…","why":"…"}]}',
  ].join("\n");

  try {
    const { run } = await runAi(env, {
      purpose: "daily market levels and calendar",
      actor,
      inputs: [prompt],
      // PUBLIC and never raised: the query leaves this system for a search engine.
      sensitivity: "PUBLIC" as never,
      budgetContext: { requiresSearch: true, expectedOutputTokens: 900, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
      routing: { category: "INTELLIGENCE" },
    });

    if (run.status !== "COMPLETED" || !run.output_text) {
      return { ok: false, levels: [], calendar: [], citations: [], aiRunId: run.id, detail: run.failure_reason ?? `run ${run.status}` };
    }
    const { levels, calendar } = parseMarketRead(run.output_text);
    return {
      ok: true,
      levels,
      calendar,
      citations: extractUrls(run.output_text),
      aiRunId: run.id,
      detail: `${levels.length} level(s), ${calendar.length} calendar item(s)`,
    };
  } catch (err) {
    // A brief without market levels is thinner. A brief that fails to arrive is useless, and the
    // sweep-based half of it is unaffected by this call — so search failing degrades, never fails.
    return { ok: false, levels: [], calendar: [], citations: [], aiRunId: null, detail: err instanceof Error ? err.message : String(err) };
  }
}
