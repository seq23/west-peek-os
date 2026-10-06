import { PREVIEW_RECIPIENT, previewHeader, previewHeaderHtml, previewSubject } from "../../shared/work/preview";
import { isPartnerEmail } from "../../shared/registry/partners";

/**
 * What every outbound email transport agrees on.
 *
 * This lives apart from any one transport because there are now two — Cloudflare's binding and
 * Resend's API — and a shared contract owned by one of them would make the other a second-class
 * citizen of its own interface. Both implement this; the executor picks between them.
 *
 * `provider` is the discriminator, and it is on the RESULT rather than inferred at the call site
 * because it ends up on the audit trail. When somebody asks how a message left the building a year
 * from now, the receipt should say, not the reader reconstruct it from which switches were set.
 */

export interface EmailPayload {
  /**
   * One address, or SEVERAL when one message is addressed to more than one person.
   *
   * Several, added 17 Sep 2026 for Parker's monthly packets. Operator: "One for Rooms, one for
   * Workshops, each addressed to Sequoia and Scooter together… not one per person." Two separate
   * messages are two conversations about one decision — a reply on one is invisible on the other,
   * and the second partner cannot see that the first already answered. Both transports take a list
   * natively (Cloudflare's `EmailDestinations.to`, Resend's `to`), so this is a widening of the
   * type rather than a second send path.
   */
  to: string | readonly string[];
  /**
   * Copied, never addressed (0239, 23 Sep 2026: "cc Scooter"). PARTNERS ONLY in practice — the one
   * writer is `services/ccPartners.ts`, and `assertPreviewLane` below holds cc to exactly the same
   * rule as `to`, so a cc can never carry a message anywhere a To could not.
   */
  cc?: readonly string[];
  subject: string;
  /** Plain text. Always present: the part every client renders and every log can read. */
  text: string;
  /**
   * An optional HTML part carrying the SAME content as `text`, laid out. Composed only by
   * `services/execEmail.ts`, the one place an employee's email to a partner is put together; a
   * transport never invents one.
   */
  html?: string;
  from?: string;
  /** Where a reply should go when it is not the sender — the intake mailbox, for an employee's mail. */
  replyTo?: string;
  /**
   * Extra RFC headers. Today this carries exactly one thing: the `References` / `In-Reply-To` pair
   * that lets a reply be matched to the conversation it answers — see `shared/email/thread.ts` for
   * why the match cannot be made on `provider_message_id`, and why a subject code was refused.
   *
   * BOTH TRANSPORTS ALLOW THESE TWO AND REFUSE `Message-ID`. Cloudflare answers
   * `E_HEADER_NOT_ALLOWED` for a platform-controlled header; Resend's send goes through SES, which
   * overrides any Message-ID a caller supplies. Anything a transport refuses must not be put here.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * 0253: files the message carries — an export, a QR code — base64, with a name and a type. Composed
   * only by `services/execEmail.ts` from `work_card_file` rows the job marked as deliverables, and
   * held to `OUTBOUND_ATTACHMENTS_MAX_BYTES` in total; a larger set is linked, never attached.
   */
  attachments?: readonly EmailAttachment[];
}

export interface EmailAttachment {
  filename: string;
  /** Base64 of the bytes. */
  content: string;
  contentType?: string;
}

/** 10 MB, total, per message: Resend's own ceiling is 40 MB and a partner's inbox is smaller than that. */
export const OUTBOUND_ATTACHMENTS_MAX_BYTES = 10 * 1024 * 1024;

/** The decoded size of a set of attachments, for the cap. */
export function attachmentsBytes(attachments: readonly EmailAttachment[] | undefined): number {
  return (attachments ?? []).reduce((n, a) => n + Math.floor((a.content.length * 3) / 4) - (a.content.endsWith("==") ? 2 : a.content.endsWith("=") ? 1 : 0), 0);
}

export interface EmailSendResult {
  sent: boolean;
  /** "gmail" means it went through a partner's own account and is in their Sent folder. */
  provider: "resend" | "cloudflare" | "gmail";
  /** Null when the transport does not issue one. Better a gap than a fabricated identifier. */
  provider_message_id: string | null;
  detail: string;
}

