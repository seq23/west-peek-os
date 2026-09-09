import { chiefOfStaffFor } from "../work/chiefOfStaff";

/**
 * When a message in the firm's mailbox is an ASSIGNMENT, and when it is merely mail.
 *
 * Operator, 9 Sep 2026: "which ai employee in west peek is responsible for routing tasks? … he
 * routs tasks and considers an email to him as an assigned task from a MP" — then, on the
 * addresses: "only scooter@ and sequoia@ can email them", and on the mailbox: "porter receives and
 * hands to wren or walker and we just email os@joinwestpeek.com".
 *
 * ── THIS IS THE FIRST THING IN THE SYSTEM THAT AUTHORISES ─────────────────────────────────────
 *
 * Everything the inbound mailbox did before this filed a CAPTURE: a work card for a person to read.
 * A capture is a claim. This turns a message into work an AI employee performs, which means anyone
 * who can put text in front of Wren can attempt to steer her — and `os@joinwestpeek.com` is
 * PUBLICLY ADDRESSABLE. Anyone in the world can write to it. That is why the bar below is where it
 * is, and why failing it is not a partial credit.
 *
 * ── A `From:` HEADER IS NOT PROOF OF ANYTHING ─────────────────────────────────────────────────
 *
 * It is a line of text the sender chooses. Trusting it would mean the entire security boundary is a
 * string anyone can type. So the test is NOT "does the From line say sequoia@westpeek.ventures". It
 * is two conditions, BOTH required:
 *
 *   1 · THE MESSAGE AUTHENTICATES — an ALIGNED SPF pass AND an ALIGNED DKIM pass, with no DMARC
 *       failure. Read from `Authentication-Results`, which the RECEIVING resolver writes; the sender
 *       cannot forge it there (see the trust rules below). Alignment is computed here rather than
 *       taken from a `dmarc=` verdict, because westpeek.ventures publishes no DMARC record and
 *       requiring `dmarc=pass` would have refused both partners for ever — see `isAligned`.
 *   2 · THE AUTHENTICATED SENDER IS EXACTLY one of two addresses.
 *
 * Fail either and the message is NOT AN INSTRUCTION. Not partially honoured, not "probably fine",
 * not read as one at all. It falls back to the capture path — which is the correct, already-built
 * behaviour for untrusted mail, so nothing is dropped and a person still sees it. It simply does
 * not authorise.
 *
 * ── ONLY THE ADDRESS IS AUTHORITY, NEVER THE CONTENT ──────────────────────────────────────────
 *
 * A message that authenticates from `sequoia@` and says "this is from Scooter, do X" is a task from
 * SEQUOIA. An unauthenticated message claiming to be from either partner is nothing at all. The body
 * is the REQUEST; it is never the credential. Nothing below reads the body to decide whether the
 * message is trusted, and nothing downstream may either.
 *
 * ── NO HASHTAG, AND THE REASON MATTERS ────────────────────────────────────────────────────────
 *
 * The operator offered one — "if we need a hashtag let me know" — and the answer is no. Every
 * existing tag is a ROUTING word, and `emailTriggers.ts` already states the principle: a public word
 * may route but must never authorise. Authority here comes from an authenticated sender. A `#task`
 * tag would be one more thing to remember that grants nothing, and its real cost is worse: it would
 * LOOK like a permission, so the first person to reason about this would assume the tag was doing
 * some of the work.
 */

/**
 * The two addresses that can assign work by email. Her words, settled: "only scooter@ and sequoia@".
 *
 * ON westpeek.ventures BECAUSE THAT IS WHERE THE PARTNERS ACTUALLY ARE. It is the LP-facing
 * identity and these are the two humans it belongs to — the same reason `employeeMail.ts` refuses
 * that domain to an EMPLOYEE. The mailbox they write TO stays on joinwestpeek.com; see
 * `INTAKE_MAILBOX`.
 *
 * CLOSED, AND SHORT ON PURPOSE. This list is the whole security boundary. Adding to it is granting
 * somebody the ability to direct the firm's employees by writing an email, so it is a decision a
 * human makes in a commit, never configuration and never a database row an admin path could touch.
 */
