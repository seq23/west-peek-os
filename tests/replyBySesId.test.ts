import { describe, expect, it } from "vitest";
import { resendSentAt, sesSentTimesIn, threadForSesIds } from "../src/shared/email/thread";

/*
 * 18 Nov 2026: Scooter answered Porter's privacy-page preview under his own subject. Gmail carried only
 * the SES Message-ID back, no `wpt_` token and no "Re:", and the OS asked him which job he meant.
 * These are the real ids from that reply and the send it answered.
 */
const REPLY = {
  inReplyTo: "010001a1ec56567f-f66e119a-748b-4b99-82d0-ccb468b56b38-000000@email.amazonses.com",
  references: "010001a1ec56567f-f66e119a-748b-4b99-82d0-ccb468b56b38-000000@email.amazonses.com",
};
const PREVIEW = { token: "wpt_577ad733d8aa49c981d6029a987613ed", object_id: "wc_e8bc74eb", provider: "resend", provider_message_id: "01a1ec56-5565-70b9-a6e0-4a2dbde4af5b" };
const GA_PREVIEW = { token: "wpt_4d02eb595f984b288225a02243523fac", object_id: "wc_d4b961bc", provider: "resend", provider_message_id: "01a1ec3f-8323-76f5-badd-9f08dacb846b" };
const GOING_AHEAD = { token: "wpt_9f1c62202ebd41979414f7cd3acdcbd5", object_id: "wc_e8bc74eb", provider: "resend", provider_message_id: "01a1ec4b-2829-7ee7-8bec-81ffd9e64e2b" };

describe("a reply is matched to the email it answers by the SES id's clock", () => {
  it("reads both clocks", () => {
    expect(sesSentTimesIn(REPLY)).toEqual([0x01a1ec56567f]);
    expect(resendSentAt(PREVIEW.provider_message_id)).toBe(0x01a1ec565565);
    expect(resendSentAt("not-a-uuid")).toBeNull();
  });

  it("finds the privacy preview among everything sent that evening, whatever the subject", () => {
    expect(threadForSesIds(REPLY, [GA_PREVIEW, GOING_AHEAD, PREVIEW])?.token).toBe(PREVIEW.token);
  });

  it("matches on the In-Reply-To even when References holds an older message too", () => {
    const deeper = { inReplyTo: REPLY.inReplyTo, references: `<010001a1ec3f8400-aaaa-000000@email.amazonses.com> <${REPLY.inReplyTo}>` };
    expect(threadForSesIds(deeper, [GA_PREVIEW, PREVIEW])?.token).toBe(PREVIEW.token);
  });

  it("never guesses: two sends in the window, nothing sent, a non-Resend row, or no SES id → null", () => {
    const twin = { ...PREVIEW, token: "wpt_twin", provider_message_id: "01a1ec56-5000-7000-8000-000000000000" };
    expect(threadForSesIds(REPLY, [PREVIEW, twin])).toBeNull();
    expect(threadForSesIds(REPLY, [GA_PREVIEW, GOING_AHEAD])).toBeNull();
    expect(threadForSesIds(REPLY, [{ ...PREVIEW, provider: "cloudflare" }])).toBeNull();
    expect(threadForSesIds({ inReplyTo: "<CAOWoBQ@mail.gmail.com>", references: null }, [PREVIEW])).toBeNull();
  });

  it("a send stamped AFTER the SES id is not its parent", () => {
    const later = { ...PREVIEW, provider_message_id: "01a1ec56-5700-7000-8000-000000000000" };
    expect(threadForSesIds(REPLY, [later])).toBeNull();
  });
});
