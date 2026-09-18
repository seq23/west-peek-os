import { describe, expect, it } from "vitest";
import {
  cloudflareEmailBlockedReason,
  emailFromAddress,
  isCloudflareEmailEnabled,
  sendViaCloudflare,
} from "../src/worker/effects/cloudflareEmailClient";
import type { Env } from "../src/worker/env";
import { canSendAs, verifiedDomain } from "../src/worker/services/sendAs";
import { APPROVED_SEND_ENV_KEY, SendBlocked } from "../src/worker/effects/emailTransport";

/**
 * AN APPROVAL FOR THE ADDRESS UNDER TEST (17 Sep 2026).
 *
 * The transport calls `applyPreviewBoundary` first, and since the preview lane that boundary now
 * also refuses any recipient outside the firm without one of these. These tests are about the
 * TRANSPORT — the binding, the sender address, the failure mode — so each one carries the approval
 * its recipient would have had, and the lane itself is proven at the end of this file rather than
 * accidentally re-proven in every case.
 */
function approving(base: Env, recipient: string): Env {
  return { ...base, [APPROVED_SEND_ENV_KEY]: { approvalId: "pva_test", recipient } } as Env;
}

/**
 * Cloudflare Email Sending transport (P33).
 *
 * The tests that earn their place are the ones about the GATE, not the happy path. A transport that
 * sends correctly but sends when it should not is the failure that matters here — an email cannot be
 * recalled — so most of this file is about the conditions under which nothing goes out.
 */

interface SentMessage {
  to: string;
  from: { email: string; name?: string };
  subject: string;
  text?: string;
}

function fakeBinding(over: { messageId?: string; throws?: string } = {}) {
  // Only the message-builder overload is implemented — it is the one this transport uses.
  const sent: SentMessage[] = [];
  const binding = {
    async send(message: SentMessage) {
      if (over.throws) throw new Error(over.throws);
      sent.push(message);
      return { messageId: over.messageId ?? "cf-msg-1" };
    },
  };
  return { binding: binding as unknown as Env["EMAIL"], sent };
}

function env(over: Partial<Env> = {}): Env {
  return {
    EMAIL: fakeBinding().binding,
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_EMAIL_SEND: "enabled",
    ...over,
  } as unknown as Env;
}

describe("the gate", () => {
  it("is open only when the binding, the address and the switch are all present", () => {
    expect(isCloudflareEmailEnabled(env())).toBe(true);
  });

  it("stays shut when the switch is not the literal 'enabled'", () => {
    // A binding in the config is not consent to start emailing people. This is the whole point of
    // the second switch, and "true" is exactly the near-miss someone would type.
    expect(isCloudflareEmailEnabled(env({ WP_OS_EMAIL_SEND: "true" }))).toBe(false);
    expect(isCloudflareEmailEnabled(env({ WP_OS_EMAIL_SEND: undefined }))).toBe(false);
  });

  it("stays shut with no binding, and says so in terms of the fix", () => {
    const e = env({ EMAIL: undefined });
    expect(isCloudflareEmailEnabled(e)).toBe(false);
    expect(cloudflareEmailBlockedReason(e)).toMatch(/wrangler\.toml/);
  });

  it("stays shut with no sender address rather than guessing one", () => {
    const e = env({ WP_OS_EMAIL_FROM: "   " });
    expect(isCloudflareEmailEnabled(e)).toBe(false);
    expect(emailFromAddress(e)).toBeNull();
    expect(cloudflareEmailBlockedReason(e)).toMatch(/onboarded/);
  });

  it("reports no reason when nothing is blocking", () => {
    expect(cloudflareEmailBlockedReason(env())).toBeNull();
  });
});

