import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";

/**
 * Perplexity adapter — the direct search lane, and the ONLY fallback search has.
 *
 * WHY THIS MATTERS MORE THAN THE OTHER DIRECT LANES. `perplexity/sonar` through OpenRouter is the
 * single ACTIVE search-capable model in the entire registry. Reasoning now has three roads out of
 * the building; search had none. One bad hour at OpenRouter and nothing in this firm could look
 * anything up.
 *
 * WHY IT IS NOT `openAiChat.ts`, WHICH IS THE OBVIOUS THING TO REUSE. Perplexity has moved Sonar
 * off chat-completions. Probed against the live key on 17 Sep 2026:
 *
 *   · `POST /chat/completions` → HTTP 403, `chat_completions_not_available`,
 *     "Sonar is now the Agent API. Use /v1/responses instead of /v1/sonar."
 *     A VALID key gets this. Wiring Perplexity like the other vendors would 403 in production and
 *     read as a bad credential, which is why 403 is classified REFUSED_BY_VENDOR and not
 *     AUTH_REJECTED (src/shared/ai/providerFailure.ts).
 *   · `POST /v1/responses` with an `input` field → a real completion.
 *   · The model id is NAMESPACED: `perplexity/sonar`. Bare `sonar`, `sonar-pro`,
 *     `sonar-reasoning`, `pplx-sonar` and `auto` all return HTTP 400 "model is not supported".
 *     The registry's own BENCH row said `sonar` and would have failed on exactly this; migration
 *     0177 corrects it.
 *
 * None of that is inferred from documentation. It is what the endpoint did when asked.
 */
export interface PerplexityOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const PERPLEXITY_PROVIDER_KEY = "perplexity";

/**
 * Pull the text out of a Responses-API payload.
 *
 * The shape nests: `output[]` holds items, a message item holds `content[]`, and a content part
 * holds `text`. `output_text` is the flattened convenience field when the vendor sends it. Both are
 * read, the convenience field first, so a shape change on either side does not silently produce an
 * empty answer that reads as a successful run.
 */
function extractText(body: unknown): string {
  const b = body as {
    output_text?: string | string[];
    output?: Array<{ content?: Array<{ text?: string; type?: string }> }>;
  };
  if (typeof b.output_text === "string" && b.output_text.length > 0) return b.output_text;
  if (Array.isArray(b.output_text)) return b.output_text.join("");
  const parts: string[] = [];
  for (const item of b.output ?? []) {
    for (const c of item.content ?? []) {
      if (typeof c.text === "string") parts.push(c.text);
    }
  }
  return parts.join("");
}

export function createPerplexityAdapter(options: PerplexityOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error("credential_missing:perplexity");

      // A namespaced id is required and a bare one is rejected, so an id arriving without its
      // namespace is repaired here rather than sent to be refused as HTTP 400.
      const asked = req.model ?? options.model;
      const model = asked.includes("/") ? asked : `perplexity/${asked}`;

      /*
       * REFUSED RATHER THAN DROPPED. The Responses call this adapter makes carries text only.
       * Silently discarding an image or a deck would produce a confident answer about something
       * the model never saw — and because this is the search lane, that answer would arrive
       * wearing citations. `provider_cannot_` is classified as a REQUEST failure, so the router
       * does not go looking for another vendor to make the same mistake.
       */
      if (req.images?.length) throw new Error("provider_cannot_see_images:perplexity");
      if (req.documents?.length) throw new Error("provider_cannot_read_documents:perplexity");

      const res = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          // `input`, not `messages` — the whole reason this adapter exists.
          input: [
            { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
            { role: "user", content: req.inputs.join("\n\n") },
          ],
        }),
      });
      if (!res.ok) throw await providerHttpError(res);

      const body = (await res.json()) as {
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number; prompt_tokens?: number; completion_tokens?: number };
      };
      const text = extractText(body);
      if (!text) throw new Error("provider_malformed_response");

      return {
        text,
        model: body.model ?? model,
        usage: {
          inputTokens: body.usage?.input_tokens ?? body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? body.usage?.completion_tokens ?? 0,
          // Perplexity bills out of band, and the per-search fee is in the catalogue rather than on
          // the response. runAi prices the run from the catalogue rate, which now includes it.
          costUsd: 0,
        },
      };
    },
  };
}
