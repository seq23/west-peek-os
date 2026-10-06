import type { Env } from "../env";
import { json, type RouteContext } from "../router";
import { SUBSCRIPTION_CLAIMER_EMAIL } from "../auth";
import { appendEvent } from "../events";
import { OUTBOUND_ATTACHMENTS_MAX_BYTES, type EmailAttachment } from "../effects/emailTransport";

/**
 * FILES A JOB PRODUCED FOR THE PARTNER (0253, 6 Oct 2026). The week before, the owner exported a
 * booth log to CSV, made a QR PNG and emailed both to the partner by hand because Porter's reply
 * path had no attachments. Now a BUILD or LAND result names its deliverables; the duty script PUTs
 * each here (the Mac's claimer identity, raw bytes, one call per file); the bytes live in R2 under
 * the card; and the DONE / preview email attaches the set when it fits `OUTBOUND_ATTACHMENTS_MAX_BYTES`
 * (10 MB) and lists every file by name either way — a file over the cap is shared from Drive by the
 * duty (`scripts/drive/push.mjs`) and linked, or linked to the card when Drive refused.
 */

export interface WorkCardFile {
  id: string;
  work_card_id: string;
  filename: string;
  media_type: string;
  bytes: number;
  r2_key: string | null;
  drive_url: string | null;
  created_at: string;
}

/** One file may be this large in R2; the EMAIL cap is separate and smaller. */
export const WORK_CARD_FILE_MAX_BYTES = 100 * 1024 * 1024;

function mayPut(ctx: RouteContext): boolean {
  return ctx.identity?.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL;
}
function mayRead(ctx: RouteContext): boolean {
  const identity = ctx.identity;
  if (!identity) return false;
  if (identity.email.toLowerCase() === SUBSCRIPTION_CLAIMER_EMAIL) return true;
  return identity.roles.includes("MANAGING_PARTNER");
}

function safeName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim().slice(0, 200) || "file";
}

export async function filesFor(env: Env, cardId: string): Promise<WorkCardFile[]> {
  const rows = await env.WP_OS_DB.prepare("SELECT * FROM work_card_file WHERE work_card_id = ?1 ORDER BY created_at ASC, filename ASC").bind(cardId).all<WorkCardFile>();
  return rows.results ?? [];
}

/**
 * POST /api/work-cards/:id/files — the claimer only. The body is the file's bytes; the name and type
 * ride in headers (`x-wp-filename`, `content-type`). A JSON body with `drive_url` records a file that
 * was shared from Drive instead (too large to attach). Same name on the same card replaces the file.
 */
