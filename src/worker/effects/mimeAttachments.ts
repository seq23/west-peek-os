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
  const parts = raw.split(`--${boundary}`);

  for (const part of parts) {
    const type = (headerIn(part, "content-type") ?? "").toLowerCase();
    if (!type.includes("application/pdf")) continue;

    const filename = filenameIn(part);
    if (attachments.length >= MAX_ATTACHMENTS) {
      unread.push(`${filename} (only the first ${MAX_ATTACHMENTS} were taken)`);
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

    attachments.push({ filename, mediaType: "application/pdf", dataBase64, bytes });
  }

  return { attachments, unread };
}
