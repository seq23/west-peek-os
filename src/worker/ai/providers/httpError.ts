/**
 * WHAT THE VENDOR ACTUALLY SAID (17 Sep 2026).
 *
 * Every adapter in this directory used to throw `provider_http_400` and nothing else. On the night
 * of 17 Sep that string was the ENTIRE account of why Parker's event-kit card failed three times in
 * fourteen minutes: the direct Anthropic lane had answered
 *
 *   "your credit balance is too low to access the Anthropic API"
 *
 * and the adapter threw the number away before anybody could read it. The owner saw "Open · queued"
 * and could not have diagnosed it; the only person who could was someone willing to read D1.
 *
 * A status code is not a reason. The vendor wrote a sentence; keeping it is the difference between
 * a block she can act on and a block she can only report. So every adapter throws through here.
 *
 * WHAT IS AND IS NOT KEPT. The body is read once, the vendor's own `error.message` is preferred
 * where the response is JSON (Anthropic, OpenAI, OpenRouter, Google and Perplexity all use that
 * shape), the text is flattened to one line and capped. Request bodies, headers and credentials are
 * never touched here — this reads the RESPONSE, which is the vendor talking to us.
 */

/** Long enough for a real vendor sentence, short enough that nothing can paste a page into a card. */
export const VENDOR_WORDS_MAX = 300;

/**
 * The error to throw for a non-2xx provider response: the status, and what the vendor said about it.
 *
 * Shaped `provider_http_<status>: <what they said>` so everything downstream that already matches on
 * `provider_http_` keeps working, and `shared/ai/laneFailure.ts` can lift the sentence back out.
 */
export async function providerHttpError(res: Response): Promise<Error> {
  const said = await vendorWords(res);
  return new Error(said ? `provider_http_${res.status}: ${said}` : `provider_http_${res.status}`);
}

/** The vendor's own sentence, or "" when the body is unreadable, empty or not text. */
export async function vendorWords(res: Response): Promise<string> {
  let raw = "";
  try {
    raw = await res.text();
  } catch {
    return "";
  }
  return readVendorWords(raw);
}

/** The pure half, so a test can feed it a real body without inventing a Response. */
export function readVendorWords(raw: string): string {
  const body = (raw ?? "").trim();
  if (!body) return "";
  let said = body;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; message?: unknown; detail?: unknown };
    const fromError = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : "";
    const candidate = fromError || (typeof parsed.message === "string" ? parsed.message : "") || (typeof parsed.detail === "string" ? parsed.detail : "");
    if (candidate.trim()) said = candidate;
  } catch {
    // Not JSON. An HTML error page is not a sentence anybody should read on a work card.
    if (/^\s*</.test(body)) return "";
  }
  return said.replace(/\s+/g, " ").trim().slice(0, VENDOR_WORDS_MAX);
}