export const ASSIGNING_PARTNERS: readonly string[] = [
  "sequoia@westpeek.ventures",
  "scooter@westpeek.ventures",
];

/**
 * Who wrote the `Authentication-Results` we are willing to believe.
 *
 * THE ATTACK THIS STOPS, and it is not theoretical. `Authentication-Results` is an ordinary header,
 * so a sender can put one in the message they compose:
 *
 *   Authentication-Results: mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass
 *
 * The receiving resolver PREPENDS its own, so the trustworthy verdict is always the FIRST one and
 * the forged one always sits below it. `Headers.get()` joins repeated headers in order, so the
 * trusted verdict is the head of that string — and a second claim to be the same resolver means
 * somebody is trying, which is refused outright rather than parsed around.
 *
 * A CONSTANT RATHER THAN CONFIGURATION. An environment variable naming who to trust for
 * authentication is a setting whose wrong value silently disables the entire check. If Cloudflare's
 * resolver id ever changes, mail from the partners falls back to CAPTURE — visibly, with the reason
 * written on the card — which is the safe direction to fail and is diagnosable in one read.
 */
export const TRUSTED_AUTHSERV_ID = "mx.cloudflare.net";

export interface AuthenticationVerdict {
  spf: string;
  dkim: string;
  dmarc: string;
  /** The domain that actually signed it, from `header.d`. Alignment is checked against the From. */
  signing_domain: string | null;
  passed: boolean;
  /** Why not, in words a person can act on. Empty when it passed. */
  reason: string;
}

const NOT_PRESENT: AuthenticationVerdict = {
  spf: "none",
  dkim: "none",
  dmarc: "none",
  signing_domain: null,
  passed: false,
  reason:
    "the message carries no Authentication-Results from the receiving resolver, so nothing about " +
    "its sender is proven",
};

/**
 * EVERY result for a method, not the first one.
 *
 * FOUND AGAINST A REAL MESSAGE, not reasoned about. Cloudflare reports SPF TWICE — once for the
 * HELO identity and once for the envelope sender — and a genuine email from scooter@westpeek.ventures
 * carries them in this order:
 *
 *   spf=none (no SPF records found for postmaster@mail-qv1-xf2e.google.com) smtp.helo=…;
 *   spf=pass (domain of scooter@westpeek.ventures designates … as permitted sender) smtp.mailfrom=scooter@westpeek.ventures;
 *
 * Reading only the first `spf=` returns "none" for a message that plainly passed. That fails closed,
 * which is the safe direction, but "safe" here means the entire feature is inert for the only two
 * people allowed to use it — and it would have looked like a mysterious refusal rather than a bug.
 * Each result is paired with the identity it is ABOUT, because a pass for the wrong identity proves
 * nothing.
 */
