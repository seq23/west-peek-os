import { expect, it, vi } from "vitest";
import { runAi } from "../src/worker/ai/runAi";
import { TLC_REVISION_BUDGET, tlcRevisionWriter } from "../src/worker/services/tlcSamples";
import { isImportantWork } from "../src/shared/ai/seatOrder";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";

vi.mock("../src/worker/ai/runAi", () => ({ runAi: vi.fn() }));

// Owner ruling, 4 Nov 2026: brand and TLC emails are never confidential and may run on free models.
it("a brand-email revision is not marked confidential (nor important), so it may take the free lanes like other brand work", async () => {
  vi.mocked(runAi).mockResolvedValue({ run: { status: "COMPLETED", output_text: '{"body":"Shorter, as asked."}' } } as Awaited<ReturnType<typeof runAi>>);
  const out = await tlcRevisionWriter({} as Env, { type: "AI", roles: [], firmScopes: ["west-peek"] } as Actor, "Redraft Wynn's answer to the brand: shorter, per her note.");
  expect(out).toEqual({ ok: true, text: '{"body":"Shorter, as asked."}' });
  const call = vi.mocked(runAi).mock.lastCall![1] as unknown as { budgetContext: Record<string, unknown>; routing: unknown };
  expect(call.budgetContext).not.toHaveProperty("confidential");
  expect(call.budgetContext).not.toHaveProperty("important");
  expect(call.budgetContext).toMatchObject({ publicModelApproved: true, judgement: true });
  expect(call.routing).toEqual({ category: "INTELLIGENCE" });
  // The router's own test of "important" (Claude seat, then Codex, never a free lane) says this is routine work.
  expect(isImportantWork(TLC_REVISION_BUDGET)).toBe(false);
  vi.mocked(runAi).mockResolvedValue({ run: { status: "BLOCKED_DEFERRED", output_text: null } } as Awaited<ReturnType<typeof runAi>>);
  expect((await tlcRevisionWriter({} as Env, {} as Actor, "Edit the PDF")).ok).toBe(false);
});
