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
  /** Whatever the transport called its own id. Never matched as a string; its UUIDv7 clock is (`threadForSesIds`). */
  provider_message_id: string | null;
  provider: string | null;
  firm_scope: string;
  created_at: string;
}

/*
 * ─── AND WHEN THE TOKEN DOES NOT COME BACK: THE SES ID'S OWN CLOCK (18 Nov 2026) ─────────────────
 *
 * MEASURED: Gmail does not carry our `References` token back. Every one of Scooter's replies since
 * September names only the SES Message-ID (`<010001a1ec56567f-…@email.amazonses.com>`), so a reply
 * was matched only when its subject still read "Re: <our subject>". On 18 Nov he answered Porter's
 * privacy-page preview under a subject of his own ("GA tags + privacy pages: verify first, then ship
 * together"), and the OS asked him which job he meant — the job his reply was a reply to.
 *
 * Both ids carry the send time to the millisecond: Resend's id is a UUIDv7 (first 48 bits = ms since
 * the epoch) and the SES Message-ID is `0100` + 12 hex digits of the same clock, stamped a few hundred
 * ms later when Resend hands the mail to SES (five of his replies: 253–362 ms, one candidate each in a
 * 60 s window). So a reply's SES id names the one email we sent that partner in the seconds before it.
 * More than one candidate in the window is not guessed: it returns null and the old ladder runs.
 */
const SES_ID_RE = /<?0100([0-9a-f]{12})-[0-9a-f-]+@[a-z0-9.-]*amazonses\.com>?/gi;
/** The gap allowed between Resend accepting a mail and SES stamping it. Measured: under 0.4 s. */
export const SES_STAMP_WINDOW_MS = 5_000;

/** The send times (ms) of every SES Message-ID in the threading headers, the answered message first. */
export function sesSentTimesIn(headers: { inReplyTo?: string | null; references?: string | null }): number[] {
  const times: number[] = [];
  const refs = [...(headers.references ?? "").matchAll(SES_ID_RE)].map((m) => m[1] ?? "").reverse();
  const irt = [...(headers.inReplyTo ?? "").matchAll(SES_ID_RE)].map((m) => m[1] ?? "");
  for (const hex of [...irt, ...refs]) {
    if (!hex) continue;
    const t = parseInt(hex, 16);
    if (Number.isFinite(t) && !times.includes(t)) times.push(t);
  }
  return times;
}

/** The ms clock in a Resend id (UUIDv7), or null for any other shape. */
export function resendSentAt(providerMessageId: string | null | undefined): number | null {
  const m = /^([0-9a-f]{8})-([0-9a-f]{4})-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec((providerMessageId ?? "").trim());
  return m ? parseInt(`${m[1]}${m[2]}`, 16) : null;
}

/**
 * The one thread a reply's SES Message-ID points at, among the threads sent to that partner; null when
 * none, or when two sends fall in the same window (never a guess). Pure, so it is tested on real ids.
 */
export function threadForSesIds<T extends { provider: string | null; provider_message_id: string | null }>(
  headers: { inReplyTo?: string | null; references?: string | null },
  sent: readonly T[],
): T | null {
  for (const stamped of sesSentTimesIn(headers)) {
    const hits = sent.filter((r) => {
      if ((r.provider ?? "").toLowerCase() !== "resend") return false;
      const at = resendSentAt(r.provider_message_id);
      return at !== null && stamped - at >= 0 && stamped - at <= SES_STAMP_WINDOW_MS;
    });
    if (hits.length === 1) return hits[0] ?? null;
    if (hits.length > 1) return null;
  }
  return null;
}
