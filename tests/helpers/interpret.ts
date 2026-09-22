import type { Interpreter } from "../../src/worker/services/instruction";

/**
 * The interpretation pass, faked, for a chain test that is proving the chain.
 *
 * WHY EVERY CHAIN TEST NEEDS ONE. `services/instruction.ts` puts a governed model call in front of
 * every chain, so that what a partner typed reaches a model before any stage runs. A test with no
 * provider therefore gets a failed run, and the chain does the right thing with it: it BLOCKS,
 * because carrying on without her words is the exact defect the pass exists to remove. That is a
 * good failure mode and it is why this helper is explicit rather than a default — a chain that
 * quietly ran unsteered in tests would prove nothing about the chain that runs in production.
 *
 * `saidNothing` is the common case: no partner has typed anything, so `steerFor` returns before
 * calling the model at all and this is never reached. It exists for the tests that DO put words on
 * a card and only care that the chain finishes.
 */
export const saidNothing: Interpreter = async () => ({
  ok: true,
  text: "UNDERSTOOD: build the usual thing, in the usual shape.",
  aiRunId: null,
  model: "fake-test-model",
  detail: "COMPLETED",
});

/** An interpreter that returns a steer the chain must carry into its prompts. */
export function steersWith(understood: string, ...steer: string[]): Interpreter {
  return async () => ({
    ok: true,
    text: [`UNDERSTOOD: ${understood}`, ...steer.map((s) => `STEER: ${s}`)].join("\n"),
    aiRunId: null,
    model: "fake-test-model",
    detail: "COMPLETED",
  });
}

/** An interpreter that finds something in her words the chain has no step for. */
export function cannotDo(understood: string, ...cannot: string[]): Interpreter {
  return async () => ({
    ok: true,
    text: [`UNDERSTOOD: ${understood}`, ...cannot.map((c) => `CANNOT: ${c}`)].join("\n"),
    aiRunId: null,
    model: "fake-test-model",
    detail: "COMPLETED",
  });
}

/** An interpreter that hands part of the ask to a DIFFERENT employee's own registered domain. */
export function handsOffTo(understood: string, kind: string, note: string, ...steer: string[]): Interpreter {
  return async () => ({
    ok: true,
    text: [`UNDERSTOOD: ${understood}`, ...steer.map((s) => `STEER: ${s}`), `HANDOFF: ${kind} — ${note}`].join("\n"),
    aiRunId: null,
    model: "fake-test-model",
    detail: "COMPLETED",
  });
}

/** An interpreter whose model could not be reached at all. */
export const unreachable: Interpreter = async () => ({
  ok: false,
  text: "",
  aiRunId: null,
  model: null,
  detail: "BUDGET_BLOCKED",
});

/** An interpreter that answered, but not in the shape the parser requires. */
export const unreadable: Interpreter = async () => ({
  ok: true,
  text: "Sure! I'd be happy to help with that.",
  aiRunId: null,
  model: "fake-test-model",
  detail: "COMPLETED",
});
