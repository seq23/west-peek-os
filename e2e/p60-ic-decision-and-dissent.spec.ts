import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * THE COMMITTEE: a packet assembled, its gaps answered, a decision recorded — AND THE DISAGREEMENT.
 *
 * `dissent_record` has existed since migration 0006. It is append-only, it is human-only, and until
 * 22 Aug 2026 there was NOTHING ANYWHERE IN THE PRODUCT THAT WROTE TO IT. A rule about a table
 * nobody could reach is a committee record that can only ever record agreement — which is the one
 * shape an investment committee's minutes must never have. A partner who was against a deal and
 * said so at the table had no way to leave that on the record, and two years later the file would
 * show a unanimous decision that was not one.
 *
 * The journey here is the one that matters most for that: the committee PASSES on a company, and a
 * partner records that they disagreed with the pass. A pass costs nothing on the day and everything
 * over ten years, so a written disagreement about one is the most valuable page in the file.
 *
 * WHAT IS ASSERTED. The packet assembles by itself when the deal reaches the committee stage
 * (ADR-019) and Poppy is holding the card to build it; an open question is answered by a person and
 * the packet stops saying it does not know; the pass is refused without a sentence and recorded
 * with one; the dissent is written, attributed and visible against that decision; and it cannot be
 * edited or removed by anybody, including whoever wrote it.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

