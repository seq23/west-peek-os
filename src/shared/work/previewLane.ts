import { PARTNER_EMAILS, PREVIEW_PARTNER, isPartnerEmail, partnerByEmail } from "../registry/partners";

/**
 * THE PREVIEW LANE — "yes, send that" (17 Sep 2026).
 *
 * Operator: "if i approve i'm going to want him to email it to scooter right away — how would i do
 * that?" A deliverable on her Home could be DISMISSED or given FEEDBACK. There was no way to say
 * yes. The two workarounds were writing a second work card, or forwarding it from her own mailbox —
 * and a forward puts her name on his work, which is the opposite of what having employees is for.
 *
 * ─── ONE WORD, ONE MEANING ─────────────────────────────────────────────────────────────────────
 *
 * "Preview" meant two unrelated things before this file existed:
 *
 *   · THE MECHANISM — `shared/work/preview.ts` and `applyPreviewBoundary` in
 *     `worker/effects/emailTransport.ts`. Enforced at the send boundary, structurally unable to
 *     reach anybody but Sequoia. A guarantee.
 *   · PROSE IN A WORK CARD — "show this to Sequoia first", written for an employee to interpret.
 *     A hope.
 *
 * This is the lane, and it is the first kind. A card marked preview-first does not ASK the employee
 * to hold the message back; the send path holds it back, at the same boundary, and files it for her
 * instead. `assertPreviewLane` in `emailTransport.ts` is where that is enforced, and
 * `scripts/validate/a-preview-guards-the-send.mjs` fails the build if a transport is added that can
 * get round it.
 *
 * ─── HER DEFAULT RULE, EXACTLY AS SHE STATED IT ────────────────────────────────────────────────
 *
 *   "anything to anyone other than sequoia@ and scooter@ should be default preview. everything else
 *    does not need to be default preview unless i specifically ask for it"
 *
 * SCOOTER IS INSIDE THE FIRM. He is a Managing Partner with final authority and 51%, not an
 * outsider, and the whole point of Walker's Monday hire search is that it lands on his desk on
 * Monday without a person in between. Anything addressed to either partner therefore sends
 * normally. `previewFirstFor` returns `false` for both addresses unless the card asked for a
 * preview, and `tests/previewLane.test.ts` asserts Monday's note is untouched.
 *
 * ASK THE REGISTRY, NEVER TYPE THE ADDRESS. `isPartnerEmail` is the one answer to "is this one of
 * the two partners?" — see `shared/registry/partners.ts` for why four copies of that fact was the
 * defect this file must not recreate. `scripts/validate/one-partner-registry.mjs` fails the build
 * on a typed partner address, and this module contains none.
 */

/** Why something is in the lane. Stored on the row, shown to her, checked by the validator. */
export type PreviewLaneReason = "DEFAULT_OUTSIDE_FIRM" | "ASKED_FOR";

export interface PreviewLaneDecision {
  previewFirst: boolean;
  /** Null when it is not in the lane. */
  reason: PreviewLaneReason | null;
  /** One line, for the card, the event and her Home. */
  why: string;
}

export interface PreviewLaneInput {
  /** The address the work is addressed to. */
  recipient: string | null | undefined;
  /**
   * `work_card.preview_first`. NULL/undefined is NOT "no" — it is "nobody said", and the default
   * rule then decides from the recipient. `true` is her asking for one on something that would
   * otherwise have gone straight out; `false` is nobody, because only she can waive her own rule
   * and she does that by addressing it to a partner.
   */
  cardAsked?: boolean | null;
}

/**
 * Is this preview-first? The one place the question is answered.
 *
 * THE OUTSIDE-THE-FIRM TEST IS THE DEFAULT AND CANNOT BE WAIVED BY A CARD. `cardAsked === false` on
 * a note addressed to a journalist still previews: a flag set by whoever wrote the card is not
 * permission to bypass a rule the owner stated about the firm's outbound mail. The only thing a
 * card can do is ADD a preview, never remove one. That asymmetry is deliberate and is what makes
 * this a guard rather than a setting.
 */
