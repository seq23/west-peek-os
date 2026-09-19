import { providerHttpError } from "./httpError";
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "./outputCeiling";
import { finishReasonFrom } from "./finishReason";

/**
 * Google Gemini adapter — a DIRECT vendor lane, used only when OpenRouter cannot serve a call
 * (P16 failover).
 *
 * Gemini's shape is its own: the model goes in the PATH, the key goes in `x-goog-api-key`, the
 * prompt is `contents[].parts[]`, and the answer comes back at
 * `candidates[0].content.parts[].text`. None of that is what `httpExternal` sends, which is why
 * this file exists rather than another generic base URL.
 *
 * The credential is GEMINI_API_KEY and has nothing to do with GOOGLE_OAUTH_CLIENT_ID/SECRET, which
 * are the read-only calendar client.
 */
export interface GoogleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const GOOGLE_PROVIDER_KEY = "google";

export function createGoogleAdapter(options: GoogleOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.apiKey) throw new Error("credential_missing:google");

      const model = req.model ?? options.model;
      const parts: Array<Record<string, unknown>> = [{ text: req.inputs.join("\n\n") }];
      for (const blob of [...(req.images ?? []), ...(req.documents ?? [])]) {
        parts.push({ inline_data: { mime_type: blob.mediaType, data: blob.dataBase64 } });
      }

      const res = await doFetch(
        `${options.baseUrl.replace(/\/$/, "")}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": options.apiKey },
          // An explicit adapter override wins, so a test can still prove the timeout path in
        // milliseconds; production never sets one, so the per-call deadline governs there.
        signal: AbortSignal.timeout(options.timeoutMs ?? req.deadlineMs ?? PROVIDER_TIMEOUT_MS),
          body: JSON.stringify({
            // AN EXPLICIT CEILING, never the provider's own default. Leaving it unset is what
            // truncated every Workers AI run at 256 tokens and failed both partners' briefs on
            // 18 Sep 2026; a default that happens to be generous today is still a number this repo
            // does not control. See `outputCeiling.ts`.
            generationConfig: { maxOutputTokens: Math.min(req.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS, PROVIDER_MAX_OUTPUT_TOKENS) },
            system_instruction: { parts: [{ text: `West Peek OS governed task: ${req.purpose}` }] },
            contents: [{ role: "user", parts }],
          }),
        },
      );
      if (!res.ok) throw await providerHttpError(res);

      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text)
        .filter((t): t is string => typeof t === "string")
        .join("");
      if (!text) throw new Error("provider_malformed_response");

      return {
        text,
        // Gemini's finishReason: MAX_TOKENS is the cap; STOP is a stop.
        finishReason: finishReasonFrom(body.candidates?.[0]?.finishReason),
        model,
        usage: {
          inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
          outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
          costUsd: 0,
        },
      };
    },
  };
}
