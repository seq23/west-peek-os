import type { Env } from "../env";
import { findGmailThread, type GmailThreadSpot } from "../effects/googleClient";
import { serviceAccountToken } from "../effects/googleWorkspaceClient";
import { TLC_OWNER } from "../../shared/tlc/learningClub";

/*
 * WYNN NEVER DROPS THE THREAD (owner, 13 Nov 2026).
 *
 * What happened: every answer Wynn sent a brand carried In-Reply-To but not Gmail's conversation id, and Gmail starts
 * a new conversation for an API send without one. By 10 Nov the Pinecone conversation sat in four separate threads in
 * her mailbox and the pricing email was alone in the newest. Follow-ups had a second hole: they answered the
 * Message-ID we generated, but Gmail replaces that id when it sends, so the brand's mail client had nothing to hang
 * the follow-up on.
 *
 * The rule: her mailbox is asked where the conversation is, every time. An answer goes on the thread of the brand
 * message it answers; a follow-up goes on the thread of the last email we sent that contact, answering the Message-ID
 * Gmail really gave it. When her mailbox cannot say, the send is a NAMED STOP and nothing goes out; the last door
 * (`brandMailAsOwner` in effects/executor.ts) refuses any brand email after the first that is not such a reply.
 */

export const THREAD_NOT_FOUND = "TLC_BRAND_THREAD_NOT_FOUND";
const GMAIL_READ_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

/** A message in her mailbox by search or by Gmail id (tests pass a fake; production reads her mailbox, read-only). */
export type ThreadFinder = (env: Env, where: { query: string } | { id: string }) => Promise<GmailThreadSpot | null>;
export const defaultThreadFinder: ThreadFinder = async (env, where) =>
  findGmailThread(await serviceAccountToken(env, [GMAIL_READ_SCOPE], TLC_OWNER.email), where);

/** What every reply on a brand conversation carries (the names the `email.send` payload uses). */
export interface BrandThreading { gmail_thread_id: string; in_reply_to: string; references: string[] }

/** The send stopped because the conversation could not be found. `retry`: her mailbox could not be read just now. */
export class BrandThreadError extends Error {
  constructor(why: string, readonly retry = false) { super(`NAMED STOP [${THREAD_NOT_FOUND}]: nothing sent; ${why}`); }
}

const bare = (id: string | null | undefined): string => (id ?? "").trim().replace(/^<|>$/g, "");
const threading = (spot: GmailThreadSpot): BrandThreading => ({ gmail_thread_id: spot.threadId, in_reply_to: bare(spot.messageId), references: spot.references.map(bare).filter(Boolean).slice(-30) });

/**
 * Where an answer to the brand's message goes: that message's own conversation in her mailbox, answering it. A brand
 * message that reached only the intake door is not in her mailbox: then the conversation of the last email we sent
 * that address, still answering the brand's message. Throws the NAMED STOP when neither is there.
 */
export async function replyThread(env: Env, brandMessageId: string, contactEmail: string, finder: ThreadFinder = defaultThreadFinder): Promise<BrandThreading> {
  const mid = bare(brandMessageId);
  if (!mid || mid.startsWith("nomid:")) throw new BrandThreadError("the brand's message has no Message-ID, so its conversation cannot be found in her mailbox");
  try {
    const theirs = await finder(env, { query: `rfc822msgid:${mid}` });
    if (theirs && bare(theirs.messageId) === mid) return threading(theirs);
    const ours = await finder(env, { query: `in:sent to:${contactEmail.trim().toLowerCase()}` });
    if (ours) return { gmail_thread_id: ours.threadId, in_reply_to: mid, references: [...ours.references.map(bare), bare(ours.messageId)].filter(Boolean).slice(-30) };
  } catch (err) {
    throw new BrandThreadError(`her mailbox could not be read to find the brand's conversation (${err instanceof Error ? err.message : String(err)})`.slice(0, 240), true);
  }
  throw new BrandThreadError("neither the brand's message nor an email we sent them is in her mailbox, so there is no conversation to reply on");
}

/**
 * Where a follow-up goes: the conversation of the last email we sent this contact, answering the Message-ID Gmail
 * really gave it. `sent` is what our own record of that send holds (Gmail's ids; the Message-ID we generated). With
 * no Gmail id on record (she wrote the first email herself, or it went before ids were kept) her Sent mail to that
 * address is searched. Her mailbox unreadable: the recorded ids are used when they are complete. Null when nothing says where.
 */
export async function followUpThread(
  env: Env,
  contactEmail: string,
  sent: { gmail_message_id: string | null; gmail_thread_id: string | null; rfc_message_id: string | null } | null,
  finder: ThreadFinder = defaultThreadFinder,
): Promise<(BrandThreading & { subject: string | null }) | null> {
  const recorded = sent?.gmail_thread_id && sent.rfc_message_id ? { gmail_thread_id: sent.gmail_thread_id, in_reply_to: bare(sent.rfc_message_id), references: [], subject: null } : null;
  try {
    const spot = sent?.gmail_message_id
      ? await finder(env, { id: sent.gmail_message_id })
      : await finder(env, { query: `in:sent to:${contactEmail.trim().toLowerCase()}` });
    if (spot) return { ...threading(spot), ...(sent?.gmail_thread_id ? { gmail_thread_id: sent.gmail_thread_id } : {}), subject: spot.subject || null };
  } catch {
    // Her mailbox could not be read: what our own record holds still places the email on its thread.
  }
  return recorded;
}