/**
 * Neutralise trigger hashtags in outbound mail.
 *
 * THE LOOP THIS PREVENTS, found while checking whether the two mailbox rules could collide.
 * Network OS's Gmail sync runs the query `{#wpnetwork #wpdealflow …}` with no `in:inbox`
 * restriction — it matches any mail carrying a trigger, including Sent. So the first digest this
 * app emails a partner saying "3 new companies via #wpdealflow this week" is ingested by Network
 * OS as a submission, which syncs back here, which appears in the next digest.
 *
 * The operator's own read was that nothing needs to change as long as a message is not sent to
 * os@joinwestpeek.com AND a westpeek.ventures address at once. That is right about ADDRESSING and
 * this is the part it does not cover: the collision is not who it was sent to, it is that the app
 * writes the trigger word at all.
 *
 * A ZERO-WIDTH JOINER after the hash, so it reads identically to a human and matches nothing. The
 * alternative — refusing to send a message containing a trigger — would block the firm from ever
 * writing about its own intake in an email, which is a worse cure than the disease.
 *
 * NETWORK OS'S DEDUPE DOES NOT MAKE THIS UNNECESSARY, and it is worth saying why, because the
 * dedupe is real: `findDuplicateContact` matches on lowercased email first, then name plus company.
 * So a PERSON who arrives twice does land once. Three things survive that:
 *
 *   1. Dedupe protects the contact record, not the queue. Every loop iteration still files an
 *      intake row and a sync cycle, so a weekly digest quoting a trigger produces a fresh item to
 *      dismiss every week, forever, while collapsing to one contact.
 *   2. A digest is not a submission. Ingesting the firm's own reporting as intake is wrong data
 *      rather than duplicate data, and dedupe has no opinion about wrong.
 *   3. `#wpdealflow` in a digest is not a person at all. It classifies as deal flow, which lands in
 *      THIS app's funnel — a different system, with a different dedupe, on a different record type.
 */
/*
 * This list is HAND-MAINTAINED and it is wider than `EMAIL_TRIGGERS`, which is why it cannot be
 * generated from it: `#addtowestpeek`, `#westpeeknetwork` and `#dealflow` are Network OS's aliases
 * and this app has never published them. The cost of that is real — a trigger added to the registry
 * must be added here too, and `#wpupdate` (item 12) was. A portfolio digest that quotes the tag
 * loops otherwise, and this time the loop would carry a company's own reported figures.
 */
const TRIGGER_WORDS = /#(wpnetwork|wpdealflow|wpdeck|wpupdate|addtowestpeek|westpeeknetwork|dealflow)\b/gi;

export function defuseTriggers(text: string): string {
  return text.replace(TRIGGER_WORDS, (m) => `#‍${m.slice(1)}`);
}

/** True when a message would be re-ingested by Network OS if sent as written. */
export function wouldLoop(text: string): boolean {
  TRIGGER_WORDS.lastIndex = 0;
  return TRIGGER_WORDS.test(text);
}

// ── THE SEND BOUNDARY IN PREVIEW MODE ─────────────────────────────────────────────────────────

/**
 * THE ONE PLACE A PREVIEW IS STOPPED FROM REACHING ANYBODY (17 Sep 2026).
 *
 * Operator: "NO EXTERNAL EFFECTS, EVER. A preview of something that would email an outside person
 * emails nobody. Enforce at the send boundary, not by remembering per feature — that is the
 * difference between a guard and a convention."
 *
 * ─── WHY HERE AND NOWHERE ELSE ─────────────────────────────────────────────────────────────────
 *
 * There are exactly two things in this system that put a message on a wire: `sendViaResend` (a
 * fetch) and `sendViaCloudflare` (a binding). Both call this first, before the key is read, before
 * the binding is touched, before any network or platform call exists. Every composer, every
 * employee, every service and every future feature reaches a recipient THROUGH one of those two, so
 * a rule enforced here cannot be forgotten by a feature that has not been written yet.
 *
 * The alternative — each caller checking "am I in preview?" before it sends — is the convention
 * this repo has already been bitten by: it holds until the day somebody adds a third caller.
 *
 * ─── WHAT IT DOES ──────────────────────────────────────────────────────────────────────────────
 *
 * REPLACES the recipient list. Not filters it, not validates it: replaces it, with exactly one
 * address, unconditionally. There is no input — no destination, no misconfiguration, no crafted
 * payload — for which this returns a recipient list containing anybody but Sequoia. A preview of
 * something addressed to a founder, a journalist or an LP therefore reaches that person never; it
 * reaches her, with the header saying who it was for.
 *
 * It also stamps the subject and prepends the header, so a preview in a mailbox can never be
 * mistaken for the live note.
 *
 * THE OTHER HALF OF THE GUARANTEE is in `executeExternalEffect`, which refuses a preview outright.
 * That is the path an approved receipt can use to reach an outsider, and refusing it early means a
 * preview never consumes a receipt either. Two independent stops, in the two places an email can
 * begin.
 */
