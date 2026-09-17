import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_TIMEOUT_MS } from "./timeout";

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
          signal: AbortSignal.timeout(options.timeoutMs ?? PROVIDER_TIMEOUT_MS),
          body: JSON.stringify({
            system_instruction: { parts: [{ text: `West Peek OS governed task: ${req.purpose}` }] },
            contents: [{ role: "user", parts }],
          }),
        },
      );
      if (!res.ok) throw new Error(`provider_http_${res.status}`);

      const body = (await res.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };
      const text = (body.candidates?.[0]?.content?.parts ?? [])
        .map((p) => p.text)
        .filter((t): t is string => typeof t === "string")
        .join("");
      if (!text) throw new Error("provider_malformed_response");

      return {
        text,
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
