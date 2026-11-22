import { inboundRead } from "./aiShapes";
import { parseDraftReply } from "../../src/shared/tlc/draftReply";
import { confirmsHandOff } from "../../src/shared/work/partnerOwnership";
import { parseInboundRead } from "../../src/shared/intake/inboundRead";
import type * as InboundReadService from "../../src/worker/services/inboundRead";

/**
 * A STAND-IN MODEL for tests whose fixtures are plain approvals ("approved", "approve 1, skip 2", "yes"). Production
 * reads her answer by a model and, with no model, decides nothing (review of #574); these flow tests are about what
 * happens AFTER her answer is understood, so they install this stand-in in place of the model ladder:
 *
 *   vi.mock("../src/worker/services/inboundRead", async (orig) => (await import("./helpers/standInModel")).withStandIn(await orig()));
 *
 * It answers only the questions our own emails ask (Wynn's numbered drafts, the send pause, Porter's hand-off question)
 * and reads them the way a careful model reads a plain fixture. Every other read, and any caller that passes its own
 * readers (an outage test passes `[]`), goes to the real ladder unchanged. Test-only: nothing in src/ imports it.
 */
export const STAND_IN = "STAND_IN_MODEL";

function standInRead(context: string, words: string): string | null {
  const said = words.trim();
  if (/^Porter asked him:/.test(context)) return inboundRead({ answer: confirmsHandOff(said) ? "yes" : /^\s*(?:no|nope|not)\b/i.test(said) ? "no" : "unsure" });
  if (/Brand emails are paused/.test(context)) return inboundRead({ answer: /^\s*(?:approve|approved|yes,? approve)\b/i.test(said) ? "yes" : /^\s*(?:no|not)\b/i.test(said) ? "no" : "not_an_answer" });
  const count = Number(/numbered 1 to (\d+)/.exec(context)?.[1] ?? 0);
  if (!/^Wynn's email/.test(context)) return null;
  const p = parseDraftReply(said);
  const items = [
    ...p.approve.map((n) => ({ n, action: "approve", note: null })),
    ...p.skip.map((n) => ({ n, action: "skip", note: null })),
    ...p.change.map((c) => ({ n: c.n, action: "change", note: c.note })),
  ];
  // One draft: a bare "skip" skips it, and free words that are not an approve, skip or no are her change to it.
  if (!p.approveAll && !items.length && count === 1) {
    if (/^\s*(?:skip|skip it|don't send|do not send)[.!]?\s*$/i.test(said)) items.push({ n: 1, action: "skip", note: null });
    else if (said && !/^(?:no|cancel)\b/i.test(said)) items.push({ n: 1, action: "change", note: said });
  }
  return inboundRead({ answer: p.approveAll || p.approve.length ? "yes" : "not_an_answer", all_items: p.approveAll ? "approve" : "none", items });
}

export function withStandIn(real: typeof InboundReadService): typeof InboundReadService {
  const readInbound: typeof real.readInbound = async (env, input, stub) => {
    if (stub) return real.readInbound(env, input, stub);
    const text = standInRead(input.context, input.words);
    if (text === null) return real.readInbound(env, input, stub);
    const ladder = await real.inboundLadder(env, input);
    return { read: parseInboundRead(text, STAND_IN), tried: [`${STAND_IN}: read it`], sender: ladder.sender };
  };
  return { ...real, readInbound };
}