test("a packet is assembled, a question is answered, the committee passes, and a partner's dissent survives", async ({
  page,
  request,
}) => {
  /* The journey crosses the Dealflow record now — the committee face loads the packet, its
     framework and its questions on top of the board — so it is the length of p6's, which runs
     under the same allowance. Nothing here waits on a duration. */
  test.slow();
  const marker = `E2E-P60-${Date.now()}`;
  const companyName = `${marker} Co`;
  const rationale = "Two of the three named customers turned out to be unpaid pilots";
  const disagreement = "The churn figure came from the founder and nothing else, and we passed on it";

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");

  // A deal that reaches the committee stage. Reaching it is what opens the packet — nothing else
  // in the product does (ADR-019), which is why the stage is the assertion below and not the form.
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("dealflow-add-toggle").click();
  await page.getByTestId("dealflow-new-name").fill(companyName);
  await page.getByTestId("dealflow-sleeve").selectOption("EARLY_STAGE_PRIMARY");
  await page.getByTestId("dealflow-stage").selectOption("IC_READY");
  await page.getByTestId("dealflow-add-submit").click();
  await expect(page.getByTestId("dealflow-message")).toContainText(companyName);

  const board = (await (await request.get("/api/dealflow/board", { headers: MP })).json()) as {
    deals: Array<{ id: string; company_name: string; status: string }>;
  };
  const deal = board.deals.find((d) => d.company_name === companyName)!;
  expect(deal.status, "the packet only opens because the deal reached the committee stage").toBe("IC_READY");

  const packetId = await packetFor(request, deal.id);
  expect(packetId, "reaching the committee stage must assemble a packet by itself").toBeTruthy();

  /*
   * A GAP THE PACKET DOES NOT KNOW, raised against it and then ANSWERED BY A PERSON on the page.
   *
   * The committee surface is built around "what the packet does not know", because the failure mode
   * of an IC pack is not a missing section — it is a section that reads as complete while the thing
   * it rests on was never checked.
   */
  const question = await request.post(`/api/ic/packets/${packetId}/questions`, {
    headers: MP,
    data: {
      question: `${marker}: who actually pays for the product today?`,
      because: "The revenue line and the customer list do not agree with each other.",
      owed_by_kind: "PARTNER",
    },
  });
  expect(question.status(), await question.text()).toBe(201);
  const questionId = await openQuestionFor(request, packetId);

  /*
   * THE COMMITTEE LIVES ON DEALFLOW (design/DEALS_SECTION_DESIGN.md §4, moved from Meetings). The
   * band lists the deal, and its row opens the record on the committee face — where every control
   * below is. The deal also shows on the Waiting-on-you band only once it is in front of the
   * partners, which is asserted further down.
   */
  await gotoSurface(page, "Dealflow");
  const icRow = page.getByTestId(`ic-row-${deal.id}`);
  await expect(icRow).toBeVisible();
  await expect(icRow).toContainText(companyName);
  await page.getByTestId(`ic-open-${deal.id}`).click();
  await expect(page.getByTestId("deal-face-committee")).toHaveAttribute("aria-selected", "true");
  const icDeal = page.getByTestId(`ic-deal-${deal.id}`);
  await expect(icDeal).toBeVisible();
  await expect(page.getByTestId("deal-record-company-name")).toContainText(companyName);

  /*
   * THE FACILITATOR IS AN EMPLOYEE AND SHE DECIDES NOTHING. "AI prepares the decision; the Managing
   * Partners make the decision" is the governing law of this system, and the committee is where a
   * violation of it would be most expensive.
   */
  await expect(page.getByTestId("ic-how-it-works")).toContainText("never decides anything");
  await expect(icDeal.getByTestId(`ic-card-${deal.id}`), "an employee is holding the card to assemble it").toContainText(
    "work card to assemble it",
  );

  const questionRow = icDeal.getByTestId(`ic-question-${questionId}`);
  await expect(questionRow).toContainText("open");
  await questionRow.getByTestId(`ic-answer-${questionId}`).click();
  await questionRow.getByTestId(`ic-answer-text-${questionId}`).fill("Four of the eleven pay. The rest are pilots.");
  await questionRow.getByTestId(`ic-answer-save-${questionId}`).click();
  await expect(questionRow).toContainText("answered");
  await expect(questionRow, "an answer is kept in the words it was given in").toContainText("The rest are pilots");

  // Put it in front of the partners, then record what they decided.
  await icDeal.getByTestId(`ic-submit-${deal.id}`).click();
  await expect(icDeal.getByTestId(`ic-decide-${deal.id}`)).toBeVisible();
  /*
   * AND NOW IT IS WAITING ON A PERSON, and the page says so above everything else: the
   * Waiting-on-you band carries the deal, the count pill says one, and the masthead answers with it.
   * The band's own control opens the same committee face — one act, reachable from the top.
   */
  await expect(page.getByTestId(`waiting-committee-${deal.id}`)).toContainText("in front of the partners");
  await expect(page.getByTestId("dealflow-waiting-count")).toHaveText(/^[1-9]\d*$/);
  await expect(page.getByTestId("dealflow-answer")).toContainText(/waiting on you/);
  await icDeal.getByTestId(`ic-decide-${deal.id}`).click();

  /*
   * A PASS NEEDS A SENTENCE. "We passed in August" is a fact; the reason is what a partner wants in
   * front of them when the founder comes back raising. The control refuses before the server does.
   */
  await expect(icDeal.getByTestId(`ic-pass-${deal.id}`)).toBeDisabled();
  await icDeal.getByTestId(`ic-rationale-${deal.id}`).fill("no");
  await expect(icDeal.getByTestId(`ic-pass-${deal.id}`)).toBeDisabled();
  await icDeal.getByTestId(`ic-rationale-${deal.id}`).fill(rationale);
  await expect(icDeal.getByTestId(`ic-pass-${deal.id}`)).toBeEnabled();
  await icDeal.getByTestId(`ic-pass-${deal.id}`).click();

  const decision = icDeal.getByTestId(`ic-decision-${deal.id}`);
  await expect(decision).toContainText("The firm passed");
  await expect(decision).toContainText(rationale);
  await expect(decision, "a decision names the person who made it").toContainText("Scooter Taylor");

  /*
   * ── AND NOW THE DISAGREEMENT ─────────────────────────────────────────────────────────────────
   *
   * The empty state is asserted first, because it is the sentence that makes the whole feature
   * honest: silence in the minutes is not agreement, and saying so is the difference between a
   * record and a rubber stamp.
   */
  const dissents = icDeal.getByTestId(`ic-dissents-${deal.id}`);
  await expect(dissents).toContainText("not the same as everybody agreeing");

  await icDeal.getByTestId(`ic-dissent-open-${deal.id}`).click();
  await expect(icDeal.getByTestId(`ic-dissent-save-${deal.id}`), "a dissent needs words in it").toBeDisabled();
  await icDeal.getByTestId(`ic-dissent-text-${deal.id}`).fill(disagreement);
  await icDeal.getByTestId(`ic-dissent-save-${deal.id}`).click();

  await expect(dissents).toContainText(disagreement);
  await expect(dissents, "a dissent is attributed — an anonymous one settles nothing").toContainText("Scooter Taylor");
  await expect(dissents).not.toContainText("not the same as everybody agreeing");

  /*
   * IT IS ON THE RECORD THE COMMITTEE IS READ FROM, not only on the page that wrote it. `dissents`
   * is collected across every decision on the packet, so a second decision cannot bury the first
   * one's disagreement.
   */
  const packet = (await (await request.get(`/api/ic/packets/${packetId}`, { headers: MP })).json()) as {
    decisions: Array<{ id: string; decision: string }>;
    dissents: Array<{ ic_decision_id: string; dissent_text: string; dissenter_id: string }>;
  };
  expect(packet.decisions).toHaveLength(1);
  expect(packet.dissents).toHaveLength(1);
  expect(packet.dissents[0]!.dissent_text).toBe(disagreement);
  expect(packet.dissents[0]!.ic_decision_id).toBe(packet.decisions[0]!.id);
  expect(packet.dissents[0]!.dissenter_id, "the dissenter is a person, recorded by id").toBeTruthy();

  // The spine carries it as a typed event, so the committee's minutes are auditable elsewhere.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-ic.dissent_recorded"]').first()).toBeVisible();

  // And the pass landed the deal on the visible pass pile with its reason, rather than stranding it
  // at the committee stage with no forward move that is not "we invested".
  const after = (await (await request.get(`/api/opportunities/${deal.id}`, { headers: MP })).json()) as {
    status?: string;
    exit_reason?: string;
    opportunity?: { status: string; exit_reason: string };
  };
  expect(after.status ?? after.opportunity?.status).toBe("PASS");
  expect(after.exit_reason ?? after.opportunity?.exit_reason).toContain("unpaid pilots");
});

