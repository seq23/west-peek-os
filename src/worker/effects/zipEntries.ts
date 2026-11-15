/**
 * THE FILES INSIDE A ZIP (15 Nov 2026). Scooter's website reply carried "the logo ZIP"; it was filed as one opaque
 * file, so the job had a ZIP and no logos. This reads a ZIP's central directory and inflates each entry with the
 * platform's own `DecompressionStream("deflate-raw")`, so the CPU spent here is a directory walk, never a hand-rolled
 * inflate. Bounded: at most `maxFiles` files and `maxTotalBytes` inflated in all; anything it does not take is named
 * with the reason (encrypted, Zip64, an unknown method, over a cap), never dropped in silence.
 */

export interface ZipFile {
  /** The entry's path inside the archive, as the archive names it. */
  name: string;
  bytes: Uint8Array;
}

export interface ZipRead {
  files: ZipFile[];
  /** Each entry not taken, and why, in plain words. */
  skipped: string[];
}

export const ZIP_MAX_FILES = 40;
export const ZIP_MAX_TOTAL_BYTES = 60 * 1024 * 1024;

const u16 = (b: Uint8Array, o: number): number => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number): number => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Housekeeping a Mac or Windows adds to every archive: never a file anybody sent. */
function isHousekeeping(name: string): boolean {
  return name.endsWith("/") || /(^|\/)__MACOSX\//.test(name) || /(^|\/)\.DS_Store$/.test(name) || /(^|\/)Thumbs\.db$/i.test(name) || /(^|\/)\._/.test(name);
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Read every file in a ZIP. Never throws: an archive it cannot read comes back with one `skipped` line saying why. */
export async function unzipEntries(zip: Uint8Array, caps: { maxFiles?: number; maxTotalBytes?: number } = {}): Promise<ZipRead> {
  const maxFiles = caps.maxFiles ?? ZIP_MAX_FILES;
  const maxTotal = caps.maxTotalBytes ?? ZIP_MAX_TOTAL_BYTES;
  const out: ZipRead = { files: [], skipped: [] };
  // End of central directory: the last 22 bytes, plus a comment of up to 64 KB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (u32(zip, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return { files: [], skipped: ["the archive could not be read (no ZIP directory found)"] };
  const count = u16(zip, eocd + 10);
  const dirOffset = u32(zip, eocd + 16);
  if (dirOffset === 0xffffffff || count === 0xffff) return { files: [], skipped: ["the archive is Zip64, which this does not read"] };
  let p = dirOffset;
  let total = 0;
  for (let n = 0; n < count && p + 46 <= zip.length; n += 1) {
    if (u32(zip, p) !== 0x02014b50) { out.skipped.push("the archive's directory is damaged past this point"); break; }
    const flags = u16(zip, p + 8);
    const method = u16(zip, p + 10);
    const compressed = u32(zip, p + 20);
    const size = u32(zip, p + 24);
    const nameLen = u16(zip, p + 28);
    const extraLen = u16(zip, p + 30);
    const commentLen = u16(zip, p + 32);
    const local = u32(zip, p + 42);
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (isHousekeeping(name)) continue;
    if (out.files.length >= maxFiles) { out.skipped.push(`${name} (only the first ${maxFiles} files of an archive are taken)`); continue; }
    if (flags & 1) { out.skipped.push(`${name} (it is encrypted)`); continue; }
    if (total + size > maxTotal) { out.skipped.push(`${name} (the archive is over ${(maxTotal / 1024 / 1024).toFixed(0)} MB unpacked)`); continue; }
    if (u32(zip, local) !== 0x04034b50) { out.skipped.push(`${name} (its data could not be found)`); continue; }
    const dataStart = local + 30 + u16(zip, local + 26) + u16(zip, local + 28);
    const data = zip.subarray(dataStart, dataStart + compressed);
    try {
      const bytes = method === 0 ? data.slice() : method === 8 ? await inflateRaw(data) : null;
      if (!bytes) { out.skipped.push(`${name} (packed with a method this does not read)`); continue; }
      total += bytes.byteLength;
      out.files.push({ name, bytes });
    } catch (err) {
      out.skipped.push(`${name} (it could not be unpacked: ${(err instanceof Error ? err.message : String(err)).slice(0, 120)})`);
    }
  }
  return out;
}

/** A ZIP by its type or its name. */
export function isZip(filename: string, mediaType: string): boolean {
  return /zip/i.test(mediaType) || /\.zip$/i.test(filename);
}

/** The media type a file inside an archive is filed with, from its name. */
export function typeOfName(name: string): string {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", heic: "image/heic",
    pdf: "application/pdf", ai: "application/postscript", eps: "application/postscript", txt: "text/plain", csv: "text/csv",
    mp4: "video/mp4", mov: "video/quicktime", m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}
