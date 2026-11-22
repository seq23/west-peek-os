import PostalMime, { decodeWords, type Email } from "postal-mime";

/**
 * READING AN EMAIL (22 Nov 2026, engineering sweep row 7, Open Loops olp_m81kzk624ngsdh1v). Every MIME read in the OS
 * goes through ONE library parse: postal-mime, in ArrayBuffer mode. It replaced the hand-built splitter
 * (effects/mimeAttachments.ts) and the hand-built RFC 2047 decoder (inboundEmail.ts decodeMimeHeader), which between
 * them had been patched for folded boundaries, nested forwards, regex-escaped boundaries, Q-encoding split across
 * bytes and a CPU blow-up per reader; postal-mime does all of that, plus quoted-printable and 7/8bit attachments the
 * old splitter could only call "unread".
 *
 * ARRAYBUFFER MODE ONLY. Measured on a 26 MB partner reply (scripts/probes/mime-cpu-bench.mts): ~290 ms CPU and ~19 MB
 * held after one parse; base64 mode holds ~350 MB and would not fit the 128 MB isolate. Base64 is made here, only for
 * the attachments a caller takes, after their size is checked.
 *
 * PARSED ONCE PER MESSAGE. One reply is read by the text reader, the file reader, the voice-note reader and the steer's
 * own readers in a row; the last parse is kept and handed back for the same string, so a message costs one parse.
 *
 * NEVER THROWS, NEVER LOSES A MESSAGE. A message postal-mime refuses (a header block over 2 MB, a nesting bomb, broken
 * structure) comes back with `problem` set and nothing read from it. The stored .eml is untouched; the door puts the
 * problem on Sequoia's desk (`flagUnparseableMail` in inboundEmail.ts). An unread file is NAMED in `unread`, never
 * silently dropped.
 */

export interface Attachment {
  filename: string;
  mediaType: string;
  /** Base64 of the file, exactly as `readDeck` and the providers want it. */
  dataBase64: string;
  bytes: number;
}

interface MailFile {
  filename: string;
  mediaType: string;
  sentAsFile: boolean;
  content: Uint8Array;
}

export interface Mail {
  /** False for text that is not an email at all (a note somebody typed, a stored body, a test fixture). */
  isMime: boolean;
  /** Why the message could not be parsed, or null. Set → nothing below was read from it. */
  problem: string | null;
  subject: string;
  inReplyTo: string;
  references: string;
  /** The words a person wrote: the text/plain part, else the HTML part as text, else the text itself when not MIME. */
  text: string;
  html: string;
  files: MailFile[];
  /** Raw header lines in order (folds merged), for rebuilding a scrubbed copy. */
  headerLines: string[];
}

/** More than this and the firm is being sent a library, not a deck. */
export const MAX_ATTACHMENTS = 3;
/** A deck bigger than this is not going to be read inside one invocation. */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
/**
 * A FILE KEPT AGAINST A CARD IS A POINTER, NOT A READ (15 Nov 2026, wc_c548d043). Above the largest message Email
 * Routing delivers (25 MiB), so a big voice memo is still kept against its card.
 */
export const MAX_KEPT_FILE_BYTES = 30 * 1024 * 1024;
/** A voice note is up to this big: a phone's few minutes of m4a is 1 to 20 MB. */
export const MAX_VOICE_NOTE_BYTES = 40 * 1024 * 1024;
/** Enough to carry a forwarded chain and its tags; not so much that scanning it costs real time. */
const MAX_SCANNED_BODY = 256 * 1024;

/** How many times a message was actually parsed. Exposed for the regression test that pins one parse per message. */
export const mailParseCount = { n: 0 };
/*
 * Two slots: the last big message and the last small one, so the short messages read in between (a thread's stored
 * email, a Got it) never evict the big reply's parse. A slot holds the parse in flight, so two readers awaiting at
 * once share it too. At most one big parse (~19 MB for a 26 MB reply) is held at a time.
 */
const BIG_MAIL_CHARS = 1024 * 1024;
const slots: { big: { raw: string; mail: Promise<Mail> } | null; small: { raw: string; mail: Promise<Mail> } | null } = { big: null, small: null };

