import type { Env } from "../env";
import { appendEvent } from "../events";
import { firstReadDecision, type FirstReadDecision } from "./partnerUnderstood";
import { propertiesIn, type WebProperty } from "../../shared/intake/webPropertyChange";
import { sentencesOf, vetoOf } from "../../shared/text/wholeSentence";

/**
 * THE FIRST READ DECIDES (owner ruling, 19 Nov 2026). Claude's first read of a partner email (partnerUnderstood.ts,
 * its `DECISION:` line) is the authority for what moves a Porter job: land, rebuild, which site, a hand-off refusal,
 * plan approval. The keyword rules are the last-resort fallback, used only when no first read exists once the
 * ten-minute wait the OS already keeps for it (FIRST_READ_WAIT_MINUTES, `claimNextCard`) has passed. The keywords had
 * been overruling it, and the partner tail patched them one phrase at a time (#531, #542, #546).
 *
 * No new queue: the reply is filed by the door as before, and the runner reads the decision when it reaches the card.
 */
export type FirstRead =
  | { state: "READ"; decision: FirstReadDecision; messageId: string }
  /** No email to read (a button on the card), or its read settled without a decision, or the ten minutes passed. */
  | { state: "ABSENT"; messageId: string | null };

/** How far past the moment a reply answered the card its message may have been stored (the door links it after). */
const LINK_SLACK_MS = 2 * 60_000;

/**
 * The first read of the authenticated partner email behind a reply on this card (or the card it was handed on from):
 * the newest one received after `after` and no later than `until` (+ the door's slack). Never throws.
 *
 * THE WAIT IS THE SWEEP'S, ALREADY (`claimNextCard`, 15 Nov 2026): a card with a partner email from the last
 * FIRST_READ_WAIT_MINUTES whose first read has not settled is not started at all. So by the time a runner reads this,
 * the first read is in, settled without a decision (no reader was there), or ten minutes late: the keywords' turn.
 */
export async function firstReadOf(env: Env, cardId: string, opts: { after?: string | null; until?: string | null } = {}): Promise<FirstRead> {
  const until = opts.until ? new Date(Date.parse(opts.until) + LINK_SLACK_MS).toISOString() : null;
  let row: { id: string } | null = null;
  try {
    row = await env.WP_OS_DB.prepare(
      `SELECT m.id FROM inbound_message m
        WHERE m.work_card_id IN (?1, COALESCE((SELECT assigned_from_card_id FROM work_card WHERE id = ?1), ?1))
          AND json_extract(m.mail_authority_json, '$.partner') IS NOT NULL
          AND (?2 IS NULL OR m.received_at > ?2)
          AND (?3 IS NULL OR m.received_at <= ?3)
        ORDER BY m.received_at DESC LIMIT 1`,
    )
      .bind(cardId, opts.after ?? null, until)
      .first<{ id: string }>();
  } catch {
    row = null;
  }
  if (!row) return { state: "ABSENT", messageId: null };
  const decision = await firstReadDecision(env, row.id).catch(() => null);
  return decision ? { state: "READ", decision, messageId: row.id } : { state: "ABSENT", messageId: row.id };
}

/**
 * Both readings on the record, every time a decision is taken: what the first read said, what the keywords said,
 * and which one acted. Returns the line for the card's findings.
 */
export async function logDecision(
  env: Env,
  card: { id: string; firm_scope: string },
  input: { what: string; read: FirstRead; firstRead: string | null; keyword: string },
): Promise<string> {
  const used = input.read.state === "READ" ? "FIRST_READ" : "KEYWORD";
  const line =
    input.read.state === "READ"
      ? input.firstRead === input.keyword
        ? `First read decides ${input.what}: ${input.firstRead} (the keywords agree).`
        : `First read decides ${input.what}: ${input.firstRead}; the keywords read ${input.keyword} and were overruled.`
      : `first read absent: keyword fallback (${input.what}: ${input.keyword}).`;
  await appendEvent(env, {
    eventType: "partner_reply.first_read_decides",
    actorType: "system",
    actorId: "first_read",
    objectType: "work_card",
    objectId: card.id,
    firmScope: card.firm_scope,
    payload: { what: input.what, used, first_read: input.firstRead, keyword: input.keyword, inbound_message_id: input.read.messageId },
  }).catch(() => undefined);
  if (used === "KEYWORD") console.log(`card ${card.id}: ${line}`);
  return line;
}

/** The registered property the first read named: its host, an alias or its repo exactly, else the one property its words name. */
export function propertyNamed(named: string | null | undefined, registry: readonly WebProperty[]): WebProperty | null {
  const said = String(named ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!said) return null;
  const exact = registry.find((p) => p.host.toLowerCase() === said || p.repo.toLowerCase() === said || (p.aliases ?? []).some((a) => a.toLowerCase() === said));
  if (exact) return exact;
  const found = propertiesIn(String(named), registry);
  return found.length === 1 ? found[0]! : null;
}

