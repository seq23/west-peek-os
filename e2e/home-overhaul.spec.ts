import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";
import { VIEWPORTS, measureSurface, reportLine, signIn } from "./support/measure";

/**
 * HOME, REBUILT (design/HOME_DESIGN.md, approved 19 Sep 2026) — the journeys the design promised.
 *
 *   · the 7 AM screen at 390 holds the masthead, the rail, Waiting and its first row, and the
 *     Arrived head above the fold;
 *   · the masthead's number IS the Waiting pill (one count, never two);
 *   · a `daily_brief` never renders in Arrived — the brief band is the brief;
 *   · the rail filters and remembers, ← Home returns, and a remembered empty filter opens on All;
 *   · Waiting decides inline (Approve → the row says approved; Reject opens the reason), and
 *     select-many quiets blockers but can never tick an approval;
 *   · Arrived's `Mark all read` clears in one press; select-many puts away, and Undo puts back;
 *   · the measured contract holds at five widths.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures", "content-type": "application/json" };
const PHONE = { width: 390, height: 844 };

async function openHome(page: Page): Promise<void> {
  await gotoSurface(page, "Home");
  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(page.getByTestId("home-answer")).not.toHaveText("");
  await expect(page.getByTestId("daily-brief-state")).toBeVisible();
}

function seedArrivals(marker: string): string[] {
  const ids = [`dlv_${marker}_a`, `dlv_${marker}_b`, `dlv_${marker}_c`];
  provisionLocalD1(
    `INSERT INTO deliverable (id, kind, title, body, prepared_by, prepared_for, source_type, source_id, privacy_label, firm_scope) VALUES
       ('${ids[0]}', 'research_packet', '${marker} Research packet: AI inference economics', '## Findings\\n\\nOne.', 'Wyatt', 'fu_sequoia_taylor', 'research_project', 'rp_${marker}', 'INTERNAL', 'west-peek'),
       ('${ids[1]}', 'meeting_prep', '${marker} Wednesday prep', '## Prep\\n\\nTwo.', 'Wren', 'fu_sequoia_taylor', 'meeting', 'mtg_${marker}', 'INTERNAL', 'west-peek'),
       ('${ids[2]}', 'daily_brief', 'Morning brief — 2026-09-19 ${marker}', '## Summary\\n\\nA copy of the band above.', 'Wren', 'fu_sequoia_taylor', 'intelligence_report', 'dir_${marker}', 'INTERNAL', 'west-peek');`,
  );
  return ids;
}

test.describe("Home", () => {
  test("the 7 AM screen at 390: masthead, rail, Waiting with its first row, and the Arrived head above the fold — one count for the answer and the pill", async ({ page, request }) => {
    const marker = `E2E-HOME-${Date.now()}`;
    const card = await request.post("/api/approvals", {
      headers: MP,
      data: { action_key: "governance.policy_change", object_type: "provider_registry", object_id: "anthropic", title: `${marker} a decision for the masthead`, submit: true },
    });
    expect(card.status(), await card.text()).toBe(201);
    const cardId = (await card.json()).id as string;
    const ids = seedArrivals(marker);

    await signIn(page);
    await page.setViewportSize(PHONE);
    await openHome(page);

    // ON A PHONE, HOME GIVES UP THE PURPOSE LINE AND THE STATUS BAR (owner, 23 Sep 2026): the
    // masthead already answers both, and together they pushed the first waiting row under the
    // fold on main (861 > 844). Hidden here; still shown on desktop and on every other page.
    await expect(page.getByTestId("page-purpose-home"), "the purpose line still takes phone Home's first screen").toBeHidden();
    await expect(page.getByTestId("status-bar"), "a second 'N waiting on you' still sits above phone Home").toBeHidden();

    // ONE COUNT: the answer's number is the pill's number, and the pill is the rail's Waiting count.
    const pill = page.getByTestId("home-waiting-pill");
    await expect(pill).toBeVisible();
    const n = Number(await pill.textContent());
    expect(n).toBeGreaterThanOrEqual(1);
    const words = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];
    const answer = await page.getByTestId("home-answer").textContent();
    expect(answer, "the answer names the same number the pill shows").toContain(n < 10 ? words[n]! : String(n));
    await expect(page.getByTestId("home-rail-waiting")).toHaveAttribute("aria-label", `Waiting on me, ${n}`);

    // ABOVE THE FOLD AT 390×844: masthead, rail, the Waiting head and its FIRST row — whole, so
    // Approve and Reject are on the first screen — and, when one thing waits, the Arrived head.
    // On the busy morning (the design's words) the waiting rows fill the first screen and Arrived
    // is the first thing below them: pinned as "no further than one row-height under the fold".
    const fold = PHONE.height;
    const firstCard = page.locator('[data-testid^="home-waiting-card-"]').first();
    for (const [name, loc] of [["home-masthead", page.getByTestId("home-masthead")], ["home-rail", page.getByTestId("home-rail")], ["the Waiting head", page.getByTestId("home-waiting-pill")], ["the first waiting row", firstCard]] as const) {
      const box = await loc.boundingBox();
      expect(box, `${name} did not render`).not.toBeNull();
      expect(box!.y + box!.height, `${name} is not whole above the 390×844 fold (bottom=${Math.round(box!.y + box!.height)})`).toBeLessThanOrEqual(fold);
    }
    const arrivedHead = (await page.getByTestId("home-arrived-pill").boundingBox())!;
    const waitingBand = (await page.getByTestId("home-waiting").boundingBox())!;
    if (n === 1) expect(arrivedHead.y, `one thing waiting: the Arrived head must be above the fold (y=${Math.round(arrivedHead.y)})`).toBeLessThan(fold);
    // Nothing sits between the Waiting band and the Arrived head: a band margin, no more.
    expect(arrivedHead.y - (waitingBand.y + waitingBand.height), `${n} waiting: Arrived is the first thing under the Waiting band`).toBeLessThan(64);
    mkdirSync("test-results/home-screens", { recursive: true });
    await page.screenshot({ path: "test-results/home-screens/after-390.png", fullPage: false });

    // The brief never renders twice: the Arrived band carries the packet and the prep, not the brief copy.
    await expect(page.getByTestId(`deliverable-${ids[0]}`)).toBeVisible();
    await expect(page.getByTestId(`deliverable-${ids[1]}`)).toBeVisible();
    await expect(page.getByTestId(`deliverable-${ids[2]}`), "a daily_brief deliverable rendered in Arrived").toHaveCount(0);
    await expect(page.getByTestId("home-deliverables")).not.toContainText("Morning brief —");
    await expect(page.getByTestId("home-brief-delivery")).toBeVisible();

    // WAITING DECIDES INLINE. Reject opens the reason field; Approve decides and the row says so.
    await page.getByTestId(`home-reject-${cardId}`).click();
    await expect(page.getByTestId(`home-reject-form-${cardId}`)).toBeVisible();
    await page.getByTestId(`home-reject-cancel-${cardId}`).click();
    await expect(page.getByTestId(`home-reject-form-${cardId}`)).toHaveCount(0);
    await page.getByTestId(`home-approve-${cardId}`).click();
    await expect(page.getByTestId(`home-decided-${cardId}`)).toContainText(/approved/);
    await expect(page.getByTestId("home-notice")).toContainText(/Approved at/);
    const decided = (await (await request.get(`/api/approvals/${cardId}`, { headers: MP })).json()) as { state: string };
    expect(["approved", "executed"]).toContain(decided.state);

    // MARK ALL READ, one press, and the count follows.
    await page.getByTestId("home-mark-all-read").click();
    await expect(page.getByTestId("home-notice")).toContainText(/Marked \d+ as read/);
    await expect(page.getByTestId(`deliverable-read-${ids[0]}`)).toBeVisible();
    await expect(page.getByTestId(`deliverable-read-${ids[1]}`)).toBeVisible();

    // SELECT-MANY puts away; Undo puts back.
    await page.getByTestId("home-arrived-select").click();
    await page.getByTestId(`deliverable-select-${ids[0]}`).check();
    await page.getByTestId(`deliverable-select-${ids[1]}`).check();
    await expect(page.getByTestId("home-arrived-select-bar")).toContainText("2 selected");
    await page.getByTestId("home-arrived-put-away-selected").click();
    await expect(page.getByTestId("home-notice")).toContainText(/Put 2 away/);
    await expect(page.getByTestId(`deliverable-${ids[0]}`)).toHaveCount(0);
    await page.getByTestId("home-undo").click();
    await expect(page.getByTestId("home-notice")).toContainText(/Back on the page: 2/);
    await expect(page.getByTestId(`deliverable-${ids[0]}`)).toBeVisible();
  });

  test("phone Home drops only its own purpose line and status bar: desktop Home and a phone on any other page keep both", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHome(page);
    await expect(page.getByTestId("page-purpose-home"), "desktop Home lost its purpose line").toBeVisible();
    await expect(page.getByTestId("status-bar"), "desktop Home lost its status bar").toBeVisible();
    await page.setViewportSize(PHONE);
    await expect(page.getByTestId("page-purpose-home")).toBeHidden();
    await expect(page.getByTestId("status-bar")).toBeHidden();
    await gotoSurface(page, "Approvals");
    await expect(page.getByTestId("approvals-page")).toBeVisible();
    await expect(page.getByTestId("page-purpose-approvals"), "a phone on Approvals lost its purpose line").toBeVisible();
    await expect(page.getByTestId("status-bar"), "a phone on Approvals lost its status bar").toBeVisible();
  });

  test("the rail filters, remembers per viewer, returns with ← Home, and never opens on an empty band", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize(PHONE);
    await openHome(page);
    await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", "all");
    await expect(page.getByTestId("home-rail-home")).toHaveCount(0);

    // Pick a band with something in it, and only that band renders — the brief stays.
    const quietCount = Number((await page.getByTestId("home-rail-quiet").getAttribute("aria-label"))!.split(", ")[1] ?? "0");
    if (quietCount > 0) {
      await page.getByTestId("home-rail-quiet").click();
      await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", "quiet");
      await expect(page.getByTestId("home-quiet-list")).toBeVisible();
      await expect(page.getByTestId("home-deliverables")).toHaveCount(0);
      await expect(page.getByTestId("home-brief-delivery")).toBeVisible();
      // Remembered: a reload opens on it.
      await page.reload();
      await openHome(page);
      await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", "quiet");
      // ← Home is the one-tap return, and Esc is the same act.
      await page.getByTestId("home-rail-home").click();
      await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", "all");
      await page.getByTestId("home-rail-quiet").click();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", "all");
    }
    // A remembered filter whose band is empty opens on All: write it by hand, then reload.
    await page.evaluate(() => {
      const me = document.querySelector('[data-testid="home-page"]');
      void me;
      for (const k of Object.keys(localStorage)) if (k.startsWith("wp.home.filter:")) localStorage.setItem(k, "arrived");
    });
    const arrivedCount = Number((await page.getByTestId("home-rail-arrived").getAttribute("aria-label"))!.split(", ")[1] ?? "0");
    await page.reload();
    await openHome(page);
    await expect(page.getByTestId("home-rail")).toHaveAttribute("data-filter", arrivedCount > 0 ? "arrived" : "all");
  });

  test("select-many in Waiting can quiet blockers but never tick an approval, and there is no Approve selected", async ({ page, request }) => {
    const marker = `E2E-HOME-SEL-${Date.now()}`;
    const card = await request.post("/api/approvals", {
      headers: MP,
      data: { action_key: "governance.policy_change", object_type: "provider_registry", object_id: "anthropic", title: `${marker} not tickable`, submit: true },
    });
    expect(card.status()).toBe(201);
    const cardId = (await card.json()).id as string;
    await signIn(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await openHome(page);
    const select = page.getByTestId("home-waiting-select");
    if (await select.isVisible().catch(() => false)) {
      await select.click();
      const bar = page.getByTestId("home-waiting-select-bar");
      await expect(bar).toBeVisible();
      await expect(bar).not.toContainText(/Approve selected/i);
      await expect(bar).toContainText("Decided one at a time");
      const box = page.getByTestId(`home-waiting-card-${cardId}`).locator('input[type="checkbox"]');
      await expect(box).toBeDisabled();
      await expect(box).toHaveAttribute("aria-describedby", "home-approvals-one-at-a-time");
      const blockers = page.locator('[data-testid^="home-attention-select-"]');
      if ((await blockers.count()) > 0) {
        await blockers.first().check();
        await expect(bar).toContainText("1 selected");
        await page.getByTestId("home-waiting-quiet-selected").click();
        await expect(page.getByTestId("home-notice")).toContainText(/Quiet for a week: 1/);
      }
    } else {
      // No blocker to select: the control is absent rather than dead, and the card still cannot be batched.
      await expect(page.getByTestId("home-waiting-select-bar")).toHaveCount(0);
    }
    await expect(page.locator('[data-testid="home-page"]').getByText(/Approve selected/i)).toHaveCount(0);
    // Leave the local record as it was found: this card was raised to prove it cannot be batched.
    expect((await request.post(`/api/approvals/${cardId}/decide`, { headers: MP, data: { decision: "rejected", note: "e2e: raised to prove select-many never ticks an approval" } })).status()).toBe(200);
  });

  test("Home holds the measured contract at five widths, and the brief band on every filter", async ({ page }) => {
    await signIn(page);
    const report: string[] = [];
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await openHome(page);
      report.push(reportLine("Home", vp, await measureSurface(page, "home-page", "Home", vp)));
    }
    console.log("HOME OVERHAUL MEASURED\n  " + report.join("\n  "));
  });
});