/** Does this text start with an email's header block? Structure only: a typed note or stored body is not parsed. */
function looksLikeMail(text: string): boolean {
  const headerEnd = text.search(/\r?\n\r?\n/);
  if (headerEnd <= 0 || !/^[A-Za-z-]+:\s/.test(text)) return false;
  return /^(?:received|from|to|subject|content-type|mime-version|date|message-id|dkim-signature|return-path|x-[a-z-]+):/im.test(text.slice(0, headerEnd));
}

function bytesOf(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

/** The one parse. Never throws. */
export function readMail(raw: string | null | undefined): Promise<Mail> {
  const text = raw ?? "";
  const slot = text.length >= BIG_MAIL_CHARS ? "big" : "small";
  const held = slots[slot];
  if (held && held.raw === text) return held.mail;
  const mail = parseMail(text);
  slots[slot] = { raw: text, mail };
  return mail;
}

async function parseMail(text: string): Promise<Mail> {
  let mail: Mail;
  if (!looksLikeMail(text)) {
    mail = { isMime: false, problem: null, subject: "", inReplyTo: "", references: "", text, html: "", files: [], headerLines: [] };
  } else {
    mailParseCount.n += 1;
    let email: Email | null = null;
    let problem: string | null = null;
    try {
      email = await PostalMime.parse(text, { attachmentEncoding: "arraybuffer" });
    } catch (err) {
      const code = (err as { code?: string }).code;
      problem = `${code ? `${code}: ` : ""}${err instanceof Error ? err.message : String(err)}`.slice(0, 300);
    }
    mail = email
      ? {
          isMime: true,
          problem: null,
          subject: email.subject ?? "",
          inReplyTo: email.inReplyTo ?? "",
          references: email.references ?? "",
          text: (email.text ?? "").trim() ? (email.text ?? "").replace(/\r\n/g, "\n").trim() : htmlAsText(email.html ?? ""),
          html: email.html ?? "",
          files: email.attachments.map((a) => ({
            filename: (a.filename ?? "").trim().slice(0, 200) || (a.mimeType === "application/pdf" ? "attachment.pdf" : "attachment"),
            mediaType: a.mimeType || "application/octet-stream",
            sentAsFile: (a.disposition ?? "").toLowerCase() === "attachment",
            content: bytesOf(a.content),
          })),
          headerLines: email.headerLines.map((h) => h.line),
        }
      : { isMime: true, problem: problem ?? "unreadable", subject: "", inReplyTo: "", references: "", text: "", html: "", files: [], headerLines: [] };
  }
  return mail;
}

/** An HTML body as the words in it. Text formatting, not MIME: the library has already decoded the part. */
function htmlAsText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d|tr)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A header value with its RFC 2047 encoded words decoded (`=?UTF-8?Q?…?=`). Anything undecodable is returned as it is. */
export function decodeHeader(value: string): string {
  if (!value.includes("=?")) return value;
  try {
    const out = decodeWords(value);
    return out || value;
  } catch {
    return value;
  }
}

/**
 * THE TEXT A PERSON WROTE. On 21 Sep 2026 the first real request reached Porter as 6,000 characters of `Received:` and
 * DKIM headers, and the words themselves were lost. Text that is not an email is returned as it is.
 */
export async function textBodyOf(raw: string | null | undefined): Promise<string> {
  return (await readMail(raw)).text;
}

/** The top headers that say whether a message is a reply or a forward, or null when the text is not an email. */
export async function topHeadersOf(raw: string | null | undefined): Promise<{ subject: string; inReplyTo: string; references: string } | null> {
  const mail = await readMail(raw);
  if (!mail.isMime || mail.problem) return null;
  return { subject: mail.subject, inReplyTo: mail.inReplyTo, references: mail.references };
}

/**
 * The readable text of a message: its subject and every text part, for the trigger scan on the oversize path (a
 * `#wpdeck` in the body routes). Attachments are not part of it.
 */
export async function messageText(raw: string): Promise<{ subject: string; body: string }> {
  const mail = await readMail(raw);
  if (!mail.isMime) {
    const split = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") + 4 : raw.indexOf("\n\n") + 2;
    return { subject: "", body: split > 1 ? raw.slice(split, split + MAX_SCANNED_BODY) : "" };
  }
  return { subject: mail.subject, body: [mail.text, mail.html].filter(Boolean).join("\n").slice(0, MAX_SCANNED_BODY) };
}

