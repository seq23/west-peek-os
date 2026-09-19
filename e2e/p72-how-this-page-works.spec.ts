import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { signIn } from "./support/measure";

/**
 * "HOW DOES THIS PAGE WORK" — the answer is the page as it is, in a shape a person can read.
 *
 * Owner, 19 Sep 2026, on asking Walter on Meetings: "I can't understand anything he said — it's all
 * jumbled … I think he still has the old page instructions." Her pasted example was one paragraph
 * with three bolded phrases — "Prepare for a meeting… Confer with an AI employee during it… Run a
 * close-out…" — the page as it was before that week's redesign.
 *
 * NEGATIVE PROOF IS THE POINT OF THIS SPEC. The retired trio is asserted absent from Walter's
 * answer and from the Help tab's Meetings section, and the current controls are asserted present
 * as a rendered ordered list and bulleted acts — not as text inside one <p>.
 */

const RETIRED_MEETINGS_TRIO = ["Prepare for a meeting", "Confer with an AI employee", "Run a close-out"];
const CURRENT_MEETINGS_CONTROLS = ["Open the room", "They said yes — record", "Approve — make these the record", "Move it", "Google Meet"];

test("ask Walter on Meetings how the page works: an ordered list of the current page, not the old trio in a paragraph", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Meetings");

  const host = page.getByTestId("page-host-meetings");
  await expect(host).toBeVisible();
  await expect(host).toContainText("Walter");

  await page.getByTestId("page-chat-toggle-meetings").click();
  await page.getByTestId("page-chat-input-meetings").fill("how does this page work?");
  await page.getByTestId("page-chat-send-meetings").click();

  const thread = page.getByTestId("page-chat-thread-meetings");
  const answer = thread.locator('[data-role="HOST"]').first();
  await expect(answer).toBeVisible();

  // STRUCTURE, RENDERED: a numbered list of the bands and a bulleted list of the acts, painted as
  // real <ol>/<ul> elements — the defect was the structure being flattened into one <p>.
  const ordered = answer.locator("ol.md-lite-list");
  await expect(ordered).toHaveCount(1);
  expect(await ordered.locator("li").count()).toBeGreaterThanOrEqual(7);
  const bulleted = answer.locator("ul.md-lite-list");
  expect(await bulleted.count()).toBeGreaterThanOrEqual(1);
  expect(await answer.locator("strong").count()).toBeGreaterThan(10);
  expect(await answer.locator("p").count()).toBeLessThan(4);

  const text = (await answer.innerText()).replace(/\s+/g, " ");
  for (const control of CURRENT_MEETINGS_CONTROLS) expect(text, control).toContain(control);
  for (const phrase of RETIRED_MEETINGS_TRIO) expect(text, phrase).not.toContain(phrase);
  for (const face of ["Before", "During", "After"]) expect(text, face).toContain(face);
  // The committee's new address is named, and no question is asked back.
  expect(text).toContain("Dealflow");
  expect(text.trim().endsWith("?")).toBe(false);
});

test("the Help tab's Meetings section is the same guide, and 'How everything works' from Meetings lands on it", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Meetings");

  await page.getByTestId("page-purpose-help-meetings").click();
  await expect(page.getByTestId("help-center-page")).toBeVisible();

  const section = page.getByTestId("help-page-meetings");
  await expect(section).toBeVisible();
  // Landed on the section, not the top of the page.
  const inView = await section.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= -8 && r.top < window.innerHeight;
  });
  expect(inView, "the Meetings section is scrolled into view on arrival").toBe(true);

  await expect(section.locator("ol.md-lite-list")).toHaveCount(1);
  await expect(section).toContainText("Hosted by Walter");
  const text = (await section.innerText()).replace(/\s+/g, " ");
  for (const control of CURRENT_MEETINGS_CONTROLS) expect(text, control).toContain(control);
  for (const phrase of RETIRED_MEETINGS_TRIO) expect(text, phrase).not.toContain(phrase);

  // Every page in the nav's rooms has a section, and the search narrows to a page by its controls.
  for (const key of ["thesis", "dealflow", "companies", "secondaries", "portfolio", "fund-strategy", "lp", "rooms", "community", "employees", "record", "research", "university", "documents", "approvals", "work", "notifications", "home"]) {
    await expect(page.getByTestId(`help-page-${key}`), key).toBeAttached();
  }
  await page.getByTestId("help-search").fill("hold to talk");
  await expect(page.getByTestId("help-page-meetings")).toBeVisible();
  await expect(page.getByTestId("help-page-thesis")).toBeHidden();
  await page.getByTestId("help-search").fill("");
  await expect(page.getByTestId("help-page-thesis")).toBeVisible();

  // The door back to the page.
  await page.getByTestId("help-page-open-meetings").click();
  await expect(page.getByTestId("page-host-meetings")).toBeVisible();
});
