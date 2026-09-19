import type { APIRequestContext } from "@playwright/test";

/**
 * Delivering a real message to the Worker's `email()` handler, locally.
 *
 * WHY THIS IS POSSIBLE AT ALL, AND WHY IT MATTERS. The inbound mailbox is the one surface the firm
 * does not control the input of, and it is where this system has already lost a real deck: a 7MB
 * message arrived at 03:29, was logged `too_large`, and was discarded silently — the operator found
 * out by asking. Everything downstream of `email()` had unit coverage; the handler itself had none,
 * because nothing could deliver a message to it.
 *
 * `wrangler dev` can. Miniflare exposes the email entry point at `POST /cdn-cgi/handler/email`
 * with `from` and `to` as query parameters and the raw RFC822 message as the body, and drives the
 * exact same `ForwardableEmailMessage` shape production does — envelope sender, parsed headers,
 * `rawSize`, and `raw` as a stream. So these journeys go through the real handler rather than
 * around it.
 *
 * TWO LOCAL LIMITS, both of which the journeys are written around:
 *   • miniflare refuses a message over 1MiB (production allows 25MiB). The oversize journey
 *     therefore uses a message comfortably over the handler's own 256KB parse cap and under 1MiB —
 *     which is the boundary being tested, not the platform's.
 *   • a `Message-ID` header is required, or miniflare rejects the message before the Worker sees it.
 */

/** A minimal but structurally real PDF — enough that the MIME part is genuinely `application/pdf`. */
export function tinyPdfBase64(padTo = 0): string {
  const body =
    "%PDF-1.4\n" +
    "1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    `% ${"padding ".repeat(Math.max(0, padTo))}\n` +
    "trailer<</Root 1 0 R>>\n%%EOF\n";
  return Buffer.from(body, "utf8").toString("base64");
}

export interface MailPart {
  contentType: string;
  /** Omitted for an inline text part. */
  filename?: string;
  /** `base64` for an attachment; anything else is sent verbatim. */
  encoding?: "base64";
  body: string;
}

export interface Mail {
  from: string;
  to?: string;
  subject: string;
  /** A simple message body. Ignored when `parts` is given. */
  body?: string;
  parts?: MailPart[];
  /** Extra headers, e.g. a forwarding trail. */
  headers?: Record<string, string>;
  /** Envelope sender, when it deliberately differs from the `From:` header (a relay, a forward). */
  envelopeFrom?: string;
}

/** Fold a base64 blob into MIME-legal 76-character lines. */
function fold(b64: string): string {
  return (b64.match(/.{1,76}/g) ?? []).join("\r\n");
}

export function buildMessage(mail: Mail): string {
  const to = mail.to ?? "os@joinwestpeek.com";
  const messageId = `<wpos-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com>`;
  const head = [
    `From: ${mail.from}`,
    `To: ${to}`,
    `Subject: ${mail.subject}`,
    `Message-ID: ${messageId}`,
    "MIME-Version: 1.0",
    ...Object.entries(mail.headers ?? {}).map(([k, v]) => `${k}: ${v}`),
  ];

  if (!mail.parts) {
    return [...head, "Content-Type: text/plain; charset=utf-8", "", mail.body ?? "", ""].join("\r\n");
  }

  /*
   * A boundary containing characters that are LEGAL in a boundary and special in a regular
   * expression. RFC 2046 allows `(`, `)`, `+`, `?`, `.`, `/`, `:`, `=` and `'` in a boundary, and
   * real clients use them — so a MIME reader that splices the boundary into a RegExp without
   * escaping it either mis-splits the message or throws, and an attachment is lost either way.
   * Using one here means the journeys exercise that, rather than only the alphanumeric happy path.
   */
  const boundary = "wp(e2e)+bound?ary_1";
  const body = mail.parts
    .map((p) =>
      [
        `--${boundary}`,
        `Content-Type: ${p.contentType}${p.filename ? `; name="${p.filename}"` : ""}`,
        ...(p.filename ? [`Content-Disposition: attachment; filename="${p.filename}"`] : []),
        ...(p.encoding === "base64" ? ["Content-Transfer-Encoding: base64"] : []),
        "",
        p.encoding === "base64" ? fold(p.body) : p.body,
      ].join("\r\n"),
    )
    .join("\r\n");

  return [...head, `Content-Type: multipart/mixed; boundary="${boundary}"`, "", body, `--${boundary}--`, ""].join("\r\n");
}

/**
 * Deliver a message and wait for the handler to finish with it.
 *
 * The handler is AWAITED inside `email()` rather than continued in `waitUntil`, so by the time this
 * responds every event, card and stored object it produces already exists — there is nothing to
 * poll for. (It had to be: `message.raw` is tied to the delivery of that message, and reading it
 * after the handler returned failed with "ReadableStream received over RPC disconnected
 * prematurely", losing the mail entirely.)
 */
export async function deliverMail(request: APIRequestContext, mail: Mail): Promise<void> {
  const to = mail.to ?? "os@joinwestpeek.com";
  const envelope = mail.envelopeFrom ?? addressOf(mail.from);
  const raw = buildMessage(mail);
  const url = `/cdn-cgi/handler/email?from=${encodeURIComponent(envelope)}&to=${encodeURIComponent(to)}`;
  // A TRANSPORT DROP IS RETRIED, A REFUSAL IS NOT. Under load the dev harness answers 500
  // "Network connection lost" after the handler has finished; a relay would retry, and the handler
  // is idempotent by Message-ID (`inbound_email_seen`), so the retry either lands or is a no-op.
  // Any other status is the handler's own verdict and is reported as it was.
  for (let attempt = 1; ; attempt += 1) {
    const res = await request.post(url, { headers: { "content-type": "message/rfc822" }, data: raw });
    if (res.status() === 200) return;
    const text = await res.text();
    if (res.status() === 500 && /Network connection lost/i.test(text) && attempt < 3) continue;
    throw new Error(`the local email handler refused the message (HTTP ${res.status()}): ${text}`);
  }
}

/** `Name <a@b.c>` → `a@b.c`. */
export function addressOf(header: string): string {
  const angled = /<([^>]+)>/.exec(header);
  return (angled ? angled[1]! : header).trim();
}
