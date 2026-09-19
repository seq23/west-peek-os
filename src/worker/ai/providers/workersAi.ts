import type { ProviderAdapter, ProviderRequest, ProviderResponse } from "./types";
import { PROVIDER_MAX_OUTPUT_TOKENS } from "./outputCeiling";
import { finishReasonFrom } from "./finishReason";

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

/**
 * The slice of the Workers AI binding this uses. Narrow on purpose — it is also the test seam.
 *
 * TWO SHAPES, NOT ONE, and assuming one is what broke the cheap tier. Workers AI's older text
 * models answer with `{ response }`. The newer ones answer in the OpenAI chat-completion shape —
 * `{ choices: [{ message: { content } }] }` — and carry no `response` field at all. Of the three
 * models this firm registered in `0081_workers_ai_cheap_tier.sql`, granite-4.0-h-micro is
 * new-shape-only and qwen3-30b returns both. Reading only `response` therefore failed granite
 * 100% of the time, and because routing picks the CHEAPEST capable model and granite is the
 * cheapest, every run that reached this provider failed. Two runs, two failures, zero successes,
 * from the day the tier was added until this was fixed.
 */
export interface WorkersAiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<{
    response?: string;
    choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  }>;
}

/**
 * The generated text, from whichever shape the model answered in.
 *
 * Returns null when neither shape carried text, which the caller reports differently from text
 * that arrived and was empty. That distinction is not pedantry: "the field is missing" and "the
 * model said nothing" have different causes and different fixes, and collapsing them into one
 * message is what made the original failure take a production database query to diagnose.
 */
function finishReasonOf(result: {
  choices?: Array<{ finish_reason?: string | null } | null> | null;
}): string | null | undefined {
  return result?.choices?.[0]?.finish_reason;
}

function generatedText(result: {
  response?: string;
  choices?: Array<{ message?: { content?: string | null } | null } | null> | null;
}): string | null {
  if (typeof result?.response === "string") return result.response;
  const content = result?.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : null;
}

/**
 * Workers AI models that can actually see.
 *
 * A allowlist rather than a capability flag on the request, because the adapter is handed a model
 * NAME and nothing else. Kept here beside the code that depends on it so the two cannot drift:
 * adding a vision model to the catalogue without adding it here fails closed with a refusal, which
 * is the safe direction. `@cf/meta/llama-3.2-11b-vision-instruct` required a one-time
 * acceptance of Meta's community licence, submitted by a Managing Partner on 21 Aug 2026; before that
 * every call returned error 5016.
 *
 * `moondream3.1-9B-A2B` is the account's other vision model and is deliberately NOT here. It needs
 * no licence, but it answers this content-array shape with an empty object and its own form wants
 * raw image bytes rather than a data URI — a third shape, which is more than a second vision option
 * is worth today. Adding it to the catalogue without adding it here refuses images rather than
 * sending them somewhere that returns nothing, which is the point of the list.
 */
/**
 * AND THE PIN IS NOT ABSOLUTE. The header above says the morning brief is pinned to a frontier
 * model and that this adapter is not meant to take over work pinned for a reason. True as intent,
 * false as a guarantee: when every frontier lane fails the router fails over here rather than
 * stopping, which is correct, and is what happened to both partners' briefs on 18 Sep 2026. So
 * this adapter must be able to carry a job it was never first choice for — which is exactly why
 * the output ceiling it now sends is not optional.
 */

const VISION_MODELS = new Set(["@cf/meta/llama-3.2-11b-vision-instruct"]);

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
       * VISION, AND WHY THIS REFUSES PER MODEL RATHER THAN OUTRIGHT.
       *
       * This used to refuse every image unconditionally, on the grounds that the vision message
       * shape differs from the text one and an adapter that quietly dropped the images would hand
       * a design review to a model that never saw the page. The reasoning was right; the blanket
       * refusal was broader than it needed to be. Workers AI's vision model takes the same
       * multimodal content array OpenRouter does — text part first, then image parts as data URIs —
       * so the shape is supported here now, mirroring `openRouter.ts` deliberately.
       *
       * The refusal survives for every OTHER model, because most Workers AI models cannot see and
       * handing them an image array produces a confident answer about nothing. Dropping images
       * silently is the failure being guarded against, and it is still guarded against — the guard
       * is now "this model cannot see" instead of "this provider cannot see".
       */
      // Refused rather than dropped. Silently ignoring an attachment produces a confident answer
      // about a file the model never saw, which is worse than an error. runAi's DOCUMENT_CAPABLE
      // gate should stop this reaching here at all — this is the second lock on the same door.
      if (req.documents?.length) {
        throw new Error(`workers_ai_cannot_read_documents:${model}`);
      }
      if (req.images?.length && !VISION_MODELS.has(model)) {
        throw new Error("workers_ai_no_vision");
      }

      const result = await options.binding.run(model, {
        /*
         * THE CEILING IS SENT, ALWAYS. Workers AI's own default is 256 output tokens, and sending
         * no `max_tokens` meant the platform applied it to every run that ever reached this
         * adapter. That is not a small reply: it is a reply cut off mid-word, which downstream
         * cannot tell from a model that writes badly.
         *
         * On 18 Sep 2026 the daily brief failed over to this adapter and returned exactly 256
         * output tokens eight times running. Its quality gate rejected all eight for missing
         * citations and missing sections — correctly, since the model never got to write them —
         * and both partners' morning brief was an empty card. The gate was right, the model was
         * adequate, and the 3% of the reply that fitted was the whole bug.
         */
        max_tokens: Math.min(req.maxOutputTokens ?? PROVIDER_MAX_OUTPUT_TOKENS, PROVIDER_MAX_OUTPUT_TOKENS),
        messages: [
          { role: "system", content: `West Peek OS governed task: ${req.purpose}` },
          {
            role: "user",
            // Without images this stays a plain string, which every model accepts and which keeps
            // the overwhelming majority of runs byte-identical to what they were before.
            content: req.images?.length
              ? [
                  { type: "text", text: req.inputs.join("\n\n") },
                  ...req.images.map((img) => ({
                    type: "image_url" as const,
                    // Data URI, never a hosted link: Cloudflare rejects HTTP URLs here, and a link
                    // would mean the provider reaching back into us — an inbound path this system
                    // does not have.
                    image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
                  })),
                ]
              : req.inputs.join("\n\n"),
          },
        ],
      });

      const text = generatedText(result);
      if (text === null) throw new Error("provider_malformed_response");
      if (text.length === 0) throw new Error("provider_empty_response");

      return {
        text,
        // The binding's chat shape carries finish_reason; its plain-text shape carries nothing, and
        // the router then compares the tokens used against the cap this adapter sent.
        finishReason: finishReasonFrom(finishReasonOf(result as { choices?: Array<{ finish_reason?: string | null } | null> | null })),
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
