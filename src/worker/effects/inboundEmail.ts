import type { Env } from "../env";
import { appendEvent } from "../events";
import { proposePerson } from "./networkOsClient";
import { dealFromMessage, intakeDealFromEmail, openRoutingCard } from "../services/dealIntake";
import { pdfAttachments } from "./mimeAttachments";
import { openPortfolioUpdateCard } from "../services/portfolioReporting";
import { EMAIL_TRIGGERS, INTAKE_MAILBOX, NO_TRIGGER_ROUTE, ROUTING_EMPLOYEE, triggersIn, type EmailTrigger } from "../../shared/intake/emailTriggers";

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

  /*
   * A BIG MESSAGE IS NOT A REJECTED ONE. This dropped a real deck on the floor.
   *
   * Operator, 22 Aug 2026: "we got an updated deck for sensori overnight to os@joinwestpeek.com."
   * It had arrived at 03:29, been logged `too_large` at 7,093,115 bytes, and been discarded —
   * silently. She found out by asking. Two things were wrong and both were mine:
   *
   * The CAP contradicted a feature the firm asked for. 256KB was chosen because "real submissions
   * are prose and a link", and then `#wpdeck` shipped, which exists precisely for decks, which are
   * megabytes. A limit written before the feature it now blocks.
   *
   * And the DROP was silent. Inbound deal flow disappearing without a word is the worst failure this
   * mailbox has: the firm cannot miss what it never learns about.
   *
   * So an oversized message is ROUTED FROM ITS HEADERS, which are already parsed and cost nothing.
   * The subject carries the trigger and the company — "#wpdealflow Sensori" is the whole routing
   * decision — so the arrival survives as a work card that says the body was not read and where to
   * go and get it. The body is still never parsed: reading seven megabytes would exhaust the 10ms
   * CPU budget a Worker invocation gets, which is the real constraint the cap was reaching for.
   */
  if (message.rawSize > MAX_BODY_BYTES) {
    const oversizeSummary = classifyInbound({ to: message.to, from: sender, subject, body: "" });
    await appendEvent(env, {
      eventType: "inbound_email.too_large_to_read",
      actorType: "system",
      actorId: "inbound_email",
      objectType: "inbound_email",
      objectId: `${message.from}:${subject}`.slice(0, 200),
      firmScope,
      payload: { from: message.from, to: message.to, subject, bytes: message.rawSize, routed: oversizeSummary.triggers },
    });

    /*
     * THE WHOLE MESSAGE IS KEPT, and this is the part that makes the arrival recoverable rather than
     * merely reported. Streaming bytes to R2 is I/O, not CPU — `put` takes the stream and never
     * decodes it — so a seven-megabyte deck costs a Worker almost nothing, while PARSING the same
     * bytes would exhaust the 10ms budget. That asymmetry is the whole design: store now, read later
     * with a fresh budget.
     *
     * Which is also why the answer to "should the sender zip it" is no. A rule that depends on
     * founders remembering to compress a deck fails the first time somebody forgets, and the firm
     * loses the deal rather than the attachment.
     */
    let storedKey: string | null = null;
    if (env.WP_OS_DOCUMENTS) {
      storedKey = `inbound-email/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.eml`;
      try {
        /*
         * THROUGH A `FixedLengthStream`, AND WITHOUT IT NOTHING WAS EVER STORED.
         *
         * R2 refuses a body whose length it does not know: passing `message.raw` straight in threw
         *   TypeError: Provided readable stream must have a known length
         *     (request/response body or readable half of FixedLengthStream)
         * every single time. The `catch` below swallowed it, `storedKey` stayed null, and the card
         * said "It could NOT be stored here… this system did not keep a copy." Which was true, and
         * was exactly the failure this whole branch was written to fix after a 7MB deck for Sensori
         * was logged `too_large` at 03:29 and discarded. The card was the half that worked; keeping
         * the message — the half that makes the arrival recoverable — never did.
         *
         * `rawSize` is the length the runtime already knows, so this stays STREAMING: bytes go to
         * R2 without being decoded, which is the asymmetry the oversize path depends on (I/O is
         * nearly free; parsing seven megabytes would exhaust the 10ms CPU budget). `pipeTo` is
         * deliberately not awaited before the `put` — awaiting it would block on a writable nobody
         * is draining yet, and the two run against each other.
         */
        const sized = new FixedLengthStream(message.rawSize);
        const pumped = message.raw.pipeTo(sized.writable);
        await env.WP_OS_DOCUMENTS.put(storedKey, sized.readable, {
          httpMetadata: { contentType: "message/rfc822" },
          customMetadata: { from: sender.slice(0, 200), subject: subject.slice(0, 200) },
        });
        await pumped;
      } catch {
        // A failed store must not also lose the notification. The card still opens and says the
        // message is in the mailbox — which it is, whatever happened here.
        storedKey = null;
      }
    }

    await openRoutingCard(env, {
      subject: `Too big to read: ${subject || "(no subject)"}`,
      from: sender,
      raw: "",
      triggers: oversizeSummary.triggers,
      why: [
        `It is ${(message.rawSize / 1024 / 1024).toFixed(1)}MB — too large to open inside one request, so the body and attachments were not read.`,
        oversizeSummary.triggers.length > 0
          ? `It carries ${oversizeSummary.triggers.join(", ")}, so it was meant for the funnel.`
          : "It carries no trigger tag.",
        storedKey
          ? `The whole message is kept here and can be opened without going anywhere else: ${storedKey}`
          // NOT "it is still in the inbox". `os@joinwestpeek.com` routes to this Worker, and whether
          // a mailbox copy also exists depends on a routing rule this code cannot see. Telling a
          // partner her deck is somewhere it may not be is worse than telling her it is gone.
          : "It could NOT be stored here. Ask the sender to send it again once this is fixed, or get it from their sent mail — this system did not keep a copy.",
      ].join(" "),
    });
    return;
  }

  const raw = await new Response(message.raw).text();

  /*
   * MOST OF THIS MAILBOX IS FORWARDS, so the envelope is the wrong answer to "who sent this".
   *
   * Operator, 22 Aug 2026: "most of the emails to this inbox will be forwards and the important info
   * will be in the original email below since its a fwd or an attachment" and "most will be forwards
   * from founders themselves."
   *
   * Without this, a forwarded deck is recorded as having come FROM A PARTNER — the register would
   * say Scooter introduced Sensori when Scooter forwarded it. Deal-flow provenance is the only
   * evidence a Fund I has about whether its sourcing is repeatable, and a register where every row
   * says "a partner sent it" answers nothing at LP diligence.
   *
   * BOTH ARE KEPT. Who forwarded it is real information — a partner vouching for something is worth
   * knowing — but it is not who it came from, and collapsing the two loses the half that matters.
   */
  const origin = forwardedOrigin(raw);
  const forwardedBy = origin?.from ? sender : null;
  const trueSender = origin?.from ?? sender;
  // The forwarded subject is usually the real one: a partner types "Fwd:" and the founder's own
  // subject carries the company name.
  const trueSubject = origin?.subject ?? subject;

  const summary = classifyInbound({ to: message.to, from: trueSender, subject: trueSubject, body: raw });

  /*
   * A COMPANY GOES TO THE FUNNEL. A message nobody could place goes to Capture.
   *
   * Operator correction: "capture page is for things we manually want to capture. the top of the
   * funnel is the deal flow tab." Filing every triggered email as a capture turned a partner's own
   * deliberate list into an inbox they then had to sort the firm's mail out of.
   */
  /*
   * THE LADDER. Wyatt owns the top of the funnel, so a readable company is his. Porter takes what
   * is ambiguous, and blocks it to a partner if he cannot resolve it either. Nothing ends in
   * "held quietly" — see dealIntake.ts.
   */
  let dealResult: { outcome: string; detail: string } | null = null;
  let routingCardId: string | null = null;
  let updateCardId: string | null = null;
  const wantsDeal = summary.triggers.includes("#wpdealflow") || summary.triggers.includes("#wpdeck");

  /*
   * A COMPANY WE ALREADY OWN GOES TO WINTER, and it goes as a job rather than as a figure.
   *
   * Handled before the deal ladder because it is a different question. The three older triggers all
   * ask "is this a new thing for the funnel"; this one is a holding reporting on itself, and running
   * it through deal intake would open an opportunity in a company the fund already bought.
   *
   * `dealFromMessage` is reused only to READ THE NAME out of the message — the same subject line and
   * `Company:` field convention, so a founder does not have to learn two ways to say who they are.
   */
  if (summary.triggers.includes("#wpupdate")) {
    const named = dealFromMessage(summary.subject, raw, summary.from, false);
    updateCardId = await openPortfolioUpdateCard(env, {
      subject: summary.subject,
      from: summary.from,
      raw,
      company: named?.company ?? null,
    });
  }

  let dealCompany: string | null = null;
  if (wantsDeal) {
    const deal = dealFromMessage(summary.subject, raw, summary.from, summary.triggers.includes("#wpdeck"));
    if (deal) {
      /*
       * THE DECK ITSELF, HANDED OVER RATHER THAN MENTIONED.
       *
       * `#wpdeck` has always meant "the information is in the attachment", and the prompt written
       * for Wyatt says so in as many words — while nothing extracted an attachment, so he was told
       * to read something he was never given. `deckReader.ts` could read a PDF the whole time; the
       * two were simply never connected.
       *
       * Stored on the card as base64 rather than read here, because reading is a model call and
       * this handler has 10ms of CPU. The employee reads it on their own step, with their own
       * budget — the same store-now-read-later shape the oversize path uses.
       */
      const { attachments, unread } = pdfAttachments(raw);

      /*
       * `#wpdeck` AND `#wpdealflow` DO THE SAME THING, and the difference is now decided by looking.
       *
       * Operator, 22 Aug 2026: "what is the difference in wpdeck and wpdealflow? i think they should
       * do the same but idk." She is right. The tags were defined as "the substance is in the
       * message" versus "the substance is in the attachment" — a distinction that existed only
       * because nothing could extract an attachment, so the sender had to say where to look.
       *
       * Now the system can look. Asking a busy partner to pick the correct word is the same mistake
       * as asking founders to zip a deck: a rule that depends on a human remembering, which fails
       * the first time one does not. She has already said she sends all three tags at once because
       * the firm is moving fast, which is the evidence.
       *
       * Both tags keep working — people have been told them and muscle memory is real — but they are
       * synonyms. A PDF present means read the deck, whichever word was typed.
       */
      /*
       * DECIDED BY LOOKING, NOT BY THE TAG — in both directions.
       *
       * Operator's own framing: "wpdeck is when we have a deck and wpdealflow doesnt have to incl a
       * deck necessarily just need to get the deal in the pipeline." Correct, and the useful
       * property is that the tag CANNOT be wrong: tag `#wpdealflow` and attach a deck and it is
       * still read; tag `#wpdeck` and forget the attachment and the company still enters the funnel.
       *
       * Set from the attachments alone rather than OR'd with the tag, because `isDeck` drives a
       * prompt that tells the analyst "the substance is in the attachment, not the message body".
       * Saying that about a message with no attachment sends him looking for something that does not
       * exist — and an attachment that arrived but could not be parsed is covered by `unread` below,
       * which says so explicitly rather than implying a deck is there to read.
       */
      deal.isDeck = attachments.length > 0;
      if (attachments.length > 0 || unread.length > 0) {
        deal.notes = [
          ...(deal.notes ?? []),
          ...attachments.map((a) => `Deck attached: ${a.filename} (${(a.bytes / 1024).toFixed(0)}KB). Read it before judging whether this is thin.`),
          // Said out loud. An attachment silently dropped is how the Sensori deck went missing.
          ...unread.map((u) => `Could NOT read an attachment: ${u}. Open the message itself for it.`),
        ];
        deal.attachments = attachments;
      }
      // Held for the network relay below: one email can carry both a company and its founder, and
      // the link between them is only free to record here.
      dealCompany = deal.company;
      dealResult = await intakeDealFromEmail(env, deal);
    } else {
      // A deal tag with no readable company is exactly the ambiguity Porter exists for. Guessing a
      // name out of prose would put a confidently wrong company at the top of the funnel.
      routingCardId = await openRoutingCard(env, {
        subject: summary.subject,
        from: summary.from,
        raw,
        triggers: summary.triggers,
        why: "Tagged for deal flow, but no company name could be read out of it.",
      });
      // Named from the shared routing table, not retyped: the seat is declared once and the mail
      // handler, Porter's method and the page a partner reads all say the same word.
      dealResult = { outcome: "AMBIGUOUS", detail: `No company name could be read, so ${ROUTING_EMPLOYEE} has it.` };
    }
  } else if (summary.unrouted) {
    routingCardId = await openRoutingCard(env, {
      subject: summary.subject,
      from: summary.from,
      raw,
      triggers: [],
      why: "No recognised tag, so nothing could route it automatically.",
    });
  }

  // People are Network OS's record. A #wpnetwork mail is relayed there as a proposal; the capture
  // above stays here as this side's evidence of having sent it.
  let relayed: { ok: boolean; detail: string } | null = null;
  if (summary.triggers.includes("#wpnetwork")) {
    const person = personFromMessage(summary.from, raw);

    /*
     * ONE EMAIL, TWO RECORDS, AND THE LINK BETWEEN THEM KEPT.
     *
     * Operator, 22 Aug 2026, on a message carrying all three triggers: the company goes to the
     * funnel and the person goes to Network OS. Both already happened — but as two unrelated
     * records, so the fact that THIS founder belongs to THAT company was thrown away at the one
     * moment the firm could see it for free.
     *
     * The email is the proof. Reconstructing it later means somebody remembering, and "who founded
     * Sensori" is exactly the question nobody can answer six months on. `ProposedPerson.company`
     * already existed and was only ever filled from a literal `company:` line in the body, which
     * almost no real message carries.
     *
     * The DEAL's company wins over anything parsed out of the prose: it is the name that was matched
     * against the register, so it is the one that will still match tomorrow.
     */
    const withCompany =
      person && dealCompany
        ? { ...person, company: person.company ?? dealCompany }
        : person;

    relayed = withCompany
      ? await proposePerson(env, withCompany)
      : { ok: false, detail: "no name could be read out of the message, so nothing was proposed" };

    /*
     * THE LAST SILENT PATH, CLOSED. Operator: "no inbound emails to os@joinwestpeek.com should
     * silently fail."
     *
     * A `#wpnetwork` message whose person could not be read, or whose relay to Network OS was
     * refused, recorded the failure on the spine and told nobody. Somebody deliberately tagged a
     * person for the firm's network and the firm quietly did not add them — which looks exactly like
     * it worked. Every other branch here already opens a card; this one did not.
     */
    if (!relayed.ok) {
      routingCardId = await openRoutingCard(env, {
        subject: summary.subject,
        from: summary.from,
        raw,
        triggers: summary.triggers,
        why: `Tagged for the network, but the person was not added: ${relayed.detail}.`,
      });
    }
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
      // Who FORWARDED it, when somebody did. Kept beside the true sender rather than instead of it:
      // a partner vouching for something is worth knowing, and it is not who it came from.
      ...(forwardedBy ? { forwarded_by: forwardedBy } : {}),
      to: summary.to,
      subject: summary.subject,
      triggers: summary.triggers,
      routed: summary.routed,
      // Named so a partner reading the event knows who to expect it from, without opening the code.
      owner: summary.unrouted ? NO_TRIGGER_ROUTE.owner : undefined,
      mailbox: INTAKE_MAILBOX,
      known_triggers: EMAIL_TRIGGERS.map((t) => t.tag),
      ...(routingCardId ? { routing_card_id: routingCardId } : {}),
      ...(updateCardId ? { portfolio_update_card_id: updateCardId } : {}),
      ...(dealResult ? { dealflow: dealResult.outcome, dealflow_detail: dealResult.detail } : {}),
      ...(relayed ? { network_os_relay: relayed.ok ? "PROPOSED" : `REFUSED: ${relayed.detail}` } : {}),
    },
  });
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

