import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * REVALIDATE ON FOCUS (Wave F, 22 Sep 2026 — plan §6). "There is no revalidate-on-focus anywhere:
 * a tab left open overnight shows last night's numbers forever." `visibilitychange` appears nowhere
 * else in the client. This is the wiring, and the guard that keeps calling it twice (Shell can
 * remount across a session — the room and Meet-panel routes render in its place) from registering
 * the listener twice.
 *
 * The test environment runs with `environment: "node"` (no jsdom in this repo — see
 * `notificationBadge.test.ts` for the same convention applied to `fetch`), so `document`/`window`
 * are stubbed by hand rather than provided by a DOM.
 */

type Handler = () => void;

function fakeEventTarget() {
  const handlers = new Map<string, Handler[]>();
  return {
    addEventListener(type: string, fn: Handler) {
      const list = handlers.get(type) ?? [];
      list.push(fn);
      handlers.set(type, list);
    },
    removeEventListener() {
      // Not exercised here — wireFocusRevalidation never tears itself down; it is a module-wide
      // singleton for the app's whole lifetime.
    },
    fire(type: string) {
      for (const fn of handlers.get(type) ?? []) fn();
    },
    count(type: string): number {
      return (handlers.get(type) ?? []).length;
    },
  };
}

/**
 * A FRESH COPY OF THE MODULE PER TEST. `wireFocusRevalidation`'s "already wired" guard is a
 * module-level singleton by design (see `lib/api.ts`) — correct for the running app, which loads
 * the module once, but wrong for a test file that wants to prove the guard's own behaviour more
 * than once. `vi.resetModules()` plus a dynamic import gives each test its own unwired instance.
 */
async function freshApiModule() {
  vi.resetModules();
  return import("../src/client/lib/api");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the tab regaining focus invalidates every surface", () => {
  it("fires the shared channel when visibilitychange reports visible", async () => {
    const doc = { ...fakeEventTarget(), visibilityState: "visible" as string };
    const win = fakeEventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);

    const { onDataInvalidated, wireFocusRevalidation } = await freshApiModule();
    wireFocusRevalidation();
    const seen = vi.fn();
    const off = onDataInvalidated(seen);

    doc.fire("visibilitychange");
    expect(seen).toHaveBeenCalledTimes(1);
    off();
  });

  it("does not fire when visibilitychange reports the tab going hidden", async () => {
    const doc = { ...fakeEventTarget(), visibilityState: "hidden" as string };
    const win = fakeEventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);

    const { onDataInvalidated, wireFocusRevalidation } = await freshApiModule();
    wireFocusRevalidation();
    const seen = vi.fn();
    const off = onDataInvalidated(seen);

    doc.fire("visibilitychange");
    expect(seen, "leaving the tab invalidated everything, which is backwards").not.toHaveBeenCalled();
    off();
  });

  it("calling it more than once never registers a second listener", async () => {
    const doc = { ...fakeEventTarget(), visibilityState: "visible" as string };
    const win = fakeEventTarget();
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", win);

    const { onDataInvalidated, wireFocusRevalidation } = await freshApiModule();
    wireFocusRevalidation();
    wireFocusRevalidation();
    wireFocusRevalidation();

    const seen = vi.fn();
    const off = onDataInvalidated(seen);
    doc.fire("visibilitychange");
    expect(seen, "three wirings fired the listener more than once — Shell remounting would leak").toHaveBeenCalledTimes(1);
    expect(doc.count("visibilitychange")).toBe(1);
    off();
  });
});

/**
 * A LISTENER NOBODY REGISTERED IS THE SAME BUG WEARING A FIX. `wireFocusRevalidation` has to
 * actually be called from the app, once, or the mechanism above never runs outside a test.
 */
describe("Shell wires focus revalidation on mount", () => {
  const APP = readFileSync(fileURLToPath(new URL("../src/client/App.tsx", import.meta.url)), "utf8");

  it("imports wireFocusRevalidation and calls it inside Shell", () => {
    expect(APP, "App.tsx does not import wireFocusRevalidation at all").toContain("wireFocusRevalidation");

    const start = APP.indexOf("function Shell()");
    expect(start, "Shell has been renamed or removed; this guard can no longer see it").toBeGreaterThan(-1);
    const after = APP.slice(start + 1);
    const end = after.search(/\n(?:function |const |export )/);
    const body = end === -1 ? after : after.slice(0, end);

    expect(body, "Shell never calls wireFocusRevalidation, so focus never revalidates anything")
      .toMatch(/useEffect\(\(\)\s*=>\s*\{\s*wireFocusRevalidation\(\);\s*\},\s*\[\]\)/);
  });
});
