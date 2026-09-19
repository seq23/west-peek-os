import type { ProviderResponse } from "./types";

/**
 * ONE MAPPING FROM EVERY VENDOR'S "WHY IT STOPPED" TO THE THREE WORDS THE ROUTER ACTS ON.
 *
 * OpenAI-shaped lanes (OpenRouter, Fireworks, Workers AI chat, the generic chat adapter) say
 * `finish_reason: "length"`; Anthropic says `stop_reason: "max_tokens"`; Gemini says
 * `finishReason: "MAX_TOKENS"`. All of them mean the same thing — the reply hit its output cap — and
 * the router treats that as a lane that did not serve, never as a completion. Anything that is not
 * a recognised cap or a recognised stop is "other" (content filter, tool call, recitation), which the
 * router leaves alone: it is not truncation and it is not for the router to guess.
 */
export function finishReasonFrom(vendor: string | null | undefined): ProviderResponse["finishReason"] {
  if (vendor === null || vendor === undefined || vendor === "") return undefined;
  const v = String(vendor).toLowerCase();
  if (v === "length" || v === "max_tokens" || v === "max_output_tokens") return "length";
  if (v === "stop" || v === "end_turn" || v === "stop_sequence" || v === "eos" || v === "completed") return "stop";
  return "other";
}
