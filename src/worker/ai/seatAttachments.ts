import type { Env } from "../env";

/**
 * A FILE ON ITS WAY TO A SUBSCRIPTION SEAT (0249, 1 Oct 2026).
 *
 * The queue carries text. A picture or a deck reaches the Mac as BYTES IN R2, named on the queue row and fetched by
 * the claimer that holds the run, then deleted when the run ends. Three walls stand between a file and a model:
 *
 *   1. THE CLAIMER MUST HAVE PROVEN IT. A seat is offered a kind of file only when the awake device declared
 *      `read_image:<seat>` / `read_document:<seat>` — and the claimer declares those only from the proof file the
 *      attachments probe writes after a seat actually read a file on that Mac. No proof, no file, no routing change.
 *   2. THE SIZE BOUNDS BELOW. A deck can be large; a queue row is not the place for it.
 *   3. ONLY THE HOLDER FETCHES IT. The download route answers the device that currently holds the run, for the run's
 *      own files, and nothing else.
 *
 * What is NOT proven by any of this: that a model read the file. The probe proves the capability once on the owner's
 * Mac; a single run's answer is as believable as any other model answer about a file, no more.
 */

export type AttachmentKind = "image" | "document";

export interface SeatAttachmentInput {
  kind: AttachmentKind;
  mediaType: string;
  /** Base64 of the file, as `ProviderImage` / `ProviderDocument` carry it. */
  dataBase64: string;
  label: string;
}

export interface SeatAttachmentRef {
  n: number;
  kind: AttachmentKind;
  media_type: string;
  /** A name safe to write to a temp directory on the Mac. */
  label: string;
  key: string;
  bytes: number;
}

export const MAX_ATTACHMENT_FILES = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENT_TOTAL_BYTES = 16 * 1024 * 1024;

/** The capability token a claimer declares, per seat and kind. */
export function attachmentCapability(seat: string, kind: AttachmentKind): string {
  return `read_${kind}:${seat}`;
}

/** Did the device row's declared capabilities include reading this kind on this seat? Unreadable means no. */
export function capabilitiesAllow(capabilitiesJson: string | null | undefined, seat: string, kind: AttachmentKind): boolean {
  if (!capabilitiesJson) return false;
  try {
    const parsed: unknown = JSON.parse(capabilitiesJson);
    return Array.isArray(parsed) && parsed.includes(attachmentCapability(seat, kind));
  } catch {
    return false;
  }
}

/** A file name that cannot climb out of a directory or be mistaken for a flag. */
export function safeLabel(label: string, n: number, mediaType: string): string {
  const ext = mediaType === "application/pdf" ? ".pdf" : /^image\/(png|jpe?g|gif|webp)$/.test(mediaType) ? `.${mediaType.split("/")[1]!.replace("jpeg", "jpg")}` : "";
  const stem =
    (label.split(/[\\/]/).pop() ?? "")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "")
      .slice(0, 60) || "file";
  return `${n + 1}-${stem}${ext}`;
}

/** Why these files may not be sent to a seat at all, or null. Pure. */
export function attachmentRefusal(files: readonly Pick<SeatAttachmentInput, "kind" | "mediaType" | "dataBase64">[]): string | null {
  if (files.length > MAX_ATTACHMENT_FILES) return `more than ${MAX_ATTACHMENT_FILES} files`;
  let total = 0;
  for (const f of files) {
    const bytes = Math.floor((f.dataBase64.length * 3) / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) return `a file over ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`;
    total += bytes;
    if (f.kind === "image" && !/^image\/(png|jpe?g|gif|webp)$/.test(f.mediaType)) return `an image type a seat is not asked to read (${f.mediaType})`;
    if (f.kind === "document" && f.mediaType !== "application/pdf") return `a document type a seat is not asked to read (${f.mediaType})`;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) return `more than ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB in all`;
  return null;
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Put the files in R2 under the run's own prefix. Throws when there is nowhere to put them. */
export async function putSeatAttachments(env: Env, runId: string, files: readonly SeatAttachmentInput[]): Promise<SeatAttachmentRef[]> {
  const bucket = env.WP_OS_DOCUMENTS;
  if (!bucket) throw new Error("seat_attachments_unavailable:no document store is bound, so a file cannot be handed to a seat");
  const refs: SeatAttachmentRef[] = [];
  for (let n = 0; n < files.length; n++) {
    const f = files[n]!;
    const bytes = decode(f.dataBase64);
    const label = safeLabel(f.label, n, f.mediaType);
    const key = `seat-attachments/${runId}/${label}`;
    await bucket.put(key, bytes, { httpMetadata: { contentType: f.mediaType } });
    refs.push({ n, kind: f.kind, media_type: f.mediaType, label, key, bytes: bytes.byteLength });
  }
  return refs;
}

export function readRefs(attachmentsJson: string | null | undefined): SeatAttachmentRef[] {
  if (!attachmentsJson) return [];
  try {
    const parsed: unknown = JSON.parse(attachmentsJson);
    return Array.isArray(parsed) ? (parsed as SeatAttachmentRef[]).filter((r) => r && typeof r.key === "string" && typeof r.n === "number") : [];
  } catch {
    return [];
  }
}

/** Delete one ended run's objects now. Best effort; a failure is left for the sweep. */
export async function clearRunAttachments(env: Env, runId: string, now: Date = new Date()): Promise<void> {
  try {
    const row = await env.WP_OS_DB.prepare(
      "SELECT attachments_json FROM subscription_seat_run WHERE id = ?1 AND attachments_json IS NOT NULL AND attachments_cleared_at IS NULL AND status IN ('REPORTED', 'FAILED', 'ABANDONED')",
    )
      .bind(runId)
      .first<{ attachments_json: string }>();
    if (!row) return;
    const refs = readRefs(row.attachments_json);
    if (env.WP_OS_DOCUMENTS && refs.length > 0) await env.WP_OS_DOCUMENTS.delete(refs.map((r) => r.key));
    await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET attachments_cleared_at = ?2 WHERE id = ?1").bind(runId, now.toISOString()).run();
  } catch {
    /* the sweep tries again */
  }
}

/** Delete the objects of every ENDED run that still has some. Best effort, bounded, never throws. */
export async function clearEndedAttachments(env: Env, now: Date = new Date()): Promise<number> {
  const bucket = env.WP_OS_DOCUMENTS;
  let cleared = 0;
  try {
    const rows =
      (
        await env.WP_OS_DB.prepare(
          `SELECT id, attachments_json FROM subscription_seat_run
            WHERE attachments_json IS NOT NULL AND attachments_cleared_at IS NULL AND status IN ('REPORTED', 'FAILED', 'ABANDONED')
            LIMIT 50`,
        ).all<{ id: string; attachments_json: string }>()
      ).results ?? [];
    for (const row of rows) {
      const refs = readRefs(row.attachments_json);
      try {
        if (bucket && refs.length > 0) await bucket.delete(refs.map((r) => r.key));
      } catch {
        continue; // try again next minute; never mark cleared what was not
      }
      await env.WP_OS_DB.prepare("UPDATE subscription_seat_run SET attachments_cleared_at = ?2 WHERE id = ?1").bind(row.id, now.toISOString()).run();
      cleared += 1;
    }
  } catch {
    /* housekeeping never breaks the tick */
  }
  return cleared;
}

