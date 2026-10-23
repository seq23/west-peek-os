import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./support/measure";

/**
 * OUTSIDE EMAIL: WHAT MAY SEND, ON A PHONE (owner, 23 Oct 2026): "We need a universal narrow switch
 * and i can easily go in the ui and tell it which jobs or work cards to allow".
 *
 * At 390 px: the TLC Brand sending panel says why nothing goes and links to the list; the list says
 * in words that nothing is allowed; Allow asks "are you sure?" first and then shows who and when;
 * Stop is one tap; ← Back is there; nothing scrolls sideways. It ends stopped, as it began.
 */

test.use({ viewport: { width: 390, height: 844 } });

async function noSideways(page: Page): Promise<void> {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(over).toBeLessThanOrEqual(0);
}

test("from the TLC panel to the list: Allow asks first and shows who and when, Stop is one tap", async ({ page }) => {
  await signIn(page);

  // The Learning Club page (its own address since 23 Oct 2026) names the list and links to it.
  await page.goto("/#/learning-club");
  const link = page.getByTestId("tlc-outside-email-link");
  await expect(link).toHaveText("TLC brand sales is not on your Outside email list — tap to allow.");
  await link.click();

  const screen = page.getByTestId("outside-email-page");
  await expect(screen).toBeVisible();
  await expect(page).toHaveURL(/#\/outside-email$/);
  await expect(page.getByTestId("outside-email-back")).toHaveText("← Back");
  await expect(page.getByTestId("outside-email-summary")).toHaveText("Nothing is allowed to email outside the firm yet.");
  await expect(page.getByTestId("outside-email-break-glass")).toHaveCount(0);
  const job = page.getByTestId("outside-email-job-tlc_brand_sales");
  await expect(job).toContainText("What it sends:");
  await expect(job).toContainText("To whom:");
  await expect(page.getByTestId("outside-email-job-state-tlc_brand_sales")).toHaveText("Not allowed");
  await noSideways(page);

  // Allow asks first; Cancel changes nothing.
  await page.getByTestId("outside-email-allow-tlc_brand_sales").click();
  await expect(job).toContainText("Are you sure?");
  await job.getByRole("button", { name: "Cancel, change nothing" }).click();
  await expect(page.getByTestId("outside-email-job-state-tlc_brand_sales")).toHaveText("Not allowed");

  await page.getByTestId("outside-email-allow-tlc_brand_sales").click();
  await page.getByTestId("outside-email-allow-yes-tlc_brand_sales").click();
  await expect(page.getByTestId("outside-email-job-state-tlc_brand_sales")).toHaveText("Allowed");
  await expect(job).toContainText(/Allowed by .+, /);
  await expect(page.getByTestId("outside-email-summary")).toContainText("Only these may email outside the firm: TLC brand sales.");
  await noSideways(page);

  // Stop is one tap, no question.
  await page.getByTestId("outside-email-stop-tlc_brand_sales").click();
  await expect(page.getByTestId("outside-email-job-state-tlc_brand_sales")).toHaveText("Not allowed");
  await expect(job).toContainText(/Stopped by .+, /);
  await expect(page.getByTestId("outside-email-summary")).toHaveText("Nothing is allowed to email outside the firm yet.");

  // Who changed what, newest first.
  await page.getByTestId("outside-email-audit").locator("summary").click();
  const lines = page.getByTestId("outside-email-audit").locator("li");
  await expect(lines.first()).toContainText("stopped TLC brand sales");
  await expect(lines.nth(1)).toContainText("allowed TLC brand sales");
  await noSideways(page);

  // ← Back returns her to the panel she came from.
  await page.getByTestId("outside-email-back").click();
  await expect(page).toHaveURL(/#\/learning-club$/);
  await expect(page.getByTestId("tlc-outside-email-link")).toBeVisible();
});
