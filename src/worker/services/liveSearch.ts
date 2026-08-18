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
      budgetContext: { expectedOutputTokens: 1200, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
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
      budgetContext: { expectedOutputTokens: 1500, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
      routing: { category: "INTELLIGENCE" },
    });
    if (run.status !== "COMPLETED" || !run.output_text) {
      return { ok: false, text: "", citations: [], aiRunId: run.id, detail: run.failure_reason ?? `run ${run.status}` };
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
      budgetContext: { expectedOutputTokens: 1200, preferredModel: SEARCH_MODEL, providerKey: "openrouter" },
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
