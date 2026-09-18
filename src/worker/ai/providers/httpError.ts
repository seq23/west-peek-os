/**
 * ONE PLACE THAT TURNS A VENDOR'S REFUSAL INTO A ROUTER-READABLE REASON.
 *
 * Every adapter in this directory used to throw `provider_http_${res.status}` and drop the body on
 * the floor. That is enough to classify 401, 429 and 5xx — and it is exactly NOT enough for the
 * failure that stopped a partner's work on 17 Sep 2026:
 *
 *     HTTP 400  {"type":"error","error":{"type":"invalid_request_error",
 *                "message":"Your credit balance is too low to access the Anthropic API."}}
 *
 * A 400 normally means WE sent something malformed, and deferring is the right answer for that. But
 * that body does not describe our request at all; it describes a vendor that cannot serve ANYONE on
 * this account. The status code alone cannot tell the two apart, so the status code alone is no
 * longer all the router gets: the vendor's own words come with it, and
 * `src/shared/ai/providerFailure.ts` decides on the words, not on the number.
 *
 * WHAT IS CARRIED, AND WHAT IS NOT. A short, single-line, credential-scrubbed excerpt — enough to
 * match a billing sentence and enough for a human reading `ai_run.failure_reason` to know what the
 * vendor said. Never the whole body: an error body can echo the request back, and the request can
 * contain a partner's words.
 */
import { redactInputs } from "../scrub";

/** How much of the vendor's sentence is kept. A billing message is well inside this. */
export const VENDOR_DETAIL_MAX_CHARS = 240;

/**
 * Pull the human-readable sentence out of an error body, whatever the vendor wrapped it in.
 *
 * Anthropic: `{error:{message}}`. OpenAI/OpenRouter: `{error:{message,code,type}}`. Google:
 * `{error:{message,status}}`. Perplexity: `{error:{message}}` or a bare string. Anything else falls
 * back to the raw text, which is why the truncation and the scrub are unconditional.
 */
export function vendorMessageFrom(bodyText: string): string {
  let message = bodyText;
  try {
    const parsed = JSON.parse(bodyText) as unknown;
    const err = (parsed as { error?: unknown })?.error;
    const parts: string[] = [];
    if (typeof err === "string") {
      parts.push(err);
    } else if (err && typeof err === "object") {
      const e = err as { message?: unknown; code?: unknown; type?: unknown; status?: unknown };
      for (const v of [e.message, e.code, e.type, e.status]) if (typeof v === "string" && v) parts.push(v);
    }
    const top = (parsed as { message?: unknown; detail?: unknown })?.message ?? (parsed as { detail?: unknown })?.detail;
    if (typeof top === "string" && top) parts.push(top);
    if (parts.length > 0) message = parts.join(" ");
  } catch {
    // Not JSON. The raw text is the message; it is scrubbed and truncated like everything else.
  }
  // One line, no runs of whitespace: this string is stored in `ai_run.failure_reason` and read back
  // on a page, and a pasted stack trace there helps nobody.
  const flattened = message.replace(/\s+/g, " ").trim();
  // The same credential scrub the inbound path uses. A vendor that echoes an Authorization header
  // back in its error body must not get it written into our audit trail.
  const scrubbed = redactInputs([flattened]).inputs[0] ?? "";
  return scrubbed.length > VENDOR_DETAIL_MAX_CHARS ? `${scrubbed.slice(0, VENDOR_DETAIL_MAX_CHARS)}…` : scrubbed;
}

/**
 * The error an adapter throws for a non-2xx response.
 *
 * Shape: `provider_http_<status>` when the vendor said nothing legible, `provider_http_<status>:
 * <vendor's words>` when it did. The suffix is optional precisely so that every existing classifier
 * assertion on the bare form still holds — adding words may make a failure MORE recognisable, never
 * less.
 *
 * NEVER THROWS OF ITS OWN ACCORD. A body that cannot be read (already consumed, a socket that died
 * mid-error) degrades to the bare status, which is exactly today's behaviour.
 */
export async function providerHttpError(res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = vendorMessageFrom(await res.text());
  } catch {
    detail = "";
  }
  return new Error(detail ? `provider_http_${res.status}:${detail}` : `provider_http_${res.status}`);
}
