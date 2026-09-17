/**
 * WHAT A PERSON WROTE, AND WHAT THEIR MAIL CLIENT QUOTED BACK AT US (17 Sep 2026).
 *
 * ─── THE BUG THIS EXISTS TO FIX ────────────────────────────────────────────────────────────────
 *
 * `classifyInbound` scans `subject + the whole body` for trigger words. That is right for a fresh
 * message and wrong for a reply, because every mail client on earth quotes the message being
 * replied to underneath the answer. So:
 *
 *   Scooter sends  "#wpdealflow Northwind Robotics" to os@joinwestpeek.com  → a funnel entry opens.
 *   Scooter replies into that thread, "actually skip this one"              → his client quotes the
 *   original, the quote still contains `#wpdealflow`, the handler sees the tag AGAIN, and a SECOND
 *   funnel entry opens for a company he has just asked to drop.
 *
 * The same shape re-files a `#wpupdate`, re-proposes a `#wpnetwork` person, and — the case that
 * matters this week — re-triggers on anything in a note the firm itself sent, every time a partner
 * answers one in prose.
 *
 * Neutralising our own outbound tags (`defuseTriggers`) does not close it, and it is worth saying
 * why, because at a glance it looks as though it should. That guard rewrites tags in mail the
 * SYSTEM sends. It has nothing to say about a tag the PARTNER typed in the message he is now
 * replying to — which is the whole first paragraph of the case above.
 *
 * ─── THE RULE, AND WHY IT IS NARROW ────────────────────────────────────────────────────────────
 *
 * A REPLY is a message whose quoted text is something the firm has already seen. A FORWARD is a
 * message whose quoted text IS the payload — that is the mailbox's most common shape, stated in as
 * many words in `inboundEmail.ts`: "most of the emails to this inbox will be forwards and the
 * important info will be in the original email below". Scanning only the written part of a FORWARD
 * would break deal intake for the case it was built for.
 *
 * So the split is applied to replies and not to forwards, and "is this a reply" is answered from
 * the headers that exist precisely to say so — `In-Reply-To` and `References` — with a `Re:`
 * subject as the fallback for a client that omits them. A message carrying a forwarding marker in
 * its subject is never treated as a reply, because `Re: Fwd: …` means somebody replied to a forward
 * and the forwarded payload below is still the thing being discussed.
 *
 * ─── WHAT IS NOT DISCARDED ─────────────────────────────────────────────────────────────────────
 *
 * The quoted half is RETURNED, not dropped. Porter reads subject and the whole 256KB body, and a
 * reply's quoted original is what gives a bare "not this one" something to refer to — that is the
 * property the operator asked to keep. Nothing here reduces what a model is shown. It changes only
 * what may FIRE a trigger: the person's own words, never the machine's echo of them.
 */

/**
 * Where a quoted block starts, in the order a client is likely to have written it.
 *
 * FOUND FROM REAL SHAPES, not invented: Gmail and Apple Mail both write an attribution line ("On
 * <date>, <someone> wrote:"), Outlook writes either `-----Original Message-----` or a horizontal
 * rule of underscores followed by a `From:` block, and every client on earth prefixes quoted lines
 * with `>`. A reply that matches none of them is treated as entirely written, which is the safe
 * direction: it means a tag the person typed still fires.
 */
const QUOTE_MARKERS: readonly RegExp[] = [
  // Gmail / Apple Mail attribution. Deliberately loose about what sits between the date and
  // "wrote:", because that part is a display name and can be anything, including an address.
  /^\s*on\s.{0,200}?\bwrote\s*:\s*$/i,
  /^\s*on\s.{0,200}?\bwrote\s*:/i,
  // Outlook, both spellings.
  /^\s*-{2,}\s*original message\s*-{2,}\s*$/i,
  /^\s*_{10,}\s*$/,
  // A forwarded block INSIDE a reply is still quoted material.
  /^\s*-{2,}\s*forwarded message\s*-{2,}/i,
  /^\s*begin forwarded message\s*:\s*$/i,
  // Outlook's markerless header block: a bare "From:" immediately followed by Sent:/Date:.
  /^\s*from\s*:\s*\S/i,
  // Anybody's quoted line.
  /^\s*>/,
  // Our own footer, so a partner replying above it does not re-read the firm's own prose as theirs.
  /^\s*—\s*(?:sent by|walker|wren|parker|porter|preston)\b/i,
];

export interface SplitBody {
  /** The part the person typed in this message. Never null; empty when they wrote nothing above. */
  written: string;
  /** Everything from the quote marker down, including the marker line. Empty when there is none. */
  quoted: string;
  /** True when a quote marker was found, so a caller can say which half a trigger came from. */
  hasQuote: boolean;
}

/** The message body — everything after the blank line that ends the top-level headers. */
export function bodyOf(raw: string): string {
  const at = raw.search(/\r?\n\r?\n/);
  return at === -1 ? raw : raw.slice(at).replace(/^\r?\n\r?\n/, "");
}

/**
 * Split a message body into what was written here and what was quoted from before.
 *
 * Takes the EARLIEST marker, because a top-posted reply — which is what every client does by
 * default and what a person on a phone always does — puts the new words above everything else.
 * A bottom-posted reply loses its new text to the quoted half, which is the conservative failure:
 * a trigger in it does not fire, and Porter's routing card still carries the whole message.
 */
export function splitQuoted(body: string): SplitBody {
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (QUOTE_MARKERS.some((re) => re.test(line))) {
      return {
        written: lines.slice(0, i).join("\n"),
        quoted: lines.slice(i).join("\n"),
        hasQuote: true,
      };
    }
  }
  return { written: body, quoted: "", hasQuote: false };
}

export interface ReplyHeaders {
  inReplyTo?: string | null;
  references?: string | null;
  subject?: string | null;
}

/**
 * Is this message a REPLY (as opposed to a fresh message or a forward)?
 *
 * The headers first, because they exist to answer exactly this and a sender cannot omit them by
 * accident when their client wrote them. The `Re:` subject is the fallback for the client that
 * does, and a forwarding prefix anywhere in the subject vetoes both: `Re: Fwd: Northwind` means
 * the forwarded deck below is still the payload.
 */
export function isReplyMessage(h: ReplyHeaders): boolean {
  const subject = h.subject ?? "";
  if (/\b(fwd?|fw)\s*:/i.test(subject)) return false;
  if ((h.inReplyTo ?? "").trim().length > 0) return true;
  if ((h.references ?? "").trim().length > 0) return true;
  return /^\s*re\s*:/i.test(subject);
}

export interface WrittenAndQuoted extends SplitBody {
  /** True when the split was actually applied. False for a fresh message or a forward. */
  applied: boolean;
}

/**
 * The one function the mail handler calls: what to scan for triggers, and what was only quoted.
 *
 * For anything that is not a reply the whole body is "written", so forwards, fresh submissions and
 * `#wpdeck` covering notes behave exactly as they always have. The split is not a new behaviour
 * applied everywhere; it is a correction applied to the one shape that was wrong.
 */
export function writtenAndQuoted(raw: string, headers: ReplyHeaders): WrittenAndQuoted {
  const body = bodyOf(raw);
  if (!isReplyMessage(headers)) return { written: body, quoted: "", hasQuote: false, applied: false };
  return { ...splitQuoted(body), applied: true };
}
