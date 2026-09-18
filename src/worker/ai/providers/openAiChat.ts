import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "./outputCeiling";

/**
 * OpenAI chat-completions adapter — a DIRECT vendor lane for OpenAI, and for Perplexity, which
 * serves the identical shape at the same path (P16 failover).
 *
 * WHY NOT `httpExternal`. That adapter speaks `POST {baseUrl}/complete` with `{model, purpose,
 * inputs}`, a protocol invented for a fixture that no vendor implements. It was what "openai",
 * "anthropic", "google" and "perplexity" all resolved to, so the failover lane for four of the
 * owner's five vendors would have 404'd on its first real call. `httpExternal` stays for anything
 * genuinely speaking that shape; real vendors get real wire contracts.
 *
 * ONE ADAPTER, TWO VENDORS, and the vendor key is carried rather than assumed so a missing key
 * fails with the right name — `credential_missing:perplexity` is actionable, a generic one is not.
 */
export interface OpenAiChatOptions {
  /** Vendor key, used only for the fail-closed message. */
  providerKey: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const OPENAI_PROVIDER_KEY = "openai";
export const PERPLEXITY_PROVIDER_KEY = "perplexity";

export function createOpenAiChatAdapter(options: OpenAiChatOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error(`credential_missing:${options.providerKey}`);

      const model = req.model ?? options.model;
      const content = req.images?.length
        ? [
            { type: "text", text: req.inputs.join("\n\n") },
            ...req.images.map((img) => ({
              type: "image_url" as const,
              // Data URI, not a hosted link: a link would mean the vendor fetching back into us,
              // which is an inbound path this system does not have and does not want.
              image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
            })),
          ]
        : req.inputs.join("\n\n");

      /*
       * A DOCUMENT IS REFUSED RATHER THAN DROPPED. This wire shape has no file block, so silently
       * omitting the attachment would produce a confident answer about a deck the model never saw.
       * The router treats this as a capability refusal, not an outage, so it does not go looking
       * for another vendor to make the same mistake.
       */
      if (req.documents?.length) throw new Error(`provider_cannot_read_documents:${options.providerKey}`);

      const res = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
        body: JSON.stringify({
          model,
          // AN EXPLICIT CEILING, never the provider's own default. Leaving it unset is what
          // truncated every Workers AI run at 256 tokens and failed both partners' briefs on
          // 18 Sep 2026; a default that happens to be generous today is still a number this repo
          // does not control. See `outputCeiling.ts`.
          max_tokens: PROVIDER_MAX_OUTPUT_TOKENS,
          messages: [
            { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
            { role: "user", content },
          ],
        }),
      });
      if (!res.ok) throw await providerHttpError(res);

      const body = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) throw new Error("provider_malformed_response");

      return {
        text,
        model: body.model ?? model,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          // Neither vendor prices the response; runAi falls back to the catalogue rate.
          costUsd: 0,
        },
      };
    },
  };
}