/**
 * The original sender and subject inside a forwarded message.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS. Operator, 22 Aug 2026: "most of the emails to this inbox will
 * be forwards and the important info will be in the original email below since its a fwd or an
 * attachment." Without this, every forwarded deck is recorded as having come FROM A PARTNER — so the
 * firm's deal-flow provenance says Scooter introduced Sensori, when Scooter forwarded it.
 *
 * That is not a cosmetic error. Porter's own method is that provenance is recorded at arrival or
 * never, and the reason is that deal-flow provenance is the only evidence a Fund I has about whether
 * its sourcing is repeatable. A register where every row says "a partner sent it" answers nothing at
 * LP diligence.
 *
 * BOTH ARE KEPT. Who forwarded it is real information — a partner vouching for something is worth
 * knowing — but it is not who it came from, and collapsing the two loses the half that matters.
 *
 * Handles the three shapes that actually arrive: Gmail's "---------- Forwarded message ----------",
 * Apple Mail's "Begin forwarded message:", and Outlook's bare "From: … Sent: … Subject:" block.
 * Returns null when it cannot find one, and the caller falls back to the envelope — a guess about
 * who sent a deck is worse than admitting the header is all we have.
 */
export function forwardedOrigin(raw: string): { from: string | null; subject: string | null } | null {
  const marker = /(-{2,}\s*forwarded message\s*-{2,}|begin forwarded message:)/i.exec(raw);
  // Outlook forwards carry no marker at all: the block begins at a bare "From:" line that is
  // followed by "Sent:" or "Date:". Looked for only when no marker was found, so a Gmail forward is
  // never parsed from the wrong place.
  const start = marker ? marker.index + marker[0].length : /^\s*from:\s*.+\r?\n\s*(sent|date):/im.exec(raw)?.index;
  if (start === undefined) return null;

  // One screenful is enough for a header block, and bounding it keeps this cheap on a long thread.
  const block = raw.slice(start, start + 1200);
  const fromLine = /^\s*from:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? null;
  const subjectLine = /^\s*subject:\s*(.+)$/im.exec(block)?.[1]?.trim() ?? null;

  const email = fromLine ? (/<([^>]+)>/.exec(fromLine)?.[1] ?? fromLine) : null;
  return {
    from: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
    subject: subjectLine,
  };
}

/**
 * A subject with every forwarding prefix removed.
 *
 * `Fwd: FW: Re: Sensori` is one message about Sensori. The old rule stripped a single `re|fwd` and
 * left the rest, so a twice-forwarded deck opened a company called "FW: Re: Sensori" — a name that
 * would never match the company already on the board, which is exactly how a register grows a second
 * row for a company the firm already screened.
 */
export function strippedSubject(subject: string): string {
  let out = subject.replace(/#wp[a-z]+/gi, "").trim();
  // Repeated rather than once: mail clients stack these, and each pass removes one layer.
  for (let i = 0; i < 6; i += 1) {
    const next = out.replace(/^\s*(re|fwd?|fw)\s*:\s*/i, "").trim();
    if (next === out) break;
    out = next;
  }
  return out;
}
