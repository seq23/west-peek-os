/**
 * Pulling the PDF out of an email.
 *
 * WHY THIS DID NOT EXIST, AND WHY THAT MATTERED. `#wpdeck` shipped meaning "the information is in
 * the attachment", `deckReader.ts` shipped able to read a PDF, and nothing ever connected them:
 * `inboundEmail.ts` extracted no attachments at all. So the prompt handed to Wyatt said "the
 * substance is in the attachment, not the message body" while the attachment was never given to
 * him. The one path that worked was uploading a deck by hand.
 *
 * DELIBERATELY SMALL AND DELIBERATELY NOT A MIME LIBRARY. A Worker has 10ms of CPU; a general
 * parser walking a multi-megabyte tree would not finish. This does one thing: find `application/pdf`
 * parts, decode their base64, and stop at the first few. Anything it cannot confidently read it
 * reports as unread rather than guessing — a deck half-decoded into a model is worse than no deck,
 * because the model will answer anyway.
 */

export interface Attachment {
  filename: string;
  mediaType: string;
  /** Base64, exactly as `readDeck` wants it — never decoded here, which is the expensive part. */
  dataBase64: string;
  bytes: number;
}

/** More than this and the firm is being sent a library, not a deck. */
export const MAX_ATTACHMENTS = 3;

/** A deck bigger than this is not going to be read inside one invocation. */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;

/**
 * The boundary token a multipart message declares in its own Content-Type.
 *
 * UNFOLDED FIRST, AND WITHOUT THAT THE WHOLE FILE WAS A NO-OP FOR APPLE MAIL AND OUTLOOK.
 *
 * RFC 5322 lets a header wrap onto a continuation line beginning with a space or a tab, and both
 * clients do it here as a matter of course:
 *
 *   Content-Type: multipart/mixed;
 *    boundary="Apple-Mail=_A1B2C3"
 *
 * The pattern's `[^\n]*` cannot cross that line break, so `boundaryOf` returned null, `pdfAttachments`
 * returned `{ attachments: [], unread: [] }`, and the caller then set `isDeck = false` and said
 * nothing — a deck dropped in silence, which is the one failure this file exists to prevent. Its own
 * docstring promises the opposite ("anything it cannot confidently read it reports as unread"), and
 * `headerIn` unfolds for exactly this reason; the function that runs FIRST and gates everything did
 * not. The operator's own note is that most of this mailbox is forwards from those two clients.
 */
/** The boundary declared by a PART's own headers, used to descend into a nested multipart. */
function nestedBoundaryOf(part: string): string | null {
  const headerEnd = part.search(/\r?\n\r?\n/);
  const headers = (headerEnd === -1 ? part : part.slice(0, headerEnd)).replace(/\r?\n[ \t]+/g, " ");
  const m = /content-type:\s*multipart\/[^\n]*boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(headers);
  return m ? m[1]! : null;
}

/**
 * MIME nests, and this file used to pretend it did not.
 *
 * Scooter forwarded a deck from Apple Mail on 23 Aug 2026 and it arrived shaped like this:
 *
 *   multipart/alternative          <- the boundary the top-level header declares
 *   ├── text/plain
 *   └── multipart/mixed            <- and the deck is in HERE
 *       ├── text/html
 *       ├── application/pdf        <- Vynlo_PreSeed_Deck_Outreach_2026-08-22.pdf
 *       └── text/html
 *
 * Splitting on the top boundary yields the whole nested block as ONE opaque part whose own
 * Content-Type reads `multipart/mixed` — not `application/pdf` — so nothing matched and the message
 * was reported as carrying no readable PDF. The deck was in the bytes the entire time.
 *
 * This is not an edge case. It is what every mail client produces when you forward a message that
 * has an attachment, and the operator's own words are "most will be forwards from founders".
 *
 * Depth is capped because a malicious or broken message can declare a boundary that contains itself,
 * and this runs inside a Worker with 10ms of CPU.
 */
const MAX_MIME_DEPTH = 6;

/** Every leaf part of a message, flattened — descending into nested multiparts. */
function leafParts(raw: string, boundary: string, depth = 0): string[] {
  const out: string[] = [];
  for (const part of raw.split(`--${boundary}`)) {
    const inner = depth < MAX_MIME_DEPTH ? nestedBoundaryOf(part) : null;
    if (inner) out.push(...leafParts(part, inner, depth + 1));
    else out.push(part);
  }
  return out;
}

