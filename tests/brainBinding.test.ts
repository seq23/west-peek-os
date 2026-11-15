import { describe, expect, it } from "vitest";
import { brainFactsOf } from "../src/worker/services/partnerProfile";

const db = (stored: string | null) => ({ prepare: () => ({ first: async () => (stored ? { brain_md: stored } : null) }) });

describe("the first read's brain comes straight from Boss OS", () => {
  it("reads the live brain through the service binding when it is there", async () => {
    const env = { WP_OS_DB: db("old copy"), WP_OS_BOSS_BRAINS: { brain: async (s: string) => (s === "west-peek" ? { slug: s, body_md: "## Partners\nlive", updated_at: null } : null) } };
    expect(await brainFactsOf(env as never)).toBe("## Partners\nlive");
  });
  it("falls back to the stored copy when the binding fails or is absent", async () => {
    const failing = { WP_OS_DB: db("stored copy"), WP_OS_BOSS_BRAINS: { brain: async () => { throw new Error("down"); } } };
    expect(await brainFactsOf(failing as never)).toBe("stored copy");
    expect(await brainFactsOf({ WP_OS_DB: db("stored copy") } as never)).toBe("stored copy");
  });
});
