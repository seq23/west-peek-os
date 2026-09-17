/**
 * MATCHING A REPLY TO THE THING IT IS ABOUT — automatically, invisibly, with nothing for anybody to
 * preserve or strip (17 Sep 2026).
 *
 * ─── WHY NOT A SUBJECT CODE ────────────────────────────────────────────────────────────────────
 *
 * Rejected on purpose. A subject is RFC 2047 encoded the moment it carries an em-dash or an accent,
 * and this repo has already lost a live trigger to exactly that: the first real routing test arrived
 * as `=?UTF-8?Q?=23wpdealflow_Northwind_Robotics_=E2=80=94_seed?=` and the `#` became `=23`. It
 * survived only because the body happened to repeat it. A code in a subject is a code that
 * disappears the first time somebody's client decides the line is non-ASCII — and the partner would
 * have no way to know.
 *
 * ─── WHY NOT `provider_message_id`, WHICH IS THE OBVIOUS ANSWER AND IS WRONG ────────────────────
 *
 * The receipt already records a `provider_message_id`, so matching a reply's `In-Reply-To` against
 * it looks like a one-line feature. It would silently never match. CONFIRMED against both
 * transports' own documentation, 17 Sep 2026:
 *
 *   · RESEND returns `{"id": "<uuid>"}` from POST /emails — a bare UUID with no domain and no angle
 *     brackets. The RFC 5322 Message-ID is a DIFFERENT value, exposed only later on
 *     GET /emails/{id} as `message_id`. Resend sends through Amazon SES, and SES overrides any
 *     Message-ID a caller supplies with its own `<…@email.amazonses.com>`. So the id the header
 *     will carry is not merely a different string from the one we store — it is not knowable at the
 *     moment we send.
 *   · CLOUDFLARE returns `{ messageId }`, documented only as "Unique email ID" identifying the mail
 *     in Cloudflare's logs. `Message-ID` is on its platform-controlled header list — setting one is
 *     refused with `E_HEADER_NOT_ALLOWED` — and nothing in the documentation says the returned
 *     string is the wire header. Assuming it is would be a match that looks right and is not.
 *
 * A failed match here does not error. It falls through to "an email nobody could place", which
 * looks exactly like working software. That is the class of defect this repo names "runs but
 * inert", and it is why the answer is not a cleverer read of a provider id.
 *
 * ─── WHAT IS USED INSTEAD: OUR OWN TOKEN, IN `References` ───────────────────────────────────────
 *
 * Both transports REFUSE to let us set `Message-ID` and both EXPLICITLY ALLOW us to set
 * `References` (Cloudflare lists it as settable; Resend documents `headers` with `In-Reply-To` and
 * `References` by name). And the threading rule every mail client implements is:
 *
 *     a reply's `References` = the original's `References`, plus the original's `Message-ID`.
 *
 * So a token we put in `References` on the way out comes back in `References` on the way in,
 * whatever the provider did with `Message-ID`, and whatever the subject became. It is invisible in
 * every client, there is nothing for a person to copy, and a partner who trims the quoted text or
 * rewrites the subject cannot break it.
 *
 * ─── AND DELIBERATELY NO TOKEN OF THE PACKET KIND ──────────────────────────────────────────────
 *
 * This is NOT the packet keep/dismiss token and must not be read as one. That token is a
 * CAPABILITY: it is unguessable, single-use and expiring because a forged reply carrying it would
 * commit the firm to a date and a budget, and because the code must survive being forwarded to
 * somebody who then holds the decision.
 *
 * A thread token is an ADDRESS, not a permission. It says which conversation a reply belongs to and
 * grants nothing. Steering a search is not destructive: the worst a forged reply can do is waste a
 * week of a search nobody has to act on. So the bar is the one the mailbox already applies to
 * everything else — the sender authenticated, and is one of the two partners — and nothing is
 * spent, expired or made single-use. Recognising the sender is enough, and adding a capability
 * token here would be security theatre that a partner pays for in lost replies.
 */

/** The token itself: `wpt_` and 32 hex characters. Long enough to be unique, not a secret. */
export const THREAD_TOKEN_RE = /wpt_[0-9a-f]{32}/gi;

/**
 * The domain the token's msg-id is written under.
 *
 * `joinwestpeek.com` — the app's own domain, where the machine inbox already lives. A `Message-ID`
 * style token must look like one (`local@domain`) or a client is entitled to drop it from the
 * `References` chain it rebuilds.
 */
export const THREAD_ID_DOMAIN = "joinwestpeek.com";

export function mintThreadToken(): string {
  // crypto.randomUUID is available in Workers and in the test runtime; the hyphens go because the
  // token has to be one `atom` inside a msg-id.
  return `wpt_${crypto.randomUUID().replace(/-/g, "")}`;
}

/** The header value: `<wpt_…@joinwestpeek.com>`. Valid as a msg-id, which is what makes it survive. */
export function threadReference(token: string): string {
  return `<${token}@${THREAD_ID_DOMAIN}>`;
}

/**
 * Every thread token in the `In-Reply-To` and `References` headers of an arriving message.
 *
 * BOTH HEADERS, because clients disagree about which they populate: some write only `In-Reply-To`
 * on a direct reply, and a long thread accumulates the chain in `References`. Reading both costs
 * nothing and missing one costs the whole feature.
 *
 * Returned NEWEST FIRST — `References` is chronological, so the last token in it is the message
 * being answered. A reply into a long thread therefore resolves to the most recent of our messages
 * it descends from, not the one that started the conversation.
 */
export function threadTokensIn(headers: { inReplyTo?: string | null; references?: string | null }): string[] {
  const found: string[] = [];
  for (const value of [headers.references, headers.inReplyTo]) {
    if (!value) continue;
    const matches = value.match(THREAD_TOKEN_RE) ?? [];
    for (const m of matches) found.push(m.toLowerCase());
  }
  // Newest first: reverse each header's chronological order, then de-duplicate keeping the first.
  const ordered = found.reverse();
  return [...new Set(ordered)];
}

/**
 * What an outbound message carries so its replies can be recognised.
 *
 * `In-Reply-To` is set as well as `References` because a few clients thread on it alone, and a
 * message that starts a conversation may name itself: both point at the same token, which is the
 * one thing this system will recognise later.
 */
export function threadHeaders(token: string): Record<string, string> {
  const ref = threadReference(token);
  return { References: ref, "In-Reply-To": ref };
}

/** What the thread is about, so a matched reply knows where to go. */
export interface EmailThreadRow {
  token: string;
  object_type: string;
  object_id: string;
  /**
   * The `work_card.kind`, when the conversation is about one.
   *
   * THE KIND AND NOT ONLY THE CARD, because a recurring duty opens a new card every week and closes
   * it the same day. A reply that arrives on Thursday answers a card that is already DONE; carried
   * as a kind, it steers next Monday's run instead of a row nothing will read again.
   */
  card_kind: string | null;
  /** The employee whose note it was, for the card and for the event trail. */
  employee: string | null;
  /** Who it was addressed to, before any preview redirect. */
  to_address: string;
  subject: string;
  /** Whatever the transport called its own id. Recorded for the audit trail, never matched on. */
  provider_message_id: string | null;
  provider: string | null;
  firm_scope: string;
  created_at: string;
}