function boundaryOf(raw: string): string | null {
  const m = /content-type:\s*multipart\/[^\n]*boundary\s*=\s*"?([^";\r\n]+)"?/i.exec(unfoldHeaders(raw));
  return m ? m[1]! : null;
}

/**
 * Join continuation lines back onto the header they belong to.
 *
 * Bounded to the message's own header block — everything before the first blank line — because that
 * is where the top-level Content-Type is, and because running it over a multi-megabyte body would
 * spend CPU this file has none of. A base64 body is never folded, so nothing downstream needs it.
 */
function unfoldHeaders(raw: string): string {
  const end = raw.search(/\r?\n\r?\n/);
  return (end === -1 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, " ");
}

/** A header value from one MIME part's own header block. */
function headerIn(part: string, name: string): string | null {
  // Unfolds continuation lines first: a long filename is legally split across lines, and reading
  // only the first would truncate the name to something that looks deliberate.
  const unfolded = part.replace(/\r?\n[ \t]+/g, " ");
  const m = new RegExp(`^${name}\\s*:\\s*(.+)$`, "im").exec(unfolded);
  return m ? m[1]!.trim() : null;
}

function filenameIn(part: string): string {
  const disposition = headerIn(part, "content-disposition") ?? "";
  const type = headerIn(part, "content-type") ?? "";
  const m = /filename\*?=\s*"?([^";\r\n]+)"?/i.exec(disposition) ?? /name\s*=\s*"?([^";\r\n]+)"?/i.exec(type);
  return (m ? m[1]!.trim() : "attachment.pdf").slice(0, 200);
}

/**
 * The PDFs in a raw MIME message.
 *
 * Returns `unread` for parts that look like attachments and could not be taken, so the caller can
 * SAY so on the work card. Silence about a dropped attachment is how the Sensori deck went missing.
 */
export function pdfAttachments(raw: string): { attachments: Attachment[]; unread: string[] } {
  return attachmentsOf(raw, (type) => type.includes("application/pdf"));
}

/**
 * THE FILES A PARTNER ATTACHED TO A REQUEST (21 Sep 2026). Images and PDFs — "the photo is
 * attached" is a specification, and the photo is an asset the plan needs. Same parser as the
 * decks, a wider net. Inline images (`Content-ID`, no disposition) count too: a photo dragged
 * into Gmail arrives that way.
 *
 * AND EVERY FILE SENT AS AN ATTACHMENT (23 Sep 2026, 0237). "Send me the fund model" is answered
 * with an .xlsx, "the font is attached" with an .otf, a speaker list with a .csv. Any part the
 * client marked `Content-Disposition: attachment` is a file she sent — kept, whatever its type.
 */
export function requestAttachments(raw: string): { attachments: Attachment[]; unread: string[] } {
  return attachmentsOf(raw, (type, sentAsFile) => sentAsFile || type.startsWith("image/") || type.includes("application/pdf"), 10);
}

/** One MIME part's body, decoded from base64 or quoted-printable; the raw body for anything else. */
function decodePartBody(part: string): string {
  const split = part.search(/\r?\n\r?\n/);
  const body = split === -1 ? "" : part.slice(split).replace(/^\r?\n\r?\n/, "");
  const encoding = (headerIn(part, "content-transfer-encoding") ?? "").toLowerCase();
  if (encoding.includes("base64")) {
    try {
      const bin = atob(body.replace(/[\r\n\s]/g, ""));
      const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      return new TextDecoder("utf-8").decode(bytes);
    } catch {
      return body;
    }
  }
  if (encoding.includes("quoted-printable")) {
    return body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-Fa-f]{2})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/[\x80-\xff]+/g, (m) => {
        try {
          return new TextDecoder("utf-8").decode(Uint8Array.from(m, (c) => c.charCodeAt(0)));
        } catch {
          return m;
        }
      });
  }
  return body;
}

/**
 * THE TEXT A PERSON WROTE, out of a MIME message: the `text/plain` leaf (decoded), else the
 * `text/html` leaf with its tags stripped, else the body after the headers. A message that is not
 * MIME at all (a test fixture, a plain body) is returned as it is. This is what a card's
 * "WHAT WAS ASKED" must carry — on 21 Sep 2026 the first real request reached Porter as 6,000
 * characters of `Received:` and DKIM headers, and the words themselves were lost.
 */