export function previewFirstFor(input: PreviewLaneInput): PreviewLaneDecision {
  const to = (input.recipient ?? "").trim().toLowerCase();
  if (!isPartnerEmail(to)) {
    return {
      previewFirst: true,
      reason: "DEFAULT_OUTSIDE_FIRM",
      why: `${to || "an unnamed recipient"} is not one of the two partners, so this goes to ${PREVIEW_PARTNER.firstName} first. Her rule: anything to anyone other than the partners is preview by default.`,
    };
  }
  if (input.cardAsked === true) {
    const partner = partnerByEmail(to);
    return {
      previewFirst: true,
      reason: "ASKED_FOR",
      why: `${partner?.fullName ?? to} is inside the firm, so this would normally send straight out — but the card was marked preview-first.`,
    };
  }
  const partner = partnerByEmail(to);
  return {
    previewFirst: false,
    reason: null,
    why: `${partner?.fullName ?? to} is a Managing Partner. Inside the firm: it sends normally.`,
  };
}

/**
 * The addresses an employee's mail may reach with nobody's hand in between. Published from the
 * registry so a reader of this file does not have to go and check, and so the validator has one
 * symbol to assert on.
 */
export const SENDS_WITHOUT_APPROVAL: readonly string[] = PARTNER_EMAILS;

// ── THE TOKEN ─────────────────────────────────────────────────────────────────────────────────

/**
 * WHY THIS TOKEN IS STRONGER THAN THE PACKET REPLY TOKEN, WRITTEN WHERE THE NEXT READER WILL HIT IT.
 *
 * Earlier today, deliberately, Scooter's STEERING replies were given no token at all: recognising
 * an authenticated sender was enough, because the worst a forged steer can do is waste a week of
 * one employee's attention, and the next note makes it visible. Cheap to detect, cheap to undo.
 *
 * THIS IS THE OPPOSITE. A click on one of these links SENDS MAIL — on her authority, in an
 * employee's voice, over the firm's domain, to somebody outside the firm. It is an AUTHORISING
 * action, not a steering one:
 *
 *   · IRREVERSIBLE. There is no unsend. The founder, the LP or the journalist has read it.
 *   · REPUTATIONAL. The damage is to what the firm appears to have said, not to a week's plan.
 *   · SILENT. A forged send looks exactly like a real one in every log the firm keeps.
 *
 * RECOGNISING THE SENDER IS NOT SUFFICIENT HERE, and that is the specific bar that moves. The
 * packet scheme leans on `mailAuthority` — SPF/DKIM/DMARC through a trusted resolver — because it
 * arrives as mail. This arrives as an HTTP request from a phone, where there is no envelope to
 * check and a `From` header does not exist. So the LINK ITSELF is the credential and is built like
 * one:
 *
 *   PER PREVIEW      One token authorises one message to one recipient. No standing approve URL.
 *   UNGUESSABLE      26 symbols of a 31-symbol alphabet ≈ 2^128, from `crypto.getRandomValues`.
 *                    A miss matches no row: there is nothing to brute-force against.
 *   STORED HASHED    The row keeps `sha256(token)`. A database dump, a backup or a log line yields
 *                    no working authorisation. (The packet token is stored in the clear precisely
 *                    because it is inert without an authenticated partner `From`. This one is not
 *                    inert, so it is not stored.)
 *   SINGLE USE       Claimed by an UPDATE that matches on `used_at IS NULL`, so two taps on a
 *                    phone — or a mail client prefetching — cannot send twice.
 *   EXPIRING         An approval is only meaningful while the draft it approves is current.
 *   REFUSES TO GUESS `readApprovalToken` accepts exactly one shape and normalises nothing beyond
 *                    case and surrounding space. Wrong length, a stray character, a lookalike:
 *                    refused, with the refusal recorded. A misread that emails the wrong person is
 *                    worse than making her open the OS.
 *
 * AND THE LINK IS NOT THE LAST GATE. Even holding a valid token, the send goes through
 * `assertPreviewLane` at the transport, which checks that THIS approval is the one that matches
 * THIS recipient. A token for a message to one person cannot be replayed against another.
 */

/**
 * No O/0, no I/1/L. The same alphabet as the packet token and for the same reason — this string
 * ends up in a URL a person may read aloud or retype off a screen.
 */
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** 26 × log2(31) ≈ 128 bits. */
export const APPROVAL_TOKEN_LENGTH = 26;