export function applyPreviewBoundary(env: unknown, payload: EmailPayload): EmailPayload {
  const preview = previewContextOf(env);
  const out = !preview
    ? payload
    : (() => {
        const normallyTo = [payload.to].flat().map((a) => a.trim().toLowerCase());
        const header = previewHeader({
          normallyTo,
          what: preview.what,
          requestedByEmail: preview.requestedByEmail,
        });
        return {
          ...payload,
          // Replaced, never filtered. This is the whole boundary — and a cc goes with it.
          to: [PREVIEW_RECIPIENT],
          cc: [],
          subject: previewSubject(payload.subject),
          text: `${header}${payload.text}`,
          ...(payload.html
            ? {
                html: `${previewHeaderHtml({ normallyTo, what: preview.what, requestedByEmail: preview.requestedByEmail })}${payload.html}`,
              }
            : {}),
        };
      })();

  /*
   * THE LANE, CHECKED AFTER THE PREVIEW REPLACEMENT AND BEFORE THE WIRE.
   *
   * Order is load-bearing. A preview's recipient list has just been replaced with Sequoia's
   * address, which is a partner, so a preview always clears the lane — exactly right: a preview
   * reaches her and nobody else, and it needs no approval to do that. Everything that is NOT a
   * preview is now held to her default rule. See `assertPreviewLane`.
   */
  assertPreviewLane(env, out);
  return out;
}

// ── HER DEFAULT RULE, AT THE SAME BOUNDARY ────────────────────────────────────────────────────

/**
 * NOBODY OUTSIDE THE FIRM IS EMAILED WITHOUT AN APPROVED PREVIEW (17 Sep 2026).
 *
 * Operator: "anything to anyone other than sequoia@ and scooter@ should be default preview.
 * everything else does not need to be default preview unless i specifically ask for it."
 *
 * ─── WHY IT IS HERE, BESIDE THE PREVIEW BOUNDARY, AND NOT IN THE FEATURES ──────────────────────
 *
 * The same argument that put `applyPreviewBoundary` here, and it is the argument this repo has
 * already been bitten by: a rule each caller remembers is a rule the next caller forgets. There are
 * exactly two things in this system that put a message on a wire, both call this function first,
 * and every composer, employee, service and unwritten feature reaches a recipient through one of
 * them. `services/execEmail.ts` restricts an employee's mail to the two partner addresses TODAY,
 * which is a narrower rule — but it is a rule in one service, and `executeExternalEffect` is a
 * second door with a different rule, and this is the floor under both.
 *
 * ─── WHAT CLEARS IT ────────────────────────────────────────────────────────────────────────────
 *
 *   · EVERY RECIPIENT IS A PARTNER. Asked of `isPartnerEmail`, the registry's one answer, never a
 *     typed address and never a test on the domain (`info@westpeek.ventures` is on that domain and
 *     is not a partner). Walker's Monday hire search to Scooter clears here with nothing attached,
 *     which is the point — he is a Managing Partner, not an outsider.
 *   · OR THE ENV CARRIES AN APPROVAL SHE GRANTED FOR THIS EXACT RECIPIENT. Set only by
 *     `services/previewApproval.ts`, only after a single-use token has been claimed, and only for
 *     the one address on the approved row. A token approved for one person cannot carry a message
 *     to another: the recipient is compared, not merely counted.
 *
 * Anything else throws before the key is read, before the binding is touched, and before any
 * network call exists.
 */
