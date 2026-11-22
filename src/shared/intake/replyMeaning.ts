/**
 * WHAT A REPLY MEANS, FROM THE ONE MODEL READ (22 Nov 2026, engineering sweep row 5: meaning is read by a model, never
 * by word lists). Each door that acts on a reply (her approve on a drafts notice, a brand-reply email or a send pause;
 * a partner's "yes" to Porter's hand-off question; a deadline in a partner's email) turns the model's fields
 * (`shared/intake/inboundRead.ts`) into its decision here. The word lists still in these files run ONLY when no model
 * answered (`read` is null), and the decision then says so: reader WORD_LISTS, NAMED STOP INBOUND_NO_MODEL_READER.
 *
 * The code keeps the hard checks a model cannot be trusted with: a change note is her own words (never a model's
 * rewording), a deadline's words are really in the email and its time is a real time ahead, and approve-all needs both
 * the all-items field AND a plain yes. Unsure never approves, skips, sends or hands over. Pure.
 */
import { WORD_LISTS, type InboundRead } from "./inboundRead";
import { centralLocalToIso, dueTimeIn, type DueTime } from "./dueTime";
import { isEmptyReply, parseDraftReply, type DraftReply } from "../tlc/draftReply";
import { confirmsHandOff } from "../work/partnerOwnership";

const norm = (s: string): string => s.toLowerCase().replace(/[“”"'‘’`]/g, "").replace(/\s+/g, " ").trim();

/** Her answer to a numbered drafts email. `unsure` lists the numbers the reader could not tell (nothing is done for them). */
export function draftApprovalOf(read: InboundRead | null, said: string, count: number): { reply: DraftReply; unsure: number[]; reader: string } {
  if (!read) return { reply: parseDraftReply(said), unsure: [], reader: WORD_LISTS };
  const reply: DraftReply = { approveAll: false, approve: [], skip: [], change: [] };
  const unsure: number[] = [];
  const all = Array.from({ length: count }, (_, i) => i + 1);
  // Approve-all needs both fields: a refusal read as "all" on its own never approves anything.
  if (read.allItems === "approve" && read.answer === "yes") reply.approveAll = true;
  if (read.allItems === "skip") reply.skip.push(...all);
  for (const it of read.items) {
    if (it.action === "approve") reply.approve.push(it.n);
    else if (it.action === "skip") reply.skip.push(it.n);
    // HER WHOLE NOTE (owner, 26 Oct 2026): the model's note only when it is her words, else everything she wrote.
    else if (it.action === "change") reply.change.push({ n: it.n, note: it.note && norm(said).includes(norm(it.note)) ? it.note : said.trim() });
    else unsure.push(it.n);
  }
  // Nothing she said can be acted on and the reader could not tell: every draft is unsure, so the email asks again.
  if (isEmptyReply(reply) && unsure.length === 0 && read.answer === "unsure") unsure.push(...all);
  return { reply, unsure: [...new Set(unsure)], reader: read.reader };
}

/** Her answer to an email that asks for one approve (the send pause). Only a plain yes approves. */
export function approvesOf(read: InboundRead | null, said: string): { approved: boolean; unsure: boolean; reader: string } {
  if (!read) return { approved: /^\s*(?:approve|approved|yes,? approve)\b/i.test(said), unsure: false, reader: WORD_LISTS };
  return { approved: read.answer === "yes", unsure: read.answer === "unsure", reader: read.reader };
}

/** A partner's answer to "Did you mean hand this card to …?". Only a plain yes hands it over. */
export function confirmsOf(read: InboundRead | null, text: string): { confirmed: boolean; unsure: boolean; reader: string } {
  if (!read) return { confirmed: confirmsHandOff(text), unsure: false, reader: WORD_LISTS };
  return { confirmed: read.answer === "yes", unsure: read.answer === "unsure", reader: read.reader };
}

/** How far ahead a read deadline may be and still be believed (a year and a little). */
const DEADLINE_MAX_DAYS = 400;

/** The deadline in a partner's email: the model's, when its words are in the email and its time is real and ahead. */
export function deadlineOf(read: InboundRead | null, written: string, now: Date): { due: DueTime | null; reader: string; why: string | null } {
  if (!read) return { due: dueTimeIn(written, now), reader: WORD_LISTS, why: null };
  const d = read.deadline;
  if (!d) return { due: null, reader: read.reader, why: null };
  if (!norm(written).includes(norm(d.words))) return { due: null, reader: read.reader, why: `the deadline "${d.words.slice(0, 80)}" is not in the email` };
  const at = centralLocalToIso(d.local, now);
  const ms = at ? Date.parse(at) - now.getTime() : NaN;
  if (!at || !Number.isFinite(ms) || ms < -3_600_000 || ms > DEADLINE_MAX_DAYS * 86_400_000) return { due: null, reader: read.reader, why: `the deadline time "${d.local}" is not a time ahead` };
  return { due: { due_at: at, due_words: d.words, priority: ms <= 2 * 86_400_000 ? "URGENT" : "HIGH" }, reader: read.reader, why: null };
}
