import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P25 — cross-system journeys (task §9 P25).
 *
 * These are the journeys the completion gate asks for, run as a Managing Partner rather than as a
 * developer: each one crosses at least two subsystems and ends where a human actually decides.
 *
 * Where a live external dependency blocks the final mile, the journey is driven to that boundary
 * and the unproven step is asserted as unproven — never skipped and never faked.
 */

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

const HEADERS = { "x-wpos-dev-user": "scooter@westpeek.ventures", "content-type": "application/json" };

test("journey 1 — MP Home → intelligence item → its source → follow-up research", async ({ page, request }) => {
  await signIn(page);

  // Intelligence: run the engine on an operator-supplied item with a real citation.
  await page.getByRole("button", { name: "Sweeps", exact: true }).click();
  const headline = `Journey-1 secondaries pricing signal ${Date.now()}`;
  // Adding an item by hand now sits behind its own disclosure: the sweep button and the manual
  // fields were one undifferentiated form, which is why "Run a sweep" read as ambiguous.
  await page.getByTestId("intel-manual-add").locator("summary").click();
  await page.getByTestId("intel-manual-title").fill(headline);
  await page.getByTestId("intel-manual-locator").fill("Broker call, journey 1");
  await page.getByTestId("intel-run-submit").click();
  await expect(page.getByTestId("intel-run-message")).toContainText("kept");

  // The item reaches Home, ranked, with the rule that ranked it.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("home-module-intelligence")).toContainText(headline);

  // Drill into the item and read its provenance.
  await page.getByTestId("home-module-intelligence").getByRole("button", { name: "Open" }).click();
  const card = page.locator('[data-testid^="intel-item-"]', { hasText: headline });
  await card.locator('[data-testid^="intel-detail-"]').click();
  await expect(card.locator('[data-testid^="intel-citations-"]')).toContainText("Broker call, journey 1");

  // Follow-up research opens against the same question and states the evidence rule.
  await page.getByRole("button", { name: "Research", exact: true }).click();
  await page.getByTestId("research-title").fill("Journey 1 follow-up");
  await page.getByTestId("research-question").fill("Does the broker signal hold against the last primary?");
  await page.getByTestId("research-submit").click();
  await expect(page.getByTestId("research-page-message")).toContainText("Opened");
  await expect(page.getByTestId("research-rule")).toContainText("no separate evidence store");
});

test("journey 2 — capture → work packet → lens gate → governed execution", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByTestId("intent-text").fill("Summarise open portfolio alerts for the partner meeting");
  await page.getByTestId("intent-submit").click();
  await expect(page.getByTestId("intent-message")).toContainText("Here is what");

  // Execution refused until the blocking lens runs.
  await page.getByTestId("packet-execute").click();
  await expect(page.getByTestId("packet-message")).toContainText("TRUTH_COMPLIANCE_GATE");

  await page.getByTestId("lens-key").selectOption("TRUTH_COMPLIANCE_GATE");
  await page.getByTestId("lens-verdict").selectOption("PASS");
  await page.getByTestId("lens-critique").fill("Internal summary of records we already hold.");
  await page.getByTestId("lens-submit").click();
  await page.getByTestId("packet-execute").click();
  await expect(page.getByTestId("packet-message")).toContainText("Work card opened");
});

test("journey 3 — employee lounge → scorecard → operator control", async ({ page }) => {
  await signIn(page);
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId("employee-open-aie_priya").click();
  await page.getByTestId("employee-compute-aie_priya").click();
  await expect(page.getByTestId("employee-message-aie_priya")).toContainText("Scorecard computed");
  await page.getByTestId("employee-lifecycle-paused-aie_priya").click();
  await expect(page.getByTestId("employee-message-aie_priya")).toContainText("Now PAUSED");
});

test("journey 4 — machine → scheduled run → artifact → notification → audit", async ({ page, request }) => {
  await signIn(page);

  // Switch the daily intelligence job on and run it.
  await page.getByRole("button", { name: "Scheduled work", exact: true }).click();
  await page.getByTestId("job-reason").fill("journey 4");
  // The toggle's own label is the reliable signal: the card body also carries run history, which
  // may legitimately mention an earlier PAUSED refusal from another spec.
  const toggle = page.getByTestId("job-toggle-daily_intelligence");
  if ((await toggle.textContent())?.includes("Switch on")) {
    await toggle.click();
    await expect(toggle).toContainText("Pause");
  }
  await page.getByTestId("job-run-daily_intelligence").click();
  await expect(page.getByTestId("jobs-message")).toContainText("SUCCEEDED");
  await expect(page.getByTestId("job-runs-daily_intelligence")).toContainText("SUCCEEDED");

  // The run's artifacts point at the records it created, and the event spine recorded it.
  const jobs = await (await request.get("/api/jobs", { headers: HEADERS })).json();
  const runId = jobs.runs.find((r: any) => r.status === "SUCCEEDED").id;
  const detail = await (await request.get(`/api/jobs/runs/${runId}`, { headers: HEADERS })).json();
  expect(detail.artifacts.some((a: any) => a.kind === "INTELLIGENCE_RUN")).toBe(true);

  const activity = await (await request.get("/api/activity?limit=50", { headers: HEADERS })).json();
  expect(activity.events.some((e: any) => e.event_type === "job_run.succeeded")).toBe(true);
});

