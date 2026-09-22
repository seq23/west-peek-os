import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, getLastFetchedAt, onFreshnessChanged } from "../src/client/lib/api";

/**
 * THE "AS OF" STAMP (Wave F, 22 Sep 2026 — plan §6). The masthead's refresh control shows "as of
 * HH:MM" so staleness is visible before she has to ask — the plan's own words. This is the plumbing
 * behind that: the last time any GET actually succeeded, updated from `api()` itself so no page has
 * to report its own freshness.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const listeners: Array<() => void> = [];

function listen(fn: () => void): void {
  listeners.push(onFreshnessChanged(fn));
}

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  while (listeners.length > 0) listeners.pop()!();
  vi.unstubAllGlobals();
});

describe("the last-fetched stamp", () => {
  it("moves forward when a GET succeeds", async () => {
    const before = getLastFetchedAt();
    await api("/api/notifications?unread=1");
    const after = getLastFetchedAt();
    expect(after).not.toBeNull();
    if (before !== null) expect(after!).toBeGreaterThanOrEqual(before);
  });

  it("does not move for a failed GET", async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"error":"forbidden"}', { status: 403, headers: { "content-type": "application/json" } }));
    const before = getLastFetchedAt();
    await api("/api/notifications?unread=1");
    expect(getLastFetchedAt()).toBe(before);
  });

  it("does not move for a mutation — only reads count as freshness", async () => {
    const before = getLastFetchedAt();
    await api("/api/notifications/ntf_1/read", { method: "POST" });
    expect(getLastFetchedAt()).toBe(before);
  });

  it("tells subscribers when it updates", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications?unread=1");
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("stops telling a subscriber that unsubscribed", async () => {
    const seen = vi.fn();
    const off = onFreshnessChanged(seen);
    off();
    await api("/api/notifications?unread=1");
    expect(seen).not.toHaveBeenCalled();
  });
});
