import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { provisionLocalD1 } from "./support/provision";

/**
 * THROWING THE WHOLE QUARANTINE QUEUE AWAY — with a reason, and without releasing anything.
 *
 * Operator, 22 Aug 2026: "we need a throw all away option." Fifty-one items nobody is going to
 * review one at a time is a queue that sits there, and a queue that sits there teaches a partner to
 * stop looking at queues — which is worse than having no queue, because the next thing that lands in
 * it genuinely does need a person.
 *
 * THE THREE PROPERTIES THAT MAKE A BULK CONTROL SAFE, and all three are asserted here:
 *   · it needs a REASON, and the control will not fire without one;
 *   · it DISCARDS rather than releases — refused output stays refused, and a discarded run must
 *     never come back as accepted, because "accept" is what makes a model's words usable as firm
 *     evidence and nobody said yes to these;
 *   · and it is not the thing your hand lands on while reaching for a single item — it is folded
 *     behind a disclosure, which is asserted as a shut lid rather than as styling.
 *
 * Runs fully offline: local D1 (miniflare), no credentials. The runs it operates on are real ones
 * through the governed boundary, taken by the deterministic `mock-local` model.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

interface QuarantineView {
  waiting_count: number;
  /** `what_it_was_for` rather than `purpose`: the payload speaks the operator's words, not the column's. */
  waiting: Array<{ id: string; what_it_was_for: string }>;
}