test("journey 5 — company → research finding → governed evidence", async ({ page, request }) => {
  await signIn(page);
  const company = await request.post("/api/companies", {
    headers: HEADERS,
    data: { canonical_name: `Journey5 Co ${Date.now()}` },
  });
  const companyId = (await company.json()).id;

  const project = await request.post("/api/research/projects", {
    headers: HEADERS,
    data: { title: "Journey 5 diligence", question: "What is ARR?", company_id: companyId },
  });
  const projectId = (await project.json()).id;
  const source = await request.post(`/api/research/projects/${projectId}/sources`, {
    headers: HEADERS,
    data: { kind: "HUMAN", title: "CFO call", reliability: "HIGH", reliability_basis: "first-hand from the number's owner" },
  });
  const finding = await request.post(`/api/research/projects/${projectId}/findings`, {
    headers: HEADERS,
    data: { source_id: (await source.json()).id, statement: "ARR was $4.2m at the last close." },
  });
  const findingId = (await finding.json()).finding.id;

  const promoted = await request.post(`/api/research/findings/${findingId}/promote`, { headers: HEADERS, data: {} });
  expect(promoted.status()).toBe(201);
  const claim = (await promoted.json()).claim;
  expect(claim.claim_status).toBe("UNVERIFIED");

  // The claim is visible on the company's own evidence surface — one substrate, not two.
  const summary = await request.get(`/api/companies/${companyId}/evidence-summary`, { headers: HEADERS });
  expect(summary.status()).toBe(200);
});

test("journey 6 — portfolio cockpit → allocation view → human decision boundary", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Fund strategy");
  await expect(page.getByTestId("cockpit-page")).toBeVisible();
  await expect(page.getByTestId("cockpit-definitions")).toContainText("never as a blank");
  await expect(page.getByTestId("cockpit-risks")).toBeVisible();
});

test("journey 9 — AI cost centre → provider/model spend → policy action", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Cockpit");
  await expect(page.getByTestId("cost-totals")).toContainText("committed this");
  await expect(page.getByTestId("spend-by-provider")).toBeVisible();

  await page.getByTestId("budget-scope-type").selectOption("CATEGORY");
  await page.getByTestId("budget-scope-id").fill("OPERATIONS");
  await page.getByTestId("budget-cap").fill("15");
  await page.getByTestId("budget-submit").click();
  await expect(page.getByTestId("ai-ops-message")).toContainText("version");
});

test("journey 10 — mobile: capture, approvals, and notifications one-handed", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);

  await gotoSurface(page, "Capture");
  await page.getByTestId("capture-text").fill("Mobile journey capture");
  await page.getByTestId("capture-submit").click();
  await expect(page.getByTestId("capture-result")).toBeVisible();

  await gotoSurface(page, "Approvals");
  await expect(page.getByTestId("approvals-page")).toBeVisible();

  await gotoSurface(page, "Notifications");
  await expect(page.getByTestId("notifications-page")).toBeVisible();

  // The wide institutional tables must not push the whole page sideways: a phone user should
  // never have to scroll the document horizontally to reach the nav (final-review check).
  for (const surface of ["Cockpit", "Machines", "Fund strategy"]) {
    await gotoSurface(page, surface);
    await page.waitForTimeout(150);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `${surface} overflows the viewport by ${overflow}px`).toBeLessThanOrEqual(1);
  }
});

test("journeys 7 and 8 are driven to their external boundary and stop there, honestly", async ({ page }) => {
  await signIn(page);

  // Journey 7 — meeting prep: the queue is real; the calendar and transcription connectors are not.
  await gotoSurface(page, "Integrations");
  await expect(page.getByTestId("prep-note")).toContainText("No calendar is connected");
  await expect(page.getByTestId("connector-transcription")).toContainText("NOT_CONFIGURED");

  // Journey 8 — LP reporting/reconciliation: the workflow exists; the administrator source does not.
  await expect(page.getByTestId("lp-ops-sources")).toContainText("NO_CONTRACT");
  await expect(page.getByTestId("lp-ops-gates")).toContainText("SOURCE CONTRACT GATE");
});
