import type { Env } from "../env";

/**
 * Image generation, through Runware.
 *
 * WHY THIS IS AN EFFECT AND NOT A MODEL CALL. Everything that reasons goes through `runAi` and its
 * privacy, cost and egress pipeline. This does not reason — it turns a prompt into a picture — and
 * routing it through the model boundary would mean pretending an image generator is a language
 * model, which would corrupt the one clean abstraction this codebase has. It is an outbound effect,
 * so it lives here with the other outbound effects and is on the egress allowlist by name.
 *
 * WHAT IT IS FOR. An employee that needs a picture: an image for a Room, a diagram for a memo, a
 * placeholder portrait, a visual for something the firm is publishing. The operator asked for it to
 * be available "whenever we want from some employee", which is the right framing — it is a tool a
 * named person uses, not a feature of the interface.
 *
 * INERT WITHOUT THE KEY, like every other transport here. No key, no request, and the caller is
 * told plainly rather than getting a silent empty result.
 *
 * THE PROMPT IS THE ONLY THING THAT LEAVES. No firm records, no partner names, no deal context —
 * whoever calls this is responsible for what is in the prompt, and the prompt is recorded so that
 * responsibility is checkable afterwards.
 */

const RUNWARE_URL = "https://api.runware.ai/v1";
/** Anything slower than this is not going to arrive inside a Worker request. */
const TIMEOUT_MS = 60_000;
/** A generated image larger than this is not something this system should be holding. */
const MAX_BYTES = 8_000_000;

export interface ImageRequest {
  prompt: string;
  /** Defaults to a square, which is what most uses here want. */
  width?: number;
  height?: number;
  /** What this is for, recorded alongside the result. */
  purpose: string;
}

export interface ImageResult {
  ok: boolean;
  /** JPEG/PNG bytes when it worked. */
  bytes: Uint8Array | null;
  contentType: string | null;
  /**
   * What the vendor says it cost, when it says. NULL means unknown and is stored as unknown —
   * never as zero, because a spend page that treats unpriced calls as free is fiction.
   */
  costUsd: number | null;
  detail: string;
}

export function isImageGenerationEnabled(env: Env): boolean {
  return typeof env.RUNWARE_API_KEY === "string" && env.RUNWARE_API_KEY.length > 0;
}

/**
 * Runware only accepts dimensions that are multiples of 64, within its own bounds. Snapping here
 * rather than passing a caller's number straight through means a slightly odd size renders instead
 * of the whole request being refused for a reason nobody would guess from the error.
 */
function snap(n: number | undefined, fallback: number): number {
  const v = Number.isFinite(n) ? Number(n) : fallback;
  const clamped = Math.min(2048, Math.max(256, v));
  return Math.round(clamped / 64) * 64;
}

export async function generateImage(env: Env, req: ImageRequest): Promise<ImageResult> {
  if (!isImageGenerationEnabled(env)) {
    return { ok: false, bytes: null, contentType: null, costUsd: null, detail: "Image generation is not configured: RUNWARE_API_KEY is not set." };
  }
  const prompt = req.prompt.trim();
  if (prompt.length < 3) {
    return { ok: false, bytes: null, contentType: null, costUsd: null, detail: "The prompt is empty." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    // Runware takes a task array and answers with one entry per task. One task per call here:
    // batching would make partial failure a case every caller has to handle for no benefit.
    const res = await fetch(RUNWARE_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.RUNWARE_API_KEY}`,
      },
      signal: controller.signal,
      body: JSON.stringify([
        {
          taskType: "imageInference",
          taskUUID: crypto.randomUUID(),
          positivePrompt: prompt.slice(0, 2_000),
          width: snap(req.width, 1024),
          height: snap(req.height, 1024),
          model: "runware:100@1",
          numberResults: 1,
          // The bytes come back in the response rather than as a hosted URL: a URL would mean a
          // second fetch to a host nobody has reviewed, and an image that expires out from under us.
          outputType: "base64Data",
          outputFormat: "JPEG",
        },
      ]),
    });

    if (!res.ok) {
      return { ok: false, bytes: null, contentType: null, costUsd: null, detail: `Runware refused the request (HTTP ${res.status}).` };
    }

    const body = (await res.json()) as {
      data?: Array<{ imageBase64Data?: string; cost?: number }>;
      errors?: Array<{ message?: string }>;
    };
    const failure = body.errors?.[0]?.message;
    if (failure) return { ok: false, bytes: null, contentType: null, costUsd: null, detail: `Runware: ${failure}` };

    const b64 = body.data?.[0]?.imageBase64Data;
    if (typeof b64 !== "string" || b64.length === 0) {
      return { ok: false, bytes: null, contentType: null, costUsd: null, detail: "Runware answered without an image." };
    }

    const binary = atob(b64);
    if (binary.length > MAX_BYTES) {
      return { ok: false, bytes: null, contentType: null, costUsd: null, detail: "The generated image is larger than this system will store." };
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

    const reported = body.data?.[0]?.cost;
    return {
      ok: true,
      bytes,
      contentType: "image/jpeg",
      costUsd: typeof reported === "number" && Number.isFinite(reported) ? reported : null,
      detail: "ok",
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      bytes: null,
      contentType: null,
      costUsd: null,
      detail: aborted ? "Runware did not answer in time." : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}