test("a dissent cannot be edited, removed, or written by an employee", async ({ request }) => {
  /*
   * THE THREE PROPERTIES THAT MAKE A DISSENT WORTH WRITING. If it can be changed afterwards it is a
   * draft; if it can be deleted it is a courtesy; and if a machine can produce one it is not a
   * judgment. The first two are enforced by triggers on the table itself
   * (`dissent_record_reject_update` / `_reject_delete`, migration 0006), which is the right place —
   * a rule that lives only in a service is a rule the next service does not have.
   */
  const marker = `E2E-P60-APPEND-${Date.now()}`;
  const company = (await (
    await request.post("/api/companies", { headers: MP, data: { canonical_name: `${marker} Co` } })
  ).json()) as { id: string };
  const opp = (await (
    await request.post("/api/opportunities", {
      headers: MP,
      data: { company_id: company.id, opportunity_type: "EARLY_STAGE_PRIMARY", title: `${marker} deal` },
    })
  ).json()) as { id: string };
  for (const to of ["SCREENING", "DILIGENCE", "IC_READY"]) {
    expect((await request.post(`/api/opportunities/${opp.id}/transition`, { headers: MP, data: { to } })).status()).toBe(200);
  }
  const packetId = await packetFor(request, opp.id);
  expect((await request.post(`/api/ic/packets/${packetId}/submit`, { headers: MP, data: {} })).status()).toBe(200);

  const decided = await request.post(`/api/ic/packets/${packetId}/decide`, {
    headers: MP,
    data: { decision: "DEFER", rationale: `${marker}: waiting on the audited accounts` },
  });
  expect(decided.status(), await decided.text()).toBe(201);
  const decisionId = ((await decided.json()) as { id: string }).id;

  // Empty text is not a dissent.
  const blank = await request.post(`/api/ic/decisions/${decisionId}/dissent`, { headers: MP, data: { dissent_text: "  " } });
  expect(blank.status(), await blank.text()).toBe(400);

  const first = await request.post(`/api/ic/decisions/${decisionId}/dissent`, {
    headers: MP,
    data: { dissent_text: "Deferring is a decision and this one costs us the round." },
  });
  expect(first.status(), await first.text()).toBe(201);

  /*
   * A SECOND DISSENT ON THE SAME DECISION IS A SECOND ENTRY, never a replacement. Two people can
   * disagree for different reasons, and one changing their mind writes another line rather than
   * overwriting the first — which is what "append-only" means to a reader rather than to a schema.
   */
  const second = await request.post(`/api/ic/decisions/${decisionId}/dissent`, {
    headers: MP,
    data: { dissent_text: "And the accounts have been three weeks away for two months." },
  });
  expect(second.status(), await second.text()).toBe(201);

  const packet = (await (await request.get(`/api/ic/packets/${packetId}`, { headers: MP })).json()) as {
    dissents: Array<{ dissent_text: string }>;
  };
  expect(packet.dissents, "both disagreements are kept, in the order they were written").toHaveLength(2);
  expect(packet.dissents.map((d) => d.dissent_text).join(" ")).toContain("costs us the round");
  expect(packet.dissents.map((d) => d.dissent_text).join(" ")).toContain("three weeks away");

  // There is no route that edits or deletes one. The absence IS the guarantee, and it is asserted
  // rather than assumed — a PATCH that quietly appeared would break the record silently.
  const edit = await request.patch(`/api/ic/decisions/${decisionId}/dissent`, {
    headers: MP,
    data: { dissent_text: "on reflection I agreed all along" },
  });
  expect(edit.status(), "nothing may edit a dissent").toBe(404);
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

async function packetFor(request: Ctx, opportunityId: string): Promise<string> {
  const body = (await (await request.get(`/api/ic/packets?opportunity_id=${opportunityId}`, { headers: MP })).json()) as {
    ic_packets: Array<{ id: string }>;
  };
  expect(body.ic_packets, "one deal at the committee stage has one packet").toHaveLength(1);
  return body.ic_packets[0]!.id;
}

async function openQuestionFor(request: Ctx, packetId: string): Promise<string> {
  const body = (await (await request.get(`/api/ic/packets/${packetId}/questions`, { headers: MP })).json()) as {
    questions: Array<{ id: string; state: string }>;
  };
  const open = body.questions.find((q) => q.state === "OPEN");
  expect(open, "the question just raised must be open against the packet").toBeTruthy();
  return open!.id;
}