function base64Of(bytes: Uint8Array): string {
  // The platform's own encoder where the runtime has it (Uint8Array.prototype.toBase64), else the chunked btoa.
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}

/** Base64 to bytes in one pass. Throws on bad base64. */
export function bytesOfBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/[\r\n\s]/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function attachmentsOf(
  raw: string,
  accept: (f: MailFile) => boolean,
  max = MAX_ATTACHMENTS,
  maxBytes = MAX_ATTACHMENT_BYTES,
): Promise<{ attachments: Attachment[]; unread: string[] }> {
  const mail = await readMail(raw);
  const attachments: Attachment[] = [];
  const unread: string[] = [];
  if (mail.problem) return { attachments, unread: [`the message itself (${mail.problem})`] };
  for (const f of mail.files) {
    if (!accept(f)) continue;
    // A text part is never a file unless the client sent it as one (a .csv); an inline body decoration is not either.
    if (f.mediaType.startsWith("text/") && !f.sentAsFile) continue;
    if (attachments.length >= max) {
      unread.push(`${f.filename} (only the first ${max} were taken)`);
      continue;
    }
    if (f.content.byteLength === 0) {
      unread.push(`${f.filename} (it was empty)`);
      continue;
    }
    if (f.content.byteLength > maxBytes) {
      unread.push(`${f.filename} (${(f.content.byteLength / 1024 / 1024).toFixed(1)}MB — too large to read here)`);
      continue;
    }
    attachments.push({ filename: f.filename, mediaType: f.mediaType, dataBase64: base64Of(f.content), bytes: f.content.byteLength });
  }
  return { attachments, unread };
}

/** The PDFs in a message. Parts that could not be taken are named in `unread`, so the card can SAY so. */
export function pdfAttachments(raw: string): Promise<{ attachments: Attachment[]; unread: string[] }> {
  return attachmentsOf(raw, (f) => f.mediaType === "application/pdf");
}

/**
 * THE FILES A PARTNER ATTACHED TO A REQUEST (21 Sep 2026; 23 Sep 2026, 0237). Images and PDFs, inline or attached, and
 * every part the client marked as an attachment, whatever its type (an .xlsx, an .otf, a .csv).
 */
export function requestAttachments(raw: string): Promise<{ attachments: Attachment[]; unread: string[] }> {
  return attachmentsOf(raw, (f) => f.sentAsFile || f.mediaType.startsWith("image/") || f.mediaType === "application/pdf", 10, MAX_KEPT_FILE_BYTES);
}

const SOUND_FILE = /\.(?:m4a|mp3|wav|aac|ogg|oga|opus|caf|amr|webm)$/i;

/** The audio files a person attached (a phone's "New Recording 4.m4a"), by type or by a sound file's name. */
export function audioAttachments(raw: string): Promise<{ attachments: Attachment[]; unread: string[] }> {
  return attachmentsOf(raw, (f) => f.mediaType.startsWith("audio/") || SOUND_FILE.test(f.filename), 5, MAX_VOICE_NOTE_BYTES);
}

/** The bytes of one named attachment. Null when the message carries no such file. */
export async function attachmentBytes(raw: string, filename: string): Promise<{ bytes: Uint8Array; mediaType: string } | null> {
  const hit = (await readMail(raw)).files.find((f) => f.filename === filename && f.content.byteLength <= MAX_KEPT_FILE_BYTES);
  return hit ? { bytes: hit.content, mediaType: hit.mediaType } : null;
}

/**
 * A deck that arrived as something this cannot open, named precisely, never as silence (operator, 24 Aug 2026: decks
 * also arrive as .pptx, Keynote, Word). Nothing is converted; the card says WHAT ARRIVED.
 */
const DECK_LIKE_TYPES: ReadonlyArray<{ match: RegExp; called: string }> = [
  { match: /presentationml|\.pptx?$/i, called: "a PowerPoint file" },
  { match: /keynote|\.key$/i, called: "a Keynote file" },
  { match: /opendocument\.presentation|\.odp$/i, called: "an OpenDocument presentation" },
  { match: /msword|wordprocessingml|\.docx?$/i, called: "a Word document" },
];

