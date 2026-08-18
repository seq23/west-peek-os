import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P17 browser journey — Machine Control Center + Capability Intelligence (GAP-06, GAP-07).
 *
 * Journey: sign in → Machines → the 45-machine fleet with live queue/spend/failures → open a
 * machine → append operating memory → pause it → the +Capture surface then REFUSES to route
 * work to it (the pause is server-enforced, not cosmetic) → resume → register a capability and
 * see it land on the bench as UNTESTED.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("the fleet is operable and a pause actually stops work reaching the machine", async ({ page, request }) => {
  await signIn(page);
  await gotoSurface(page, "Machines");
  await expect(page.getByTestId("machines-page")).toBeVisible();
  await expect(page.getByTestId("machines-note")).toContainText("45 machines");

  // Open the Marketing / PR / Content machine (#33) and record an operating note.
  await page.getByTestId("machine-open-33").click();
  await expect(page.getByTestId("machine-detail-33")).toBeVisible();
  await page.getByTestId("machine-memo-33").fill("Rebrand in progress; hold outbound content.");
  await page.getByTestId("machine-memo-submit-33").click();
  await expect(page.getByTestId("machine-memory-33")).toContainText("Rebrand in progress");

  // Pause it, with a reason.
  await page.getByTestId("machine-reason-33").fill("rebrand freeze");
  await page.getByTestId("machine-pause-33").click();
  await expect(page.getByTestId("machine-message-33")).toContainText("refuses work routing");

  // The API refuses to route a capture there — the pause is enforced server-side.
  const headers = { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" };
  const capture = await request.post("/api/captures", {
    headers,
    data: { capture_type: "note", raw_text: "content idea during the freeze", source_channel: "web" },
  });
  const captureBody = await capture.json();
  const routed = await request.post(`/api/captures/${captureBody.id}/route`, { headers, data: { machine_id: 33 } });
  expect(routed.status()).toBe(409);
  expect((await routed.json()).error).toBe("machine_paused");

  // Resume, and routing works again.
  await page.getByTestId("machine-reason-33").fill("freeze lifted");
  await page.getByTestId("machine-pause-33").click();
  await expect(page.getByTestId("machine-message-33")).toContainText("Resumed");
  const routedAgain = await request.post(`/api/captures/${captureBody.id}/route`, { headers, data: { machine_id: 33 } });
  expect(routedAgain.status()).toBe(200);
});

test("a capability registers on the bench as untested and the stack stays evidence-based", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Machines");

  const key = `journey_capability_${Date.now()}`;
  await page.getByTestId("capability-key").fill(key);
  await page.getByTestId("capability-name").fill("Journey capability");
  await page.getByTestId("capability-submit").click();

  await expect(page.getByTestId("capability-message")).toContainText("UNTESTED");
  await expect(page.getByTestId("capabilities-bench")).toContainText("Journey capability");
  await expect(page.getByTestId("recommended-stack")).toContainText("not a model opinion");
});
