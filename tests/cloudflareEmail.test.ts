import { describe, expect, it } from "vitest";
import {
  cloudflareEmailBlockedReason,
  emailFromAddress,
  isCloudflareEmailEnabled,
  sendViaCloudflare,
} from "../src/worker/effects/cloudflareEmailClient";
import type { Env } from "../src/worker/env";

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
    const result = await sendViaCloudflare(env({ EMAIL: binding }), {
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
      sendViaCloudflare(env({ EMAIL: binding }), { to: "a@b.test", subject: "s", text: "t" }),
    ).rejects.toThrow(/not onboarded/);
  });

  it("refuses to send with no binding even if called directly", async () => {
    await expect(
      sendViaCloudflare(env({ EMAIL: undefined }), { to: "a@b.test", subject: "s", text: "t" }),
    ).rejects.toThrow(/no email binding/);
  });

  it("refuses to send with no sender address even if called directly", async () => {
    const { binding } = fakeBinding();
    await expect(
      sendViaCloudflare(env({ EMAIL: binding, WP_OS_EMAIL_FROM: undefined }), {
        to: "a@b.test",
        subject: "s",
        text: "t",
      }),
    ).rejects.toThrow(/no sending address/);
  });
});
