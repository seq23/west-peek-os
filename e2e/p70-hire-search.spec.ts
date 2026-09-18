import { expect, test } from "@playwright/test";
import { provisionLocalD1, queryLocalD1 } from "./support/provision";
import { openWorkMachinery } from "./support/nav";
import { kindDef } from "../src/shared/deliverables/deliverable";

/**
 * P70 — Walker's weekly hire search lands on Scooter's Home, and he marks a candidate there
 * (16 Sep 2026).
 *
 * The runner itself is unit-proven (tests/productionsHire.test.ts; the local server has no search
 * model). This is the rendering and the answer: a `productions_hire_search` deliverable with two
 * candidate rows behind it is on Scooter's Home under Walker's name, and opening it shows the
 * candidates with their pages. Sequoia's Home does not carry it (it is prepared for Scooter) and
 * the candidate list answers only to him.
 *
 * ─── WHAT THIS JOURNEY USED TO PROVE, AND WHY IT NOW PROVES THE OPPOSITE (17 Sep 2026) ────────
 *
 * It used to press Contacted and assert the status stuck. Operator: "i really dont think we should
 * give him extra work if he likes one he will reach out with the sample draft intro language walker
 * creates." The two buttons and the route behind them are gone — removed rather than hidden,
 * because an endpoint that still wrote a status no reader reports would silently change what next
 * week's search returns.
 *
 * So the assertions are inverted and WIDENED rather than deleted. It is not enough that the buttons
 * are absent from this panel: nothing anywhere on the page may offer a way to mark a candidate, the
 * route must 404 in the browser's own session, and the row must be unchanged afterwards. A journey
 * that merely stopped clicking would pass against a UI that still had the buttons one screen over.
 */

const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

