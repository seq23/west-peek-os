import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { api, notificationsChanged, onNotificationsChanged } from "../src/client/lib/api";

/**
 * The badge follows what she just did.
 *
 * Operator, 9 Sep 2026: "the west peek os home screen still says 12 unread even tho i read it all
 * and dismissed or took responsibility."
 *
 * WHAT WAS ACTUALLY WRONG, and it was not the count. `StatusBar` fetched
 * `/api/notifications?unread=1` into its own `useApi` instance, refreshed only when App's
 * `refreshNonce` changed — and that nonce reaches exactly two components, `CapturePage` and
 * `WorkSurface`. The Notifications page is not one of them: it calls its OWN `useApi().reload()`,
 * which bumps a nonce the status bar cannot see. So she could clear the entire inbox, watch the
 * page say "You are caught up", and have the badge above it keep showing the number it fetched
 * when the tab opened, until she reloaded. Two components each keeping their own copy of one
 * number, with nothing linking them.
 *
 * The count was never wrong. On 9 Sep her true unread count was ZERO — all twenty-six unread rows
 * in production are addressed to Scooter — and the badge was displaying a stale snapshot.
 *
 * WHY THE CHANNEL IS TESTED RATHER THAN THE NUMBER. Passing `refreshNonce` into one more page
 * would fix the symptom and keep the trap: the next surface that marks something read has to
 * remember a prop it was never handed, and forgetting is silent. Publishing from `api()` means the
 * invalidation happens because the write happened. These tests hold that, and hold that the badge
 * is still actually subscribed — a channel nobody listens to is the same bug wearing a fix.
 */

const listeners: Array<() => void> = [];

/** Subscribe and remember to unsubscribe, so one test cannot leak into the next. */
function listen(fn: () => void): void {
  listeners.push(onNotificationsChanged(fn));
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  // localStorage is absent in the node environment; `getDevUser` already tolerates that.
});

afterEach(() => {
  while (listeners.length > 0) listeners.pop()!();
  vi.unstubAllGlobals();
});

describe("a notification write tells whatever is counting notifications", () => {
  it("publishes when a dismiss is accepted", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications/ntf_1/read", { method: "POST" });
    expect(seen, "dismissing did not tell the badge").toHaveBeenCalledTimes(1);
  });

  it("publishes when taking responsibility is accepted", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications/ntf_1/acknowledge", { method: "POST" });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("publishes when everything is dismissed at once", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications/read-all", { method: "POST", body: {} });
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the server REFUSED the write", async () => {
    /*
     * The half that matters more. A badge cleared on a failed dismiss is worse than a stale one:
     * it says the work is done when the row was never touched.
     */
    fetchMock.mockResolvedValueOnce(
      new Response('{"error":"forbidden"}', { status: 403, headers: { "content-type": "application/json" } }),
    );
    const seen = vi.fn();
    listen(seen);
    const res = await api("/api/notifications/ntf_1/read", { method: "POST" });
    expect(res.status).toBe(403);
    expect(seen, "a refused write cleared the badge").not.toHaveBeenCalled();
  });

  it("stays silent when the connection dropped", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const seen = vi.fn();
    listen(seen);
    const res = await api("/api/notifications/ntf_1/read", { method: "POST" });
    expect(res.status).toBe(0);
    expect(seen).not.toHaveBeenCalled();
  });

  it("stays silent on a plain read of the list, and on saving a preference", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/notifications?unread=1");
    await api("/api/notifications/preferences", { method: "POST", body: { push_enabled: false } });
    // Quiet hours change WHEN she is interrupted, never what is outstanding.
    expect(seen).not.toHaveBeenCalled();
  });

  it("stays silent for writes to anything else", async () => {
    const seen = vi.fn();
    listen(seen);
    await api("/api/approvals/apc_1/decide", { method: "POST", body: {} });
    expect(seen).not.toHaveBeenCalled();
  });

  it("tells every subscriber, and one throwing does not silence the rest", async () => {
    const first = vi.fn(() => { throw new Error("boom"); });
    const second = vi.fn();
    listen(first);
    listen(second);
    notificationsChanged();
    expect(first).toHaveBeenCalled();
    expect(second, "a throwing subscriber stopped the others being told").toHaveBeenCalled();
  });

  it("stops telling a subscriber that has unsubscribed", () => {
    const seen = vi.fn();
    const off = onNotificationsChanged(seen);
    off();
    notificationsChanged();
    expect(seen).not.toHaveBeenCalled();
  });
});

/**
 * A CHANNEL NOBODY LISTENS TO IS THE SAME BUG WEARING A FIX.
 *
 * Everything above passes with `StatusBar` never subscribing — the publisher would work perfectly
 * and the badge would still be frozen. This is the assertion that reaches the thing the fix is
 * actually for, read out of the source so it cannot drift from it.
 */
describe("the badge is subscribed to it", () => {
  const APP = readFileSync(fileURLToPath(new URL("../src/client/App.tsx", import.meta.url)), "utf8");

  it("imports the channel and subscribes inside the status bar", () => {
    expect(APP, "App.tsx does not import the channel at all").toContain("onNotificationsChanged");

    const start = APP.indexOf("function StatusBar(");
    expect(start, "StatusBar has been renamed or removed; this guard can no longer see it").toBeGreaterThan(-1);
    // The component ends where the next top-level declaration begins.
    const after = APP.slice(start + 1);
    const end = after.search(/\n(?:function |const |export )/);
    const body = end === -1 ? after : after.slice(0, end);

    expect(body, "the status bar never subscribes, so the badge stays frozen after a dismiss")
      .toContain("onNotificationsChanged");
    // Subscribed inside an effect, with the unsubscribe returned — a subscription that is never
    // torn down leaks a listener per re-render.
    expect(body).toMatch(/useEffect\(\(\)\s*=>\s*onNotificationsChanged\(/);
  });
});