// ── WHAT HIS REPLY SAYS ABOUT THE CARD ITSELF (owner ruling, 19 Nov 2026; built 20 Nov 2026) ─────────────────────────

/** One part of the first read: READ when the decision carries that field, else ABSENT (an older read, or none at all). */
function partOf(read: FirstRead, has: boolean): FirstRead {
  return read.state === "READ" && has ? read : { state: "ABSENT", messageId: read.messageId };
}

/**
 * HAND-OFF, TAKE-BACK, A SECOND PARTNER'S "APPROVED", CC AND "BACK ON <DAY>", DECIDED BY THE FIRST READ.
 *
 * These used to be read by keywords at the reply door (emailThread.ts), the moment his email arrived, and the partner
 * tail patched them one phrase at a time ("I don't think Scooter will take it from here" handed the card off). The
 * door now only files the reply; this runs when the first read of that reply is in (partnerUnderstood.ts, right after
 * the brief is saved), so the sweep's wait (`claimNextCard`) already holds the card until it has. Each part follows the
 * first read's DECISION; a part the read did not give (no reader answered within the ten minutes, or an older read)
 * falls back to the keywords, judged by whole sentences (wholeSentence.ts) and logged "first read absent: keyword
 * fallback". Both readings go on the event spine for every part either one mentions.
 *
 * Only a reply on a card's own thread (a `work_steer` row for the message: what the door filed) is read here; a card a
 * developer has taken over is left alone, as at the door. A hand-off or take-back is never the answer to the card's
 * question: when this reply had answered its block, the block is put back before the card changes hands, so it waits
 * on the new primary. Never throws past its own logging.
 */
