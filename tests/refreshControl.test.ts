import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * THE MASTHEAD REFRESH CONTROL (Wave F, 22 Sep 2026 — plan §6). "There is no refresh control
 * anywhere in the client — zero hits for a refresh or reload button." This proves the control
 * exists, lives in the app-wide chrome (not a per-card masthead — that surface belongs to a
 * sibling agent's work-card detail page this session), and is wired to the shared channel rather
 * than to its own private fetch.
 */
const APP = readFileSync(fileURLToPath(new URL("../src/client/App.tsx", import.meta.url)), "utf8");

function componentBody(startMarker: string): string {
  const start = APP.indexOf(startMarker);
  expect(start, `${startMarker} not found in App.tsx`).toBeGreaterThan(-1);
  const after = APP.slice(start + 1);
  const end = after.search(/\n(?:function |const |export )/);
  return end === -1 ? after : after.slice(0, end);
}

describe("RefreshControl", () => {
  const body = componentBody("function RefreshControl()");

  it("presses call the shared invalidation channel, not a private fetch of its own", () => {
    expect(body, "RefreshControl does not call invalidateAll — pressing it would refresh nothing")
      .toContain("invalidateAll()");
  });

  it("shows an as-of stamp sourced from the shared freshness channel", () => {
    expect(body).toContain("onFreshnessChanged(");
    expect(body).toContain("getLastFetchedAt()");
    expect(body, "the stamp text does not say 'as of', which is the plan's own wording")
      .toMatch(/as of \$\{/);
  });

  it("carries a stable test id for e2e to find", () => {
    expect(body).toContain('data-testid="global-refresh"');
    expect(body).toContain('data-testid="global-refresh-asof"');
  });
});