export async function unreadableDeckAttachments(raw: string): Promise<string[]> {
  const found: string[] = [];
  for (const f of (await readMail(raw)).files) {
    if (f.mediaType === "application/pdf" || f.mediaType.startsWith("text/")) continue;
    const known = DECK_LIKE_TYPES.find((k) => k.match.test(f.mediaType) || k.match.test(f.filename));
    if (known) found.push(`${f.filename} (${known.called})`);
  }
  return found.slice(0, MAX_ATTACHMENTS);
}

/**
 * Deck links in the body, which is how a lot of decks travel now. SURFACED, NOT FETCHED: Docsend gates on an address
 * and Slides needs paging; claiming to have read a deck from a screenshot of slide one would be an over-claim.
 */
const DECK_HOSTS = /https:\/\/(?:www\.)?(docsend\.com|drive\.google\.com|docs\.google\.com|dropbox\.com|notion\.so|figma\.com|canva\.com|pitch\.com)\/[^\s"'<>)\]]+/gi;

export function deckLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(DECK_HOSTS)) {
    seen.add(m[0].replace(/[.,;:]+$/, "").slice(0, 300));
    if (seen.size >= 5) break;
  }
  return [...seen];
}

const secretsIn = (values: readonly string[]): string[] => values.filter((v) => typeof v === "string" && v.length >= 4);

/** True when any value is still readable in the message: plainly, or in its decoded subject or text. Used by the guard. */
export async function carriesSecretValue(raw: string, values: readonly string[]): Promise<boolean> {
  const wanted = secretsIn(values);
  if (!wanted.length || !raw) return false;
  if (wanted.some((v) => raw.includes(v))) return true;
  const mail = await readMail(raw);
  // Unparseable is not "clean": the guard must not pass a message it could not read.
  if (mail.problem) return true;
  return wanted.some((v) => mail.subject.includes(v) || mail.text.includes(v) || mail.html.includes(v));
}

/**
 * A SECRET'S VALUE, SCRUBBED OUT OF A STORED MESSAGE (0253, 6 Oct 2026). Once the Worker has the value encrypted, the
 * .eml in R2 must not keep it. Plain occurrences (headers, a 7bit body) are replaced in place. When the value is still
 * readable after decoding (a base64 or quoted-printable text part, as Gmail sends), the message is rebuilt from the
 * parse: its own header lines, the scrubbed text and HTML as 8bit parts, and every attachment re-encoded from its
 * decoded bytes under the same name, so `attachmentBytes` on the scrubbed copy returns the same bytes.
 */
export async function scrubSecretValues(raw: string, values: readonly string[], marker = "[secret redacted]"): Promise<string> {
  const wanted = secretsIn(values);
  if (!wanted.length || !raw) return raw;
  const replaceAll = (text: string): string => wanted.reduce((acc, v) => acc.split(v).join(marker), text);
  const out = replaceAll(raw);
  if (!(await carriesSecretValue(out, wanted))) return out;
  const mail = await readMail(out);
  // A message the library cannot read cannot be rebuilt from it: the plain scrub is all there is, and the caller's guard
  // (carriesSecretValue, which treats unparseable as carrying) refuses to store it.
  if (mail.problem || !mail.isMime) return out;
  const boundary = `wpos-scrubbed-${crypto.randomUUID()}`;
  const keep = mail.headerLines.filter((l) => !/^(?:content-type|content-transfer-encoding|mime-version)\s*:/i.test(l)).map(replaceAll);
  const fold = (b64: string) => b64.replace(/(.{76})/g, "$1\r\n");
  const parts = [`Content-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${replaceAll(mail.text)}\r\n`];
  if (mail.html) parts.push(`Content-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${replaceAll(mail.html)}\r\n`);
  for (const f of mail.files) {
    const name = f.filename.replace(/["\r\n]/g, "");
    parts.push(
      `Content-Type: ${f.mediaType}; name="${name}"\r\nContent-Disposition: ${f.sentAsFile ? "attachment" : "inline"}; filename="${name}"\r\nContent-Transfer-Encoding: base64\r\n\r\n${fold(base64Of(f.content))}\r\n`,
    );
  }
  return [
    ...keep,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "X-WP-OS-Scrubbed: secret redacted; message rebuilt",
    "",
    ...parts.map((p) => `--${boundary}\r\n${p}`),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
