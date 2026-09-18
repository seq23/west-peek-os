import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { providerHttpError } from "./httpError";

/**
 * Specialist vendor adapters — Harvey (legal) and Norm (compliance) (P23, GAP-15).
 *
 * WHAT THIS IS: the governed shape a specialist vendor would be called through, behind `run_ai()`
 * like every other provider. Same quarantine, same egress policy, same budget preflight.
 *
 * WHAT THIS IS NOT: a verified integration. This environment has no network access, no vendor
 * account, no credential, and no published API contract for either vendor. The wire format below
 * is the generic governed shape this repo already uses (`{ model, purpose, inputs }` →
 * `{ text, model, usage }`) and is NOT claimed to match a real vendor endpoint. Live behaviour is
 * UNPROVEN — VENDOR ACCESS GATE.
 *
 * The adapter fails closed twice over: no base URL configured, or no credential configured, and it
 * throws before any network attempt with a reason an operator can read.
 */
export interface SpecialistOptions {
  vendor: "harvey" | "norm";
  baseUrl: string | null;
  model: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}

export function createSpecialistAdapter(options: SpecialistOptions): ProviderAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      if (!options.baseUrl) {
        throw new Error(`vendor_endpoint_unknown:${options.vendor}`);
      }
      if (!options.apiKey) {
        throw new Error(`credential_missing:${options.vendor}`);
      }
      const res = await doFetch(`${options.baseUrl.replace(/\/$/, "")}/complete`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
        body: JSON.stringify({ model: req.model ?? options.model, purpose: req.purpose, inputs: req.inputs }),
      });
      if (!res.ok) throw await providerHttpError(res);
      const body = (await res.json()) as { text?: string; model?: string; usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number } };
      if (typeof body.text !== "string") throw new Error("provider_malformed_response");
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
