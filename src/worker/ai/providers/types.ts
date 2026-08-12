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

export interface ProviderRequest {
  purpose: string;
  inputs: string[];
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
