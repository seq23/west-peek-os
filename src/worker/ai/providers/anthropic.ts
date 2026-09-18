import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";

/**
 * Anthropic Messages API adapter — a DIRECT vendor lane, used only when OpenRouter cannot serve a
 * call (P16 failover).
 *
 * WHY THIS EXISTS RATHER THAN `httpExternal`. The generic adapter posts `{model, purpose, inputs}`
 * to `{baseUrl}/complete` and expects `{text, model, usage}` back. No vendor on earth speaks that
 * protocol — it is a shape invented for a fixture. Pointing it at api.anthropic.com produces a 404,
 * which meant the "fallback" for four of the owner's five vendors could not have completed a single
 * call. A fallback that cannot be reached is the defect this file closes.
 *
 * Wire contract implemented: POST /v1/messages, `x-api-key` + `anthropic-version` headers, a system
 * string and one user message, `content[0].text` out, `usage.input_tokens` / `usage.output_tokens`.
 * Anthropic does not return a price, so `costUsd` is 0 and runAi prices the run from the catalogue
 * rate — recorded as `cost_source: catalogue_rate`, never as a free run.
 *
 * Fail-closed: no key → `credential_missing:anthropic` before any network attempt.
 */
export interface AnthropicOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** Injectable fetch — tests always pass a stub. */
  fetchImpl?: typeof fetch;
  /** Overridable so a test can prove the timeout path without waiting a minute. */
  timeoutMs?: number;
}

export const ANTHROPIC_PROVIDER_KEY = "anthropic";

/** The dated API version header Anthropic requires on every request. */
const ANTHROPIC_VERSION = "2023-06-01";

export function createAnthropicAdapter(options: AnthropicOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error("credential_missing:anthropic");

      const model = req.model ?? options.model;
      const content: Array<Record<string, unknown>> = [{ type: "text", text: req.inputs.join("\n\n") }];
      for (const img of req.images ?? []) {
        content.push({ type: "image", source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 } });
      }
      for (const doc of req.documents ?? []) {
        content.push({ type: "document", source: { type: "base64", media_type: doc.mediaType, data: doc.dataBase64 } });
      }

      const res = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": options.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        // A request that never answers must become a failure the router can act on, not a hang.
        signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          max_tokens: 4096,
          system: `West Peek OS governed task: ${req.purpose}`,
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) throw await providerHttpError(res);

      const body = (await res.json()) as {
        model?: string;
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (body.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (!text) throw new Error("provider_malformed_response");

      return {
        text,
        model: body.model ?? model,
        usage: {
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
          // Anthropic bills out of band and reports no price on the response.
          costUsd: 0,
        },
      };
    },
  };
}
