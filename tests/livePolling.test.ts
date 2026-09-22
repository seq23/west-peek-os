import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * GENTLE POLLING ONLY WHILE SOMETHING IS MOVING (Wave F, 22 Sep 2026 — plan §6). `usePollWhile`
 * (`lib/api.ts`) generalises the `DailyBriefPanel` precedent it names explicitly: poll on an
 * interval only while `active`, and stop the moment it is not. The plan rejects the alternative by
 * name — "no polling the empty desk (5,760 requests a day against a board that changes twice a
 * week)" — so the shape that matters is: the interval starts under `active`, stops under `!active`,
 * and is torn down on unmount, exactly the way `DailyBriefPanel`'s inline version already does for
 * the daily brief.
 *
 * This repo has no DOM/React renderer in its unit tests (`environment: "node"`, no jsdom — see
 * `AGENTS.md`/`vitest.config.ts`), and `DailyBriefPanel`'s own hand-written version of this same
 * pattern is not unit tested at this granularity either; only its pure helpers
 * (`briefBand.ts`/`briefRunState.ts`) are. Consistent with that, this proves the shape from source,
 * the same technique `notificationBadge.test.ts` uses to prove `StatusBar` actually subscribes to
 * its channel rather than merely having one defined.
 */

const API_SRC = readFileSync(fileURLToPath(new URL("../src/client/lib/api.ts", import.meta.url)), "utf8");

describe("usePollWhile", () => {
  it("is exported for live surfaces to adopt", () => {
    expect(API_SRC).toContain("export function usePollWhile(");
  });

  it("only starts the interval while active, and clears it on cleanup", () => {
    const start = API_SRC.indexOf("export function usePollWhile(");
    expect(start).toBeGreaterThan(-1);
    const after = API_SRC.slice(start);
    const end = after.indexOf("\n}", after.indexOf("useEffect"));
    const body = after.slice(0, end + 2);

    expect(body, "usePollWhile does not bail out when inactive — this is the 'polling the empty desk' bug the plan rejects")
      .toMatch(/if\s*\(!active\)\s*return;/);
    expect(body, "usePollWhile never starts a real interval").toContain("window.setInterval(reload, intervalMs)");
    expect(body, "usePollWhile's effect never clears its own interval — a leaked timer per mount")
      .toContain("window.clearInterval(t)");
  });
});

/**
 * A UTILITY NOBODY CALLS IS THE SAME BUG WEARING A FIX. The plan's build list names two live
 * surfaces — "a card being worked, a preview that is pending" — as the reason this exists. The
 * card surface belongs to a sibling agent's work-card detail page in this session (out of scope
 * here by the collision note); the pending-preview surface is this wave's own to wire, and it is
 * the one the plan names by exact wording.
 */
describe("a pending preview polls while one exists", () => {
  const SRC = readFileSync(fileURLToPath(new URL("../src/client/pages/PreviewApprovals.tsx", import.meta.url)), "utf8");

  it("usePreviewApprovals imports and calls usePollWhile, gated on there being a preview to watch", () => {
    expect(SRC).toContain('import { api, usePollWhile, useApi } from "../lib/api";');

    const start = SRC.indexOf("export function usePreviewApprovals(");
    expect(start, "usePreviewApprovals has been renamed or removed; this guard can no longer see it").toBeGreaterThan(-1);
    const after = SRC.slice(start + 1);
    const end = after.search(/\n(?:export function|export const|function )/);
    const body = end === -1 ? after : after.slice(0, end);

    expect(body, "usePreviewApprovals never polls, so a preview that lapses or fails to send is only seen on the next manual reload")
      .toContain("usePollWhile(previews.length > 0, list.reload)");
  });
});
