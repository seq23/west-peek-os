/**
 * DECIDING A PACKET BY REPLYING TO THE EMAIL — a token minted per packet (17 Sep 2026).
 *
 * Operator: "you can have Parker give us a special #hashtag to use and anything after that is the
 * reason?" Yes — with one change, which this codebase already argues for in `effects/inboundEmail.ts`:
 *
 *   "A hashtag is a public word — so it may route but must never authorise."
 *
 * That sentence is why `#wpdealflow` files a capture instead of creating an opportunity. A FIXED
 * public tag like `#wpno` would be exactly the thing that rule forbids: anyone who ever learned it
 * — a forwarded email, a screenshot, a contractor who saw one — could kill a month's plan by
 * writing it in a message. So the tag is minted PER PACKET.
 *
 * ─── The threat model, and what each control actually stops ────────────────────────────────────
 *
 *   A GUESSED TAG. 4 characters from a 31-letter alphabet is ~923,000 per packet, and a wrong
 *   token matches no row at all — there is nothing to brute force against, because a miss is a
 *   capture on Porter's desk rather than an error a prober can read.
 *
 *   A LEAKED TAG. The token alone does nothing: the reply must ALSO come from an authenticated
 *   assigning partner (`mailAuthority`, the same bar an emailed assignment clears — SPF/DKIM/DMARC
 *   through the trusted resolver, and one of two addresses). A screenshot of the email is not a
 *   credential.
 *
 *   A FORGED `From`. The address alone does nothing either: without the token there is no packet
 *   to decide, and without authentication the address is an untrusted string. Both, or nothing.
 *
 *   A REPLAYED THREAD. Single use, and it expires with the month it belongs to. Somebody digging
 *   up October's email in February cannot cancel February's work, and a partner who replies twice
 *   does not re-decide a packet that has already been decided.
 *
 *   A MISREAD REPLY. Handled by refusing to guess — see `readReply` below. A reply that cannot be
 *   read confidently becomes a capture on Porter's desk. A misread that cancels the wrong month is
 *   far worse than a human glancing at one email.
 *
 * ─── Why the token lives in this file and the decision does not ────────────────────────────────
 *
 * Minting, formatting and READING are pure — no database, no environment — so the parser can be
 * tested against the real shapes a reply arrives in (quoted originals, Outlook's header block,
 * both tokens visible in the quote below the answer) without a mail runtime. Deciding is in
 * `worker/services/packetReplyDecision.ts`, and it does NOT re-implement a decision: it calls
 * `decidePacket`, the same function the in-app button calls, so there is one decision path with
 * one status, one note, one event and one shelf.
 */

/**
 * The alphabet. No O/0, no I/1/L — a token is read off a screen and retyped by a person on a
 * phone, and a pair a human cannot tell apart is a support problem disguised as a security one.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const TOKEN_LENGTH = 4;

export const KEEP_PREFIX = "#wpkeep";
export const NO_PREFIX = "#wpno";

export type PacketDecisionWord = "KEEP" | "NO";

/** `#wpkeep-7Q4K` / `#wpno-7Q4K`. One token per packet; the word says which way. */
export function tagFor(word: PacketDecisionWord, token: string): string {
  return `${word === "KEEP" ? KEEP_PREFIX : NO_PREFIX}-${token}`;
}

/**
 * A fresh token. `crypto.getRandomValues` rather than `Math.random`, because this is the only
 * secret in the scheme and a predictable one is not a secret.
 */
export function mintToken(random: Crypto = crypto): string {
  const bytes = new Uint8Array(TOKEN_LENGTH);
  random.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}

/**
 * The month a token dies with. A packet proposed FOR November expires at the end of November: the
 * decision is only meaningful while the thing it decides has not happened.
 */
export function expiryFor(proposedForMonth: string): string {
  const [y, m] = proposedForMonth.split("-").map(Number);
  if (!y || !m) return "9999-12-31T23:59:59.999Z";
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return `${next}T00:00:00.000Z`;
}

export interface ReplyRead {
  /** What the reply says to do, when it says one thing clearly. */
  decision: "APPROVED" | "DECLINED" | null;
  token: string | null;
  /** Everything the writer typed after the tag, which is the reason. */
  reason: string | null;
  /**
   * Set when the message carries a tag but cannot be read CONFIDENTLY — two different answers, two
   * different packets, a tag with no token. The caller files a capture for Porter rather than
   * guessing. Null when there is nothing to read at all (an ordinary email), which is not a
   * problem and routes as it always did.
   */
  unsure: string | null;
}

const TAG = new RegExp(`(${KEEP_PREFIX}|${NO_PREFIX})-([A-Z0-9]{${TOKEN_LENGTH},12})\\b`, "gi");

