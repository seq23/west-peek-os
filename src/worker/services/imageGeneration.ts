import { z } from "zod";
import type { RouteContext } from "../router";
import { json } from "../router";
import { appendEvent } from "../events";
import { actorFromIdentity, authorize } from "./authorize";
import { uploadDocument } from "./documents";
import { generateImage, isImageGenerationEnabled } from "../effects/runwareClient";

/**
 * Making a picture, on request.
 *
 * WHY IT IS FILED RATHER THAN RETURNED AND FORGOTTEN. An image that only exists in the response to
 * the request that made it is an image nobody can find again, and it has already cost money. Every
 * generation becomes a document, which means it is in Documents, versioned, hashed, and reachable
 * by anyone in the firm — the same place every other artifact lives.
 *
 * WHY IT IS NOT AN APPROVAL-GATED EXTERNAL EFFECT. Nothing leaves the firm and nothing reaches
 * anybody: a prompt goes out, an image comes back, and it lands in the firm's own store. That is
 * the same shape as a model call, not the same shape as sending an email. If a generated image is
 * later PUBLISHED, that publication is the external effect and is approved on its own terms.
 *
 * THE PROMPT IS RECORDED, on the event and in the document title. Whoever asked for a picture is
 * answerable for what they asked for, and that is only checkable if the ask is written down.
 */

const generateSchema = z.object({
  prompt: z.string().trim().min(3).max(2_000),
  /** What it is for, in the operator's words. Becomes the document title. */
  title: z.string().trim().min(1).max(160),
  width: z.number().int().min(256).max(2048).optional(),
  height: z.number().int().min(256).max(2048).optional(),
});

export async function handleGenerateImage(ctx: RouteContext): Promise<Response> {
  const parsed = generateSchema.safeParse(await ctx.request.json().catch(() => null));
  if (!parsed.success) return json({ error: "invalid_input", issues: parsed.error.issues }, { status: 400 });

  if (!isImageGenerationEnabled(ctx.env)) {
    return json(
      { error: "not_configured", detail: "Image generation is switched off: no Runware credential is bound." },
      { status: 503 },
    );
  }

  const actor = actorFromIdentity(ctx.identity!);
  const authz = await authorize(ctx.env, actor, "image.generate", { objectType: "document" });
  if (authz.decision !== "ALLOW") return json({ error: "forbidden", detail: authz.reason }, { status: 403 });

  const input = parsed.data;
  const result = await generateImage(ctx.env, {
    prompt: input.prompt,
    width: input.width,
    height: input.height,
    purpose: input.title,
  });

  if (!result.ok || !result.bytes) {
    return json({ error: "generation_failed", detail: result.detail }, { status: 502 });
  }

  // Straight into Documents. An image nobody can find again has cost money for nothing.
  let binary = "";
  for (let i = 0; i < result.bytes.length; i += 8192) {
    binary += String.fromCharCode(...result.bytes.subarray(i, i + 8192));
  }

  const { document } = await uploadDocument(ctx.env, actor, {
    title: input.title,
    doc_type: "IMAGE",
    privacy_label: "INTERNAL",
    content_type: result.contentType ?? "image/jpeg",
    content_base64: btoa(binary),
  });

  /*
   * BOOK THE MONEY.
   *
   * Firm spend is summed from `ai_run`, and this call deliberately does not go through it — so
   * without this row the total quietly under-reports by whatever pictures cost, which is worse than
   * a total that is obviously missing something, because it gets believed.
   *
   * The vendor's own figure or nothing. There is no local price list, because a guessed rate that
   * drifts from the real bill turns a spend page into fiction; an unpriced call is counted as an
   * image and not as money, and the cost centre says how many of those there were.
   */
  await ctx.env.WP_OS_DB.prepare(
    `INSERT INTO vendor_spend (id, vendor, purpose, cost_usd, units, unit_kind, object_type, object_id, requested_by)
     VALUES (?1, 'runware', ?2, ?3, 1, 'image', 'document', ?4, ?5)`,
  )
    .bind(`vsp_${crypto.randomUUID()}`, input.title.slice(0, 200), result.costUsd, document.id, ctx.identity!.id)
    .run();

  await appendEvent(ctx.env, {
    eventType: "image.generated",
    actorType: "firm_user",
    actorId: ctx.identity!.id,
    objectType: "document",
    objectId: document.id,
    payload: { prompt: input.prompt.slice(0, 500), bytes: result.bytes.byteLength, cost_usd: result.costUsd },
  });

  return json({ document_id: document.id, title: document.title, bytes: result.bytes.byteLength }, { status: 201 });
}