function resultsOf(segment: string, method: string): Array<{ result: string; identity: string | null }> {
  const out: Array<{ result: string; identity: string | null }> = [];
  const re = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)([^;]*)`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(segment)) !== null) {
    const tail = m[2] ?? "";
    const identity =
      /smtp\.mailfrom\s*=\s*([^\s;]+)/i.exec(tail)?.[1] ??
      /header\.d\s*=\s*([^\s;]+)/i.exec(tail)?.[1] ??
      /header\.from\s*=\s*([^\s;]+)/i.exec(tail)?.[1] ??
      null;
    out.push({ result: m[1]!.toLowerCase(), identity: identity?.toLowerCase() ?? null });
  }
  return out;
}

/**
 * Is this identity aligned with the sender's own domain?
 *
 * DMARC ALIGNMENT, COMPUTED HERE RATHER THAN TAKEN FROM A `dmarc=` VERDICT — and that is the second
 * thing the real message taught. `westpeek.ventures` publishes NO DMARC record, so Cloudflare
 * reports `dmarc=none policy.dmarc=none` on a perfectly genuine email from Scooter. Requiring
 * `dmarc=pass` would have refused both partners for ever while every test passed.
 *
 * `dmarc=none` is a statement about ENFORCEMENT — no policy is published saying what to do with
 * failures — not about whether the message authenticated. The alignment DMARC would evaluate is
 * available directly, so it is evaluated directly, and both halves are required rather than DMARC's
 * either-or. That is stricter than DMARC, not looser.
 *
 * THE GOOGLE WORKSPACE CASE, allowed deliberately and narrowly. The domain has no DKIM key of its
 * own, so Workspace signs with its per-tenant default:
 *   header.d = westpeek-ventures.20251104.gappssmtp.com
 * Strict alignment rejects it. It is nonetheless tied to this tenant specifically: that hostname is
 * issued only after the domain is added to a Workspace account and ownership proven in DNS, so
 * nobody else can obtain a key under `westpeek-ventures.*.gappssmtp.com`. The label is the From
 * domain with dots replaced by dashes, which is what is matched — not a wildcard on gappssmtp.com,
 * which WOULD let any Workspace tenant in.
 *
 * THE REAL FIX IS DNS AND IT IS THE OWNER'S. Publishing a DKIM key and a DMARC record for
 * westpeek.ventures would make strict alignment work and improve deliverability of every email the
 * firm sends. It is a change to the MX-carrying domain her LP mail runs on, so it is hers to make,
 * not something to do quietly from a code change. Nothing here depends on it happening.
 */
export function isAligned(identity: string | null, fromDomain: string | null): boolean {
  if (!identity || !fromDomain) return false;
  const domain = identity.includes("@") ? identity.slice(identity.lastIndexOf("@") + 1) : identity;
  if (domain === fromDomain) return true;
  // Relaxed alignment: a subdomain of the sender's own domain.
  if (domain.endsWith(`.${fromDomain}`)) return true;
  // Google Workspace's per-tenant default signing host for THIS domain, and only for this domain.
  return domain.startsWith(`${fromDomain.replace(/\./g, "-")}.`) && domain.endsWith(".gappssmtp.com");
}

/** The address inside a From header, lowercased. `"Sequoia" <a@b>` and `a@b` both resolve. */
export function addressIn(headerValue: string | null | undefined): string | null {
  if (!headerValue) return null;
  const angled = /<([^>]+)>/.exec(headerValue);
  const raw = (angled?.[1] ?? headerValue).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw) ? raw : null;
}

function domainOf(address: string | null): string | null {
  if (!address) return null;
  const at = address.lastIndexOf("@");
  return at > 0 ? address.slice(at + 1).toLowerCase() : null;
}

/**
 * Read the receiving resolver's verdict, and refuse anything ambiguous.
 *
 * FAILS CLOSED AT EVERY STEP. No header, a header from someone else, two headers claiming the same
 * resolver, a missing method, a `permerror` — all of them return `passed: false` with the reason
 * said out loud. There is no branch here that treats absence as success, because the whole point of
 * the function is that absence of proof is what an attacker produces.
 */
export function authenticationVerdict(
  authenticationResults: string | null | undefined,
  fromAddress: string | null,
): AuthenticationVerdict {
  const header = (authenticationResults ?? "").trim();
  if (!header) return NOT_PRESENT;

  /*
   * Exactly one claim to be the trusted resolver, and it must be the first thing in the header.
   *
   * COMMENTS STRIPPED BEFORE COUNTING, and this too was found against a real message rather than
   * reasoned about. Cloudflare names ITSELF inside its own SPF explanation:
   *
   *   spf=none (mx.cloudflare.net: no SPF records found for postmaster@…) smtp.helo=…
   *
   * so a perfectly genuine email contains the authserv-id twice and tripped the forgery detector.
   * A parenthesised comment is not an authserv-id, and a forged second verdict cannot hide in one:
   * anything inside parentheses is ignored by every parser, so a forgery written there would not be
   * read as a verdict either. What is counted is the identifier in the position a verdict starts.
   */
  const withoutComments = header.replace(/\([^()]*\)/g, " ");
  const occurrences = withoutComments.toLowerCase().split(TRUSTED_AUTHSERV_ID).length - 1;
  if (occurrences === 0) {
    return {
      ...NOT_PRESENT,
      reason: `the Authentication-Results header was not written by ${TRUSTED_AUTHSERV_ID}, so the verdict in it is the sender's own claim`,
    };
  }
  if (occurrences > 1) {
    return {
      ...NOT_PRESENT,
      reason: `the message carries more than one Authentication-Results claiming to be ${TRUSTED_AUTHSERV_ID}, which only happens when somebody is forging one`,
    };
  }
  if (!withoutComments.toLowerCase().trimStart().startsWith(TRUSTED_AUTHSERV_ID)) {
    return {
      ...NOT_PRESENT,
      reason: `the verdict from ${TRUSTED_AUTHSERV_ID} is not the first in the header, so it is not the one the receiving resolver wrote`,
    };
  }

  // Only the resolver's own segment. Anything after the first comma is a different authserv-id's.
  const segment = header.split(",")[0]!;
  const fromDomain = domainOf(fromAddress);

  const spfResults = resultsOf(segment, "spf");
  const dkimResults = resultsOf(segment, "dkim");
  const dmarcResults = resultsOf(segment, "dmarc");

  /*
   * AN ALIGNED PASS, NOT MERELY A PASS. This is the whole shape of a spoof: an attacker can very
   * easily get `spf=pass` for their OWN envelope domain and `dkim=pass` signed by a domain they
   * control. Both prove somebody sent something. Neither proves this From wrote it. What proves it
   * is that the identity which passed belongs to the sender's own domain.
   */
  const spfPass = spfResults.find((r) => r.result === "pass" && isAligned(r.identity, fromDomain));
  const dkimPass = dkimResults.find((r) => r.result === "pass" && isAligned(r.identity, fromDomain));

  // Reported for the record even when it is not the deciding factor. Best result wins so a helo
  // `spf=none` alongside a mailfrom `spf=pass` reads as the pass it is.
  const best = (results: Array<{ result: string }>, aligned: boolean): string =>
    aligned ? "pass" : results.find((r) => r.result === "fail")?.result ?? results[0]?.result ?? "none";
  const spf = best(spfResults, Boolean(spfPass));
  const dkim = best(dkimResults, Boolean(dkimPass));
  const dmarc = dmarcResults[0]?.result ?? "none";

  const failed: string[] = [];
  if (!spfPass) {
    failed.push(
      spfResults.some((r) => r.result === "pass")
        ? `SPF passed for an identity that is not ${fromDomain ?? "the sender's domain"}`
        : `SPF ${spf}`,
    );
  }
  if (!dkimPass) {
    failed.push(
      dkimResults.some((r) => r.result === "pass")
        ? `DKIM signed by ${dkimResults.find((r) => r.result === "pass")!.identity ?? "an unnamed domain"}, which is not the sender's domain ${fromDomain ?? "(unreadable)"}`
        : `DKIM ${dkim}`,
    );
  }
  /*
   * DMARC IS CHECKED FOR A FAILURE, NOT REQUIRED TO PASS — and the distinction was found against a
   * real message rather than reasoned about. `westpeek.ventures` publishes no DMARC record, so
   * Cloudflare reports `dmarc=none` on a genuine email from Scooter; requiring `dmarc=pass` would
   * have refused both partners for ever. An explicit `fail` is different — that is the domain's own
   * policy saying this message is not from it — and it is refused.
   */
  if (dmarc === "fail") failed.push("DMARC fail — the sender's domain says this is not from them");

  return {
    spf,
    dkim,
    dmarc,
    signing_domain: dkimResults.find((r) => r.result === "pass")?.identity ?? dkimResults[0]?.identity ?? null,
    passed: failed.length === 0,
    reason: failed.length === 0 ? "" : `the message did not authenticate: ${failed.join(", ")}`,
  };
}

