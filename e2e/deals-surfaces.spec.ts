import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { VIEWPORTS, measureSurface, reportLine, signIn, type Viewport } from "./support/measure";

/**
 * THE DEALS SECTION, MEASURED RATHER THAN ASSERTED (design/DEALS_SECTION_DESIGN.md §12.7).
 *
 * Every tab of the section is held to the numbers its artboards were measured against (§10): 0
 * horizontal overflow at 320 / 375 / 414 / 768 / 1280, 0 wrapped clickables, 0 targets under 24px
 * (44 below the phone breakpoint), and a contrast sweep over every text node. The measurers are
 * in `support/measure.ts`; ONE `describe` PER TAB below says which surfaces that tab has and seeds
 * enough record for each surface to render its real shape rather than its empty state. A sibling
 * tab adds its own `describe` and nothing else changes.
 *
 * RULE 0: EXAMINING NOTHING IS A FAILURE. `measureSurface` refuses to pass a surface with no text
 * or no clickables, and each seed asserts the rows it made actually landed.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function post<T = { id: string }>(request: APIRequestContext, path: string, data: unknown, ok = 201): Promise<T> {
  const res = await request.post(path, { headers: MP, data });
  expect(res.status(), `${path}: ${await res.text()}`).toBe(ok);
  return (await res.json()) as T;
}

// ── Meetings ──────────────────────────────────────────────────────────────────────────────────

test.describe("Meetings", () => {
  /**
   * A record with every shape the surfaces draw: a meeting on the calendar with a brief to build,
   * and a held meeting with a decision, commitments on both sides, an open question, and a
   * proposed stage move — so the list's readiness and outputs lines, the After face's banner and
   * both columns of "Owed", and the During checklist all render with rows rather than empty states.
   */
  interface Seed { upcomingId: string; heldId: string }
  let seed: Seed | null = null;

  async function seedMeetings(request: APIRequestContext): Promise<Seed> {
    if (seed) return seed;
    const marker = `E2E-DEALS-M-${Date.now()}`;
    const company = await post(request, "/api/companies", { canonical_name: `${marker} Psyflo`, description: "Mental health care for youth, delivered through schools" });
    const opp = await post(request, "/api/opportunities", { company_id: company.id, opportunity_type: "EARLY_STAGE_PRIMARY", title: `${marker} deal` });

    const upcoming = await post(request, "/api/meetings", {
      title: `${marker} Deana Oliver, Psyflo — founder call`,
      meeting_type: "FOUNDER",
      company_id: company.id,
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const held = await post(request, "/api/meetings", {
      title: `${marker} First call with Deana Oliver`,
      meeting_type: "FOUNDER",
      company_id: company.id,
      occurred_at: new Date(Date.now() - 86_400_000).toISOString(),
    });
    await post(request, `/api/meetings/${held.id}/commitments`, { commitment_text: "Send the two district contacts from the Room", owner_side: "FIRM", due_date: "2026-09-12" });
    await post(request, `/api/meetings/${held.id}/commitments`, { commitment_text: "Share the pilot data from the spring term", owner_side: "COUNTERPARTY" });
    await post(request, `/api/meetings/${held.id}/decisions`, { decision_text: "The pilot data lands Friday in their format; we do not wait on a clean version." });
    await post(request, `/api/meetings/${held.id}/open-questions`, { question: "Does the school channel pay, or the parent?", owed_by_kind: "PARTNER" });
    await post(request, `/api/meetings/${held.id}/stage-proposals`, { opportunity_id: opp.id, to_status: "SCREENING", rationale: "The fit question is answered well enough to spend six weeks on." });

    // The seed landed: the list carries both rows with the counts the surfaces draw from.
    const list = (await (await request.get("/api/meetings", { headers: MP })).json()) as {
      meetings: Array<{ id: string; stage_proposal_pending_count: number; we_owe_them: number; decision_count: number }>;
    };
    const heldRow = list.meetings.find((m) => m.id === held.id);
    expect(heldRow?.stage_proposal_pending_count, "the held meeting must carry its proposal").toBe(1);
    expect(heldRow?.decision_count).toBe(1);
    expect(list.meetings.find((m) => m.id === upcoming.id)?.we_owe_them, "the upcoming meeting must carry what rolls forward").toBe(1);
    seed = { upcomingId: upcoming.id, heldId: held.id };
    return seed;
  }

  async function openMeetings(page: Page): Promise<void> {
    await gotoSurface(page, "Meetings");
    await expect(page.getByTestId("meetings-page")).toBeVisible();
    await expect(page.getByTestId("meetings-answer")).not.toContainText("Reading the calendar");
  }

  async function openFace(page: Page, s: Seed, which: "upcoming" | "held", face: "before" | "during" | "after"): Promise<void> {
    await openMeetings(page);
    if (which === "upcoming") await page.getByTestId(`upcoming-open-${s.upcomingId}`).click();
    else await page.getByTestId(`meeting-open-${s.heldId}`).click();
    await page.getByTestId(`face-${face}`).click();
    await expect(page.getByTestId(`face-${face}`)).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId(`face-panel-${face}`)).toBeVisible();
    // The face's own reads have landed: no "Reading…" slot is left on it.
    await expect(page.getByTestId(`face-panel-${face}`)).not.toContainText("Reading the record…");
    await expect(page.getByTestId(`face-panel-${face}`)).not.toContainText("Reading the brief…");
    await page.waitForTimeout(400);
  }

  test("the list holds its numbers at five widths", async ({ page, request }) => {
    const s = await seedMeetings(request);
    await signIn(page);
    const report: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openMeetings(page);
      await expect(page.getByTestId(`upcoming-${s.upcomingId}`)).toBeVisible();
      await expect(page.getByTestId(`meeting-${s.heldId}`)).toBeVisible();
      // The answer line is derived from the seed: a stage move is waiting.
      await expect(page.getByTestId("meetings-answer")).toContainText("waiting on you");
      report.push(reportLine("Meetings list", vp, await measureSurface(page, "meetings-page", "Meetings list", vp)));
    }
    console.log("MEETINGS MEASURED\n  " + report.join("\n  "));
  });

  for (const [which, face] of [["upcoming", "before"], ["held", "during"], ["held", "after"]] as const) {
    test(`the record's ${face} face holds its numbers at five widths`, async ({ page, request }) => {
      const s = await seedMeetings(request);
      await signIn(page);
      const report: string[] = [];
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await openFace(page, s, which, face);
        if (face === "after") {
          await expect(page.locator('[data-testid^="stage-accept-"]'), "the seeded proposal must render as the banner").toHaveCount(1);
          await expect(page.getByTestId("commitment-list")).toContainText("district contacts");
        }
        report.push(reportLine(`Meetings ${face}`, vp, await measureSurface(page, "meeting-detail", `Meetings ${face} face`, vp)));
      }
      console.log(`MEETINGS ${face.toUpperCase()} MEASURED\n  ` + report.join("\n  "));
    });
  }

  test("the standalone room holds its numbers at 360px and the five widths", async ({ page, request }) => {
    const s = await seedMeetings(request);
    await signIn(page);
    const report: string[] = [];
    const panel: Viewport = { name: "360 — the Meet side panel", width: 360, height: 900 };
    for (const vp of [panel, ...VIEWPORTS]) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await page.goto(`/#/room/${s.upcomingId}`);
      await expect(page.getByTestId("room-standalone")).toBeVisible();
      await expect(page.getByTestId(`room-${s.upcomingId}`)).toBeVisible();
      await expect(page.getByTestId("room-status")).not.toContainText("Reading the room");
      await expect(page.getByTestId("nav-toggle"), "the standalone room carries no app shell").toHaveCount(0);
      report.push(reportLine("Room standalone", vp, await measureSurface(page, "room-standalone", "Room standalone", vp)));
    }
    console.log("ROOM STANDALONE MEASURED\n  " + report.join("\n  "));
  });

  test("the faces are a keyboard tablist: arrows move, one face is mounted at a time", async ({ page, request }) => {
    const s = await seedMeetings(request);
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openFace(page, s, "held", "after");
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(3);
    await expect(page.locator('[role="tabpanel"]')).toHaveCount(1);
    await page.getByTestId("face-after").focus();
    await page.keyboard.press("ArrowLeft");
    await expect(page.getByTestId("face-during")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("face-during")).toBeFocused();
    await expect(page.getByTestId("face-panel-during")).toBeVisible();
    await expect(page.getByTestId("face-panel-after")).toHaveCount(0);
    await page.keyboard.press("Home");
    await expect(page.getByTestId("face-before")).toHaveAttribute("aria-selected", "true");
    // Roving tabindex: exactly one tab is in the tab order.
    await expect(page.locator('[role="tab"][tabindex="0"]')).toHaveCount(1);
  });
});
