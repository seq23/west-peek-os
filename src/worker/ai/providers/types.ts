/**
 * Provider adapter contract (D9: providers are configuration, not architecture).
 *
 * This directory is the ONLY place in the repo where provider SDKs, model API
 * hostnames, or bearer-token model calls may exist — enforced by
 * scripts/validate/no-direct-provider-calls.mjs (`npm run validate:ai-boundary`).
 *
 * An adapter's existence is NOT a verified vendor: live provider use is
 * UNPROVEN — CREDENTIAL GATE. Tests point adapters at fixtures/stubs, never
 * a real vendor.
 */

/**
 * An image sent to a model.
 *
 * Base64 rather than a URL on purpose: a URL would mean the provider fetching from us, which is an
 * inbound path this system does not have and does not want. The bytes go with the request, through
 * the same adapter, subject to the same egress decision.
 */
export interface ProviderImage {
  /** image/jpeg or image/png. */
  mediaType: string;
  dataBase64: string;
  /** What this is a picture of, so the model is not guessing. */
  label: string;
}

export interface ProviderRequest {
  purpose: string;
  inputs: string[];
  /** Present only for vision work. An adapter that cannot see must refuse rather than ignore them. */
  images?: ProviderImage[];
  model: string | null;
  capabilityRequirement?: string;
}

export interface ProviderUsage {
  inputTokens: number;
  outputTokens: number;
  /** Actual billed cost in USD, when known (0 for the local adapter). */
  costUsd: number;
}

export interface ProviderResponse {
  text: string;
  model: string;
  usage: ProviderUsage;
}

export interface ProviderAdapter {
  complete(req: ProviderRequest): Promise<ProviderResponse>;
}
