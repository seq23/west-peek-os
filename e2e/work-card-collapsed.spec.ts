import { expect, test, type Page } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * WORK CARDS, COLLAPSED BY DEFAULT — ONE PRESS SHOWS EVERYTHING, IN PLACE (23 Sep 2026).
 *
 * Her words, approving the canvas: "it's too much for a work home landing page. it should be truly
 * collapsed with only the title and in progress and the necessary things showing then a big chevron
 * or some obvious expansion button that has everything and i shouldnt have to click again to see
 * everything."
 *
 * Three pins, each a sentence of hers:
 *   1 · the collapsed row carries NOTHING but owner, title, one status, the site track and the
 *       button — in particular no WebPropertyChangePanel, no switch, no model or audience label;
 *   2 · the button's aria-expanded toggles, and the whole card (Porter's panel included) appears
 *       IMMEDIATELY after the row, inside the same card — never below other content;
 *   3 · the title is the plain one, never the raw email cut off mid-word; and at 390px the page
 *       does not scroll sideways and the button is a real thumb target.
 */

const MP = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).not.toContainText("NOT AUTHENTICATED");
}

async function openSiteCard(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.post("/api/work-cards", {
    headers: MP,
    data: {
      title: 'Change joinwestpeek.com: "Porter, We need to get started on the community site redesign (joinwestpeek.com). Ever',
      kind: "WEB_PROPERTY_CHANGE",
      property_host: "joinwestpeek.com",
      owner_type: "AI",
      owner_id: "aie_porter",
      prompt: "Porter,\n\nWe need to get started on the community site redesign (joinwestpeek.com). Everything is in the folder.\n\nThanks,\nSequoia",
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test("a card rests as one row, and one press opens everything directly under it", async ({ page, request }) => {
  const cardId = await openSiteCard(request);
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoSurface(page, "Work");
  await page.getByTestId("work-view-desk").click();

  const card = page.getByTestId(`work-card-${cardId}`);
  const row = page.getByTestId(`work-card-row-${cardId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });

  // 3 · The plain title — the raw brief never reaches the row.
  await expect(page.getByTestId(`work-card-title-${cardId}`)).toHaveText("Community site redesign · joinwestpeek.com");
  await expect(row).not.toContainText("Porter, We need");

  // 1 · Nothing else on the collapsed row.
  await expect(card.locator(`[data-testid="work-card-wpc-${cardId}"]`)).toHaveCount(0);
  await expect(card.locator('[data-testid^="wpc-"]')).toHaveCount(0);
  for (const gone of ["previewtoggle", "model-access", "audience", "lane", "origin", "done", "drop", "steer-input"]) {
    await expect(card.locator(`[data-testid="work-card-${gone}-${cardId}"]`), `${gone} must not be on the collapsed row`).toHaveCount(0);
  }
  await expect(row.locator(".switch")).toHaveCount(0);
  await expect(row.getByRole("button"), "the only control on the row is Show everything").toHaveCount(1);
  await expect(page.getByTestId(`work-card-state-${cardId}`)).toHaveCount(1);
  await expect(page.getByTestId(`work-card-track-${cardId}`)).toContainText("Plan");
  // "Working now" is a claim about a machine; nothing holds this card, so it must not be said.
  await expect(page.getByTestId(`work-card-state-${cardId}`)).not.toHaveText("Working now");

  // 2 · The button is labelled, big, and its state is aria-expanded.
  const toggle = page.getByTestId(`work-card-toggle-${cardId}`);
  await expect(toggle).toHaveText(/Show everything/);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  const box = await toggle.boundingBox();
  expect(box!.height, "the expansion button is at least a thumb high").toBeGreaterThanOrEqual(44);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText(/Hide/);

  // Porter's panel is revealed at once, no second press…
  const panel = page.getByTestId(`work-card-wpc-${cardId}`);
  await expect(panel).toBeVisible();
  // …and it is IMMEDIATELY after the row: the body is the row's next sibling, inside the same card.
  const placement = await page.evaluate((id) => {
    const r = document.querySelector(`[data-testid="work-card-row-${id}"]`);
    const body = r?.nextElementSibling ?? null;
    return {
      bodyTestid: body?.getAttribute("data-testid") ?? null,
      panelInBody: Boolean(body?.querySelector(`[data-testid="work-card-wpc-${id}"]`)),
      sameCard: body?.parentElement === r?.parentElement && r?.parentElement?.getAttribute("data-testid") === `work-card-${id}`,
      controls: document.querySelector(`[data-testid="work-card-toggle-${id}"]`)?.getAttribute("aria-controls"),
      bodyId: body?.id ?? null,
    };
  }, cardId);
  expect(placement.bodyTestid).toBe(`work-card-expanded-${cardId}`);
  expect(placement.panelInBody).toBe(true);
  expect(placement.sameCard).toBe(true);
  expect(placement.controls).toBe(placement.bodyId);

  // Everything is there on that one press: the details, the box to Porter, the request once, the foot.
  await expect(page.getByTestId(`work-card-asked-by-${cardId}`)).toContainText("You");
  await expect(page.getByTestId(`work-card-steer-input-${cardId}`)).toBeVisible();
  await expect(page.getByTestId(`work-card-steer-send-${cardId}`)).toContainText("Send to Porter");
  await expect(page.getByTestId(`work-card-request-${cardId}`)).toHaveCount(1);
  await expect(page.getByTestId(`work-card-technical-${cardId}`)).toContainText(cardId);
  await expect(page.getByTestId(`work-card-drop-${cardId}`)).toHaveText("Stop this work");
  // The black Done is not offered on an employee's card in flight.
  await expect(page.getByTestId(`work-card-done-${cardId}`)).toHaveCount(0);

  // Hide closes it again.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByTestId(`work-card-wpc-${cardId}`)).toHaveCount(0);

  // The card's own page renders the same body, the same title and the same status.
  const status = await page.getByTestId(`work-card-status-${cardId}`).textContent();
  await page.goto(`/#/work/${cardId}`);
  await expect(page.getByTestId("work-card-title")).toHaveText("Community site redesign · joinwestpeek.com");
  await expect(page.getByTestId(`work-card-wpc-${cardId}`)).toBeVisible();
  await expect(page.getByTestId("work-card-progress")).toContainText(status!.trim());
  await expect(page.getByTestId("work-card-page")).not.toContainText("step 0 of");
  await expect(page.getByTestId("work-card-page")).not.toContainText("Requested by a hand-off");
  await expect(page.getByTestId("work-card-page")).not.toContainText("WEB_PROPERTY_CHANGE");
});

test("at 390px the desk does not scroll sideways and every row keeps its big button", async ({ page, request }) => {
  const cardId = await openSiteCard(request);
  await signIn(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoSurface(page, "Work");
  await page.getByTestId("work-view-desk").click();
  const toggle = page.getByTestId(`work-card-toggle-${cardId}`);
  await expect(toggle).toBeVisible({ timeout: 20_000 });
  const box = await toggle.boundingBox();
  expect(box!.height).toBeGreaterThanOrEqual(44);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(390);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the phone desk scrolls sideways").toBeLessThanOrEqual(0);
  await toggle.click();
  await expect(page.getByTestId(`work-card-wpc-${cardId}`)).toBeVisible();
  const opened = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(opened, "the open card scrolls sideways on a phone").toBeLessThanOrEqual(0);
});
