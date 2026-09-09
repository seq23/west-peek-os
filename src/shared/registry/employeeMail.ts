import { AI_EMPLOYEE_ROSTER } from "./aiEmployees";

/**
 * Where a West Peek OS employee's email comes FROM.
 *
 * Operator, 9 Sep 2026: "why dont any of the ai employees from os.joinwestpeek.com have emails from
 * @joinwestpeek.com".
 *
 * SHE IS RIGHT AND THERE WAS NEVER A TECHNICAL REASON. `joinwestpeek.com` has been a verified
 * Resend sending domain on the West Peek account the whole time. Employees had no sender identity
 * at all: every message an employee caused went out as the firm's `WP_OS_EMAIL_FROM`, and when the
 * coordinator wired Preston to a notifier by hand he reused Boss OS's — so a WEST PEEK employee
 * signed three emails from `preston@sequoiataylor.com`, the domain of her PERSONAL OS.
 *
 * THAT IS THE BUSINESS-BLENDING DEFECT, AND IT HAS NOW HAPPENED IN BOTH DIRECTIONS IN ONE DAY.
 * The morning's was a Boss OS employee writing from `westpeek.ventures`; the fix there was that
 * Boss OS employees write from `sequoiataylor.com`. The same rule pointed the other way was simply
 * never built. This file is it, and the reason it lives in the shared registry rather than in a
 * transport is that the next person wiring up a notifier will look for the roster, not for the
 * mailer.
 *
 * ── THREE DOMAINS, AND WHY ONLY ONE OF THEM IS FOR EMPLOYEES ──────────────────────────────────
 *
 * `joinwestpeek.com` — EMPLOYEES. It is the hostname the employees actually inhabit
 *   (`os.joinwestpeek.com`, `network.joinwestpeek.com`), it is where the intake mailbox already
 *   lives (`os@joinwestpeek.com`, see `emailTriggers.ts`), and it carries no implication that the
 *   sender is a person at the fund.
 *
 * `westpeek.ventures` — THE PARTNERS AND THE FIRM. This is the LP-FACING IDENTITY: `sequoia@` and
 *   `scooter@` live there and it is printed on page 15 of the deck. An email from
 *   `preston@westpeek.ventures` reads to an outsider as a PERSON AT THE FUND, which is precisely
 *   what an AI employee is not. So it is forbidden to employees — not merely un-preferred — and
 *   `partner_send_as` and `WP_OS_EMAIL_FROM` keep it untouched for the humans and the firm.
 *
 * `sequoiataylor.com` — BOSS OS. A different business with a different Resend account and a
 *   different key. Nothing in this repo may send from it. See `business-separation`: two
 *   businesses, never blended.
 *
 * ── THE THREE RULES, WHICH ARE THE ONES BOSS OS ALREADY PROVED ────────────────────────────────
 *
 * 1 · THE SENDER IS REQUIRED. There is no default and no anonymous employee send. A silent default
 *     is exactly what let every employee send as a generic address for weeks with nobody noticing —
 *     the wrong address never announced itself because no caller ever had to name one.
 *
 * 2 · THE ROSTER IS CLOSED. A name that is not on `AI_EMPLOYEE_ROSTER` is REFUSED, never turned
 *     into an address. This matters more than it looks: a verified domain will happily sign ANY
 *     local part, so `prestn@joinwestpeek.com` would send perfectly, from an address belonging to
 *     nobody, and bounce into a mailbox that does not exist.
 *
 * 3 · SENDER AND KEY TRAVEL TOGETHER. `RESEND_API_KEY` is the West Peek account and can sign only
 *     West Peek's domains; `BOSS_OS_MAIL_KEY` is the other account's and appears nowhere in this
 *     repo. A key from one account sending a domain from the other fails as what looks like a
 *     verification problem, which sends the next person hunting DNS records for a mistake that is
 *     actually a wrong key. Pairing them explicitly is what stops that hour being spent.
 */

/** Employees. The OS hostname they inhabit, verified on the West Peek Resend account. */
export const EMPLOYEE_MAIL_DOMAIN = "joinwestpeek.com";

/**
 * The LP-facing identity. Partners and the firm, never an employee.
 *
 * Refused rather than deprioritised: the harm is not a stylistic one, it is that an outsider
 * reading `preston@westpeek.ventures` reasonably concludes a person at the fund wrote to them.
 */
export const LP_FACING_MAIL_DOMAIN = "westpeek.ventures";

/** Boss OS. A different business, a different Resend account, a different key. Never from here. */
export const FOREIGN_MAIL_DOMAINS: readonly string[] = ["sequoiataylor.com"];

/** The Resend credential that can sign `joinwestpeek.com`. Named so the pairing is checkable. */
export const EMPLOYEE_MAIL_KEY_BINDING = "RESEND_API_KEY";

export class EmployeeSenderError extends Error {}

/** Roster names, lowercased, resolved once. The roster is the list; there is no second list. */
const ROSTER_LOCAL_PARTS = new Map(
  AI_EMPLOYEE_ROSTER.map((e) => [e.name.trim().toLowerCase(), e.name] as const),
);

/**
 * The address this employee sends from.
 *
 * THROWS RATHER THAN FALLING BACK, and the throw is the feature. A caller that cannot name an
 * employee on the roster has a bug, and the safe-looking alternative — quietly sending as the firm
 * — is how the original defect stayed invisible: the mail went out, it looked fine, and nobody
 * learned that the sender was never resolved.
 */
export function employeeSenderAddress(name: string | null | undefined): string {
  const key = (name ?? "").trim().toLowerCase();
  if (!key) {
    throw new EmployeeSenderError(
      "an employee email needs a named sender: there is no default and no anonymous send",
    );
  }
  if (!ROSTER_LOCAL_PARTS.has(key)) {
    throw new EmployeeSenderError(
      `"${name}" is not on the West Peek roster, so no address is minted for them. A verified domain ` +
        `signs any local part, so a typo would send perfectly from an address belonging to nobody.`,
    );
  }
  return `${key}@${EMPLOYEE_MAIL_DOMAIN}`;
}

/** The display name on the envelope: "Preston · West Peek <preston@joinwestpeek.com>". */
export function employeeSenderHeader(name: string): string {
  const address = employeeSenderAddress(name);
  return `${ROSTER_LOCAL_PARTS.get(name.trim().toLowerCase())} · West Peek <${address}>`;
}

/** True when this is an address this repo's employees are allowed to send from. */
export function isEmployeeSender(address: string | null | undefined): boolean {
  if (!address) return false;
  const at = address.lastIndexOf("@");
  if (at <= 0) return false;
  const local = address.slice(0, at).trim().toLowerCase();
  const domain = address.slice(at + 1).trim().toLowerCase().replace(/>$/, "");
  return domain === EMPLOYEE_MAIL_DOMAIN && ROSTER_LOCAL_PARTS.has(local);
}

/** Every employee address, for the surface that tells the operator who has a mailbox. */
export function employeeSenderDirectory(): Array<{ name: string; address: string }> {
  return AI_EMPLOYEE_ROSTER.map((e) => ({ name: e.name, address: employeeSenderAddress(e.name) }));
}
