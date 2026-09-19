import { expect, test } from "@playwright/test";
import { figuresOf, numbersIn, textOfDocx, textOfPptx } from "../src/shared/artifacts/render";

/**
 * Artifacts on demand (owner, 19 Sep 2026), against local `wrangler dev`:
 *
 * DOOR A · the room. Two table/chart blocks are on a meeting (saved the way the room saves them,
 * with their plans) → in the During face she types "make this a dashboard" → the answer is a LINK
 * BLOCK whose state is read from the artifact row (building → ready) → "Open it" opens the
 * artifact inside Documents: the dashboard renders its panels with their cites, Export .pptx and
 * Export .docx are live → the exports parse back to the figures the page shows → the row is on the
 * Documents shelf under the company, findable by title → nothing on the After face became a record.
 *
 * DOOR B · a work card. "Wyatt, build me a dashboard on <company>" is recognised as an ARTIFACT
 * card; working it hands it to the same producer. `wrangler dev --local` reaches no model, so her
 * words cannot be interpreted and the card stops — BLOCKED, with the reason in words and the doors
 * on it — which is the product rule (a chain that cannot read her words does not carry on), and
 * the artifact row behind it says the same. What reaches her when a model IS reachable is proven
 * in tests/artifacts.test.ts with the model seams.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("door A: 'make this a dashboard' in the room → link block → ready → opens under Documents → exports parse → on the shelf", async ({ page, request }) => {
  const marker = `E2E-ART-${Date.now()}`;
  // A company with a deal, and a meeting about it.
  const co = await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Sensori` } });
  expect(co.status(), await co.text()).toBe(201);
  const companyId = ((await co.json()) as { id: string }).id;
  const opp = await request.post("/api/opportunities", { headers: MP, data: { company_id: companyId, opportunity_type: "EARLY_STAGE_PRIMARY", title: `${marker} Series A` } });
  expect(opp.status(), await opp.text()).toBe(201);
  const created = await request.post("/api/meetings", { headers: MP, data: { title: `${marker} founder call`, meeting_type: "FOUNDER", company_id: companyId, scheduled_at: new Date(Date.now() + 3_600_000).toISOString() } });
  expect(created.status(), await created.text()).toBe(201);
  const meetingId = ((await created.json()) as { id: string }).id;

  // Two blocks, saved the way the room saves a query it answered: state OK, the plan on the body.
  for (const block of [
    { kind: "chart", title: "Deals by status", body: { state: "OK", answered_by: "Walter", chart: "bar", plan: { table: "investment_opportunity", group_by: "status", metric: { fn: "count" }, chart: "bar" } } },
    { kind: "table", title: "Companies on the record", body: { state: "OK", answered_by: "Walter", plan: { table: "canonical_company", select: ["canonical_name", "status"], limit: 10 } } },
  ]) {
    const saved = await request.post(`/api/meetings/${meetingId}/artifacts`, { headers: MP, data: block });
    expect(saved.status(), await saved.text()).toBe(201);
  }
  const afterBefore = (await (await request.get(`/api/meetings/${meetingId}/after`, { headers: MP })).json()) as { decisions: unknown[]; commitments: unknown[]; open_questions: unknown[] };

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await page.getByRole("button", { name: "Meetings", exact: true }).click();
  await page.getByTestId(`start-${meetingId}`).click();
  const room = page.getByTestId(`room-${meetingId}`);
  await expect(room).toBeVisible();

  // The ask. No model is consulted for this: the plans are the room's own blocks.
  await room.getByTestId("room-ask-input").fill("make this a dashboard");
  await room.getByTestId("room-ask-send").click();
  const block = room.locator('[data-testid^="room-artifact-mar_"][data-kind="artifact"]').first();
  await expect(block).toBeVisible({ timeout: 20_000 });
  const build = block.locator('[data-testid^="room-build-mar_"]');
  await expect
    .poll(async () => build.getAttribute("data-state"), { message: "the link block reads the build's state from the row until it is terminal", timeout: 30_000 })
    .toMatch(/^(REQUESTED|BUILDING|READY)$/);
  await expect.poll(async () => build.getAttribute("data-state"), { timeout: 30_000 }).toBe("READY");
  await expect(block.locator('[data-testid^="room-build-state-"]')).toContainText(/ready · v1 · \d+ rows? cited/);

  // The artifact is on the meeting AND on the company — never only on the meeting.
  const artifactsOnMeeting = (await (await request.get(`/api/artifacts?about=${meetingId}`, { headers: MP })).json()) as { artifacts: Array<{ id: string; kind: string; state: string; about: { company_id: string | null } }> };
  expect(artifactsOnMeeting.artifacts).toHaveLength(1);
  const artifactId = artifactsOnMeeting.artifacts[0]!.id;
  expect(artifactsOnMeeting.artifacts[0]).toMatchObject({ kind: "dashboard", state: "READY" });
  expect(artifactsOnMeeting.artifacts[0]!.about.company_id).toBe(companyId);
  const onCompany = (await (await request.get(`/api/artifacts?about=${companyId}`, { headers: MP })).json()) as { artifacts: Array<{ id: string }> };
  expect(onCompany.artifacts.map((a) => a.id)).toContain(artifactId);

  // Open it: the in-app render, inside Documents.
  await block.locator('[data-testid^="room-build-open-"]').click();
  const artifactPage = page.getByTestId("artifact-page");
  await expect(artifactPage).toBeVisible();
  await expect(artifactPage).toHaveAttribute("data-state", "READY");
  await expect(artifactPage).toHaveAttribute("data-kind", "dashboard");
  await expect(page.getByTestId("artifact-dashboard")).toBeVisible();
  await expect(page.getByTestId("artifact-panel-p1")).toBeVisible();
  await expect(page.getByTestId("artifact-panel-p2")).toBeVisible();
  await expect(page.getByTestId("artifact-panel-cites-p1")).toContainText(/cites \d+ record/);
  await expect(page.getByTestId("artifact-export-pptx")).toBeEnabled();
  await expect(page.getByTestId("artifact-export-docx")).toBeEnabled();
  await expect(page.getByTestId("artifact-refresh")).toBeEnabled();
  await expect(page.getByTestId("artifact-open-object")).toBeVisible();
  await expect(page.getByTestId("artifact-versions")).toContainText("v1");

  // The exports parse back to what the page shows: every number in the panels' tables is in the file.
  const pageNumbers = new Set(numbersIn(await page.getByTestId("artifact-dashboard").locator("table").allInnerTexts().then((t) => t.join(" "))));
  const pptx = await request.get(`/api/artifacts/${artifactId}/export.pptx`, { headers: MP });
  expect(pptx.status()).toBe(200);
  expect(pptx.headers()["content-type"]).toContain("presentationml");
  const slides = textOfPptx(new Uint8Array(await pptx.body()));
  expect(slides.length).toBeGreaterThanOrEqual(4);
  const pptxNumbers = new Set(figuresOf(slides.flat()));
  for (const n of pageNumbers) expect(pptxNumbers, `the .pptx is missing the figure ${n} the page shows`).toContain(n);
  const docx = await request.get(`/api/artifacts/${artifactId}/export.docx`, { headers: MP });
  expect(docx.status()).toBe(200);
  const docxNumbers = new Set(figuresOf(textOfDocx(new Uint8Array(await docx.body()))));
  for (const n of pageNumbers) expect(docxNumbers, `the .docx is missing the figure ${n} the page shows`).toContain(n);

  // Refresh: a new version; the old one stays.
  await page.getByTestId("artifact-refresh").click();
  await expect(page.getByTestId("artifact-versions")).toContainText("v2", { timeout: 20_000 });
  await expect(page.getByTestId("artifact-version-1")).toBeVisible();
  await expect(page.getByTestId("artifact-version-2")).toBeVisible();

  // Back to Documents: it is on the shelf under the company, and searchable by title.
  await page.getByTestId("artifact-back").click();
  await expect(page.getByTestId("built-on-demand")).toBeVisible();
  const group = page.getByTestId("built-on-demand-group").filter({ hasText: `${marker} Sensori` });
  await expect(group).toBeVisible();
  await expect(group.getByTestId(`artifact-row-${artifactId}`)).toContainText(/Dashboard/);
  await expect(group.getByTestId(`artifact-row-${artifactId}`)).toContainText(/built by Walter/);
  await page.getByTestId("artifact-search").fill("zzz-nothing-is-called-this");
  await expect(page.getByTestId("built-on-demand-empty")).toBeVisible();
  await page.getByTestId("artifact-search").fill("dashboard");
  await expect(page.getByTestId(`artifact-row-${artifactId}`)).toBeVisible();

  // NOTHING BECAME A RECORD. The After face is as it was.
  const afterNow = (await (await request.get(`/api/meetings/${meetingId}/after`, { headers: MP })).json()) as typeof afterBefore;
  expect(afterNow.decisions).toHaveLength(afterBefore.decisions.length);
  expect(afterNow.commitments).toHaveLength(afterBefore.commitments.length);
  expect(afterNow.open_questions).toHaveLength(afterBefore.open_questions.length);

  // At a phone width the page does not scroll sideways.
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto(`/#/documents/a/${artifactId}`);
  await expect(page.getByTestId("artifact-page")).toBeVisible();
  const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(wide, "the artifact page scrolls sideways at 375px").toBeLessThanOrEqual(1);
});

test("door B: 'Wyatt, build me a dashboard on <company>' is an ARTIFACT card; worked with no model reachable it stops and says why, and the card carries the artifact row", async ({ page, request }) => {
  const marker = `E2E-ARTCARD-${Date.now()}`;
  const co = await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Northwind` } });
  expect(co.status()).toBe(201);
  const companyId = ((await co.json()) as { id: string }).id;

  const card = await request.post("/api/work-cards", {
    headers: MP,
    data: { title: `${marker} dashboard`, owner_type: "AI", owner_id: "Wyatt", priority: "NORMAL", prompt: `Wyatt, build me a dashboard on ${marker} Northwind — the deals and the companies near it.` },
  });
  expect(card.status(), await card.text()).toBe(201);
  const cardId = ((await card.json()) as { id: string }).id;
  const read = (await (await request.get(`/api/work-cards/${cardId}`, { headers: MP })).json()) as { kind?: string | null; card?: { kind?: string | null } };
  expect(read.kind ?? read.card?.kind, "her words are recognised as an artifact build at the one place every card passes").toBe("ARTIFACT");

  // Work it. No model is reachable here: her words cannot be read, so the chain STOPS rather than
  // carrying on without them — a BLOCKED card with the reason in words.
  const worked = await request.post(`/api/work-cards/${cardId}/work`, { headers: MP });
  expect(worked.status(), await worked.text()).toBe(200);
  const outcome = (await worked.json()) as { finished: boolean; blocked: boolean; detail: string };
  expect(outcome.finished).toBe(false);
  expect(outcome.blocked).toBe(true);
  expect(outcome.detail.length).toBeGreaterThan(15);

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await page.getByRole("button", { name: "Work", exact: true }).click();
  const row = page.getByTestId(`work-card-artifact-${cardId}`);
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText("What it builds");
  // The block on the card says why it stopped, in words she can act on.
  await expect(page.getByTestId(`work-card-block-${cardId}`)).toBeVisible();
  // No artifact was invented while her words could not be read; the row says so rather than lying.
  const built = (await (await request.get(`/api/artifacts?card=${cardId}`, { headers: MP })).json()) as { artifacts: unknown[] };
  expect(built.artifacts).toHaveLength(0);
  await expect(row.getByTestId(`work-card-artifact-rows-${cardId}-empty`)).toBeVisible();
  expect(companyId).toBeTruthy();
});
