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
            {
              role: "user",
              // WITH IMAGES OR A DOCUMENT, the content becomes the multimodal array OpenRouter
              // expects; without them it stays a plain string, which every model accepts and which
              // keeps the overwhelming majority of runs byte-identical to what they were before
              // vision existed.
              //
              // A PDF is a `file` block and NOT an image block, and that is not cosmetic: sent as an
              // image, a twenty-page deck arrives as one unreadable thumbnail.
              content:
                req.images?.length || req.documents?.length
                  ? [
                      { type: "text", text: req.inputs.join("\n\n") },
                      ...(req.images ?? []).map((img) => ({
                        type: "image_url" as const,
                        // Data URI rather than a link. A hosted URL would mean the provider reaching
                        // back into us, which is an inbound path this system does not have.
                        image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
                      })),
                      ...(req.documents ?? []).map((doc) => ({
                        type: "file" as const,
                        file: {
                          filename: doc.label,
                          file_data: `data:${doc.mediaType};base64,${doc.dataBase64}`,
                        },
                      })),
                    ]
                  : req.inputs.join("\n\n"),
            },
          ],
          // ASK FOR THE BILL. Without this OpenRouter returns token counts and no cost, so every
          // run recorded cost_usd: 0 — which meant "spent today" was always zero and the firm's
          // daily cap could never fire. A cap that cannot fire is not a cap.
          usage: { include: true },
          /*
           * How a PDF gets read.
           *
           * `native` uses the model's own file support and is charged as input tokens — no second
           * vendor, no per-page fee, and nothing leaves for anywhere this system has not already
           * accounted for. The alternative engines are an OCR service billed separately, which
           * would put spend outside the budget ceiling this boundary exists to enforce.
           */
          ...(req.documents?.length
            ? { plugins: [{ id: "file-parser", pdf: { engine: "native" } }] }
            : {}),
        }),
      });
      if (!res.ok) throw new Error(`provider_http_${res.status}`);

      const body = (await res.json()) as {
        model?: string;
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number; cost?: number };
      };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== "string") throw new Error("provider_malformed_response");

      return {
        text,
        model: body.model ?? req.model ?? options.model,
        usage: {
          inputTokens: body.usage?.prompt_tokens ?? 0,
          outputTokens: body.usage?.completion_tokens ?? 0,
          // Requested above via usage.include. OpenRouter has used both spellings; take either.
          // Still 0 if the provider declines to say — runAi then prices it from the catalogue
          // rather than recording a free run, because a run is never actually free.
          costUsd: body.usage?.total_cost ?? body.usage?.cost ?? 0,
        },
      };
    },
  };
}