export async function handlePutWorkCardFile(ctx: RouteContext): Promise<Response> {
  if (!mayPut(ctx)) return json({ error: "forbidden", detail: "A job's files are put by the Mac's claimer." }, { status: 403 });
  const cardId = ctx.params.id!;
  const card = await ctx.env.WP_OS_DB.prepare("SELECT id, firm_scope FROM work_card WHERE id = ?1").bind(cardId).first<{ id: string; firm_scope: string }>();
  if (!card) return json({ error: "not_found", detail: "no such card" }, { status: 404 });
  const type = (ctx.request.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim().toLowerCase();
  const filename = safeName(decodeURIComponent(ctx.request.headers.get("x-wp-filename") ?? ""));
  if (!filename) return json({ error: "invalid_input", detail: "x-wp-filename is required" }, { status: 400 });

  let r2Key: string | null = null;
  let driveUrl: string | null = null;
  let bytes = 0;
  if (type === "application/json" && ctx.request.headers.get("x-wp-drive") === "1") {
    const body = (await ctx.request.json().catch(() => ({}))) as { drive_url?: string; bytes?: number };
    driveUrl = String(body.drive_url ?? "").trim();
    bytes = Number(body.bytes ?? 0) || 0;
    if (!/^https:\/\/(drive|docs)\.google\.com\//.test(driveUrl)) return json({ error: "invalid_input", detail: "drive_url must be a Google Drive link" }, { status: 400 });
  } else {
    if (!ctx.env.WP_OS_DOCUMENTS) return json({ error: "unavailable", detail: "the document store is not bound" }, { status: 503 });
    const buf = new Uint8Array(await ctx.request.arrayBuffer());
    bytes = buf.byteLength;
    if (bytes === 0) return json({ error: "invalid_input", detail: "the body is empty" }, { status: 400 });
    if (bytes > WORK_CARD_FILE_MAX_BYTES) return json({ error: "too_large", detail: `${bytes} bytes is over the ${WORK_CARD_FILE_MAX_BYTES}-byte ceiling; share it from Drive` }, { status: 413 });
    r2Key = `work-card/${cardId}/files/${crypto.randomUUID()}/${filename}`;
    await ctx.env.WP_OS_DOCUMENTS.put(r2Key, buf, { httpMetadata: { contentType: type }, customMetadata: { work_card_id: cardId, filename } });
  }
  const id = `wcf_${crypto.randomUUID()}`;
  await ctx.env.WP_OS_DB.prepare("DELETE FROM work_card_file WHERE work_card_id = ?1 AND filename = ?2").bind(cardId, filename).run();
  await ctx.env.WP_OS_DB.prepare("INSERT INTO work_card_file (id, work_card_id, filename, media_type, bytes, r2_key, drive_url, firm_scope) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)")
    .bind(id, cardId, filename, type, bytes, r2Key, driveUrl, card.firm_scope)
    .run();
  await appendEvent(ctx.env, {
    eventType: "work_card.file_added",
    actorType: "system",
    actorId: SUBSCRIPTION_CLAIMER_EMAIL,
    objectType: "work_card",
    objectId: cardId,
    firmScope: card.firm_scope,
    payload: { file_id: id, filename, media_type: type, bytes, via: driveUrl ? "drive" : "r2" },
  });
  return json({ ok: true, id, filename, bytes, via: driveUrl ? "drive" : "r2" });
}

/** GET /api/work-cards/:id/files — names, sizes and where each is. */
export async function handleListWorkCardFiles(ctx: RouteContext): Promise<Response> {
  if (!mayRead(ctx)) return json({ error: "forbidden", detail: "A job's files are read by a Managing Partner or the Mac's claimer." }, { status: 403 });
  const files = await filesFor(ctx.env, ctx.params.id!);
  return json({ files: files.map((f) => ({ id: f.id, filename: f.filename, media_type: f.media_type, bytes: f.bytes, drive_url: f.drive_url, path: f.r2_key ? `/api/work-cards/${f.work_card_id}/files/${f.id}` : null, created_at: f.created_at })) });
}

/** GET /api/work-cards/:id/files/:fileId — the bytes, by name. */
export async function handleGetWorkCardFile(ctx: RouteContext): Promise<Response> {
  if (!mayRead(ctx)) return json({ error: "forbidden", detail: "A job's files are read by a Managing Partner or the Mac's claimer." }, { status: 403 });
  const row = await ctx.env.WP_OS_DB.prepare("SELECT * FROM work_card_file WHERE id = ?1 AND work_card_id = ?2").bind(ctx.params.fileId!, ctx.params.id!).first<WorkCardFile>();
  if (!row) return json({ error: "not_found", detail: "no such file on this card" }, { status: 404 });
  if (!row.r2_key) return Response.redirect(row.drive_url!, 302);
  const obj = await ctx.env.WP_OS_DOCUMENTS?.get(row.r2_key);
  if (!obj) return json({ error: "not_found", detail: "the file's bytes are gone from the store" }, { status: 404 });
  return new Response(obj.body, { headers: { "content-type": row.media_type, "content-disposition": `attachment; filename="${row.filename.replace(/"/g, "")}"`, "cache-control": "private, no-store" } });
}

export interface OutboundFiles {
  /** Files that fit the cap, read and base64'd for the transport. */
  attachments: EmailAttachment[];
  /** One section for the email: every file by name, and where it is when it is not attached. */
  section: { label: string; bullets: string[] } | null;
}

function b64(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

/**
 * THE FILES FOR AN EMAIL. Every file on the card is LISTED; the ones in R2 are ATTACHED in order
 * until the cap would be crossed; the rest carry a link (Drive when the duty shared it, else the
 * card's own download). Never partial silence: a file that is not attached says where it is.
 */
export async function outboundFilesFor(env: Env, cardId: string, cap = OUTBOUND_ATTACHMENTS_MAX_BYTES): Promise<OutboundFiles> {
  const files = await filesFor(env, cardId);
  if (!files.length) return { attachments: [], section: null };
  const attachments: EmailAttachment[] = [];
  const bullets: string[] = [];
  let used = 0;
  for (const f of files) {
    const size = f.bytes >= 1024 * 1024 ? `${(f.bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(f.bytes / 1024))} KB`;
    if (f.r2_key && used + f.bytes <= cap && env.WP_OS_DOCUMENTS) {
      const obj = await env.WP_OS_DOCUMENTS.get(f.r2_key);
      if (obj) {
        attachments.push({ filename: f.filename, content: b64(new Uint8Array(await obj.arrayBuffer())), contentType: f.media_type });
        used += f.bytes;
        bullets.push(`${f.filename} (${size}) — attached`);
        continue;
      }
    }
    if (f.drive_url) bullets.push(`${f.filename} (${size}) — shared from Drive: ${f.drive_url}`);
    else bullets.push(`${f.filename} (${size}) — on the card: /api/work-cards/${cardId}/files/${f.id}`);
  }
  return { attachments, section: { label: "Files", bullets } };
}
