import { expect, test } from "@playwright/test";
import { provisionLocalD1, queryLocalD1 } from "./support/provision";
import { kindDef } from "../src/shared/deliverables/deliverable";

/**
 * P70 — Walker's weekly hire search lands on Scooter's Home, and he marks a candidate there
 * (16 Sep 2026).
 *
 * The runner itself is unit-proven (tests/productionsHire.test.ts; the local server has no search
 * model). This is the rendering and the answer: a `productions_hire_search` deliverable with two
 * candidate rows behind it is on Scooter's Home under Walker's name; opening it shows the
 * candidates with Contacted / Pass; pressing Contacted writes the status the next week's search
 * reads. Sequoia's Home does not carry it (it is prepared for Scooter) and the candidate list
 * answers only to him.
 */

const SCOOTER = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const SEQUOIA = { "x-wpos-dev-user": "sequoia@westpeek.ventures" };

test("the hire-search note renders on Scooter's Home with its candidates, and Contacted sticks", async ({ page, request }) => {
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

  // The candidates behind the note, with the two verbs.
  const panel = page.getByTestId(`hire-candidates-${dlvId}`);
  await expect(panel).toBeVisible();
  await expect(page.getByTestId(`hire-candidate-status-pcd_${marker}_a`)).toHaveText("new this week");
  await expect(page.getByTestId(`hire-candidate-status-pcd_${marker}_b`)).toHaveText("seen before");
  await page.getByTestId(`hire-candidate-contacted-pcd_${marker}_a`).click();
  await expect(page.getByTestId("hire-candidates-message")).toContainText("Jordan Example marked contacted");
  await expect(page.getByTestId(`hire-candidate-status-pcd_${marker}_a`)).toHaveText("contacted");
  await expect(page.getByTestId(`hire-candidate-undo-pcd_${marker}_a`)).toBeVisible();

  const stored = queryLocalD1<{ status: string; status_changed_by: string }>(`SELECT status, status_changed_by FROM productions_candidate WHERE id = 'pcd_${marker}_a'`);
  expect(stored[0]).toEqual({ status: "CONTACTED", status_changed_by: "fu_scooter_taylor" });

  // The list is his: Sequoia gets a 404, and her own Home (mine=1) does not carry the note.
  expect((await request.get(`/api/productions/candidates?deliverable=${dlvId}`, { headers: SEQUOIA })).status()).toBe(404);
  expect((await request.get(`/api/productions/candidates?deliverable=${dlvId}`, { headers: SCOOTER })).status()).toBe(200);
  const hers = (await (await request.get("/api/deliverables?kind=productions_hire_search&mine=1", { headers: SEQUOIA })).json()) as { deliverables: Array<{ id: string }> };
  expect(hers.deliverables.some((d) => d.id === dlvId)).toBe(false);
});