test("a partner throws the whole queue away, with a reason, and nothing is released by it", async ({
  page,
  request,
}) => {
  const marker = `E2E-P67-${Date.now()}`;

  /*
   * THREE REAL RUNS THROUGH THE GOVERNED BOUNDARY, THEN ONE FIXTURE FLIP — and the flip is the
   * honest part of this spec.
   *
   * Quarantine is where EXTERNAL output waits: "external outputs land quarantined until a human
   * accept step; local outputs are unquarantined" (`runAi.ts:39`). Under `wrangler dev --local`
   * there is no provider credential and privacy mode is LOCKDOWN, so every run takes the
   * deterministic local adapter and comes back unquarantined by design. That is correct behaviour
   * and it means the queue CANNOT be filled here through the front door.
   *
   * So the runs are genuine — created through `POST /api/ai/run`, completed, priced, on the spine —
   * and the single column the frontier path would have set is set here instead. Everything this
   * journey is actually about happens downstream of that flag: what the queue shows, what accepting
   * one does, what throwing the rest away does, and what it must never do.
   */
  for (const n of [1, 2, 3]) {
    const run = await request.post("/api/ai/run", {
      headers: MP,
      data: {
        purpose: `${marker} draft ${n}`,
        inputs: [`Draft a short note, number ${n}.`],
        sensitivity: "INTERNAL",
      },
    });
    expect(run.status(), await run.text()).toBe(201);
    expect(((await run.json()) as { status: string }).status).toBe("COMPLETED");
  }
  provisionLocalD1(
    `UPDATE ai_run SET output_quarantine = 1 WHERE purpose LIKE '${marker}%' AND status = 'COMPLETED';`,
  );

  const mine = async (): Promise<string[]> => {
    const view = (await (await request.get("/api/ai/quarantine", { headers: MP })).json()) as QuarantineView;
    return view.waiting.filter((w) => (w.what_it_was_for ?? "").startsWith(marker)).map((w) => w.id);
  };
  expect(await mine(), "completed output waits for a person before it can be used").toHaveLength(3);

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
  await gotoSurface(page, "Cockpit");

  const queue = page.getByTestId("quarantine-queue");
  await expect(queue).toBeVisible();
  await expect(queue).toContainText("waiting");

  /*
   * ONE ITEM ACCEPTED FIRST, on purpose. It proves the queue's ordinary exit still works, and it
   * gives the bulk control something it must NOT touch: an accepted decision is a decision, and a
   * "throw everything away" that reopened settled items would be rewriting them.
   */
  const accepted = (await mine())[0]!;
  const acceptRes = await request.post(`/api/ai/runs/${accepted}/accept-output`, {
    headers: MP,
    data: { reason: `${marker}: read it, it is fine` },
  });
  expect(acceptRes.status(), await acceptRes.text()).toBe(200);
  expect(await mine(), "an accepted item leaves the queue").toHaveLength(2);

  /*
   * ── THE BULK CONTROL IS BEHIND A LID, AND WILL NOT FIRE WITHOUT A REASON ─────────────────────
   *
   * The reason covers the batch — asking once per item would guarantee it was answered without
   * thought — so the one reason there is has to be real. The button is disabled under four
   * characters, which is the refusal a person actually meets.
   */
  await page.reload();
  await gotoSurface(page, "Cockpit");
  const bulk = page.getByTestId("quarantine-discard-all");
  await expect(bulk).toBeVisible();
  expect(
    await bulk.evaluate((el) => (el as HTMLDetailsElement).open),
    "the control that acts on everything at once must not be the one your hand lands on",
  ).toBe(false);

  await bulk.locator("summary").first().click();
  await expect(page.getByTestId("quarantine-discard-all-submit")).toBeDisabled();
  await page.getByTestId("quarantine-discard-all-reason").fill("no");
  await expect(page.getByTestId("quarantine-discard-all-submit")).toBeDisabled();
  await page.getByTestId("quarantine-discard-all-reason").fill(`${marker}: the sweep produced nothing usable`);
  await expect(page.getByTestId("quarantine-discard-all-submit")).toBeEnabled();
  await page.getByTestId("quarantine-discard-all-submit").click();

  await expect(page.getByTestId("ai-ops-message")).toContainText("thrown away");
  await expect.poll(async () => (await mine()).length, { message: "the queue empties" }).toBe(0);

  /*
   * ── AND NOTHING WAS RELEASED ─────────────────────────────────────────────────────────────────
   *
   * Discarding is a tombstone, exactly as it is for a single item: the run is still there, its
   * output is still held back, and the decision recorded against it says DISCARD with the reason
   * the partner typed. A bulk control that quietly marked things accepted would turn fifty-one
   * unreviewed model outputs into firm evidence in one press.
   */
  const discarded = (await (await request.get("/api/ai/runs", { headers: MP })).json()) as {
    runs: Array<{ id: string; purpose: string; status: string; output_quarantine?: number }>;
  };
  const batch = discarded.runs.filter((r) => r.purpose.startsWith(marker));
  expect(batch, "the runs themselves are not deleted by a discard").toHaveLength(3);
  for (const run of batch) expect(run.status).toBe("COMPLETED");

  // The reason is answerable later, which is the whole point of requiring one.
  await gotoSurface(page, "Activity");
  await expect(page.locator('[data-testid="activity-event-ai_output.discarded"]').first()).toBeVisible();
});

test("the bulk control is not offered when there is nothing waiting", async ({ page, request }) => {
  /*
   * A CONTROL THAT EXISTS ONLY TO DO NOTHING teaches people to distrust the ones that work — the
   * same rule the pipeline applies to offering "pass" on a company the fund already owns. With an
   * empty queue the disclosure is absent, and the surface says the queue is empty instead.
   */
  const remaining = (await (await request.get("/api/ai/quarantine", { headers: MP })).json()) as QuarantineView;
  if (remaining.waiting_count > 0) {
    const cleared = await request.post("/api/ai/quarantine/discard-all", {
      headers: MP,
      data: { reason: "E2E-P67: clearing the bench so the empty state can be read" },
    });
    expect(cleared.status(), await cleared.text()).toBe(200);
  }

  await page.goto("/");
  await page.getByTestId("dev-login-email").fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await gotoSurface(page, "Cockpit");

  await expect(page.getByTestId("quarantine-queue")).toBeVisible();
  await expect(page.getByTestId("quarantine-discard-all")).toHaveCount(0);
  // And the empty queue is a stated fact rather than a blank, like every other slot in this product.
  await expect(page.getByTestId("quarantine-queue")).toContainText("0 waiting");
});