export const APPROVED_SEND_ENV_KEY = "__wpApprovedSend";

export interface ApprovedSendMarker {
  /** `preview_approval.id`. On the refusal event and the delivery record. */
  approvalId: string;
  /** The ONE address this approval authorises, lower-case. */
  recipient: string;
}

export function approvedSendOf(env: unknown): ApprovedSendMarker | null {
  if (!env || typeof env !== "object") return null;
  const marker = (env as Record<string, unknown>)[APPROVED_SEND_ENV_KEY];
  if (!marker || typeof marker !== "object") return null;
  const m = marker as Partial<ApprovedSendMarker>;
  return typeof m.approvalId === "string" && typeof m.recipient === "string"
    ? { approvalId: m.approvalId, recipient: m.recipient.trim().toLowerCase() }
    : null;
}

/**
 * Thrown by the boundary. A distinct class so a caller can report the reason to a partner rather
 * than logging "fetch failed", and so a test can assert the refusal rather than a generic throw.
 */
export class SendBlocked extends Error {
  readonly code = "preview_required";
  constructor(message: string) {
    super(message);
    this.name = "SendBlocked";
  }
}

/** The check itself. Throws `SendBlocked`, or returns. */
export function assertPreviewLane(env: unknown, payload: EmailPayload): void {
  // To AND cc: a copied address is a recipient like any other (0239).
  const recipients = [...[payload.to].flat(), ...(payload.cc ?? [])].map((a) => a.trim().toLowerCase()).filter((a) => a.length > 0);
  if (recipients.length === 0) return;

  const outside = recipients.filter((a) => !isPartnerEmail(a));
  if (outside.length === 0) return;

  const approved = approvedSendOf(env);
  if (!approved) {
    throw new SendBlocked(
      `${outside.join(", ")} is outside the firm and nothing has been approved to go there. ` +
        "Her rule: anything to anyone other than the two partners is preview-first — it goes to her " +
        "Home and her inbox, and only 'Send it' puts it on the wire.",
    );
  }
  /*
   * ONE APPROVAL, ONE RECIPIENT. Not a count and not a subset test: every outside address on this
   * message must be the address she approved. A message addressed to the approved founder AND a
   * journalist is not partly approved, it is refused.
   */
  const wrong = outside.filter((a) => a !== approved.recipient);
  if (wrong.length > 0) {
    throw new SendBlocked(
      `approval ${approved.approvalId} authorises ${approved.recipient} only, and this message is also ` +
        `addressed to ${wrong.join(", ")}. An approval is for one recipient; it is not a licence to send.`,
    );
  }
}

/**
 * The preview marker on the environment, read without importing the worker service.
 *
 * ON THE ENV RATHER THAN IN A MODULE VARIABLE. A Worker isolate serves many requests, and a module
 * global would leak one request's preview mode into another's live send — the worst possible
 * direction for this particular bug. `Env` is already threaded through every function that can
 * send, so it is the channel that exists; a preview run is given a shallow copy of it carrying this
 * field and nothing else can set it.
 */
export const PREVIEW_ENV_KEY = "__wpPreview";

export interface PreviewEnvMarker {
  id: string;
  what: string;
  requestedByEmail: string;
}

export function previewContextOf(env: unknown): PreviewEnvMarker | null {
  if (!env || typeof env !== "object") return null;
  const marker = (env as Record<string, unknown>)[PREVIEW_ENV_KEY];
  if (!marker || typeof marker !== "object") return null;
  const m = marker as Partial<PreviewEnvMarker>;
  return typeof m.id === "string" && typeof m.what === "string" && typeof m.requestedByEmail === "string"
    ? { id: m.id, what: m.what, requestedByEmail: m.requestedByEmail }
    : null;
}

/** True when this environment is a preview run. The question every boundary asks. */
export function isPreviewEnv(env: unknown): boolean {
  return previewContextOf(env) !== null;
}