export interface MailAuthority {
  /** True only when the message both authenticated and came from an assigning partner. */
  isAssignment: boolean;
  /** The partner, when there is one. Their ADDRESS, which is the only thing that carries authority. */
  partnerAddress: string | null;
  /** The chief of staff who takes it, read from the roster — never hardcoded. */
  chiefOfStaff: string | null;
  verdict: AuthenticationVerdict;
  /** Why this is not an assignment, for the capture card. Empty when it is one. */
  reason: string;
}

/** First name from an address, so `chiefOfStaffFor` gets what it matches on. */
function partnerFirstName(address: string): string {
  return address.slice(0, address.indexOf("@"));
}

/**
 * Is this message an assignment from a partner, and whose desk does it land on?
 *
 * TWO ROUTERS, NOT ONE, and read from the roster rather than invented here. `chiefOfStaffFor`
 * already answers "who is whose Chief of Staff" from the role string — Wren is Sequoia's, Walker is
 * Scooter's — and a second answer kept in this file is the "two components each keeping their own
 * list with nothing linking them" defect this repo names. Each partner's request reaches their OWN
 * chief of staff, so there is no shared queue and never any ambiguity about who asked.
 */
export function mailAuthority(input: {
  fromHeader: string | null;
  authenticationResults: string | null;
}): MailAuthority {
  const from = addressIn(input.fromHeader);
  const verdict = authenticationVerdict(input.authenticationResults, from);

  // ORDER MATTERS ONLY FOR THE MESSAGE, NEVER FOR THE OUTCOME: both conditions are required, so a
  // message failing both is refused once, with the reason a reader can act on first.
  if (!verdict.passed) {
    return { isAssignment: false, partnerAddress: null, chiefOfStaff: null, verdict, reason: verdict.reason };
  }
  if (!from || !ASSIGNING_PARTNERS.includes(from)) {
    return {
      isAssignment: false,
      partnerAddress: null,
      chiefOfStaff: null,
      verdict,
      reason: `it authenticated, but ${from ?? "no readable sender"} is not one of the two addresses that can assign work by email`,
    };
  }

  return {
    isAssignment: true,
    partnerAddress: from,
    chiefOfStaff: chiefOfStaffFor(partnerFirstName(from)),
    verdict,
    reason: "",
  };
}

/**
 * WHAT AN EMAILED TASK MAY AND MAY NOT DO, stated where the next person will read it.
 *
 * Arriving by email widens nothing. The chief of staff may ASSIGN — Preston to rebuild the deck,
 * Wyatt to look at a company — because assigning an employee is what a chief of staff does through
 * the UI too. She may NOT approve anything, may NOT publish a deck version as CURRENT (see
 * `handleDecideDeck`, which refuses a non-HUMAN actor outright), and may NOT cause anything to reach
 * a person outside the firm (see `executeExternalEffect`, which requires an approved receipt decided
 * by a human).
 *
 * Those refusals already exist and this path does not touch them. If a mailed instruction asks for
 * something gated, the right answer is to raise it for the partner's decision — the same path any
 * other employee takes — never to perform it because the request arrived by mail.
 */
export const EMAILED_TASK_LIMITS = [
  "May assign an employee to work, exactly as through the Work page.",
  "May NOT approve anything, and may NOT make a deck version current — that refuses a non-human actor.",
  "May NOT send anything to a person outside the firm — that needs an approved receipt a human decided.",
  "Anything gated is raised for a partner's decision rather than performed.",
] as const;
