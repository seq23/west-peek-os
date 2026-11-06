/**
 * Which models answer from the live web, and why routing has to know (16 Sep 2026).
 *
 * WHAT THIS COST. Parker's October Workshop packet blocked three times on "the judgement pass
 * failed: the judgement was routed to the search model". The chain's judge — the pass that reads
 * what the searcher found and decides what is worth keeping — refuses to be the search model, on
 * purpose: a model whose job is retrieving pages is not the one that should be deciding which of
 * them are any good. It had no way to say so to the router, so it asked for "cheapest adequate"
 * and hoped. Migration 0158 gave `perplexity/sonar` a price so the SEARCH path could reach it, and
 * from that hour it was the cheapest priced model on the account — $1/$1 against Claude's $2/$10 —
 * so every unpinned call in the firm went to it and the judge refused its own answer every time.
 *
 * Hope is not a routing rule. A call that must not be answered from a search index says so, and
 * this is the list the router reads. It is deliberately in `shared` rather than beside the search
 * client: `runAi` cannot import a service, and a list that lives in the caller is a list the router
 * does not have.
 */
/**
 * THE $0 SEARCH LANE (5 Nov 2026). One provider (`free_search`), one catalogue id, three routes inside its adapter
 * (providers/freeSearch.ts): Gemini 2.5 Flash with Google Search grounding, then Brave Search + a free Gemini model
 * writing only from the fetched pages, then a named stop. It is search-grounded by construction — it never answers
 * from model memory — so it is on the list below and nothing that judges may be routed to it.
 */
export const FREE_SEARCH_PROVIDER_KEY = "free_search";
export const FREE_SEARCH_MODEL = "free-search/grounded";
export const isFreeSearchModel = (model: string | null | undefined): boolean => model === FREE_SEARCH_MODEL;

export const SEARCH_GROUNDED_MODELS: readonly string[] = ["perplexity/sonar", "perplexity/sonar-pro", "perplexity/sonar-reasoning", FREE_SEARCH_MODEL];

export function isSearchGrounded(model: string | null | undefined): boolean {
  return model ? SEARCH_GROUNDED_MODELS.includes(model) : false;
}
