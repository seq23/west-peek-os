import { expect, test } from "@playwright/test";
import { PARTNERS } from "../src/shared/registry/partners";
import { chiefOfStaffFor } from "../src/shared/work/chiefOfStaff";
import { seatId } from "../src/shared/intake/emailTriggers";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1, queryLocalD1 } from "./support/provision";

test.use({ viewport: { width: 390, height: 844 } });

for (const partner of PARTNERS) {
  const chief = chiefOfStaffFor(partner.fullName);
  const employeeId = seatId(chief);

  test(`${chief} accepts a message and renders a fixture reply on the employee page`, async ({ page }, testInfo) => {
    const consoleErrors: string[] = [];
    page.on("pageerror", (error) => consoleErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    const message = `Please outline tomorrow's handoff. TEST ${chief} ${Date.now()}`;
    await page.goto("/");
    await page.getByTestId("dev-login-email").fill(partner.email);
    await page.getByTestId("dev-login-submit").click();
    await expect(page.getByTestId("identity-status")).toContainText(partner.fullName);
    await gotoSurface(page, "Employees");
    await page.getByTestId(`employee-open-${employeeId}`).click();
    const box = page.getByRole("textbox", { name: `Message ${chief}` });
    await box.fill(message);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Message queued for ${chief}.` })).toBeVisible();

    const [session] = queryLocalD1<{ id: string }>(
      `SELECT work_card_id AS id FROM partner_session WHERE source = 'PAGE' AND request_text = '${message.replaceAll("'", "''")}'`,
    );
    expect(session?.id).toBeTruthy();
    const reply = { phase: "SESSION", status: "ok", asks: [{ status: "DONE", words: "Outline the handoff", why: "Drafted" }], reply: "Start with the intake queue, then review the open decisions." };
    provisionLocalD1(
      `UPDATE partner_session SET report_json = '${JSON.stringify(reply)}' WHERE work_card_id = '${session!.id}';
       UPDATE work_card SET state = 'DONE' WHERE id = '${session!.id}';`,
    );
    await page.getByTestId("employee-detail-close").click();
    await page.getByTestId(`employee-open-${employeeId}`).click();
    await expect(page.getByText(reply.reply)).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    expect(consoleErrors).toEqual([]);
    await page.getByRole("region", { name: `Messages with ${chief}` }).screenshot({ path: testInfo.outputPath(`${chief.toLowerCase()}.png`) });
  });
}
