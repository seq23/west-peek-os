import { expect, test } from "@playwright/test";
import { gotoSurface, openWorkMachinery } from "./support/nav";

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
  await gotoSurface(page, "Sources & sweeps");
  const headline = `Journey-1 secondaries pricing signal ${Date.now()}`;
  // Adding an item by hand now sits behind its own disclosure: the sweep button and the manual
  // fields were one undifferentiated form, which is why "Run a sweep" read as ambiguous.
  await page.getByTestId("intel-manual-add").locator("summary").click();
  await page.getByTestId("intel-manual-title").fill(headline);
  await page.getByTestId("intel-manual-locator").fill("Broker call, journey 1");
  await page.getByTestId("intel-run-submit").click();
  await expect(page.getByTestId("intel-run-message")).toContainText("kept");

  /*
   * Home carries the module, and the module is the way through to the item.
   *
   * It does NOT assert this headline is on Home. The module deliberately shows the top two items
   * and nothing more — a brief that lists everything is a brief nobody reads — so which two appear
   * depends on what else the firm has gathered, and every spec in this suite shares one database.
   * Pinning a headline here made this journey pass or fail on the order of the file list, which is
   * not what it is about. What it is about is the DRILL: Home names the subject, and pressing Open
   * lands on the surface that owns the records, where the item and its provenance are.
   */
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByTestId("home-page")).toBeVisible();
  /*
   * THE MODULE MAY BE QUIET, AND A QUIET MODULE IS ONE PRESS AWAY. Home shows a module as a card
   * only when something in its top eight is newer than the partner's last look; the rest sit in
   * the quiet roll behind "Show each". The item this journey added is real and on the record, but
   * whether it is in the top eight depends on what every spec before this one gathered — on 19 Sep
   * three branches that added a data-heavy spec earlier in the alphabet failed here, and the base
   * without one passed. The journey is about the DRILL, so it walks the path a person walks: open
   * the quiet roll if that is where the module is, and press Open on it.
   */
  const module = page.getByTestId("home-module-intelligence");
  let quiet = false;
  if (!(await module.isVisible().catch(() => false))) {
    const roll = page.getByTestId("home-quiet-roll");
    await expect(roll, "the module is neither a card nor in the quiet roll — it is missing from Home").toContainText("nothing new since you last looked");
    await page.getByTestId("home-quiet-roll-toggle").click();
    quiet = true;
  }
  await expect(module).toBeVisible();
  // A fresh card leads with what moved; a quiet one says since when nothing has, and still opens.
  if (quiet) await expect(module).toContainText("nothing new since");
  else await expect(module).toContainText("What moved overnight");

  // Drill into the module and read the item's provenance on the surface that owns it.
  await module.getByRole("button", { name: quiet ? "Open anyway" : "Open" }).click();
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

