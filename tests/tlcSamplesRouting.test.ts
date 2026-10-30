import { expect, it, vi } from "vitest";
import { runAi } from "../src/worker/ai/runAi";
import { tlcRevisionWriter } from "../src/worker/services/tlcSamples";
import type { Env } from "../src/worker/env";
import type { Actor } from "../src/worker/services/authorize";

vi.mock("../src/worker/ai/runAi", () => ({ runAi: vi.fn() }));

it("the shared email/PDF reviser uses the important route and excludes training routes for owner notes", async () => {
  vi.mocked(runAi).mockResolvedValue({ run: { status: "COMPLETED", output_text: '{"seriesHeading":"Practice lab"}' } } as Awaited<ReturnType<typeof runAi>>);
  const out = await tlcRevisionWriter({} as Env, { type: "AI", roles: [], firmScopes: ["west-peek"] } as Actor, "Private deal terms and an owner's copy edit");
  expect(out).toEqual({ ok: true, text: '{"seriesHeading":"Practice lab"}' });
  expect(runAi).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
    sensitivity: "INTERNAL", budgetContext: expect.objectContaining({ important: true, confidential: true, judgement: true }), routing: { category: "INTELLIGENCE" },
  }));
  vi.mocked(runAi).mockResolvedValue({ run: { status: "BLOCKED", output_text: null } } as Awaited<ReturnType<typeof runAi>>);
  expect((await tlcRevisionWriter({} as Env, {} as Actor, "Edit the PDF")).ok).toBe(false);
});
