import type { Env } from "../env";
import { ccAck, ccAsksIn, ccList, resolveCc } from "../../shared/work/ccPartners";
import { partnerByEmail } from "../../shared/registry/partners";

/**
 * THE ONE WRITER OF `work_card.cc_emails` (0239). Called wherever the requesting partner's own words
 * enter a card — the opening request (`openAssignmentCard`), a reply on the card's thread
 * (`steerFromReply`) and a note typed on the card (`handleAddWorkCardNote`) — so the three can never
 * disagree about what "cc Scooter" means. See `shared/work/ccPartners.ts` for the rule.
 *
 * ONLY THE PARTNER WHO ASKED. `writerEmail` is the authenticated address (a DKIM/DMARC-checked
 * sender, or the signed-in partner's own address), compared with the card's `requested_by_email`.
 * Anyone else's "cc …" adds nothing and says so. A card nobody asked for by email has no requester
 * and no finished email to copy anyone on, so it records nothing.
 *
 * Never removes: a cc once asked for stays until the work is done.
 */
export async function recordCcFrom(
  env: Env,
  cardId: string,
  text: string | null | undefined,
  writerEmail: string | null | undefined,
): Promise<{ added: string[]; refused: string[]; ack: string | null }> {
  const tokens = ccAsksIn(text);
  if (tokens.length === 0) return { added: [], refused: [], ack: null };
  const card = await env.WP_OS_DB.prepare("SELECT requested_by_email, cc_emails FROM work_card WHERE id = ?1")
    .bind(cardId)
    .first<{ requested_by_email: string | null; cc_emails: string | null }>();
  if (!card) return { added: [], refused: [], ack: null };
  const requester = partnerByEmail(card.requested_by_email);
  const writer = (writerEmail ?? "").trim().toLowerCase();
  const res = resolveCc(tokens, writer);
  const allowed = Boolean(requester) && requester!.email === writer;
  // Anyone but the requester is refused whatever they named — even themselves.
  const ack = allowed ? ccAck(res, true, requester?.firstName ?? null) : ccAck({ add: [], refused: tokens }, false, requester?.firstName ?? null);
  if (!allowed || res.add.length === 0) {
    if (ack) await trail(env, cardId, ack);
    return { added: [], refused: allowed ? res.refused : tokens, ack };
  }
  const next = [...new Set([...ccList(card.cc_emails), ...res.add.map((p) => p.email)])];
  await env.WP_OS_DB.prepare("UPDATE work_card SET cc_emails = ?2 WHERE id = ?1").bind(cardId, JSON.stringify(next)).run();
  if (ack) await trail(env, cardId, ack);
  return { added: res.add.map((p) => p.email), refused: res.refused, ack };
}

/** The ack on the card's own trail, where every other finding lives. */
async function trail(env: Env, cardId: string, ack: string): Promise<void> {
  await env.WP_OS_DB.prepare(
    "UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1",
  )
    .bind(cardId, ack.slice(0, 600))
    .run();
}

/** The cc a finished email carries, read from the card (0239). Partners only, whatever the row says. */
export async function ccOfCard(env: Env, cardId: string | null | undefined): Promise<string[]> {
  if (!cardId) return [];
  const row = await env.WP_OS_DB.prepare("SELECT cc_emails FROM work_card WHERE id = ?1").bind(cardId).first<{ cc_emails: string | null }>();
  return ccList(row?.cc_emails);
}
