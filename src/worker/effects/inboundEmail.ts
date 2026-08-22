import type { Env } from "../env";
import { appendEvent } from "../events";
import { EMAIL_TRIGGERS, INTAKE_MAILBOX, NO_TRIGGER_ROUTE, triggersIn, type EmailTrigger } from "../../shared/intake/emailTriggers";

/**
 * Mail arriving at the firm's machine inbox.
 *
 * Operator direction, 21 Aug 2026: "we should be able to email os@joinwestpeek.com with #wpnetwork
 * #wpdealflow and get companies added to the funnel and sync to the network OS database", and "i
 * want the employee monitoring the inbox to know immediately what to do when emails enter the inbox
 * with those triggers."
 *
 * WHAT THIS DOES AND DELIBERATELY DOES NOT DO.
 *
 * It reads the message, works out which triggers it carries, and RECORDS what arrived along with
 * where each trigger says it belongs. It creates nothing on its own. Every route lands as a proposal
 * a person accepts, and the reason is the constraint the whole design turns on: a hashtag is a public
 * word. Anyone who learns it can type it, so it may route but must never authorise. An inbound
 * handler that created opportunities directly would mean anyone who guessed `#wpdealflow` could put
 * a company in the firm's pipeline.
 *
 * FAILING CLOSED ON SIZE AND SENDER. A message larger than the cap is recorded and dropped rather
 * than parsed — an inbox is the one surface the firm does not control the input of, and "we will
 * handle whatever arrives" is how a mail handler becomes the way in. The sender is recorded on every
 * event because provenance is the only thing that makes an unauthenticated proposal reviewable.
 */

/** Beyond this the body is not parsed. Real submissions are prose and a link, not megabytes. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * Decode an RFC 2047 encoded-word subject, e.g. `=?UTF-8?Q?=23wpdealflow_Northwind?=`.
 *
 * FOUND BY THE FIRST REAL EMAIL, not by a test. The live routing test arrived with the subject
 * "#wpdealflow Northwind Robotics — seed"; the em-dash made the whole header non-ASCII, so the mail
 * client encoded it, and `#` became `=23`. The trigger survived only because the body happened to
 * repeat it. Anyone putting a trigger in the subject alone — which is the natural place to put one —
 * would have been silently ignored the moment their subject contained a dash, a curly quote or an
 * accented name.
 *
 * It also makes the stored subject readable. A trail whose subject line reads
 * `=?UTF-8?Q?=23wpdealflow...?=` is a trail nobody can scan.
 *
 * Q and B encoding both, because clients pick between them by content and the firm does not control
 * which client a founder uses. Anything unparseable is returned untouched: a subject we cannot
 * decode is still a subject, and dropping it would trade a formatting problem for a lost message.
 */
export function decodeMimeHeader(value: string): string {
  if (!value.includes("=?")) return value;

  return value
    // Encoded words separated only by whitespace are one run and the space is not part of the text.
    .replace(/\?=\s+=\?/g, "?==?")
    .replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=/g, (whole, _charset: string, enc: string, text: string) => {
      try {
        if (enc.toUpperCase() === "B") {
          const bin = atob(text);
          const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
          return new TextDecoder("utf-8").decode(bytes);
        }
        // Q encoding: `_` is a space, `=XX` is a byte. Decoded as bytes first so a multi-byte
        // character split across two escapes (as UTF-8 always is) reassembles correctly.
        const withSpaces = text.replace(/_/g, " ");
        const bytes: number[] = [];
        for (let i = 0; i < withSpaces.length; i += 1) {
          if (withSpaces[i] === "=" && i + 2 < withSpaces.length) {
            const hex = withSpaces.slice(i + 1, i + 3);
            if (/^[0-9a-fA-F]{2}$/.test(hex)) {
              bytes.push(parseInt(hex, 16));
              i += 2;
              continue;
            }
          }
          bytes.push(withSpaces.charCodeAt(i));
        }
        return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
      } catch {
        return whole;
      }
    });
}

export interface InboundSummary {
  to: string;
  from: string;
  subject: string;
  triggers: string[];
  routed: Array<{ tag: string; owner: string; lands: string }>;
  unrouted: boolean;
  reason?: string;
}

/**
 * Decide what an arriving message means. Pure, so the routing table can be tested without a
 * mail runtime and the handler below stays a thin shell around it.
 */
export function classifyInbound(input: { to: string; from: string; subject: string; body: string }): InboundSummary {
  // Decoded before matching AND before recording: the subject is the natural place to put a trigger,
  // and it is the header most likely to be encoded.
  const subject = decodeMimeHeader(input.subject);
  const haystack = `${subject}\n${input.body}`;
  const found: EmailTrigger[] = triggersIn(haystack);

  return {
    to: input.to,
    from: input.from,
    subject,
    triggers: found.map((t) => t.tag),
    routed: found.map((t) => ({ tag: t.tag, owner: t.owner, lands: t.lands })),
    unrouted: found.length === 0,
    ...(found.length === 0 ? { reason: NO_TRIGGER_ROUTE.does } : {}),
  };
}

/**
 * The Email Worker entry point.
 *
 * Every message produces an event whether it routed or not. A mail the system could not place is
 * the case that most needs a person, and the failure this repo has already had once is work sitting
 * in a queue nobody opens — so an unrouted message is recorded loudly rather than discarded.
 */
export async function handleInboundEmail(
  message: { from: string; to: string; headers: Headers; raw: ReadableStream; rawSize: number },
  env: Env,
): Promise<void> {
  const subject = message.headers.get("subject") ?? "";
  const firmScope = "west-peek";

  if (message.rawSize > MAX_BODY_BYTES) {
    await appendEvent(env, {
      eventType: "inbound_email.rejected",
      actorType: "system",
      actorId: "inbound_email",
      objectType: "inbound_email",
      objectId: `${message.from}:${subject}`.slice(0, 200),
      firmScope,
      payload: { from: message.from, to: message.to, subject, reason: "too_large", bytes: message.rawSize },
    });
    return;
  }

  const raw = await new Response(message.raw).text();
  const summary = classifyInbound({ to: message.to, from: message.from, subject, body: raw });

  await appendEvent(env, {
    eventType: summary.unrouted ? "inbound_email.unrouted" : "inbound_email.received",
    actorType: "system",
    actorId: "inbound_email",
    objectType: "inbound_email",
    objectId: `${message.from}:${subject}`.slice(0, 200),
    firmScope,
    payload: {
      from: summary.from,
      to: summary.to,
      subject: summary.subject,
      triggers: summary.triggers,
      routed: summary.routed,
      // Named so a partner reading the event knows who to expect it from, without opening the code.
      owner: summary.unrouted ? NO_TRIGGER_ROUTE.owner : undefined,
      mailbox: INTAKE_MAILBOX,
      known_triggers: EMAIL_TRIGGERS.map((t) => t.tag),
    },
  });
}
