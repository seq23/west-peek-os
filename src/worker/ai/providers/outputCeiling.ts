/**
 * How long a reply this firm asks for may be, in output tokens — one number, every adapter.
 *
 * WHAT WENT WRONG, 18 Sep 2026. Both partners' morning briefs failed. The brief was generated,
 * rejected twice by its own quality gate — "executive_summary carries no [n] citation;
 * top_headlines carries no [n] citation; ... the markets_macro section is missing" — and closed
 * FAILED. The gate was right. The model was not writing badly; it was being cut off.
 *
 * Every one of the eight Workers AI runs that morning recorded `output_tokens: 256`. Not about
 * 256 — exactly 256, eight times out of eight, the reply ending mid-word in the middle of the
 * second section. 256 is Workers AI's own default `max_tokens`, and `workersAi.ts` was sending no
 * ceiling at all, so the platform applied it. The daily brief asks for 8000 output tokens. It was
 * being given 3% of that and then failed for not containing the other 97%.
 *
 * WHY IT SURFACED THAT MORNING AND NOT BEFORE. The brief is pinned to a frontier lane and had
 * never reached this adapter. On 17 Sep a 60s provider deadline landed; an 8000-token completion
 * does not finish in 60s, so every frontier attempt began aborting and the router failed over to
 * the cheapest lane that answered — Workers AI. The truncation had been latent in every Workers AI
 * run since the tier was added; the deadline is what walked the brief into it.
 *
 * WHY A SHARED CONSTANT AND NOT A NUMBER PER ADAPTER. `anthropic.ts` carried its own hard-coded
 * 4096, which is also below what the brief asks for — the same defect, a different adapter, and
 * nobody had linked the two. A ceiling that lives beside each wire call drifts from what the
 * callers actually request, and drift here is invisible: a truncated reply looks like a bad model.
 * One number, imported everywhere, and `validate:brief-arrives` reads the largest
 * `expectedOutputTokens` any caller in this repo asks for and fails if this is below it. The
 * catalogue and the callers can no longer disagree without something going red.
 *
 * WHY THIS NUMBER. 16384 is comfortably above the largest ask in the repo (8000, the daily brief)
 * with room for a caller to grow into, and below the output limit of every model registered here.
 * It is a CEILING, not a target: a 300-token classification still returns 300 tokens and costs what
 * 300 tokens cost. Nothing is paid for headroom that is not used.
 */
export const PROVIDER_MAX_OUTPUT_TOKENS = 16_384;