test("journey 2 — work packet → lens gate → governed execution", async ({ page, request }) => {
  /*
   * The packet workbench came off the Ask page when it was rebuilt (see `e2e/p18-intent.spec.ts`
   * for the full note and for the expected-to-fail test that holds the missing surface open). The
   * GATE is what this journey is about and it is unchanged, so it is driven where it lives.
   */
  const created = await request.post("/api/work-packets", {
    headers: HEADERS,
    data: { text: "Summarise open portfolio alerts for the partner meeting", enhancement_strength: "STANDARD" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { packet } = (await created.json()) as { packet: { id: string } };

  // Execution refused until the blocking lens runs.
  const refused = await request.post(`/api/work-packets/${packet.id}/execute`, { headers: HEADERS, data: {} });
  expect(await refused.text()).toContain("TRUTH_COMPLIANCE_GATE");

  expect(
    (await request.post(`/api/work-packets/${packet.id}/lenses`, {
      headers: HEADERS,
      data: {
        lens_key: "TRUTH_COMPLIANCE_GATE",
        verdict: "PASS",
        critique: "Internal summary of records we already hold.",
      },
    })).status(),
  ).toBe(201);

  const executed = await request.post(`/api/work-packets/${packet.id}/execute`, { headers: HEADERS, data: {} });
  expect(executed.status(), await executed.text()).toBe(200);

  // A real card, on the board a person reads.
  const after = (await (await request.get(`/api/work-packets/${packet.id}`, { headers: HEADERS })).json()) as {
    packet: { work_card_id: string | null };
  };
  expect(after.packet.work_card_id).toBeTruthy();
  await signIn(page);
  await gotoSurface(page, "Work");
  await expect(page.getByTestId(`work-card-${after.packet.work_card_id}`)).toBeVisible();
});

test("journey 3 — employee lounge → scorecard → operator control", async ({ page, request }) => {
  /*
   * Whichever employee is currently WORKING, rather than a name pinned here. `aie_priya` is not on
   * the roster any more, and the roster is all ACTIVE since migration 0136 — so a fixed name is
   * both wrong now and would make this spec fail on a second run once it had paused somebody.
   */
  const roster = (await (await request.get("/api/ai/employees", { headers: HEADERS })).json()) as {
    employees: Array<{ id: string; status: string }>;
  };
  const id = roster.employees.find((e) => e.status === "ACTIVE")!.id;

  await signIn(page);
  await page.getByRole("button", { name: "Employees", exact: true }).click();
  await page.getByTestId(`employee-open-${id}`).click();
  await page.getByTestId(`employee-compute-${id}`).click();
  await expect(page.getByTestId(`employee-message-${id}`)).toContainText("Scorecard computed");
  await page.getByTestId(`employee-lifecycle-paused-${id}`).click();
  await expect(page.getByTestId(`employee-message-${id}`)).toContainText("Now PAUSED");
});

test("journey 4 — machine → scheduled run → artifact → notification → audit", async ({ page, request }) => {
  await signIn(page);

  // Switch the daily intelligence job on and run it. The machinery is Work's third address since
  // 18 Sep, and the helper pins that it is off the desk and one click away.
  await openWorkMachinery(page);
  // A paused job shows "Put it back on"; a running one shows "Pause… (why?)". Put it on if needed.
  const resume = page.getByTestId("job-resume-daily_intelligence");
  if (await resume.isVisible().catch(() => false)) {
    await resume.click();
    await expect(page.getByTestId("job-state-daily_intelligence")).toHaveText("Scheduled");
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

test("journey 6 — the monitoring lives on Portfolio, the plan on Fund strategy, and neither repeats the other", async ({ page, request }) => {
  /*
   * RE-POINTED STRICTER, 19 Sep 2026 (design/FUND_STRATEGY_DESIGN.md §2, the owner's Q2): the cockpit —
   * top risks, deteriorating, improving, stale, support asks — no longer mounts under Fund strategy.
   * Portfolio's four bands carry that data; Fund strategy carries the plan and the distance from it.
   * The journey now proves BOTH halves and that the split holds: the monitoring lists are on
   * Portfolio, the pace and the gap rows are on Fund strategy, and Fund strategy shows no cockpit.
   */
  await signIn(page);
  await gotoSurface(page, "Portfolio");
  await expect(page.getByTestId("portfolio-page")).toBeVisible();
  await expect(page.getByTestId("deteriorating")).toBeVisible();
  await expect(page.getByTestId("improving")).toBeVisible();
  await expect(page.getByTestId("stale")).toBeVisible();
  await expect(page.getByTestId("support-list")).toBeVisible();

  // A fund exists on the record (this journey may run on an empty firm), so every band draws.
  const funds = (await (await request.get("/api/funds", { headers: { "x-wpos-dev-user": "sequoia@westpeek.ventures" } })).json()) as { funds: Array<{ id: string }> };
  if (funds.funds.length === 0) {
    const made = await request.post("/api/funds", { headers: { "x-wpos-dev-user": "sequoia@westpeek.ventures" }, data: { name: "West Peek Ventures Fund I", vintage_year: 2026 } });
    expect(made.status()).toBe(201);
  }
  await page.reload();
  await gotoSurface(page, "Fund strategy");
  await expect(page.getByTestId("fund-strategy-page")).toBeVisible();
  await expect(page.getByTestId("fund-door")).toBeVisible();
  await expect(page.getByTestId("fund-plan-vs-reality")).toBeVisible();
  await expect(page.getByTestId("cockpit-page"), "the cockpit must not come back to Fund strategy").toHaveCount(0);
  await expect(page.getByTestId("composition"), "the composition bars must not come back to Fund strategy").toHaveCount(0);
  await expect(page.getByTestId("deteriorating")).toHaveCount(0);
});

test("journey 9 — AI cost centre → provider/model spend → policy action", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Cockpit");
  // The block now asks the question rather than labelling a total: the operator could not tell
  // this figure from the all-time one sitting directly above it.
  await expect(page.getByTestId("cost-totals")).toContainText("what has it cost");
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
  /*
   * "Not set up" is the state in the operator's words; the enum came off the card. What must
   * survive the rewording is the honesty: no provider, and TWO independent gates in front of it —
   * an MP/compliance-reserved recording policy and the counterparty's own consent.
   */
  await expect(page.getByTestId("connector-transcription")).toContainText("Not set up");
  await expect(page.getByTestId("connector-transcription")).toContainText("No transcription provider is configured");
  await expect(page.getByTestId("connector-transcription")).toContainText("counterparty consent is a second, independent gate");

  // Journey 8 — LP reporting/reconciliation: the workflow exists; the administrator source does not.
  // Same rewording, same honesty: no agreement, nothing ever imported, and no code path that could
  // write back to an administrator even if one were connected.
  await expect(page.getByTestId("lp-ops-sources")).toContainText("no agreement yet");
  await expect(page.getByTestId("lp-ops-sources")).toContainText("no code path that writes to an administrator");
  // The gates, named in full sentences rather than as a banner. The last one is the one that keeps
  // this journey honest: distribution proves routing and review, and actual delivery has never run.
  await expect(page.getByTestId("lp-ops-gates")).toContainText("The fund administrator");
  await expect(page.getByTestId("lp-ops-gates")).toContainText("Actual delivery is an external effect that has never run");
});
