/**
 * AN EMPLOYEE WHO ANSWERED ON THE WRONG THREAD SAYS SORRY AND ANSWERS AGAIN, UNDER THE PARTNER'S EMAIL (24 Nov 2026).
 *
 * Her words: "if he made a mistake in sending an email to the wrong thread then he should fucking send another duplicate
 * to both of us (scooter gets it 2x thats fine) with an apology about the wrong thread", and "his code needs fixing so
 * that any mistakes get this corrected way to do it". Scooter emailed os@ "Fund I deck" on 23 Nov; Preston answered in
 * the old 26 Oct thread, so Scooter's email looked unanswered.
 *
 * ONE WAY, FOR EVERY EMPLOYEE: the partner's stored email is re-read through the door (`POST /api/inbound-email/reingest`
 * with `correction: "wrong_thread"`, or `scripts/ops/replay-stored-email.mjs <key> --wrong-thread`). The door runs as it
 * always does, so the employee who owns the work writes the answer, and every email it sends to a partner during that
 * re-read is, at the one transport every partner email passes (`execEmail.ts`):
 *   - threaded under the partner's own email (In-Reply-To their Message-ID, "Re: <their subject>"), our own thread token
 *     kept last in References so a reply still reaches the same work;
 *   - sent to BOTH partners (the one who wrote gets it twice; her ruling);
 *   - opened by one plain sentence of apology, in the employee's own voice.
 * A request-scoped store carries it, so no door needs new parameters and nothing outlives the re-read.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { ASSIGNING_PARTNERS } from "../../shared/intake/partnerAuthority";
import { messageReference, replySubject } from "../../shared/email/thread";

export interface WrongThreadCorrection {
  /** The partner's own email, as its headers carry it. */
  messageId: string;
  references: string | null;
  subject: string;
  /** "Scooter": whose email was answered in the wrong place. */
  partnerFirstName: string;
}

const scope = new AsyncLocalStorage<WrongThreadCorrection>();

/** Runs `fn` with every partner email it sends corrected; null when the message cannot be answered (no Message-ID). */
export function withWrongThreadCorrection<T>(c: WrongThreadCorrection, fn: () => Promise<T>): Promise<T> {
  return scope.run(c, fn);
}

export function activeCorrection(): WrongThreadCorrection | null {
  return scope.getStore() ?? null;
}

export function apologyLine(partnerFirstName: string): string {
  return `Sorry, my answer to ${partnerFirstName}'s email went into the wrong email thread. Here it is again, under ${partnerFirstName}'s email, to both of you.`;
}

const MSG_ID = /<[^\s<>"]{1,300}@[^\s<>"]{1,300}>/g;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface OutgoingPartnerMail {
  to: string | readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  html: string;
  headers?: Record<string, string>;
}

/**
 * The same email, corrected. Only mail to the partners is touched (the caller only sends there); with no Message-ID to
 * answer the email is returned unchanged, so a correction can never invent a thread.
 */
export function correctPartnerMail<M extends OutgoingPartnerMail>(c: WrongThreadCorrection | null, m: M): M {
  if (!c) return m;
  const theirs = messageReference(c.messageId);
  const subject = replySubject(c.subject);
  if (!theirs || !subject) return m;
  const ours = (m.headers?.References ?? m.headers?.["In-Reply-To"] ?? "").match(MSG_ID) ?? [];
  const earlier = (c.references ?? "").match(MSG_ID) ?? [];
  const references = [...new Set([...earlier.slice(-8), theirs, ...ours.filter((r) => r !== theirs)])].join(" ");
  const asked = (Array.isArray(m.to) ? m.to : [m.to as string]).map((a) => a.trim().toLowerCase());
  const to = [...new Set([...asked, ...ASSIGNING_PARTNERS])];
  const cc = (m.cc ?? []).filter((a) => !to.includes(a.trim().toLowerCase()));
  const line = apologyLine(c.partnerFirstName);
  const p = `<p>${esc(line)}</p>`;
  const html = /<body[^>]*>/i.test(m.html) ? m.html.replace(/<body[^>]*>/i, (b) => `${b}${p}`) : `${p}${m.html}`;
  return { ...m, to, cc, subject, text: `${line}\n\n${m.text}`, html, headers: { ...(m.headers ?? {}), "In-Reply-To": theirs, References: references } };
}
