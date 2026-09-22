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

describe("RefreshControl is mounted in the app-wide chrome, once", () => {
  it("is rendered inside the shell header's surface-identity block, not inside a per-page masthead", () => {
    const headerStart = APP.indexOf('<header className="shell-header">');
    expect(headerStart, "the shell header markup has moved; re-locate before trusting this guard").toBeGreaterThan(-1);
    const identityStart = APP.indexOf('<div className="surface-identity">', headerStart);
    expect(identityStart).toBeGreaterThan(headerStart);
    const identityEnd = APP.indexOf("</div>", identityStart);
    const identityBlock = APP.slice(identityStart, identityEnd);
    expect(identityBlock, "<RefreshControl /> is not mounted in the shell's identity/status area")
      .toContain("<RefreshControl />");
  });

  it("appears exactly once in the whole file — one control, not one per page", () => {
    const matches = APP.match(/<RefreshControl\s*\/>/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("is not defined inside WorkCardPage or any work-card-detail component — that surface belongs to the sibling wave", () => {
    expect(APP).not.toMatch(/function WorkCardPage\(/);
  });
});
