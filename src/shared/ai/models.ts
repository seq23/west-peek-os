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
export const SEARCH_GROUNDED_MODELS: readonly string[] = ["perplexity/sonar", "perplexity/sonar-pro", "perplexity/sonar-reasoning"];

export function isSearchGrounded(model: string | null | undefined): boolean {
  return model ? SEARCH_GROUNDED_MODELS.includes(model) : false;
}