describe("sending", () => {
  it("sends from the configured address and reports the platform's message id", async () => {
    const { binding, sent } = fakeBinding({ messageId: "cf-abc-123" });
    const result = await sendViaCloudflare(approving(env({ EMAIL: binding }), "lp@example.test"), {
      to: "lp@example.test",
      subject: "Q3 update",
      text: "Attached.",
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.from.email).toBe("os@westpeek.ventures");
    expect(sent[0]!.to).toBe("lp@example.test");
    expect(sent[0]!.text).toBe("Attached.");

    // The id is what makes the receipt checkable against Cloudflare's own log, so it must survive
    // onto the result rather than being dropped into the summary string alone.
    expect(result.provider_message_id).toBe("cf-abc-123");
    expect(result.provider).toBe("cloudflare");
    expect(result.sent).toBe(true);
  });

  it("throws rather than returning a sent result when the platform rejects it", async () => {
    // A rejected send that returned {sent:true} would leave an EXECUTED receipt behind, and that
    // receipt is what the audit trail treats as proof the message went out.
    const { binding } = fakeBinding({ throws: "domain not onboarded" });
    await expect(
      sendViaCloudflare(approving(env({ EMAIL: binding }), "a@b.test"), { to: "a@b.test", subject: "s", text: "t" }),
    ).rejects.toThrow(/not onboarded/);
  });

  it("refuses to send with no binding even if called directly", async () => {
    await expect(
      sendViaCloudflare(approving(env({ EMAIL: undefined }), "a@b.test"), { to: "a@b.test", subject: "s", text: "t" }),
    ).rejects.toThrow(/no email binding/);
  });

  it("refuses to send with no sender address even if called directly", async () => {
    const { binding } = fakeBinding();
    await expect(
      sendViaCloudflare(approving(env({ EMAIL: binding, WP_OS_EMAIL_FROM: undefined }), "a@b.test"), {
        to: "a@b.test",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/no sending address/);
  });

  /*
   * THE LANE, THROUGH THE REAL TRANSPORT (17 Sep 2026).
   *
   * `tests/previewLane.test.ts` proves the rule; this proves the transport cannot get round it. It
   * is here rather than there because THIS is the file that knows how to reach the binding, and the
   * failure it guards against is a transport added or rewritten without the boundary in front of it.
   */
  it("refuses an outsider with no approval, before the binding is touched", async () => {
    const { binding, sent } = fakeBinding();
    await expect(
      sendViaCloudflare(env({ EMAIL: binding }), { to: "founder@somestartup.example", subject: "s", text: "t" }),
    ).rejects.toThrow(SendBlocked);
    expect(sent, "the binding was reached despite the refusal").toHaveLength(0);

    // And a partner needs nothing attached — Walker's Monday note to Scooter is unaffected.
    const ok = await sendViaCloudflare(env({ EMAIL: binding }), {
      to: "scooter@westpeek.ventures",
      subject: "Walker: hire search",
      text: "the note",
    });
    expect(ok.sent).toBe(true);
    expect(sent).toHaveLength(1);
  });
});

/**
 * Which transport wins.
 *
 * The executor prefers Cloudflare whenever its binding is present, which was right when the binding
 * could send. It cannot: Email Sending needs the Workers Paid plan, which this firm is not on. A
 * deployed-but-unusable binding therefore OUTRANKED a working Resend configuration and would have
 * failed every send while Resend sat unused. The binding is commented out of wrangler.toml, and
 * these tests pin the selection logic so re-adding it cannot quietly recreate that.
 */
describe("choosing a transport", () => {
  const resendOnly = {
    RESEND_API_KEY: "re_test_not_a_real_key",
    WP_OS_EMAIL_FROM: "os@westpeek.ventures",
    WP_OS_EMAIL_SEND: "enabled",
  } as unknown as Env;

  it("does not consider Cloudflare ready when there is no binding, however else it is configured", () => {
    // Both switches are on and a sender is set; only the binding is absent. This is exactly the
    // production shape, and getting it wrong means every approved email fails.
    expect(isCloudflareEmailEnabled(resendOnly)).toBe(false);
  });

  it("reports the Resend reason when Resend is the transport in play", () => {
    // Naming the Cloudflare blocker to somebody who is not using Cloudflare sends them to fix the
    // wrong thing.
    const halfSet = { ...resendOnly, WP_OS_EMAIL_SEND: undefined } as unknown as Env;
    expect(cloudflareEmailBlockedReason(halfSet)).toMatch(/wrangler\.toml/);
    expect(isCloudflareEmailEnabled(halfSet)).toBe(false);
  });

  it("is ready again the moment a binding comes back, without any other change", () => {
    // The upgrade path: uncomment the binding and it takes over. Nothing else to remember.
    const withBinding = { ...resendOnly, EMAIL: fakeBinding().binding } as unknown as Env;
    expect(isCloudflareEmailEnabled(withBinding)).toBe(true);
  });
});

/**
 * Sending as a partner rather than as the firm.
 *
 * The risk here is not technical — any address on a verified domain is a legal From. It is that the
 * system speaks in a named person's voice to people who trust that person. So the tests are about
 * the conditions under which it refuses to.
 */
describe("who a message goes out as", () => {
  const base = { WP_OS_EMAIL_FROM: "os@westpeek.ventures" } as unknown as Env;

  it("only allows addresses on the firm's verified domain", () => {
    // A partner on another domain would produce mail that fails DMARC and vanishes into spam —
    // which reads as "the system did not send it" rather than as a misconfiguration.
    expect(canSendAs(base, "scooter@westpeek.ventures")).toBe(true);
    expect(canSendAs(base, "scooter@gmail.com")).toBe(false);
    expect(canSendAs(base, "scooter@westpeek.ventures.evil.test")).toBe(false);
    expect(canSendAs(base, null)).toBe(false);
  });

  it("reads the verified domain from the firm address rather than a second setting", () => {
    expect(verifiedDomain(base)).toBe("westpeek.ventures");
    expect(verifiedDomain({} as unknown as Env)).toBeNull();
  });

  it("treats a malformed address as not sendable", () => {
    expect(canSendAs(base, "westpeek.ventures")).toBe(false);
    expect(canSendAs(base, "@westpeek.ventures")).toBe(false);
  });
});