export async function decideReplyWords(
  env: Env,
  input: { inboundId: string; messageId: string | null; receivedAt: string; decision: FirstReadDecision | null },
): Promise<void> {
  if (!input.messageId) return;
  const steer = await env.WP_OS_DB.prepare(
    "SELECT from_card_id, said_by, body, thread_token FROM work_steer WHERE message_id = ?1 AND from_card_id IS NOT NULL ORDER BY created_at LIMIT 1",
  )
    .bind(input.messageId)
    .first<{ from_card_id: string; said_by: string; body: string; thread_token: string | null }>();
  if (!steer) return;
  const card = await env.WP_OS_DB.prepare(
    "SELECT id, firm_scope, state, requested_by_email, secondary_partner_email, held_reason, block_answered_at, block_answered_by FROM work_card WHERE id = ?1",
  )
    .bind(steer.from_card_id)
    .first<{ id: string; firm_scope: string; state: string; requested_by_email: string | null; secondary_partner_email: string | null; held_reason: string | null; block_answered_at: string | null; block_answered_by: string | null }>();
  const { partnerByEmail, partnerFor } = await import("../../shared/registry/partners");
  const partner = partnerByEmail(steer.said_by);
  const { isTakenOver } = await import("../../shared/work/takeover");
  if (!card || !partner || isTakenOver(card.held_reason)) return;
  const words = steer.body;
  const read: FirstRead = input.decision ? { state: "READ", decision: input.decision, messageId: input.inboundId } : { state: "ABSENT", messageId: input.inboundId };
  const d = input.decision;
  const trail = async (line: string) => {
    await env.WP_OS_DB.prepare("UPDATE work_card SET description = substr(COALESCE(description, '') || char(10) || '• ' || ?2, 1, 16000) WHERE id = ?1").bind(card.id, line.slice(0, 600)).run();
  };

  // CC (0239): the partners he asked to copy on the finished email.
  const { ccAsksIn } = await import("../../shared/work/ccPartners");
  const ccRead = partOf(read, Array.isArray(d?.cc));
  const ccKeyword = ccAsksIn(words);
  const cc = ccRead.state === "READ" ? d!.cc! : ccKeyword;
  if (cc.length || ccKeyword.length) {
    await logDecision(env, card, { what: "the cc", read: ccRead, firstRead: ccRead.state === "READ" ? cc.join(", ") || "no cc" : null, keyword: ccKeyword.join(", ") || "no cc" });
    if (cc.length) await (await import("./ccPartners")).recordCc(env, card.id, cc, partner.email);
  }

  // BACK ON <DAY> (0302): the partner who asked says when to expect him, so nothing reminds him before then.
  if ((card.requested_by_email ?? "").trim().toLowerCase() === partner.email) {
    const { backByDay, partnerBackIn } = await import("../../shared/work/partnerBackBy");
    const at = new Date(Date.parse(input.receivedAt) || Date.now());
    const backRead = partOf(read, d?.backBy !== undefined);
    const keyword = partnerBackIn(words, at);
    const back = backRead.state === "READ" ? (d!.backBy ? backByDay(d!.backBy, words.split("\n")[0] ?? words, at) : null) : keyword;
    if (back || keyword) {
      await logDecision(env, card, { what: "when he is back", read: backRead, firstRead: backRead.state === "READ" ? back?.back_at ?? "not said" : null, keyword: keyword?.back_at ?? "not said" });
      if (back) await (await import("./blocks")).recordPartnerBack(env, card.id, back, partner.firstName);
    }
  }

  // HAND-OFF AND TAKE-BACK (0241).
  const { ownershipIntentIn, roleOf } = await import("../../shared/work/partnerOwnership");
  const handOff = await import("./handOff");
  const ownRead = read;
  const keywordIntent = ownershipIntentIn(words, partner.email);
  const said = (i: ReturnType<typeof ownershipIntentIn>): string =>
    !i ? "no hand-off" : i.kind === "TAKE_BACK" ? "take back" : i.kind === "HAND_OFF" ? `hand to ${i.to?.firstName ?? i.named}` : `unsure: ${i.to.firstName}?`;
  let readIntent: ReturnType<typeof ownershipIntentIn> = null;
  if (d?.takeBack) readIntent = { kind: "TAKE_BACK" };
  else if (d?.handOffTo) {
    const to = partnerFor(d.handOffTo);
    readIntent = { kind: "HAND_OFF", to, named: to ? to.firstName : d.handOffTo };
    // ANCHORED TO HIS WORDS (replay of #556 on main, 20 Nov): a hand-off only acts at once when the sentence naming that
    // partner stands as said. "If I'm not back by Friday, hand this to Scooter" (a condition), a negation or a report
    // turns the read into Porter's one question ("Did you mean hand this card to Scooter?"), never a hand-off now.
    if (to && sentencesOf(words).some((s) => new RegExp(`\\b(?:${to.firstName}|${to.email.replace(/[.]/g, "\\.")})\\b`, "i").test(s.text) && (vetoOf(s.text, null, ["CONDITIONS", "NEGATES", "REPORTS"]) !== null))) {
      readIntent = { kind: "UNSURE_HAND_OFF", to };
    }
  }
  const intent = ownRead.state === "READ" ? readIntent : keywordIntent;
  if (readIntent || keywordIntent) {
    const line = await logDecision(env, card, { what: "the hand-off", read: ownRead, firstRead: ownRead.state === "READ" ? said(readIntent) : null, keyword: said(keywordIntent) });
    await trail(line);
  }
  const answeredByThis = Boolean(card.block_answered_at) && ["OPEN", "IN_PROGRESS"].includes(card.state) && card.block_answered_by === partner.firmUserId && Date.parse(card.block_answered_at!) >= Date.parse(input.receivedAt) - 2 * 60_000;
  const owned = await handOff.ownershipFromWords(env, {
    cardId: card.id,
    writer: partner.email,
    text: words,
    via: "REPLY",
    ackOnThread: steer.thread_token,
    // His answer to Porter's own "Did you mean…?" is THIS read's field (one read per email); no read → unsure, it stands.
    answer: read.state === "READ" ? (d?.handOffAnswer ?? null) : null,
    intent: read.state === "READ" ? intent : undefined,
    beforeActing: async () => {
      if (answeredByThis) await (await import("./blocks")).restoreBlock(env, card.id, "his reply was about who owns the card, not the answer to its question");
    },
  });
  if (owned && !owned.ok) {
    await handOff.tellPartner(env, { cardId: card.id, to: partner, label: "Not changed", line: owned.reason ?? "Not changed.", subjectTail: "not handed off", onThread: steer.thread_token });
    return;
  }
  if (owned) return;

  // A SECONDARY'S "APPROVED" (0241): refused, and told who approves and how to take it over. Kept as a note at the door.
  const fresh = await env.WP_OS_DB.prepare("SELECT requested_by_email, secondary_partner_email FROM work_card WHERE id = ?1").bind(card.id).first<{ requested_by_email: string | null; secondary_partner_email: string | null }>();
  if (!fresh || roleOf(fresh, partner.email) !== "SECONDARY") return;
  const { readApprovalReply, opensWithApproval } = await import("../../shared/work/approvalReply");
  // "Approved, looks great." opens with an approval too: here it only earns the refusal note telling her who approves,
  // so its first clause counts (replay of #556 on main, 20 Nov: she got silence and would think it approved).
  const firstClause = (words.trim().split(/\r?\n/)[0] ?? "").replace(/^(\s*[a-z]+),/i, "$1.");
  const keywordApproves = ["APPROVED", "FORCED", "PREVIEW", "PUBLISH"].includes(readApprovalReply(words).kind) || opensWithApproval(firstClause);
  const readApproves = d?.kind === "approve";
  const approves = read.state === "READ" ? readApproves : keywordApproves;
  if (readApproves || keywordApproves) {
    await logDecision(env, card, { what: "a secondary's approval", read, firstRead: read.state === "READ" ? (readApproves ? "approve" : d!.kind) : null, keyword: keywordApproves ? "approve" : "no approval" });
  }
  const { ownershipOf } = await import("../../shared/work/partnerOwnership");
  const primary = ownershipOf(fresh).primary;
  if (approves && primary) await handOff.tellSecondaryRefused(env, { cardId: card.id, secondary: partner, primary, said: words, onThread: steer.thread_token });
}
