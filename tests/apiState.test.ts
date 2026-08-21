import { describe, expect, it } from "vitest";
import { failureText, isFailure, mutationError, stateMessage } from "../src/client/lib/api";

/**
 * Empty is not the same as failed, and this system produces failures that look like emptiness more
 * than most: `authorize()` fails CLOSED, so an action key missing from the action_type table
 * answers 403 — and a surface rendering `data?.items ?? []` reports that as "nothing here yet".
 *
 * The blind review found `stateMessage` exported and imported by no file in the codebase, and a bug
 * inside it that explains some of that: `useApi` records status 0 when fetch itself rejects, and the
 * old test was `status >= 400`, so a dead connection fell through to the empty text. The helper
 * written to stop failure looking like emptiness had exactly that failure in it.
 */
describe("a surface can tell an absence from a refusal", () => {
  it("reports a dropped connection as a failure, not as an empty list", () => {
    // status 0 is what useApi records when fetch rejects. This is the bug the helper itself had.
    expect(stateMessage(false, 0, "Nothing in the pipeline yet.", true)).toContain("Could not reach the server");
    expect(stateMessage(false, 0, "Nothing in the pipeline yet.", true)).not.toContain("Nothing in the pipeline");
    expect(isFailure(false, 0)).toBe(true);
  });

  it("reports a governed refusal in words a partner can act on, keeping the code for whoever fixes it", () => {
    const msg = stateMessage(false, 403, "Nothing in the pipeline yet.", true);
    expect(msg).toContain("not allowed");
    expect(msg).toContain("403");
    expect(msg).not.toContain("Nothing in the pipeline");
  });

  it("still says the empty thing when the call genuinely succeeded and there is nothing there", () => {
    expect(stateMessage(false, 200, "Nothing in the pipeline yet.", true)).toBe("Nothing in the pipeline yet.");
    expect(isFailure(false, 200)).toBe(false);
  });

  it("says nothing at all when there is something to show", () => {
    expect(stateMessage(false, 200, "Nothing in the pipeline yet.", false)).toBeNull();
  });

  it("prefers loading over every other state, so a slow load never reads as broken", () => {
    expect(stateMessage(true, null, "Nothing yet.", true)).toBe("Loading…");
    expect(stateMessage(true, 500, "Nothing yet.", true)).toBe("Loading…");
    expect(isFailure(true, 500)).toBe(false);
  });

  it("has not decided anything before the first response arrives", () => {
    expect(isFailure(false, null)).toBe(false);
  });
});

describe("a mutation that was refused says so", () => {
  it("returns null on the success codes this API actually uses", () => {
    expect(mutationError({ status: 200, data: {} })).toBeNull();
    expect(mutationError({ status: 201, data: {} })).toBeNull();
    expect(mutationError({ status: 201, data: {} }, 201)).toBeNull();
  });

  it("treats an unexpected success code as a failure when the caller named one", () => {
    // A route that answers 200 where the caller required 201 did not do what was asked.
    expect(mutationError({ status: 200, data: {} }, 201)).not.toBeNull();
  });

  it("uses the server's own reason over ours, because it knows which rule refused", () => {
    const msg = mutationError({ status: 403, data: { error: "forbidden", detail: "needs a second approver" } });
    expect(msg).toContain("needs a second approver");
    expect(msg).toContain("403");
  });

  it("falls back to plain language when the server gave no reason", () => {
    expect(mutationError({ status: 409, data: null })).toContain("Something else changed this first");
    expect(mutationError({ status: 500, data: null })).toContain("Nothing was changed");
    expect(mutationError({ status: 0, data: null })).toContain("Could not reach the server");
  });

  it("names the 403 case specifically, since fail-closed authorization is this system's usual refusal", () => {
    expect(failureText(403)).toContain("approval");
    expect(failureText(401)).toContain("signed in");
  });
});
