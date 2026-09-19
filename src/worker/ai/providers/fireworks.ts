import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "./outputCeiling";
import { finishReasonFrom } from "./finishReason";

/**
 * Fireworks AI adapter (P16, GAP-03).
 *
 * Same fail-closed contract as every other external adapter: with no operator-supplied credential
 * it throws `credential_missing:fireworks` before attempting anything, so the governed pipeline
 * records a visible reason rather than a mysterious failure.
 *
 * Live behaviour is UNPROVEN — CREDENTIAL GATE. No Fireworks account, key, or contract exists in
 * this environment; the adapter implements the OpenAI-compatible completion shape Fireworks
 * documents and is exercised only against injected stubs.
 */
export interface FireworksOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export const FIREWORKS_PROVIDER_KEY = "fireworks";

export function createFireworksAdapter(options: FireworksOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) {
        throw new Error("credential_missing:fireworks");
      }
      const url = `${options.baseUrl.replace(/\/$/, "")}/inference/v1/chat/completions`;
      const res = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: req.model ?? options.model,
          // AN EXPLICIT CEILING, never the provider's own default. Leaving it unset is what
          // truncated every Workers AI run at 256 tokens and failed both partners' briefs on
          // 18 Sep 2026; a default that happens to be generous today is still a number this repo
          // does not control. See `outputCeiling.ts`.
          max_tokens: Math.min(req.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS, PROVIDER_MAX_OUTPUT_TOKENS),
          messages: [
            { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
            { role: "user", content: req.inputs.join("\n\n") },
          ],
        }),
      });
      if (!res.ok) throw await providerHttpError(res);

      const body = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string }; finish_reason?: string | null }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("provider_malformed_response");

      return {
        text,
        finishReason: finishReasonFrom(body.choices?.[0]?.finish_reason),
        model: body.model ?? req.model ?? options.model,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          // Fireworks bills per token from the account's price sheet and does not return a cost
          // on the response: actual cost is genuinely unknown here, so the estimate stands.
          costUsd: 0,
        },
      };
    },
  };
}