/** How long a yes stays meaningful. Long enough for a weekend, short enough to matter. */
export const APPROVAL_TTL_HOURS = 72;

/**
 * A fresh token. `crypto.getRandomValues`, never `Math.random`: this is the only secret in the
 * scheme and a predictable secret is not one.
 *
 * REJECTION SAMPLING rather than `% ALPHABET.length`. 256 is not a multiple of 31, so the modulo
 * shortcut the packet token uses biases the first eight symbols — harmless at four characters
 * deciding a calendar entry, not something to copy into a credential that sends mail.
 */
export function mintApprovalToken(random: Crypto = crypto): string {
  const out: string[] = [];
  const limit = Math.floor(256 / ALPHABET.length) * ALPHABET.length; // 248
  const buf = new Uint8Array(64);
  while (out.length < APPROVAL_TOKEN_LENGTH) {
    random.getRandomValues(buf);
    for (const b of buf) {
      if (b >= limit) continue;
      out.push(ALPHABET[b % ALPHABET.length]!);
      if (out.length === APPROVAL_TOKEN_LENGTH) break;
    }
  }
  return out.join("");
}

const TOKEN_SHAPE = new RegExp(`^[${ALPHABET}]{${APPROVAL_TOKEN_LENGTH}}$`);

/**
 * Read a token off a URL, or refuse.
 *
 * UNWILLING TO GUESS, which is the property the packet reader also has and for a sharper reason
 * here. No lookalike folding (a `0` is not an `O`), no truncation, no prefix matching. The only
 * normalisation is trimming surrounding space and upper-casing, because a URL may arrive from a
 * mail client that lower-cased the path. Anything else is refused and the refusal is recorded.
 */
export function readApprovalToken(raw: string | null | undefined): string | null {
  const t = (raw ?? "").trim().toUpperCase();
  return TOKEN_SHAPE.test(t) ? t : null;
}

/** What is stored. The plaintext lives in her inbox and nowhere else. */
export async function hashApprovalToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** When a yes stops meaning anything. */
export function approvalExpiry(now: Date = new Date()): string {
  return new Date(now.getTime() + APPROVAL_TTL_HOURS * 3600_000).toISOString();
}

// ── THE THREE ANSWERS ─────────────────────────────────────────────────────────────────────────

/**
 * Three actions and no more. Operator's table, unchanged:
 *
 *   SEND IT     → goes to the named recipient now, from the employee, in their voice, UNCHANGED.
 *   SEND IT BACK→ her words reach the employee; they redo it and preview again.
 *   DISMISS     → it dies there.
 */
export const PREVIEW_ACTIONS = ["SEND", "RETURN", "DISMISS"] as const;
export type PreviewAction = (typeof PREVIEW_ACTIONS)[number];

export function isPreviewAction(v: string): v is PreviewAction {
  return (PREVIEW_ACTIONS as readonly string[]).includes(v);
}

export interface PreviewActionDef {
  key: PreviewAction;
  label: string;
  /** What it actually does, in her words. */
  effect: string;
}

export const PREVIEW_ACTION_DEFS: readonly PreviewActionDef[] = [
  {
    key: "SEND",
    label: "Send it",
    effect: "Goes to the named recipient now, from the employee, in their voice, unchanged.",
  },
  {
    key: "RETURN",
    label: "Send it back",
    effect: "Your words reach the employee; they redo it and preview it again.",
  },
  { key: "DISMISS", label: "Dismiss", effect: "It dies there. Nothing is sent." },
] as const;

/**
 * The line every preview carries, naming the recipient.
 *
 * SAYS THE ADDRESS, NOT "the recipient". Operator: "The preview names the recipient it is intended
 * for, so 'send it' is never ambiguous." A button that says Send with no name on the page beside it
 * is a button somebody presses twice and asks about afterwards.
 */
export function previewIntendedFor(input: {
  recipient: string;
  employee: string;
  setBy: "EMPLOYEE" | "PARTNER";
}): string {
  const who = input.setBy === "PARTNER" ? "you set the recipient" : `${input.employee} addressed this`;
  return `If you send it, it goes to ${input.recipient} — ${who}. You can change the address before sending.`;
}
