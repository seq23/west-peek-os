/**
 * EVERY BRAND EMAIL ENDS WITH OUR MAILING ADDRESS (owner, 1 Nov 2026; west-peek brain, Settled decisions). Wynn's
 * pitches, her follow-up and every answer to a brand close with a small, muted line under the signature (and under
 * the email-1 P.S.): the public mailbox below. It replaces the earlier "no postal address in brand emails" rule. The
 * soft human P.S. stays; there is still no "reply unsubscribe" line.
 *
 * ONE CONSTANT, ONE FUNCTION. Every builder (shared/tlc/learningClub.ts, ownerInstruction.ts, the reply drafts in
 * worker/services/tlcBrandReply.ts), every place a brand email is filed for approval, the weekly approval email's
 * previews and the executor's brand lane all go through `withBrandFooter`, so what she approves is what goes out and
 * nothing copies the address. It is idempotent: a body that already ends with the footer is returned unchanged.
 * The HTML part (`brandEmailHtml`) is the same text with the footer set small and grey.
 */
export const BRAND_MAILING_ADDRESS = "3055 Lombard St #471024, San Francisco, CA 94147";

/** The text, ending with exactly one mailing-address footer, a blank line under the last line of the email. */
export function withBrandFooter(text: string): string {
  let body = text.trimEnd();
  while (body.endsWith(BRAND_MAILING_ADDRESS)) body = body.slice(0, -BRAND_MAILING_ADDRESS.length).trimEnd();
  return `${body}\n\n${BRAND_MAILING_ADDRESS}`;
}

/** The words above the footer: what a redraft or a "words only" reader works from. */
export function withoutBrandFooter(text: string): string {
  let body = text.trimEnd();
  while (body.endsWith(BRAND_MAILING_ADDRESS)) body = body.slice(0, -BRAND_MAILING_ADDRESS.length).trimEnd();
  return body;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The HTML alternative of a brand email: her words exactly as the plain-text part says them (no styling on the body,
 * so it reads like a person's email), then the address small and muted.
 */
export function brandEmailHtml(text: string): string {
  const body = withoutBrandFooter(text)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 1em">${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
  return `<div>\n${body}\n<p style="margin:1.5em 0 0;font-size:11px;line-height:1.4;color:#9a9a9a">${esc(BRAND_MAILING_ADDRESS)}</p>\n</div>`;
}