export function textBodyOf(raw: string): string {
  const text = raw ?? "";
  const headerEnd = text.search(/\r?\n\r?\n/);
  const looksMime = /^[A-Za-z-]+:\s/.test(text) && headerEnd > 0 && /^(?:received|from|to|subject|content-type|mime-version|date|message-id|dkim-signature|return-path|x-[a-z-]+):/im.test(text.slice(0, headerEnd));
  if (!looksMime) return text;
  const boundary = boundaryOf(text);
  const parts = boundary ? leafParts(text, boundary) : [text];
  const decoded = decodePartBody;
  const plain = parts.find((p) => (headerIn(p, "content-type") ?? "").toLowerCase().startsWith("text/plain") && !/attachment/i.test(headerIn(p, "content-disposition") ?? ""));
  if (plain) return decoded(plain).replace(/\r\n/g, "\n").trim();
  const html = parts.find((p) => (headerIn(p, "content-type") ?? "").toLowerCase().startsWith("text/html"));
  if (html) {
    return decoded(html)
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
  return boundary ? "" : decoded(text).replace(/\r\n/g, "\n").trim();
}

/** The bytes of one named attachment, decoded. Null when the message carries no such file. */
export function attachmentBytes(raw: string, filename: string): { bytes: Uint8Array; mediaType: string } | null {
  const { attachments } = attachmentsOf(raw, () => true, 50);
  const hit = attachments.find((a) => a.filename === filename);
  if (!hit) return null;
  try {
    const bin = atob(hit.dataBase64);
    return { bytes: Uint8Array.from(bin, (c) => c.charCodeAt(0)), mediaType: hit.mediaType };
  } catch {
    return null;
  }
}

function attachmentsOf(raw: string, accept: (type: string, sentAsFile: boolean) => boolean, max = MAX_ATTACHMENTS): { attachments: Attachment[]; unread: string[] } {
  const attachments: Attachment[] = [];
  const unread: string[] = [];

  const boundary = boundaryOf(raw);
  if (!boundary) return { attachments, unread };

  /*
   * Split on the declared boundary, WITHOUT a regular expression.
   *
   * It used to escape the boundary and build a RegExp, and the escape did not work. The character
   * class read `/[.*+?^${}()|[\\]\\\\]/` — the `\\` closed the escape and the following `]` ended
   * the class, so the pattern was "one metacharacter followed by a literal `\\]`", which matches
   * nothing a boundary ever contains. Every boundary went into `new RegExp` UNESCAPED.
   *
   * RFC 2046 allows `(`, `)`, `+`, `?`, `.`, `/`, `:`, `=` and `'` in a boundary, and real clients
   * use them. So a boundary with a `+` or a `?` in it mis-split the message and the deck was
   * silently dropped, and an unbalanced `(` made `new RegExp` THROW — which, from inside the email
   * handler, loses the entire message: no event, no card, no capture. Exactly the class of silent
   * loss the rest of this file exists to prevent.
   *
   * `String.prototype.split` with a plain string needs no escaping at all, cannot throw on a legal
   * boundary, and is what this always wanted. The regex was never buying anything.
   */
  const parts = leafParts(raw, boundary);

  for (const part of parts) {
    const type = (headerIn(part, "content-type") ?? "").toLowerCase();
    if (type.startsWith("multipart/")) continue;
    // A part the client marked as an attachment is a file she sent, whatever its type (a .csv too).
    const sentAsFile = (headerIn(part, "content-disposition") ?? "").toLowerCase().startsWith("attachment");
    if (!accept(type, sentAsFile)) continue;
    // A text/html leaf is never a file; an unnamed image with no disposition is a body decoration.
    if (type.startsWith("text/") && !sentAsFile) continue;

    const filename = filenameIn(part);
    if (attachments.length >= max) {
      unread.push(`${filename} (only the first ${max} were taken)`);
      continue;
    }

    const encoding = (headerIn(part, "content-transfer-encoding") ?? "").toLowerCase();
    if (!encoding.includes("base64")) {
      // Anything else would need decoding this file does not do. Said, not guessed at.
      unread.push(`${filename} (sent as ${encoding || "an encoding this cannot read"})`);
      continue;
    }

    // The body is everything after the blank line that ends the part's headers.
    const split = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") + 4 : part.indexOf("\n\n") + 2;
    if (split <= 1) {
      unread.push(`${filename} (its content could not be found)`);
      continue;
    }

    const dataBase64 = part.slice(split).replace(/[\r\n]/g, "").trim();
    if (!dataBase64) {
      unread.push(`${filename} (it was empty)`);
      continue;
    }

    // Base64 is 4 characters per 3 bytes; close enough to refuse an oversized file without decoding
    // it, which is the whole point — measuring by decoding would cost what reading costs.
    const bytes = Math.floor((dataBase64.length * 3) / 4);
    if (bytes > MAX_ATTACHMENT_BYTES) {
      unread.push(`${filename} (${(bytes / 1024 / 1024).toFixed(1)}MB — too large to read here)`);
      continue;
    }

    attachments.push({ filename, mediaType: type.split(";")[0]!.trim() || "application/octet-stream", dataBase64, bytes });
  }

  return { attachments, unread };
}


/**
 * The readable text of a message: its subject, and every text part of the body.
 *
 * WHY THE OVERSIZE PATH NEEDS THIS. Operator, 23 Aug 2026: *"the subjects will all be different its
 * the #hashtag trigger that matters"*, and *"the hashtag can be in the subject or the body"*. A
 * message over the size cap is routed from its HEADERS ALONE, because walking a seven-megabyte MIME
 * tree does not fit in a Worker's 10ms of CPU — so a `#wpdeck` written in the body is invisible at
 * arrival, and both of Scooter's decks opened cards reading "It carries no trigger tag."
 *
 * The whole message is already stored, and the scheduled reader has its own CPU budget. So the
 * trigger scan happens THERE, over this text, rather than being missed at the door.
 *
 * Attachments are skipped deliberately: a hashtag inside a PDF is not a routing instruction, and
 * decoding megabytes of base64 to look for one is the cost this split exists to avoid.
 */
export function messageText(raw: string): { subject: string; body: string } {
  const subject = headerIn(unfoldHeaders(raw.split(/\r?\n\r?\n/)[0] ?? ""), "subject") ?? "";

  const boundary = boundaryOf(raw);
  if (!boundary) {
    // Not multipart: everything after the first blank line is the body.
    const split = raw.indexOf("\r\n\r\n") >= 0 ? raw.indexOf("\r\n\r\n") + 4 : raw.indexOf("\n\n") + 2;
    return { subject, body: split > 1 ? raw.slice(split, split + MAX_SCANNED_BODY) : "" };
  }

  const chunks: string[] = [];
  // Flattened for the same reason as the attachments above: on a forward the readable body sits
  // inside a nested multipart, and a one-level scan returns the wrapper instead of the words.
  for (const part of leafParts(raw, boundary)) {
    const type = (headerIn(part, "content-type") ?? "").toLowerCase();
    // text/plain and text/html only. An empty content-type is the preamble, not a part.
    if (!type.startsWith("text/")) continue;
    const encoding = (headerIn(part, "content-transfer-encoding") ?? "").toLowerCase();
    if (encoding.includes("base64")) continue; // Not decoded here; a trigger is rarely base64-only.
    const blank = part.indexOf("\r\n\r\n") >= 0 ? part.indexOf("\r\n\r\n") + 4 : part.indexOf("\n\n") + 2;
    if (blank > 1) chunks.push(part.slice(blank));
    if (chunks.join("").length > MAX_SCANNED_BODY) break;
  }
  return { subject, body: chunks.join("\n").slice(0, MAX_SCANNED_BODY) };
}

/** Enough to carry a forwarded chain and its tags; not so much that scanning it costs real time. */
const MAX_SCANNED_BODY = 256 * 1024;


/**
 * A deck that arrived as something this cannot open — named precisely, never as silence.
 *
 * Operator, 24 Aug 2026, on the PDF-only limit: decks also arrive as `.pptx`, as Keynote, and as
 * Docsend or Google Slides LINKS. The reader refuses anything that is not `application/pdf`, which
 * is correct — handing a model a file it cannot open and believing the answer is worse than
 * refusing — but the refusal read "The message carried no PDF this can read", which is true of the
 * parser and useless to a partner. It does not say a 9MB Keynote was sitting right there.
 *
 * This does not convert anything and does not pretend to. It reports WHAT ARRIVED so the card can
 * say it, which is the difference between "we cannot read this" and "nothing was there".
 */
const DECK_LIKE_TYPES: ReadonlyArray<{ match: RegExp; called: string }> = [
  { match: /presentationml|\.pptx?$/i, called: "a PowerPoint file" },
  { match: /keynote|\.key$/i, called: "a Keynote file" },
  { match: /opendocument\.presentation|\.odp$/i, called: "an OpenDocument presentation" },
  { match: /msword|wordprocessingml|\.docx?$/i, called: "a Word document" },
];

export function unreadableDeckAttachments(raw: string): string[] {
  const boundary = boundaryOf(raw);
  if (!boundary) return [];

  const found: string[] = [];
  for (const part of leafParts(raw, boundary)) {
    const type = (headerIn(part, "content-type") ?? "").toLowerCase();
    if (!type || type.includes("application/pdf") || type.startsWith("text/") || type.startsWith("multipart/")) continue;
    const filename = filenameIn(part);
    const known = DECK_LIKE_TYPES.find((k) => k.match.test(type) || k.match.test(filename));
    if (known) found.push(`${filename} (${known.called})`);
  }
  return found.slice(0, MAX_ATTACHMENTS);
}

/**
 * Deck links in the body, which is how a lot of decks travel now.
 *
 * SURFACED, NOT FETCHED, and that boundary is deliberate. Docsend gates on an email address and
 * Google Slides needs paging through slides — the browser tool this system has reads one page of
 * text and shoots above the fold, which would capture a title slide and nothing else. Reporting the
 * link so a person can open it is honest; claiming to have read a deck from a screenshot of slide
 * one would be the same over-claim this whole review keeps removing.
 */
const DECK_HOSTS = /https:\/\/(?:www\.)?(docsend\.com|drive\.google\.com|docs\.google\.com|dropbox\.com|notion\.so|figma\.com|canva\.com|pitch\.com)\/[^\s"'<>)\]]+/gi;

export function deckLinks(text: string): string[] {
  const seen = new Set<string>();
  for (const m of text.matchAll(DECK_HOSTS)) {
    // Trailing punctuation from prose, and the tracking noise a forward adds.
    const url = m[0].replace(/[.,;:]+$/, "");
    seen.add(url.slice(0, 300));
    if (seen.size >= 5) break;
  }
  return [...seen];
}

/**
 * A SECRET'S VALUE, SCRUBBED OUT OF A STORED MESSAGE (0253, 6 Oct 2026). A partner may email
 * `SECRET NAME=value`; once the Worker has the value encrypted, the `.eml` in R2 must not keep it.
 * The value is replaced with `marker` wherever it appears plainly (headers, a 7bit body), and every
 * TEXT part whose DECODED body carries it (base64 or quoted-printable — Gmail sends both) is
 * re-emitted as an 8bit part with the value replaced, so a reader that decodes the message never
 * finds it either. Attachments and every other part are left byte-for-byte as they were: the
 * `request_attachment` rows read their bytes out of this same key on demand.
 */
export function scrubSecretValues(raw: string, values: readonly string[], marker = "[secret redacted]"): string {
  const wanted = values.filter((v) => typeof v === "string" && v.length >= 4);
  if (!wanted.length || !raw) return raw;
  const replaceAll = (text: string): string => wanted.reduce((acc, v) => acc.split(v).join(marker), text);
  let out = replaceAll(raw);
  const boundary = boundaryOf(out);
  const parts = boundary ? leafParts(out, boundary) : [out];
  for (const part of parts) {
    const type = (headerIn(part, "content-type") ?? "").toLowerCase();
    const isText = boundary ? type.startsWith("text/") : true;
    if (!isText) continue;
    const decoded = decodePartBody(part);
    if (!wanted.some((v) => decoded.includes(v))) continue;
    const split = part.search(/\r?\n\r?\n/);
    const headers = (split === -1 ? part : part.slice(0, split)).replace(/^content-transfer-encoding:.*(?:\r?\n[ \t]+.*)*\r?\n?/gim, "").replace(/\r?\n$/, "");
    const rebuilt = `${headers}\r\nContent-Transfer-Encoding: 8bit\r\nX-WP-OS-Scrubbed: secret redacted; part re-encoded\r\n\r\n${replaceAll(decoded)}\r\n`;
    out = out.replace(part, rebuilt);
  }
  return out;
}

/** True when any value is still readable in the message — plainly, or in any decoded text part. Used by the guard. */
export function carriesSecretValue(raw: string, values: readonly string[]): boolean {
  const wanted = values.filter((v) => typeof v === "string" && v.length >= 4);
  if (!wanted.length || !raw) return false;
  if (wanted.some((v) => raw.includes(v))) return true;
  const boundary = boundaryOf(raw);
  const parts = boundary ? leafParts(raw, boundary) : [raw];
  return parts.some((part) => {
    const decoded = decodePartBody(part);
    return wanted.some((v) => decoded.includes(v));
  });
}