/**
 * THE PART THE ORIGINAL EMAIL IS QUOTED INTO, REMOVED FIRST — and without this the whole scheme
 * reads the wrong thing every time.
 *
 * Parker's email spells out BOTH tags, with a worked example of each, because item 9 requires that
 * nobody has to remember the scheme. Every reply therefore quotes both `#wpkeep-7Q4K` AND
 * `#wpno-7Q4K` below whatever the partner typed. Scanning the whole body would find two
 * contradictory answers in literally every reply, and picking "the first one" would be picking
 * whichever the mail client happened to place higher.
 *
 * So only the NEW text counts: everything above the first quote marker, and no line that is
 * quoted. The three shapes that actually arrive are the three `forwardedOrigin` already handles —
 * Gmail's "On … wrote:", Apple Mail's "Begin forwarded message:", Outlook's rule line — plus `>`
 * quoting, which every client uses in the plain-text part.
 */
export function newTextOf(body: string): string {
  const markers = [
    /^\s*On .{0,200}wrote:\s*$/im,
    /^\s*-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^\s*Begin forwarded message:\s*$/im,
    /^\s*_{10,}\s*$/m,
    /^\s*From:\s*.+$/im,
  ];
  let cut = body.length;
  for (const m of markers) {
    const hit = m.exec(body);
    if (hit && hit.index < cut) cut = hit.index;
  }
  return body
    .slice(0, cut)
    .split(/\r?\n/)
    .filter((l) => !/^\s*>/.test(l))
    .join("\n");
}

/**
 * Read a reply. Pure, and deliberately unwilling to guess.
 *
 * `unsure` is returned rather than a best effort whenever the new text carries more than one
 * answer, more than one packet, or a tag with nothing usable after it. A capture on Porter's desk
 * costs a person ten seconds; a misread that declines the wrong month costs a month.
 */
export function readReply(body: string): ReplyRead {
  const fresh = newTextOf(body);
  const hits = [...fresh.matchAll(TAG)];
  if (hits.length === 0) {
    // Nothing to read. Not an error: it is an ordinary email and routes as one. But a body that
    // mentions a tag WITHOUT a token is somebody trying to answer and getting it wrong, and that
    // is worth a person's eyes rather than silence.
    const bare = new RegExp(`(${KEEP_PREFIX}|${NO_PREFIX})(?![-A-Z0-9])`, "i").test(fresh);
    return { decision: null, token: null, reason: null, unsure: bare ? "the reply uses the keep/no tag but without the code from the email, so I could not tell which packet it is about" : null };
  }

  const answers = hits.map((h) => ({
    decision: h[1]!.toLowerCase() === KEEP_PREFIX ? ("APPROVED" as const) : ("DECLINED" as const),
    token: h[2]!.toUpperCase(),
    end: h.index! + h[0].length,
  }));
  const tokens = [...new Set(answers.map((a) => a.token))];
  const decisions = [...new Set(answers.map((a) => a.decision))];
  if (tokens.length > 1) {
    return { decision: null, token: null, reason: null, unsure: `the reply carries ${tokens.length} different codes (${tokens.join(", ")}), so I could not tell which packet it is about` };
  }
  if (decisions.length > 1) {
    return { decision: null, token: tokens[0]!, reason: null, unsure: "the reply says both keep and no, so I could not tell which was meant" };
  }

  const last = answers[answers.length - 1]!;
  const reason = fresh.slice(last.end).replace(/^[\s:,.–—-]+/, "").trim();
  return {
    decision: last.decision,
    token: last.token,
    // Everything after the tag is the reason, exactly as she asked. Empty is allowed — a bare
    // "#wpkeep-7Q4K" is a complete answer.
    reason: reason.length > 0 ? reason.slice(0, 2000) : null,
    unsure: null,
  };
}

/**
 * The paragraph the email carries, so nobody has to remember the scheme. Plain language, no IDs a
 * human has to copy, and a worked example of BOTH answers — item 9: "the mail in front of them
 * says how to answer it."
 */
export function howToAnswer(input: { token: string; what: string }): string[] {
  return [
    `**To keep it:** reply with \`${tagFor("KEEP", input.token)}\` — for example: "${tagFor("KEEP", input.token)} yes, book it for the 12th".`,
    `**To say no:** reply with \`${tagFor("NO", input.token)}\` and your reason — for example: "${tagFor("NO", input.token)} too close to the holidays, try January".`,
    "Anything you type after the code is the reason, and it is kept with the decision.",
    `The code \`${input.token}\` belongs to this ${input.what} only, works once, and stops working at the end of the month it is for.`,
    "Just hit Reply — it comes straight back to me. If I cannot read your answer I will not guess; it goes to Porter and a person looks at it.",
  ];
}
