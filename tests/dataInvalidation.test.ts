import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api, onDataInvalidated, invalidateAll } from "../src/client/lib/api";

/**
 * THE GENERAL INVALIDATION CHANNEL (Wave F, 22 Sep 2026 — plan §6, "A refresh that actually
 * refreshes").
 *
 * THE BUG THIS FIXES. `useApi` fetched on mount and never again. The app-wide `refreshNonce`
 * (`App.tsx`) reached four components out of roughly ninety, because reaching the rest meant every
 * page remembering to accept and forward one more prop — and most never did. Approving a preview
 * refreshed the preview list and left the Work board and the notification badge stale.
 *
 * `onNotificationsChanged`/`notificationsChanged` (see `notificationBadge.test.ts`) already proved
 * the shape: publish from `api()` itself, because the write happening is what makes data stale, so
 * no caller can forget to say so. This generalises it from "a notification changed" to "anything
 * changed", modeled the same way and tested the same way.
 */

const listeners: Array<() => void> = [];

function listen(fn: () => void): void {
  listeners.push(onDataInvalidated(fn));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  while (listeners.length > 0) listeners.pop()!();
  vi.unstubAllGlobals();
});

describe("any accepted mutation, anywhere, invalidates everything", () => {
  it("publishes on an accepted POST", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/approvals/apc_1/decide", { method: "POST", body: {} });
    expect(seen, "an accepted mutation did not invalidate anything").toHaveBeenCalledTimes(1);
  });

  it("publishes on an accepted PATCH", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    const seen = vi.fn();
    listen(seen);
    await api("/api/work-cards/wc_1", { method: "PATCH", body: { state: "HELD" } });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("publishes on a 201 Created", async () => {
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 201, headers: { "content-type": "application/json" } }));
    const seen = vi.fn();
    listen(seen);
    await api("/api/work-cards", { method: "POST", body: {} });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("does not publish for a plain GET, mutation channel or not", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications?unread=1");
    expect(seen, "reading data invalidated everything else, which would loop").not.toHaveBeenCalled();
  });

  it("does not publish when the server refused the write", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"forbidden"}', { status: 403, headers: { "content-type": "application/json" } }),
    );
    const seen = vi.fn();
    listen(seen);
    const res = await api("/api/work-cards/wc_1", { method: "PATCH", body: {} });
    expect(res.status).toBe(403);
    expect(seen, "a refused write still told every surface to refetch").not.toHaveBeenCalled();
  });

  it("does not publish when the connection dropped", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const seen = vi.fn();
    listen(seen);
    const res = await api("/api/work-cards/wc_1", { method: "PATCH", body: {} });
    expect(res.status).toBe(0);
    expect(seen).not.toHaveBeenCalled();
  });

  it("tells every subscriber, and one throwing does not silence the rest", async () => {
    const first = vi.fn(() => { throw new Error("boom"); });
    const second = vi.fn();
    listen(first);
    listen(second);
    invalidateAll();
    expect(first).toHaveBeenCalled();
    expect(second, "a throwing subscriber stopped the others being told").toHaveBeenCalled();
  });

  it("stops telling a subscriber that has unsubscribed", () => {
    const seen = vi.fn();
    const off = onDataInvalidated(seen);
    off();
    invalidateAll();
    expect(seen).not.toHaveBeenCalled();
  });

  it("is deliberately broader than the notification-only channel — a preferences save still counts", async () => {
    // `mutatedNotifications` excludes /api/notifications/preferences on purpose (a quiet-hours
    // change is not "something waiting on you"). The general channel has no such carve-out: a
    // preferences page's own `useApi` still needs to hear that its own write landed.
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications/preferences", { method: "POST", body: { push_enabled: false } });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

/**
 * A CHANNEL NOBODY LISTENS TO IS THE SAME BUG WEARING A FIX (see `notificationBadge.test.ts` for
 * the precedent this borrows). `useApi` has to actually subscribe, or every mutation above could
 * publish correctly and no page would ever refetch.
 */
describe("useApi is subscribed to the channel", () => {
  const API_SRC = readFileSync(fileURLToPath(new URL("../src/client/lib/api.ts", import.meta.url)), "utf8");

  it("subscribes inside useApi's own effect, and tears the subscription down", () => {
    const start = API_SRC.indexOf("export function useApi<T>(");
    expect(start, "useApi has been renamed or removed; this guard can no longer see it").toBeGreaterThan(-1);
    const after = API_SRC.slice(start + 1);
    const end = after.search(/\n(?:export function|export async function)/);
    const body = end === -1 ? after : after.slice(0, end);

    expect(body, "useApi never subscribes to the invalidation channel, so a mutation elsewhere leaves it stale")
      .toContain("onDataInvalidated(reload)");
    // Returned as the effect's cleanup, not fired-and-forgotten — a subscription with no teardown
    // leaks one listener per mount, the same defect class the badge test already guards against.
    expect(body).toMatch(/useEffect\(\(\)\s*=>\s*\{[\s\S]*?return onDataInvalidated\(reload\);[\s\S]*?\},\s*\[path, reload\]\)/);
  });
});
