import { expect, test, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { VIEWPORTS, measureSurface, reportLine, signIn } from "./support/measure";

/**
 * THE HOME BRIEF BAND ON THE SHARED MEASURED CONTRACT (19 Sep 2026).
 *
 * The same contract the six Deals tabs answer to — zero horizontal overflow at five widths, every
 * text node at AA contrast, every clickable at or above the floor and on one line — measured on
 * the brief band in the two states a partner actually sees: IDLE (no brief today yet, the button is
 * the door) and TERMINAL (arrived, or the stated reason after the clock built it). The band's
 * visual design is Phase HOME_DESIGN's; this holds the floor whatever it looks like.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function openHome(page: Page): Promise<void> {
  await gotoSurface(page, "Home");
  await expect(page.getByTestId("daily-brief")).toBeVisible();
  await expect(page.getByTestId("daily-brief-state")).toBeVisible();
}

test.describe("Home — the brief band", () => {
  test("the band holds its numbers at five widths while idle, and after the clock has answered a press", async ({ page, request }) => {
    await signIn(page);
    const report: string[] = [];

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openHome(page);
      report.push(reportLine("Home brief band (idle or as left)", vp, await measureSurface(page, "daily-brief", "Home brief band", vp)));
    }

    // Press once, let the clock build it, and measure the terminal band — arrived or stated.
    const before = (await (await request.get("/api/daily-intelligence/status", { headers: MP })).json()) as { kind: string };
    if (!["arrived", "retrying", "failed_out"].includes(before.kind)) {
      const pressed = await request.post("/api/daily-intelligence/generate", { headers: MP, data: {} });
      expect([200, 202]).toContain(pressed.status());
      const tick = await request.post("/api/jobs/tick", { headers: MP });
      expect(tick.status()).toBe(200);
    }
    const after = (await (await request.get("/api/daily-intelligence/status", { headers: MP })).json()) as { kind: string; line: string };
    expect(["arrived", "retrying", "failed_out"], `the clock left the brief in a non-terminal state: ${after.kind} — ${after.line}`).toContain(after.kind);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      // A fresh load: the band asks the row on mount and polls only while it moves, so a page that
      // was open through the press must be reloaded to read the outcome — as a partner's would be.
      await page.reload();
      await openHome(page);
      await expect(page.getByTestId("daily-brief-state")).toHaveAttribute("data-kind", after.kind);
      // The state line reads as a sentence, and the button reads as its next act, at every width.
      await expect(page.getByTestId("daily-brief-state-line")).toContainText(/brief/i);
      await expect(page.getByTestId("daily-brief-generate")).toBeEnabled();
      report.push(reportLine(`Home brief band (${after.kind})`, vp, await measureSurface(page, "daily-brief", `Home brief band ${after.kind}`, vp)));
    }
    console.log("HOME BRIEF BAND MEASURED\n  " + report.join("\n  "));
  });
});