test("the hire-search note renders on Scooter's Home with its candidates, and there is nothing for him to mark", async ({ page, request }) => {
  const marker = `e2e-p70-${Date.now()}`;
  const cardId = `wc_${marker}`;
  const dlvId = `dlv_${marker}`;
  provisionLocalD1(
    [
      `INSERT INTO work_card (id, title, description, owner_type, owner_id, state, priority, kind, firm_scope, created_by) VALUES ('${cardId}', 'Walker: West Peek Productions hire search (2026-W38 ${marker})', 'e2e', 'AI', 'aie_walker', 'DONE', 'NORMAL', 'PRODUCTIONS_HIRE_SEARCH', 'west-peek', 'system:work_sweep');`,
      `INSERT INTO deliverable (id, kind, title, body, prepared_by, prepared_for, source_type, source_id, privacy_label, firm_scope) VALUES ('${dlvId}', 'productions_hire_search', 'Hire search 2026-W38: 2 candidate(s) for senior experiential producer, freelance ${marker}', '1. Jordan Example — Senior Experiential Producer (freelance) · fit 9/10', 'Walker', 'fu_scooter_taylor', 'work_card', '${cardId}', 'INTERNAL', 'west-peek');`,
      `INSERT INTO productions_candidate (id, url, name, title, company, city, evidence_url, why, opening_line, fit_score, week, last_card_id, status) VALUES ('pcd_${marker}_a', 'https://example.org/${marker}/jordan', 'Jordan Example', 'Senior Experiential Producer (freelance)', 'Independent', 'Brooklyn, NY', 'https://agency.example/team/jordan', 'why', 'line', 9, '2026-W38', '${cardId}', 'NEW');`,
      `INSERT INTO productions_candidate (id, url, name, title, company, city, evidence_url, why, opening_line, fit_score, week, last_card_id, status) VALUES ('pcd_${marker}_b', 'https://example.org/${marker}/sam', 'Sam Sample', 'Executive Producer', 'Freelance', 'Los Angeles, CA', NULL, 'why', 'line', 8, '2026-W38', '${cardId}', 'SEEN');`,
    ].join("\n"),
  );

  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await expect(page.getByTestId("home-page")).toBeVisible();

  const row = page.getByTestId(`deliverable-${dlvId}`);
  await expect(row, "on his Home under Walker").toBeVisible();
  await expect(row.locator(".owner-chip")).toContainText("Walker");
  await expect(row.locator(".badge").first()).toHaveText(kindDef("productions_hire_search")!.label);
  await row.getByTestId(`deliverable-open-${dlvId}`).click();
  await expect(row.locator(".deliverable-body")).toContainText("Jordan Example");

  // The candidates behind the note — as information, with nothing to maintain.
  const panel = page.getByTestId(`hire-candidates-${dlvId}`);
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId(`hire-candidate-pcd_${marker}_a`)).toContainText("Jordan Example");
  await expect(panel.getByTestId(`hire-candidate-pcd_${marker}_b`)).toContainText("Sam Sample");
  await expect(panel.getByTestId("hire-candidates-no-upkeep")).toContainText("Nothing to mark here");
  await expect(panel.getByTestId("hire-candidates-no-upkeep")).toContainText("reply to Walker");
  // What he is shown instead of a status: when the name first appeared, which needs no upkeep.
  await expect(panel.getByTestId(`hire-candidate-first-seen-pcd_${marker}_a`)).toContainText("first seen");

  // NOT ANYWHERE ON THE PAGE, not merely not in this panel.
  for (const gone of ["Contacted", "Pass", "Passed", "Put back"]) {
    await expect(page.getByRole("button", { name: gone, exact: true }), `"${gone}" is not a button any more`).toHaveCount(0);
  }
  await expect(page.getByTestId(`hire-candidate-contacted-pcd_${marker}_a`)).toHaveCount(0);
  await expect(page.getByTestId(`hire-candidate-passed-pcd_${marker}_a`)).toHaveCount(0);
  await expect(page.getByTestId(`hire-candidate-status-pcd_${marker}_a`)).toHaveCount(0);

  /*
   * And the route behind them is gone — asked AS SCOOTER, the one person it ever answered, so a 404
   * here means the route does not exist rather than that the caller was refused. (Asked without
   * credentials it would 401, which proves nothing about whether the route is still there.)
   */
  const marked = await request.post(`/api/productions/candidates/pcd_${marker}_a/status`, { headers: SCOOTER, data: { status: "CONTACTED" } });
  expect(marked.status(), "the marking route must not exist").toBe(404);
  const stored = queryLocalD1<{ status: string; status_changed_by: string | null }>(`SELECT status, status_changed_by FROM productions_candidate WHERE id = 'pcd_${marker}_a'`);
  expect(stored[0], "nothing changed the row").toEqual({ status: "NEW", status_changed_by: null });

  // The list is his: Sequoia gets a 404, and her own Home (mine=1) does not carry the note.
  expect((await request.get(`/api/productions/candidates?deliverable=${dlvId}`, { headers: SEQUOIA })).status()).toBe(404);
  expect((await request.get(`/api/productions/candidates?deliverable=${dlvId}`, { headers: SCOOTER })).status()).toBe(200);
  const hers = (await (await request.get("/api/deliverables?kind=productions_hire_search&mine=1", { headers: SEQUOIA })).json()) as { deliverables: Array<{ id: string }> };
  expect(hers.deliverables.some((d) => d.id === dlvId)).toBe(false);
});

/**
 * And the way she actually runs one: a button on Work, next to the job.
 *
 * WHY THIS JOURNEY EXISTS. Production is behind Cloudflare Access, so without a control on a page
 * she is already signed in to, "preview it" means fetching an Access token and composing a curl
 * line — which is the owner doing a task a machine could do. A route with no door is also this
 * repo's "exists but nothing invokes it" defect wearing a different hat.
 *
 * It does NOT press the button: the preview does the real work, and the local server has no search
 * model. What is proven is that the door is there, on the right jobs and not on the others, and
 * that it says what it costs and where it goes before anybody presses it.
 */
test("a partner can ask for a preview from the Work page, on the jobs that have something to preview", async ({ page }) => {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("sequoia@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Sequoia Taylor");

  await openWorkMachinery(page);
  const button = page.getByTestId("job-preview-productions_hire_search");
  await expect(button, "the hire search can be previewed").toBeVisible();
  await expect(button).toHaveText("Preview it to me");
  await expect(button).toHaveAttribute("title", /emails the result to sequoia@westpeek\.ventures only/);
  await expect(button).toHaveAttribute("title", /Nothing is filed and the scheduled run is untouched/);

  // NOT offered where there is no deliverable to preview — a button that answers "not previewable"
  // is worse than no button.
  await expect(page.getByTestId("job-preview-employee_work_sweep")).toHaveCount(0);
  await expect(page.getByTestId("job-preview-daily_intelligence")).toHaveCount(0);
  // The scheduled run's own control is still there and is still the primary one.
  await expect(page.getByTestId("job-run-productions_hire_search")).toBeVisible();
});
