import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

/**
 * OpenRouter adapter (P16, GAP-03).
 *
 * IMPORTANT SEPARATION (task §12): this is the WEST PEEK PRODUCT's OpenRouter provider adapter.
 * It has nothing to do with any OpenRouter usage by the tooling that builds this repository. The
 * product's credential is operator-supplied through the encrypted vault and does not exist in any
 * current environment.
 *
 * Fail-closed contract:
 * - No API key configured → throws `credential_missing:openrouter` BEFORE any network attempt, so
 *   the run lands BLOCKED_DEFERRED with a visible, honest reason instead of a silent failure.
 * - Tests inject `fetchImpl`. This adapter has never been run against api.openrouter.ai and its
 *   live behaviour is UNPROVEN — CREDENTIAL GATE.
 *
 * Wire contract implemented: the OpenAI-compatible chat-completions shape OpenRouter exposes.
 */
export interface OpenRouterOptions {
  baseUrl: string;
  model: string;
  /** Operator-supplied credential from the vault. Absent in every current environment. */
  apiKey?: string;
  /** Optional attribution headers OpenRouter documents for app identification. */
  referer?: string;
  title?: string;
  fetchImpl?: typeof fetch;
}

export const OPENROUTER_PROVIDER_KEY = "openrouter";

export function createOpenRouterAdapter(options: OpenRouterOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) {
        throw new Error("credential_missing:openrouter");
      }
      const url = `${options.baseUrl.replace(/\/$/, "")}/api/v1/chat/completions`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      };
      if (options.referer) headers["http-referer"] = options.referer;
      if (options.title) headers["x-title"] = options.title;

      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: req.model ?? options.model,
          messages: [
            { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
            { role: "user", content: req.inputs.join("\n\n") },
          ],
        }),
      });
      if (!res.ok) throw new Error(`provider_http_${res.status}`);

      const body = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("provider_malformed_response");

      return {
        text,
        model: body.model ?? req.model ?? options.model,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          // OpenRouter reports a total cost on the usage object when it knows one; absent means
          // unknown, which the run records as 0 actual and keeps the estimate visible.
          costUsd: body.usage?.total_cost ?? 0,
        },
      };
    },
  };
}
