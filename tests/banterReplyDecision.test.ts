import { describe, expect, it, vi } from "vitest";
import type { Env } from "../src/worker/env";
import { banterReply } from "./helpers/aiShapes";
import { BANTER_REPLY_OUTPUT, defaultGenerateBanterReply } from "../src/worker/services/banterReply";
import { readStructuredText } from "../src/worker/ai/structuredOutput";

/**
 * WHETHER A PARTNER HEARS BACK ON BANTER IS THE MODEL'S "reply" FIELD (22 Nov 2026, #573 review F1). A line written
 * alongside reply:false is never sent, and an answer that is not the shape is read as "let it go quiet".
 */
let scripted: { status: string; output_text: string | null; failure_reason: string | null };
vi.mock("../src/worker/ai/runAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker/ai/runAi")>();
  return { ...actual, runAi: async () => ({ run: { id: "run_banter", ...scripted } }) };
});

const input = { employeeName: "Porter", voice: "dry", sarcastic: false, senderMessage: "ha, nice one", recentContext: "(none)" };
const env = {} as Env;

describe("the banter send decision", () => {
  it("reply:false with a line sends nothing", async () => {
    scripted = { status: "COMPLETED", output_text: banterReply({ reply: false, line: "Ha, likewise." }), failure_reason: null };
    expect(await defaultGenerateBanterReply(env, input)).toEqual({ shouldReply: false, line: null, aiRunId: "run_banter" });
  });

  it("reply:true with a line sends that line", async () => {
    scripted = { status: "COMPLETED", output_text: banterReply({ reply: true, line: "Ha, likewise." }), failure_reason: null };
    expect(await defaultGenerateBanterReply(env, input)).toEqual({ shouldReply: true, line: "Ha, likewise.", aiRunId: "run_banter" });
  });

  it("prose that is not the shape sends nothing", async () => {
    const prose = "REPLY: yes\nLINE: Ha, likewise.";
    expect(readStructuredText(BANTER_REPLY_OUTPUT, prose).ok, "the boundary rejects it").toBe(false);
    scripted = { status: "FAILED", output_text: null, failure_reason: "verifier_rejected:structured_output: the reply is not a JSON object" };
    expect(await defaultGenerateBanterReply(env, input)).toMatchObject({ shouldReply: false, line: null });
    // Even a completed run carrying prose (a stand-in lane) never sends.
    scripted = { status: "COMPLETED", output_text: prose, failure_reason: null };
    expect(await defaultGenerateBanterReply(env, input)).toMatchObject({ shouldReply: false, line: null });
  });
});
