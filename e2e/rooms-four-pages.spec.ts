import { expect, test, type Page } from "@playwright/test";
import { openDisclosure } from "./support/nav";

/**
 * EVENTS & ROOMS IS FOUR PAGES (owner approved the v8 mock-up, 23 Oct 2026), at a phone (390 px) and
 * a laptop (1280 px). Each page carries the links row and ← Back; nothing scrolls sideways; the
 * things she does on each page work: a note under an idea, a research link, the sponsors' heading.
 */

async function signIn(page: Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");
}

async function noSideways(page: Page, where: string): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over, `${where} scrolls sideways`).toBeLessThanOrEqual(0);
}

for (const [label, size] of [["phone (390 px)", { width: 390, height: 844 }], ["laptop (1280 px)", { width: 1280, height: 800 }]] as const) {
  test(`the four Rooms pages at a ${label}: links row, ← Back, nothing sideways`, async ({ page }) => {
    await page.setViewportSize(size);
    await signIn(page);
    await page.goto("/#/rooms");
    await expect(page.getByTestId("rooms-page")).toBeVisible();
    await expect(page.getByTestId("rooms-links")).toBeVisible();
    await expect(page.getByTestId("rooms-back")).toHaveText("← Back");
    await expect(page.getByTestId("tlc-ideas-card")).toBeVisible();
    await noSideways(page, "Events & Rooms");

    for (const [key, testId, title] of [
      ["learning-club", "learning-club-page", "The Learning Club"],
      ["room-sponsors", "room-sponsors-page", "Room sponsors"],
      ["research-library", "research-library-page", "Research library"],
    ] as const) {
      await page.goto("/#/rooms");
      await page.getByTestId(`rooms-link-${key}`).click();
      await expect(page).toHaveURL(new RegExp(`#/${key}$`));
      await expect(page.getByTestId(testId)).toBeVisible();
      // Its own header title, never "Home" or another page's.
      await expect(page.locator("h2").first()).toHaveText(title);
      await expect(page.getByTestId(`rooms-link-${key}`)).toHaveAttribute("aria-current", "page");
      await expect(page.getByTestId("rooms-back")).toHaveText("← Back to Events & Rooms");
      await noSideways(page, title);
      await page.getByTestId("rooms-back").click();
      await expect(page).toHaveURL(/#\/rooms$/);
    }
  });
}

test("The Learning Club page: sending at the top, not-pitching right, one partners list, steps folded", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/#/learning-club");
  await expect(page.getByTestId("tlc-brand-sending")).toContainText(/Sending to brands is (ON|OFF)/);
  await expect(page.getByTestId("tlc-next-clubs")).toBeVisible();
  const notPitching = page.getByTestId("tlc-not-pitching");
  await expect(notPitching).toContainText("Sportsbooks");
  await expect(notPitching.locator("p.small").first()).not.toContainText(/Kalshi|Polymarket|Robinhood|full-body/);
  await expect(notPitching).toContainText("Prediction markets (Kalshi, Polymarket), Robinhood and full-body scans are allowed");
  await expect(page.getByTestId("tlc-title-sponsors")).toContainText("Anthropic");
  await expect(page.getByTestId("tlc-must-pitch")).toBeVisible();
  await expect(page.getByTestId("tlc-partners").locator("h3")).toHaveText("Partners who said yes");
  expect(await page.getByTestId("tlc-steps-fold").evaluate((el) => (el as HTMLDetailsElement).open)).toBe(false);
  await openDisclosure(page, "tlc-steps-fold");
  await expect(page.getByTestId("tlc-step-pitch")).toBeVisible();
});

test("a note under an idea is saved with who and when; a research link is added; sponsors sit under Who is paying for it", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.goto("/#/rooms");
  const add = page.getByTestId("tlc-idea-add");
  await add.locator("input").first().fill("Matcha making night");
  await add.getByRole("button", { name: "Add to the list" }).click();
  await page.getByTestId("tlc-ideas-search").fill("Matcha making night");
  const row = page.locator('[data-testid^="tlc-idea-tli_"]').filter({ hasText: "Matcha making night" }).first();
  await expect(row).toBeVisible();
  await row.locator('[data-testid^="tlc-idea-note-add-"]').click();
  await row.locator('[data-testid^="tlc-idea-note-input-"]').fill("Ceremonial grade, whisked at the table.");
  await row.locator('[data-testid^="tlc-idea-note-save-"]').click();
  await expect(row.locator('[data-testid^="tlc-idea-note-tln_"]')).toContainText(/You, \d{1,2} [A-Z][a-z]{2} \d{4}: Ceremonial grade, whisked at the table\./);

  await page.goto("/#/research-library");
  const pages = page.getByTestId("research-pages");
  await expect(pages).toContainText("Title sponsors: who pays $25K alone");
  await expect(pages).toContainText("Fragrance & AI sponsors");
  await page.getByTestId("research-link-open").click();
  await page.getByTestId("research-link-title").fill("Who funds TLC");
  await page.getByTestId("research-link-url").fill("https://claude.ai/artifact/example");
  await page.getByTestId("research-link-save").click();
  await expect(pages).toContainText("Who funds TLC");
  await expect(pages).toContainText("Added by Sequoia");
  await noSideways(page, "Research library");

  await page.goto("/#/room-sponsors");
  await expect(page.getByRole("heading", { name: "Who is paying for it" })).toBeVisible();
  await expect(page.getByTestId("add-sponsor-card")).toContainText("Add a sponsor to a Room");
  await noSideways(page, "Room sponsors");
});
