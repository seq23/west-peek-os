import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

/**
 * httpExternal — generic HTTPS adapter for an external model provider.
 *
 * This is the ONLY adapter that may make model API HTTP calls, and it is never
 * exercised against a real vendor in tests: tests inject `fetchImpl` pointed at
 * a stub/fixture. No live AI credentials exist in this repo or its environments
 * (UNPROVEN — CREDENTIAL GATE); `apiKey` is operator-supplied configuration that
 * does not exist yet, so a real call would fail closed at the provider.
 *
 * Expected upstream contract (normalized by this adapter):
 *   POST {baseUrl}/complete  { model, purpose, inputs }  →
 *   200 { text, model, usage?: { input_tokens, output_tokens, cost_usd? } }
 */
export interface HttpExternalOptions {
  baseUrl: string;
  model: string;
  /** Operator-supplied credential. Absent in all current environments. */
  apiKey?: string;
  /** Injectable fetch — tests ALWAYS pass a stub; production defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function createHttpExternalAdapter(options: HttpExternalOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const url = `${options.baseUrl.replace(/\/$/, "")}/complete`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.apiKey) headers["authorization"] = `Bearer ${options.apiKey}`;
      const res = await doFetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: req.model ?? options.model,
          purpose: req.purpose,
          inputs: req.inputs,
        }),
      });
      if (!res.ok) {
        throw new Error(`provider_http_${res.status}`);
      }
      const body = (await res.json()) as {
        text?: string;
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number };
      };
      if (typeof body.text !== "string") {
        throw new Error("provider_malformed_response");
      }
      return {
        text: body.text,
        model: body.model ?? req.model ?? options.model,
        usage: {
          inputTokens: body.usage?.input_tokens ?? 0,
          outputTokens: body.usage?.output_tokens ?? 0,
          costUsd: body.usage?.cost_usd ?? 0,
        },
      };
    },
  };
}
