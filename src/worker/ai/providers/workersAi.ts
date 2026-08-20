import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";

/**
 * Cloudflare Workers AI — the cheap tier, and the only one that is ever actually free.
 *
 * WHY THIS EXISTS. The operator asked whether there is a lever that gets the firm close to $0, and
 * whether any open model here is free. The honest answer before this file was no: the cheapest
 * thing registered was gemini-1.5-flash at $0.075/$0.30 per million tokens, and CHEAPO mode had
 * nowhere genuinely cheap to route to. Workers AI runs open-weight models — Llama, Qwen, Granite,
 * Gemma — on the platform the firm already pays for, with 10,000 neurons a day included at no cost.
 * For the small, frequent, unglamorous work that makes up most runs, that is free.
 *
 * IT IS A BINDING, NOT A FETCH. `env.AI` is granted to the Worker by the platform, so there is no
 * hostname, no bearer token, no third-party credential and no egress-allowlist entry — the same
 * reason the Cloudflare email transport needed none. That is a real security property and not a
 * convenience: nothing that has not been given the binding can reach it.
 *
 * WHAT IT IS NOT FOR. The morning brief is pinned to a frontier model because the cheap tier
 * produced "the 30-year U.S. tax at 19 year high" and shipped it as fact. This adapter exists to
 * make the cheap end genuinely cheap, not to quietly take over work that was pinned for a reason —
 * see the spend-posture handling in runAi for how the two are kept apart.
 */

/** The slice of the Workers AI binding this uses. Narrow on purpose — it is also the test seam. */
export interface WorkersAiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<{ response?: string; usage?: { prompt_tokens?: number; completion_tokens?: number } }>;
}

export interface WorkersAiOptions {
  binding: WorkersAiBinding;
  /** Fallback when the routing layer names no model. */
  model: string;
}

export function createWorkersAiAdapter(options: WorkersAiOptions): ProviderAdapter {
  return {
    async complete(req: ProviderRequest): Promise<ProviderResponse> {
      const model = req.model ?? options.model;

      /*
       * VISION IS NOT WIRED THROUGH HERE, and refusing is the only honest answer.
       *
       * Workers AI has exactly one vision model and its message shape differs from the text one.
       * An adapter that quietly dropped the images would hand a design review to a model that
       * never saw the page — the precise failure the vision guard in runAi exists to prevent. So
       * this refuses, loudly, and the run fails rather than fabricating.
       */
      if (req.images?.length) {
        throw new Error("workers_ai_no_vision");
      }

      const result = await options.binding.run(model, {
        messages: [
          { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
          { role: "user", content: req.inputs.join("\n\n") },
        ],
      });

      const text = result.response;
      if (typeof text !== "string" || text.length === 0) throw new Error("provider_malformed_response");

      return {
        text,
        model,
        usage: {
          inputTokens: Number(result.usage?.prompt_tokens ?? 0),
          outputTokens: Number(result.usage?.completion_tokens ?? 0),
          // The binding does not report money. Cost is priced locally from the catalogue rate,
          // which runAi already does whenever a provider returns zero — see the pricing note there.
          costUsd: 0,
        },
      };
    },
  };
}
