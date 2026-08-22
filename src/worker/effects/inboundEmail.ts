import type { Env } from "../env";
import { appendEvent } from "../events";
import { proposePerson } from "./networkOsClient";
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
 * It reads the message, works out which triggers it carries, and files each one through the door
 * the firm already has: a CAPTURE. Nothing here creates a company, an opportunity or a contact.
 *
 * That is the constraint the whole design turns on. A hashtag is a public word — anyone who learns
 * it can type it — so it may route but must never authorise. A handler that opened opportunities
 * directly would mean anyone who guessed `#wpdealflow` could put a company in the firm's pipeline.
 * A capture is exactly the right shape for that: it records what arrived, carries the sender, and
 * waits for a person or a routed machine to decide what it becomes.
 *
 * REUSING CAPTURE RATHER THAN BUILDING A SECOND DOOR is the other half of it. Capture already has
 * routing, privacy labels, person and company resolution and an audit trail, and it is already
 * Porter's machine (`global_capture_routing`). A parallel email-only pipeline would have duplicated
 * all of that and then drifted from it.
 *
 * `#wpnetwork` is the exception that proves the rule: people are Network OS's record, so that one
 * is ALSO relayed to Network OS's intake queue. Still a proposal — the far end decides — and the
 * capture stays here as this side's trail of having sent it.
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

  /*
   * The From HEADER, not the envelope sender.
   *
   * `message.from` is the SMTP envelope address, which for anything sent through a delivery service
   * is a bounce-tracking token like `010001a027045243-…@amazonses.com` rather than a person. The
   * capture would then record who relayed the message instead of who wrote it, and Capture's own
   * person resolution reads exactly that line. The envelope stays as the fallback, because a header
   * can be absent and an envelope never is.
   */
  const sender = extractAddress(message.headers.get("from")) ?? message.from;

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
  const summary = classifyInbound({ to: message.to, from: sender, subject, body: raw });

  // Everything that arrives becomes a capture, triggered or not. An email the system could not place
  // is the one that most needs a person, and the failure this repo has already had once is work
  // sitting somewhere nobody opens.
  const captureId = await fileCapture(env, {
    kind: summary.unrouted ? "EMAIL_UNROUTED" : `EMAIL_${summary.triggers[0]!.replace("#wp", "").toUpperCase()}`,
    from: summary.from,
    subject: summary.subject,
    body: raw,
    triggers: summary.triggers,
  });

  // People are Network OS's record. A #wpnetwork mail is relayed there as a proposal; the capture
  // above stays here as this side's evidence of having sent it.
  let relayed: { ok: boolean; detail: string } | null = null;
  if (summary.triggers.includes("#wpnetwork")) {
    const person = personFromMessage(summary.from, raw);
    relayed = person
      ? await proposePerson(env, person)
      : { ok: false, detail: "no name could be read out of the message, so nothing was proposed" };
  }

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
      capture_id: captureId,
      ...(relayed ? { network_os_relay: relayed.ok ? "PROPOSED" : `REFUSED: ${relayed.detail}` } : {}),
    },
  });
}

/**
 * File an arriving message as a capture.
 *
 * `captured_by` is `system:inbound_email` rather than a person, because nobody at the firm captured
 * it — attributing it to whoever happens to read it first would put a name on the record that did
 * not do the thing.
 *
 * The subject and sender are prepended to the stored text rather than kept only in the event,
 * because Capture's own resolution reads `raw_text` and a message stripped of who sent it is not
 * resolvable to a person.
 */
async function fileCapture(
  env: Env,
  input: { kind: string; from: string; subject: string; body: string; triggers: string[] },
): Promise<string> {
  const id = `cap_${crypto.randomUUID()}`;
  const text = [`From: ${input.from}`, `Subject: ${input.subject}`, "", input.body].join("\n");

  await env.WP_OS_DB.prepare(
    `INSERT INTO capture (id, capture_type, raw_text, source_channel, privacy_label, firm_scope, captured_by)
     VALUES (?1, ?2, ?3, 'email', 'INTERNAL', 'west-peek', 'system:inbound_email')`,
  )
    .bind(id, input.kind, text.slice(0, 60_000))
    .run();

  await appendEvent(env, {
    eventType: "capture.created",
    actorType: "system",
    actorId: "inbound_email",
    objectType: "capture",
    objectId: id,
    firmScope: "west-peek",
    payload: { capture_type: input.kind, source_channel: "email", from: input.from, triggers: input.triggers },
  });
  return id;
}

/**
 * Read a person out of a message well enough to propose them.
 *
 * Network OS parses `key: value` lines itself, so this only has to find a NAME — without one there
 * is nothing to propose and saying so is better than sending a blank record for somebody to puzzle
 * over. The sender's own address is the fallback for email, because a `#wpnetwork` mail is usually
 * an introduction and the person introducing is not always the person being introduced.
 */
/** Pull the bare address out of a `From` header, which may be `Name <a@b.c>` or just `a@b.c`. */
export function extractAddress(header: string | null): string | null {
  if (!header) return null;
  const angled = /<([^>]+)>/.exec(header);
  const candidate = (angled ? angled[1]! : header).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate : null;
}

export function personFromMessage(from: string, body: string): { name: string; email?: string | null; company?: string | null } | null {
  const field = (key: string): string | null => {
    const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+?)\\s*$`, "im").exec(body);
    return m ? m[1]! : null;
  };
  const name = field("name") ?? field("full name");
  if (!name) return null;
  return { name, email: field("email") ?? from, company: field("company") };
}
