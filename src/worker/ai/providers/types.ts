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

/** A document handed to a provider. Kept apart from an image: the wire formats differ. */
export interface ProviderDocument {
  mediaType: string;
  dataBase64: string;
  label: string;
}

export interface ProviderRequest {
  purpose: string;
  inputs: string[];
  /** Present only for vision work. An adapter that cannot see must refuse rather than ignore them. */
  images?: ProviderImage[];
  /**
   * Present only for document work — a deck, a term sheet. An adapter that cannot read one must
   * refuse rather than ignore it: silently dropping the attachment produces a confident answer
   * about a file the model never saw, which is worse than an error.
   */
  documents?: ProviderDocument[];
  model: string | null;
  capabilityRequirement?: string;
  /**
   * THIS CALLER'S OWN ASK, finally reaching the wire.
   *
   * `expectedOutputTokens` has always existed — it is what prices the run — and it stopped at the
   * cost estimate. Every adapter therefore sent the shared ceiling, so a 300-token classification
   * and an 8000-token brief were indistinguishable to the provider and to the clock. Absent, an
   * adapter falls back to `PROVIDER_MAX_OUTPUT_TOKENS` exactly as before, so nothing truncates: the
   * shared ceiling sits above every caller's ask in this repo.
   */
  maxOutputTokens?: number;
  /**
   * How long THIS attempt may take, from `chainBudget.ts`. Sized to the work asked for and shortened
   * to whatever is left of the run's total budget for finding a lane that answers. Absent, an
   * adapter falls back to `PROVIDER_TIMEOUT_MS`, which stays the absolute ceiling either way.
   */
  deadlineMs?: number;
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
