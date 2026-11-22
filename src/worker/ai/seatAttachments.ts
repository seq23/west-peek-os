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
    if (!bytesAre(f.mediaType, f.dataBase64)) return `a file whose bytes are not the ${f.mediaType} it says it is`;
  }
  if (total > MAX_ATTACHMENT_TOTAL_BYTES) return `more than ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB in all`;
  return null;
}

/*
 * THE BYTES MUST BE THE TYPE THEY CLAIM (22 Nov 2026, engineering sweep row 8). The declared media type comes from
 * whoever sent the file; a seat on the Mac opens it by that type. A "png" that is really a PDF, a script or an
 * archive is refused here, before it is stored, by its first bytes (the file signature every one of these formats
 * starts with).
 */
const SIGNATURES: Record<string, (b: Uint8Array) => boolean> = {
  "image/png": (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  "image/jpeg": (b) => starts(b, [0xff, 0xd8, 0xff]),
  "image/jpg": (b) => starts(b, [0xff, 0xd8, 0xff]),
  "image/gif": (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) && (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61,
  "image/webp": (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && starts(b.subarray(8), [0x57, 0x45, 0x42, 0x50]),
  "application/pdf": (b) => starts(b, [0x25, 0x50, 0x44, 0x46, 0x2d]),
};

function starts(b: Uint8Array, sig: readonly number[]): boolean {
  return b.length >= sig.length && sig.every((v, i) => b[i] === v);
}

/** Do the file's first bytes carry its declared type's signature? Unreadable base64 or an unknown type is no. */
export function bytesAre(mediaType: string, dataBase64: string): boolean {
  const check = SIGNATURES[mediaType];
  if (!check) return false;
  try {
    return check(decode(dataBase64.replace(/\s+/g, "").slice(0, 16)));
  } catch {
    return false;
  }
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
  try {
    for (let n = 0; n < files.length; n++) {
      const f = files[n]!;
      const bytes = decode(f.dataBase64);
      const label = safeLabel(f.label, n, f.mediaType);
      const key = `${SEAT_ATTACHMENT_PREFIX}${runId}/${label}`;
      await bucket.put(key, bytes, { httpMetadata: { contentType: f.mediaType } });
      refs.push({ n, kind: f.kind, media_type: f.mediaType, label, key, bytes: bytes.byteLength });
    }
  } catch (err) {
    // No queue row will ever name these, so neither the end-of-run delete nor the sweep could find them.
    await deleteKeys(bucket, refs.map((r) => r.key));
    throw err;
  }
  return refs;
}

/** Delete objects, swallowing a failure: this runs while another error is already being raised. */
export async function deleteKeys(bucket: { delete: (keys: string[]) => Promise<unknown> }, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete(keys);
  } catch {
    /* nothing more can be done from here */
  }
}

/**
 * The files a run carries, or NULL when the stored list cannot be read (corrupt JSON, not a list, an entry with no
 * key). Null is UNKNOWN, never "no files": nothing is deleted or stamped cleared from it, no device is offered the run
 * on its strength, and the bucket's lifecycle rule on `seat-attachments/` (see SEAT_ATTACHMENT_PREFIX) removes the
 * objects in the end.
 */
export function readRefs(attachmentsJson: string | null | undefined): SeatAttachmentRef[] | null {
  if (!attachmentsJson) return [];
  try {
    const parsed: unknown = JSON.parse(attachmentsJson);
    if (!Array.isArray(parsed)) return null;
    const ok = parsed.every((r) => r && typeof r === "object" && typeof (r as SeatAttachmentRef).key === "string" && typeof (r as SeatAttachmentRef).n === "number");
    return ok ? (parsed as SeatAttachmentRef[]) : null;
  } catch {
    return null;
  }
}

/** Every seat file lives under this prefix; the R2 lifecycle rule (docs/OPERATIONS.md) is scoped to it. */
export const SEAT_ATTACHMENT_PREFIX = "seat-attachments/";

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
    // An unreadable list is unknown: nothing is deleted on its strength and the run is never stamped cleared.
    if (!refs) return;
    if (refs.length > 0) {
      // No bucket bound is an outage, not a deletion: the files are still there, so the run is left for the sweep.
      if (!env.WP_OS_DOCUMENTS) return;
      await env.WP_OS_DOCUMENTS.delete(refs.map((r) => r.key));
    }
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
              AND json_valid(attachments_json)
            LIMIT 50`,
        ).all<{ id: string; attachments_json: string }>()
      ).results ?? [];
    for (const row of rows) {
      const refs = readRefs(row.attachments_json);
      if (!refs) continue; // an unreadable list: unknown, never "cleared" (the lifecycle rule is the backstop)
      if (refs.length > 0 && !bucket) continue; // no bucket bound: unknown, never "cleared"
      try {
        if (refs.length > 0) await bucket!.delete(refs.map((r) => r.key));
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

