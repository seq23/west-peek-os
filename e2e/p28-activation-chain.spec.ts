import { expect, test } from "@playwright/test";

/**
 * P28 — the activation chain, end to end.
 *
 * REGRESSION. `request-activation` created an approval card and Approvals could approve it, but no
 * client code ever called `POST /api/ai/employees/:id/activate`. The chain stopped one link short:
 * an approved receipt sat unconsumed and the employee stayed INACTIVE forever, with no error to
 * explain why. The backend was complete the whole time; only the final call was missing.
 *
 * This walks the full governed path through the API — request → approve → activate — and asserts
 * the employee actually reaches ACTIVE, plus that the governance around it still holds.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" };

test("request → approve → activate actually reaches ACTIVE", async ({ request }) => {
  const list = await request.get("/api/ai/employees", { headers: MP });
  expect(list.ok()).toBeTruthy();
  const employees = (await list.json()).employees as Array<{ id: string; name: string; status: string }>;
  const target = employees.find((e) => e.status === "INACTIVE");
  test.skip(!target, "no INACTIVE employee available in this fixture");

  // 1 · Request activation — creates the approval card.
  const req = await request.post(`/api/ai/employees/${target!.id}/request-activation`, {
    headers: MP,
    data: { reason: "p28 chain test" },
  });
  expect(req.status()).toBe(201);
  const card = await req.json();
  expect(card.action_key).toBe("ai_employee.activate");
  expect(card.object_id).toBe(target!.id);

  // 2 · Activation MUST refuse before approval — the receipt is not yet approved.
  const premature = await request.post(`/api/ai/employees/${target!.id}/activate`, {
    headers: MP,
    data: { approval_receipt_id: card.id, reason: "premature" },
  });
  expect(premature.status(), "activation must refuse an unapproved receipt").not.toBe(200);

  // 3 · A Managing Partner approves.
  const decide = await request.post(`/api/approvals/${card.id}/decide`, {
    headers: MP,
    data: { decision: "approved", note: "p28" },
  });
  expect(decide.ok()).toBeTruthy();

  // 4 · Now activation succeeds — the link that was missing.
  const activate = await request.post(`/api/ai/employees/${target!.id}/activate`, {
    headers: MP,
    data: { approval_receipt_id: card.id, reason: "p28 chain test" },
  });
  expect(activate.status(), await activate.text()).toBe(200);
  expect((await activate.json()).status).toBe("ACTIVE");

  // 5 · And it is genuinely ACTIVE when read back, not just in the response.
  const after = await request.get(`/api/ai/employees/${target!.id}`, { headers: MP });
  expect((await after.json()).employee?.status ?? (await after.json()).status).toBe("ACTIVE");
});

test("activation still refuses without any receipt", async ({ request }) => {
  const list = await request.get("/api/ai/employees", { headers: MP });
  const employees = (await list.json()).employees as Array<{ id: string; status: string }>;
  const target = employees.find((e) => e.status === "INACTIVE");
  test.skip(!target, "no INACTIVE employee available");

  // The fix must not have weakened the gate: no receipt, no activation.
  const res = await request.post(`/api/ai/employees/${target!.id}/activate`, {
    headers: MP,
    data: { reason: "no receipt" },
  });
  expect(res.status()).not.toBe(200);
  expect(await res.text()).toMatch(/approval|receipt|forbidden/i);
});

test("the UI exposes the completion step — the actual regression", async ({ page, request }) => {
  // The API chain above always worked. What was missing was any control in the interface that
  // called it, so this asserts the button exists, appears only once a receipt is approved, and
  // actually drives the employee to ACTIVE from the browser.
  const list = await request.get("/api/ai/employees", { headers: MP });
  const employees = (await list.json()).employees as Array<{ id: string; name: string; status: string }>;
  const target = employees.find((e) => e.status === "INACTIVE");
  test.skip(!target, "no INACTIVE employee available");

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId(`employee-open-${target!.id}`).click().catch(() => {});
  const activate = page.getByTestId(`employee-activate-${target!.id}`);

  // Before any approved receipt exists, the completion control must NOT be offered.
  await expect(activate).toHaveCount(0);

  // Create and approve a receipt out of band, then reload.
  const card = await (
    await request.post(`/api/ai/employees/${target!.id}/request-activation`, {
      headers: MP,
      data: { reason: "p28 ui" },
    })
  ).json();
  await request.post(`/api/approvals/${card.id}/decide`, {
    headers: MP,
    data: { decision: "approved", note: "p28 ui" },
  });

  await page.reload();
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId(`employee-open-${target!.id}`).click().catch(() => {});

  // Now the completion step is offered, and it works.
  await expect(activate).toBeVisible();
  await activate.click();
  await expect(page.getByTestId(`employee-detail-${target!.id}`)).toContainText("ACTIVE");
});

test("the employees page shows who is active and makes the opened record obvious", async ({ page, request }) => {
  const list = await request.get("/api/ai/employees", { headers: MP });
  const employees = (await list.json()).employees as Array<{ id: string; status: string }>;
  const someone = employees[0]!;

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await page.getByRole("button", { name: "Employees", exact: true }).click();

  // Active vs not is stated in words, not only in colour.
  await expect(page.getByTestId("lounge-status-summary")).toContainText("active");

  // The filter narrows to actives only, and every visible card really is ACTIVE.
  await page.getByTestId("lounge-status-filter").selectOption("ACTIVE");
  const cards = page.locator('[data-testid^="employee-card-"]');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    await expect(cards.nth(i)).toHaveAttribute("data-status", "ACTIVE");
  }

  // Opening a record reveals the anchor, says where you are, and marks the card open.
  await page.getByTestId("lounge-status-filter").selectOption("ALL");
  await page.getByTestId(`employee-open-${someone.id}`).click();
  const anchor = page.getByTestId("employee-detail-anchor");
  await expect(anchor).toBeVisible();
  await expect(anchor).toContainText("This is the record you opened");
  await expect(page.getByTestId(`employee-card-${someone.id}`)).toHaveAttribute("data-open", "true");
  await expect(page.getByTestId(`employee-open-${someone.id}`)).toHaveAttribute("aria-expanded", "true");

  // And it can be closed again.
  await page.getByTestId("employee-detail-close").click();
  await expect(anchor).toHaveCount(0);
});
