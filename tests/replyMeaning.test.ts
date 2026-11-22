import { describe, expect, it } from "vitest";
import { inboundRead } from "./helpers/aiShapes";
import { WORD_LISTS, parseInboundRead } from "../src/shared/intake/inboundRead";
import { approvesOf, confirmsOf, deadlineOf, draftApprovalOf } from "../src/shared/intake/replyMeaning";

/**
 * WHAT A REPLY MEANS IS THE MODEL'S READ (22 Nov 2026, engineering sweep row 5). The word lists run only when no model
 * answered; unsure never approves, skips, sends or hands over; a model's note or deadline is believed only where it is
 * in what was written. Fake text only.
 */
const read = (o: Record<string, unknown>) => parseInboundRead(inboundRead(o), "CLAUDE")!;

describe("her approval of numbered drafts", () => {
  it("a refusal that carries the word yes approves nothing, read by the model or by the word lists", () => {
    const said = "I can't say yes to this";
    const m = draftApprovalOf(read({ answer: "no", all_items: "approve" }), said, 3);
    expect(m.reply.approveAll, "approve-all needs a plain yes as well").toBe(false);
    expect(m.reply.approve).toEqual([]);
    const w = draftApprovalOf(null, said, 3);
    expect(w.reader).toBe(WORD_LISTS);
    expect(w.reply.approveAll).toBe(false);
    expect(w.reply.approve).toEqual([]);
  });

  it("unsure items are named and nothing is done for them; an unsure answer to everything leaves every draft waiting", () => {
    const m = draftApprovalOf(read({ answer: "yes", items: [{ n: 1, action: "approve", note: null }, { n: 2, action: "unsure", note: null }] }), "1 is good, not sure about 2", 2);
    expect(m.reply.approve).toEqual([1]);
    expect(m.unsure).toEqual([2]);
    const all = draftApprovalOf(read({ answer: "unsure" }), "let me think about these", 3);
    expect(all.reply).toEqual({ approveAll: false, approve: [], skip: [], change: [] });
    expect(all.unsure).toEqual([1, 2, 3]);
  });

  it("a change note is her words: a model's rewording is replaced by everything she wrote", () => {
    const said = "2: make the opening warmer and drop the second paragraph";
    const own = draftApprovalOf(read({ items: [{ n: 2, action: "change", note: "make the opening warmer" }] }), said, 2);
    expect(own.reply.change).toEqual([{ n: 2, note: "make the opening warmer" }]);
    const reworded = draftApprovalOf(read({ items: [{ n: 2, action: "change", note: "Rewrite it to be friendlier." }] }), said, 2);
    expect(reworded.reply.change).toEqual([{ n: 2, note: said }]);
  });
});

describe("one approve (the send pause) and a hand-off yes", () => {
  it("only a plain yes counts; unsure is unsure; with no model the word lists decide", () => {
    expect(approvesOf(read({ answer: "no" }), "I can't say yes to this")).toMatchObject({ approved: false, unsure: false });
    expect(approvesOf(read({ answer: "unsure" }), "hmm")).toMatchObject({ approved: false, unsure: true });
    expect(approvesOf(read({ answer: "yes" }), "go ahead")).toMatchObject({ approved: true, reader: "CLAUDE" });
    expect(approvesOf(null, "I can't say yes to this")).toEqual({ approved: false, unsure: false, reader: WORD_LISTS });
    expect(approvesOf(null, "approve")).toMatchObject({ approved: true, reader: WORD_LISTS });
    expect(confirmsOf(read({ answer: "no" }), "yes, but not to her")).toMatchObject({ confirmed: false });
    expect(confirmsOf(read({ answer: "unsure" }), "maybe")).toMatchObject({ confirmed: false, unsure: true });
    expect(confirmsOf(read({ answer: "yes" }), "yep, she has it")).toMatchObject({ confirmed: true });
  });
});

describe("a deadline in a partner's email", () => {
  const now = new Date("2026-11-22T15:00:00.000Z"); // 09:00 Central
  it("is the model's when its words are in the email and its time is ahead", () => {
    const soon = deadlineOf(read({ deadline: { words: "by Monday noon", local: "2026-11-23T12:00" } }), "Can you have it ready by Monday noon?", now);
    expect(soon.due).toEqual({ due_at: "2026-11-23T18:00:00.000Z", due_words: "by Monday noon", priority: "URGENT" });
    const later = deadlineOf(read({ deadline: { words: "by Tuesday noon", local: "2026-11-24T12:00" } }), "Can you have it ready by Tuesday noon?", now);
    expect(later.due).toEqual({ due_at: "2026-11-24T18:00:00.000Z", due_words: "by Tuesday noon", priority: "HIGH" });
  });
  it("is refused when the words are not his or the time is not a time ahead", () => {
    expect(deadlineOf(read({ deadline: { words: "by Friday", local: "2026-11-27T17:00" } }), "Whenever you can.", now)).toMatchObject({ due: null, why: expect.stringContaining("not in the email") });
    expect(deadlineOf(read({ deadline: { words: "yesterday", local: "2026-11-01T17:00" } }), "I needed it yesterday", now)).toMatchObject({ due: null, why: expect.stringContaining("not a time ahead") });
    expect(deadlineOf(read({ deadline: { words: "by 2031", local: "2031-01-01T17:00" } }), "done by 2031", now).due).toBeNull();
  });
  it("is the word lists' when no model answered, and none when the model saw none", () => {
    expect(deadlineOf(null, "Need this ASAP", now).reader).toBe(WORD_LISTS);
    expect(deadlineOf(read({}), "Need this ASAP", now)).toEqual({ due: null, reader: "CLAUDE", why: null });
  });
});
