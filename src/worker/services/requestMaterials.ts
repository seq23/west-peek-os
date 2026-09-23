import type { Env } from "../env";
import { requestAttachments } from "../effects/mimeAttachments";
import { missingMaterialsSection, readMissingMaterials, type MissingMaterial } from "../../shared/work/missingMaterials";
import type { ExecEmailSection } from "../../shared/email/execEmail";

/**
 * A CARD'S MATERIALS, FOR EVERY EMPLOYEE (23 Sep 2026, migration 0237).
 *
 * The files a requester sent — with the opening email (0221) or, since today, with any reply on the
 * card's own thread — and the list of what is still missing. One module, so the door, the thread,
 * Porter's Mac lane and every Worker-side chain read and write them the same way.
 */

export interface RequestAttachment {
  id: string;
  filename: string;
  media_type: string;
  bytes: number;
  eml_key: string;
  source?: "REQUEST" | "REPLY";
  created_at?: string;
}

export async function attachmentsFor(env: Env, cardId: string): Promise<RequestAttachment[]> {
  return (
    (await env.WP_OS_DB.prepare("SELECT id, filename, media_type, bytes, eml_key, source, created_at FROM request_attachment WHERE work_card_id = ?1 ORDER BY created_at ASC").bind(cardId).all<RequestAttachment>())
      .results ?? []
  );
}

/**
 * KEEP THE FILES IN A MESSAGE AGAINST A CARD — the one mechanism, used by the door for the opening
 * email and by the thread for a reply. A name against the card and the stored .eml it lives in; the
 * bytes are extracted on demand. Without a stored message nothing can be kept, and that is said.
 */
export async function storeAttachments(
  env: Env,
  input: { cardId: string; raw: string; emlKey: string | null; firmScope: string; source: "REQUEST" | "REPLY" },
): Promise<{ stored: string[]; attachments: number; unread: string[] }> {
  const { attachments, unread } = requestAttachments(input.raw);
  const stored: string[] = [];
  if (input.emlKey) {
    for (const a of attachments) {
      await env.WP_OS_DB.prepare(
        "INSERT INTO request_attachment (id, work_card_id, filename, media_type, bytes, eml_key, firm_scope, source) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
      )
        .bind(`ratt_${crypto.randomUUID()}`, input.cardId, a.filename, a.mediaType, a.bytes, input.emlKey, input.firmScope, input.source)
        .run();
      stored.push(a.filename);
    }
  }
  return { stored, attachments: attachments.length, unread };
}

/**
 * THE FILES, FOR A PROMPT. Every Worker-side run of a card is handed this (through `steerFor` for
 * the chains, through the loop context for the general loop), so a file sent with a reply reaches
 * the next run whatever its kind. Empty when nothing was sent.
 */
export async function materialsForPrompt(env: Env, cardId: string): Promise<string> {
  const files = await attachmentsFor(env, cardId);
  if (files.length === 0) return "";
  return [
    "FILES THE PARTNER SENT (kept on the card; each opens by name on the card):",
    ...files.map((f) => `  • ${f.filename} (${f.media_type}, ${f.bytes} bytes) — ${f.source === "REPLY" ? "sent with a reply" : "sent with the request"}`),
  ].join("\n");
}

/** What the card still needs from the requester. */
export async function missingFor(env: Env, cardId: string): Promise<MissingMaterial[]> {
  const row = await env.WP_OS_DB.prepare("SELECT missing_materials_json FROM work_card WHERE id = ?1").bind(cardId).first<{ missing_materials_json: string | null }>();
  return readMissingMaterials(row?.missing_materials_json ?? "[]");
}

/**
 * THE CARD'S SECTION, FOR ANY EMAIL ABOUT IT — the one list, rendered by the one renderer. Null when
 * nothing is missing. `replyToRequester` (every ask, preview and generic DONE email) and the kinds
 * that send their own finished email (blog help, Productions monthly, the Productions hire search)
 * all read it here, so no email about a card can forget what is still missing.
 */
export async function missingSectionFor(env: Env, cardId: string, stage: "ASK" | "STILL"): Promise<ExecEmailSection | null> {
  return missingMaterialsSection(await missingFor(env, cardId), stage);
}

/** A finished email's sections with "Still missing" placed before "Your call" (or last). Unchanged when nothing is missing. */
export async function withStillMissing(env: Env, cardId: string, sections: readonly ExecEmailSection[]): Promise<ExecEmailSection[]> {
  const missing = await missingSectionFor(env, cardId, "STILL");
  if (!missing) return [...sections];
  const at = sections.findIndex((s) => s.label === "Your call");
  return at < 0 ? [...sections, missing] : [...sections.slice(0, at), missing, ...sections.slice(at)];
}

/** Replace the card's list with what the latest run found missing ([] clears it). */
export async function recordMissing(env: Env, cardId: string, items: readonly MissingMaterial[]): Promise<void> {
  await env.WP_OS_DB.prepare("UPDATE work_card SET missing_materials_json = ?2 WHERE id = ?1").bind(cardId, JSON.stringify(readMissingMaterials(items))).run();
}
