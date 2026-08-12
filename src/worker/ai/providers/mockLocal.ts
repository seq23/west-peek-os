import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

/**
 * mockLocal — the deterministic local adapter. This is the manual/no-provider
 * fallback that ALWAYS works offline: no network, no credentials, no cost.
 * It backs the LOCAL and LOCKDOWN privacy paths (D8) so the firm can still do
 * local AI-assisted work when external providers are disallowed or unavailable.
 *
 * Output is a pure function of (purpose, inputs) — same input, same output —
 * which keeps tests and offline drills reproducible.
 */
async function digestHex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const MOCK_LOCAL_MODEL = "mock-local";

export function createMockLocalAdapter(): ProviderAdapter {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const joined = req.inputs.join("\n");
      const hash = (await digestHex(`${req.purpose}\n${joined}`)).slice(0, 12);
      const inputTokens = Math.max(1, Math.ceil(joined.length / 4));
      const outputText =
        `[mock-local ${hash}] Deterministic local draft for purpose "${req.purpose}". ` +
        `Received ${req.inputs.length} input(s), ${joined.length} chars. ` +
        `No data left this system; review and accept before governed use.`;
      return {
        text: outputText,
        model: MOCK_LOCAL_MODEL,
        usage: {
          inputTokens,
          outputTokens: Math.max(1, Math.ceil(outputText.length / 4)),
          costUsd: 0,
        },
      };
    },
  };
}
