import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { queryLocalD1 } from "./support/provision";

/**
 * THE SYSTEM TELLING THE TRUTH ABOUT ITSELF.
 *
 * Three journeys, one property: a firm that runs on automated work has to be able to tell "nothing
 * happened today" from "this is broken", and it can only do that if the product says which.
 *
 * 17 · THE MORNING BRIEF ARRIVES — AND WHEN IT DOES NOT, THE PAGE SAYS WHY. This is the first thing
 *      a partner reads every morning, so a silent blank on it poisons everything underneath: a
 *      reader who cannot tell an empty day from a broken pipeline stops trusting the page, and then
 *      stops opening it.
 *
 * 18 · DIAGNOSTICS CATCHES SOMETHING DOWN, ESCALATES ONCE TO BOTH PARTNERS, AND ANNOUNCES RECOVERY.
 *      Each of those three words is a separate failure mode. Not catching it is the obvious one.
 *      Escalating repeatedly is how an alert becomes wallpaper. Telling one partner leaves the
 *      other believing the firm is fine. And never announcing recovery leaves a warning standing
 *      over something that fixed itself an hour later, which teaches everyone to ignore the next one.
 *
 * 19 · A SPEND CEILING STOPS A RUN AND SAYS SO — asserted as far as this environment can carry it,
 *      and the boundary is stated on the test rather than papered over. See the note there.
 *
 * Runs fully offline: local D1 (miniflare), no credentials.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

test("the morning brief: press the button → a named state is on screen → the clock builds it → it arrives; a lane that cannot write leaves the reason and the retry time", async ({
  page,
  request,
}) => {
  /*
   * 19 Sep 2026: "I pushed the button to build a brief and I don't know if it's coming or not or
   * how long it takes — there is no progress bar — and I pushed the button again and some other
   * message came up." Every step of that morning is driven here, through the browser, against the
   * real routes, with the tick fired the way the Cron Trigger fires it.
   *
   * WHERE THIS STOPS. Under local `wrangler dev` there is no provider credential and privacy mode is
   * LOCKDOWN, so the write stage's model is `mock-local`, which returns prose. What a real model
   * writes into each section is not claimed here. What IS proven: the press is a request the row
   * carries, the page shows a named state with the measured usual duration, a second press changes
   * nothing and says so, the tick walks the row to a terminal state, and the page ends on EITHER a
   * brief or a stated reason with a retry time — never the blank this journey exists to prevent.
   */
  await signIn(page);
  await gotoSurface(page, "Home");
  const panel = page.getByTestId("daily-brief");
  await expect(panel).toBeVisible();

  // 1 · THE STATE IS ON SCREEN BEFORE ANY PRESS, and it is one of the named ones.
  const state = page.getByTestId("daily-brief-state");
  await expect(state).toBeVisible();
  const kinds = ["arrived", "requested", "running", "queued", "retrying", "failed_out", "scheduled", "off", "stalled"];
  expect(kinds, "the band renders a state the shared module does not name").toContain(await state.getAttribute("data-kind"));
  await expect(page.getByTestId("daily-brief-state-line")).not.toHaveText("");

  // 2 · PRESS. The server answers at once with the named state; nothing runs inside the request.
  const button = page.getByTestId("daily-brief-generate");
  await expect(button).toBeEnabled();
  await button.click();
  await expect(state).toHaveAttribute("data-kind", /requested|running|queued/);
  await expect(page.getByTestId("daily-brief-state-next")).toContainText(/usually|at a guess/);
  // "requested by you" is a fact from the row, not a label the client added.
  await expect(page.getByTestId("daily-brief-meta")).toContainText(/requested by you/);

  // 3 · A SECOND PRESS WHILE IT MOVES DOES NOTHING AND SAYS SO — from the row: the button is
  //     disabled and reads "Already building — started …", and the route answers `already: true`.
  await expect(button).toBeDisabled();
  await expect(button).toHaveText(/^Already building — started /);
  const again = await request.post("/api/daily-intelligence/generate", { headers: MP, data: {} });
  expect(again.status(), await again.text()).toBe(200);
  const againBody = (await again.json()) as { already: boolean; kind: string; line: string };
  expect(againBody.already).toBe(true);
  expect(againBody.line).toMatch(/Requested|Building|Between stages/);

  // 4 · THE CLOCK. The same code path the Cron Trigger calls, fired once.
  const tick = await request.post("/api/jobs/tick", { headers: MP });
  expect(tick.status(), await tick.text()).toBe(200);
  const ran = (await tick.json()) as { ran: Array<{ job_key: string; status: string; summary: string }> };
  const served = ran.ran.find((r) => r.job_key === "_morning_brief");
  expect(served, "a tick with a requested brief must serve it and say so").toBeTruthy();
  expect(served!.summary).toMatch(/^Morning brief for fu_/);
  expect(["READY", "FAILED"], "one tick walks a requested brief to a terminal state").toContain(served!.status);

  // 5 · THE PAGE ENDS ON A BRIEF OR A STATED REASON. The poll picks the change up within a few
  //     seconds; the terminal kind is asserted strictly for whichever the model produced.
  await expect(state).toHaveAttribute("data-kind", /arrived|retrying|failed_out/, { timeout: 15_000 });
  const kind = await state.getAttribute("data-kind");
  const status = (await (await request.get("/api/daily-intelligence/status", { headers: MP })).json()) as {
    kind: string; line: string; next: string | null; actAt: string | null; attempts: number; status: string; button: { label: string; enabled: boolean };
  };
  expect(status.kind).toBe(kind);
  if (kind === "arrived") {
    expect(status.status).toBe("READY");
    await expect(page.getByTestId("daily-brief-state-line")).toContainText(/Today's brief arrived at/);
    await expect(page.getByTestId("brief-executive_summary")).toBeVisible();
    await expect(button).toHaveText("Rebuild today's brief");
  } else {
    // mock-local returns prose; the verifier refuses it; the row says so and says when it retries.
    expect(status.status).toBe("FAILED");
    expect(status.line, "a failed brief names its reason").toMatch(/failed: .{10,}/);
    if (kind === "retrying") {
      expect(status.actAt, "a retryable failure carries the clock time it retries at").toBeTruthy();
      expect(status.next).toMatch(/tries again at \d{1,2}:\d{2} (AM|PM)/);
      await expect(page.getByTestId("daily-brief-state-next")).toContainText(/tries again at/);
    } else {
      expect(status.next).toMatch(/Nothing more is tried automatically today/);
    }
    await expect(button).toHaveText("Try again now");
  }
  await expect(button).toBeEnabled();
  // The empty-state fallback never shows beside a named state.
  await expect(page.getByTestId("daily-brief-empty")).toHaveCount(0);

  // The brief is delivered by a named colleague on Home rather than appearing from nowhere.
  await expect(page.getByTestId("home-brief-delivery")).toBeVisible();
});

test("diagnostics catches something down, escalates once to BOTH partners, and announces the recovery", async ({
  page,
  request,
}) => {
  const marker = `E2E-P62-${Date.now()}`;

  /*
   * A REAL FAULT, MADE REAL. `approval_load` reports DOWN past 25 cards waiting, because "a long
   * approval queue is a bug report, not a to-do list" — past about ten a queue gets skimmed rather
   * than read. So the queue is genuinely overloaded here and genuinely cleared afterwards; nothing
   * is stubbed, and the check is asked what it thinks at each step rather than assumed.
   */
  expect(
    await checkState(request, "approval_load"),
    "this journey needs the queue to start healthy; if it is already DOWN, something before this spec left it that way",
  ).not.toBe("DOWN");

  /*
   * SETTLE ANYTHING STILL OPEN FIRST, USING THE PRODUCT RATHER THAN SQL.
   *
   * A `health_fault` row stays open until a sweep sees the check healthy again, and an already
   * escalated fault is deliberately never escalated twice — so an earlier attempt that ended between
   * "escalate" and "recover" would make this journey read as "nothing new" for a fault that is
   * genuinely down. One sweep against a healthy queue closes the episode, which is exactly the
   * recovery behaviour asserted at the foot of this test.
   */
  await sweep(request);

  /*
   * COUNTED AS A DELTA, NOT AS A TOTAL. Every spec drives the same database and this one may have
   * run before against it, so "how many notifications mention approval_load" is a number that grows
   * across episodes. What this journey is about is ONE fault episode: how many people it told, and
   * how many times. So the ledger is photographed first and only the new rows are counted.
   */
  const alreadySeen = new Set(notificationsAbout("approval_load").map((n) => n.id));
  const newlyRaised = (): NotificationRow[] =>
    notificationsAbout("approval_load").filter((n) => !alreadySeen.has(n.id));

  const cards: string[] = [];
  try {
    for (let i = 0; i < 30; i += 1) {
      const res = await request.post("/api/approvals", {
        headers: MP,
        data: {
          action_key: "investment.approve",
          object_type: "canonical_company",
          object_id: `cc_${marker}_${i}`,
          title: `${marker} queue depth ${i}`,
          submit: true,
        },
      });
      expect(res.status(), await res.text()).toBe(201);
      cards.push(((await res.json()) as { id: string }).id);
    }
    expect(await checkState(request, "approval_load"), "thirty cards waiting must read as DOWN").toBe("DOWN");

    /*
     * ── ONE SIGHTING IS NOT A FAULT ───────────────────────────────────────────────────────────────
     *
     * The first sweep records it and says nothing. Two consecutive readings are required before
     * anybody is told, which is what keeps a momentary blip from waking both partners — and it is
     * asserted here rather than assumed, because a check that escalated on first sight would still
     * pass every "does it escalate" test ever written.
     */
    const first = await sweep(request);
    expect(first, "a first sighting must not escalate").not.toContain("escalated approval_load");

    /*
     * Matched as two substrings rather than one phrase: the sweep escalates everything it finds in
     * the same sentence, so `escalated a, b, approval_load` is the ordinary shape and pinning
     * "escalated approval_load" would pass only when this fault happened to be listed first.
     */
    const second = await sweep(request);
    expect(second, "a fault seen twice running must be escalated").toContain("escalated");
    expect(second, "and this fault must be one of the ones it names").toContain("approval_load");

    /*
     * BOTH PARTNERS, ONE EACH. A firm with two Managing Partners where only one is told has a
     * partner walking around believing the system is fine.
     */
    const warnings = newlyRaised().filter((n) => n.severity === "WARNING");
    expect(warnings.length, "each Managing Partner is told, once").toBe(2);
    expect(new Set(warnings.map((n) => n.dedupe_key)).size, "the two are distinct rows, not one counted twice").toBe(2);
    for (const n of warnings) {
      // The reading, and what to do about it — an alert that names neither is a noise generator.
      expect(n.title).toContain("down");
      expect(n.body, "an escalation carries what was read").toContain("waiting");
    }

    /*
     * AND ONCE. A fault that keeps being reported while nobody has fixed it is how an alert becomes
     * wallpaper — the third sweep sees exactly the same fault and says nothing new.
     */
    const third = await sweep(request);
    expect(third, "an open fault must not be re-escalated on every tick").toContain("nothing new");
    expect(newlyRaised().filter((n) => n.severity === "WARNING")).toHaveLength(2);

    // A partner can see the fault on the board it belongs to, in the state it is in.
    await signIn(page);
    await gotoSurface(page, "Diagnostics");
    await expect(page.getByTestId("health-approval_load")).toHaveAttribute("data-state", "DOWN");
  } finally {
    // Clear the queue again, whatever happened above — a spec that leaves thirty cards waiting has
    // broken the next one's starting state as surely as if it had failed.
    for (const id of cards) {
      await request.post(`/api/approvals/${id}/decide`, {
        headers: MP,
        data: { decision: "rejected", note: `${marker}: queue-depth fixture, cleared` },
      });
    }
  }

  expect(await checkState(request, "approval_load"), "the fixture must have cleared").not.toBe("DOWN");

  /*
   * ── AND THE RECOVERY IS ANNOUNCED ─────────────────────────────────────────────────────────────
   *
   * A warning left standing over something that fixed itself is worse than no warning: it teaches
   * the reader that red does not mean anything. The sweep that sees the fault gone says so, and the
   * partners get told in the same place they were told it was broken.
   */
  const recovered = await sweep(request);
  expect(recovered, "the sweep that finds it fixed must say so").toContain("recovered approval_load");

  /*
   * Counted as a TOTAL here rather than as a delta, and deliberately. The recovery notification is
   * deduped into an hour bucket (`health_recovered:<key>:<hour>`), so a second recovery inside the
   * same hour writes nothing — which is correct, and is the opposite of the escalation case where
   * "one each, once" is the property. What has to hold is that the recovery WAS announced, and the
   * sweep's own summary above is what pins it to this episode.
   */
  const good = notificationsAbout("approval_load").filter((n) => n.severity === "INFO");
  expect(good.length, "recovery is announced").toBeGreaterThan(0);
  expect(good[0]!.title).toContain("working again");
  // And nothing else was changed by the check — diagnostics observes, it does not repair.
  expect(good[0]!.body).toContain("Nothing else was changed");

  // Read fresh: the board was already open on this page from the DOWN half above, and navigating to
  // the page you are already on does not re-ask the server.
  await page.reload();
  await gotoSurface(page, "Diagnostics");
  await expect(page.getByTestId("health-approval_load")).not.toHaveAttribute("data-state", "DOWN");
});

test("a spending ceiling is a partner's decision, it persists, and a cost mode actually stops a run", async ({
  page,
  request,
}) => {
  /*
   * ── WHAT THIS CAN AND CANNOT PROVE HERE, SAID PLAINLY ─────────────────────────────────────────
   *
   * The MONETARY ceiling (`firm_spend_budget`, and the daily cap) is enforced at step 7 of
   * `runAi` — after step 3, where LOCKDOWN and LOCAL short-circuit to the deterministic
   * `mock-local` adapter and return. Local runs therefore never reach the money gates, and they
   * never should: the local adapter costs nothing, and refusing a free run on a spending limit
   * would be wrong. Under `wrangler dev --local` there is no provider credential and privacy mode
   * is LOCKDOWN, so **a monetary ceiling cannot be made to block a run in this environment at all**,
   * and no assertion here claims that it does. That leg is unit-testable against the frontier path
   * and belongs in `tests/`.
   *
   * What IS proved, end to end and in the browser:
   *   · the ceiling is a person's decision and a Managing Partner's alone;
   *   · it PERSISTS and is read back where it was set — "a budget that displays but does not bind
   *     is worse than none" cuts both ways, and a ceiling nobody can see afterwards is the same
   *     failure wearing the other face;
   *   · and a spending decision that CAN reach a local run — the cost MODE — stops one and names
   *     the rule that stopped it, on the run's own row, which is the shape every budget refusal in
   *     this system takes.
   */
  const marker = `E2E-P62-SPEND-${Date.now()}`;
  await signIn(page);

  // ── The ceiling: set by a partner, on the page that spends the money ────────────────────────
  await gotoSurface(page, "Cockpit");
  const before = page.getByTestId("firm-budget-MONTHLY");
  await expect(before).toBeVisible();

  /*
   * THE FIRM HAS A MONTHLY CEILING NOW, AND IT DID NOT WHEN THIS WAS WRITTEN.
   *
   * `firm_spend_budget` was empty: there was no monthly ceiling at all, only a daily cap, and 31 x
   * $2.50 of daily cap is $77.50 — past the $50 the owner named as her worst case. Migration 0178
   * gave the firm its first one, so the MONTHLY window legitimately no longer renders "No limit
   * set".
   *
   * THE PROPERTY THIS LINE WAS DEFENDING IS NOT DROPPED. "With no limit set the page says so rather
   * than drawing a bar against nothing" is still true and still worth holding, so it is asserted
   * against ALL_TIME, which genuinely has no ceiling and is meant to keep not having one — nothing
   * is invented for a window nobody set. And the MONTHLY side is now pinned too: the shipped
   * ceiling has to be drawn, with its figure. Both states of the component are covered where one
   * was.
   */
  await expect(
    page.getByTestId("firm-budget-none-ALL_TIME"),
    "with no limit set the page says so rather than drawing a bar against nothing",
  ).toContainText("No limit set");
  await expect(
    page.getByTestId("firm-budget-cap-MONTHLY"),
    "the monthly ceiling the owner set must be drawn, with its figure, rather than left implicit",
    // $75 SINCE 0179, not $50. She named two numbers where there had been one: $50 is where she is
    // NOTIFIED with the bypass decision in front of her, and $75 is where the firm stops. A single
    // ceiling could only be one of those, and making $50 the stop meant the first she would hear of
    // $50 was work failing.
  ).toContainText("75.00");
  await expect(page.getByTestId("firm-budget-none-MONTHLY")).toHaveCount(0);

  await page.getByTestId("firm-budget-input-MONTHLY").fill("250");
  await page.getByTestId("firm-budget-save-MONTHLY").click();
  await expect(page.getByTestId("firm-budget-cap-MONTHLY")).toContainText("250");
  await expect(page.getByTestId("firm-budget-none-MONTHLY")).toHaveCount(0);

  // It persists. A ceiling that lives in a component's state is a ceiling nobody set.
  await page.reload();
  await gotoSurface(page, "Cockpit");
  await expect(page.getByTestId("firm-budget-cap-MONTHLY")).toContainText("250");

  const stored = (await (await request.get("/api/ai/cost", { headers: MP })).json()) as {
    firm_budgets?: Array<{ budget_window: string; cap_usd?: number; cap_cents?: number; active?: number }>;
  };
  const monthly = (stored.firm_budgets ?? []).find((b) => b.budget_window === "MONTHLY");
  expect(monthly, "the ceiling is read back from the same payload that reports the spend it governs").toBeTruthy();

  // ── AND IT IS A PARTNER'S DECISION. Not a role, not an employee, not an API client. ──────────
  const asEmployee = await request.post("/api/ai/firm-budget", {
    headers: { "x-wpos-dev-user": "e2e-member@westpeek.ventures" },
    data: { budget_window: "ALL_TIME", cap_cents: 100_000, reason: `${marker} not my decision` },
  });
  expect(asEmployee.status(), await asEmployee.text()).toBe(403);
  expect(await asEmployee.text()).toContain("Managing Partner");

  /*
   * ── A SPENDING DECISION THAT DOES STOP A LOCAL RUN ────────────────────────────────────────────
   *
   * CRITICAL_ONLY is the firm saying "only spend on work that cannot wait". It is checked at step 1
   * of `runAi`, before the privacy short-circuit, so it binds here — and it is the same mechanism
   * every money refusal uses: the run is RECORDED, blocked, with a reason on its own row, rather
   * than throwing or silently not happening.
   */
  /*
   * AND THIS IS ALSO THE LIVE PROOF THAT THE OLD FIELD STILL WORKS.
   *
   * `cost_mode` is retired as a control — nothing about routing reads it — but the API still accepts
   * it and TRANSLATES it rather than ignoring or refusing it. CRITICAL_ONLY never answered "how much
   * money" at all; it answered "what work runs at all", which is now its own `defer_non_critical`
   * field. A caller still sending the old value gets the behaviour it always meant, end to end, in
   * a browser, which is the only place that claim is worth anything.
   */
  const policy = await request.post("/api/ai/budget", {
    headers: MP,
    data: {
      cost_mode: "CRITICAL_ONLY",
      privacy_mode: "LOCKDOWN",
      daily_cap_usd: 25,
      per_run_cap_usd: 5,
    },
  });
  expect(policy.status(), await policy.text()).toBe(201);

  try {
    await gotoSurface(page, "AI controls");
    await page.getByTestId("ai-purpose").fill(`${marker} tidy up the notes`);
    await page.getByTestId("ai-input").fill("Rewrite last week's portfolio notes more neatly.");
    await page.getByTestId("ai-run-submit").click();

    /*
     * DEFERRED, NOT DISCARDED, AND IT SAYS WHICH RULE. The run exists, it is on the list, and the
     * reason is printed against it — because "the firm is in a cost mode that does not run this"
     * and "the AI is broken" look identical to an operator unless one of them is written down.
     */
    await expect(page.getByTestId("ai-message")).toContainText("BLOCKED_DEFERRED");
    const blockedRun = page.locator('li[data-testid^="ai-run-"]').filter({ hasText: `${marker} tidy up` }).first();
    await expect(blockedRun).toBeVisible();
    await expect(blockedRun).toContainText("defer_non_critical");

    // NOTHING WAS BOUGHT, and the spend definition says so: a refused run counts as nothing,
    // because nothing was bought.
    const run = (await (await request.get("/api/ai/runs", { headers: MP })).json()) as {
      runs: Array<{ purpose: string; status: string; failure_reason: string | null }>;
    };
    const mine = run.runs.find((r) => r.purpose.includes(`${marker} tidy up`))!;
    expect(mine.status).toBe("BLOCKED_DEFERRED");
    expect(mine.failure_reason).toContain("defer_non_critical");

    // Work the firm HAS decided is critical still runs — a ceiling is a priority, not a shutdown.
    const critical = await request.post("/api/ai/run", {
      headers: MP,
      data: {
        purpose: `${marker} IC packet gap analysis`,
        inputs: ["What is missing from this committee packet?"],
        sensitivity: "INTERNAL",
      },
    });
    expect(critical.status(), await critical.text()).toBe(201);
    expect(((await critical.json()) as { status: string }).status).toBe("COMPLETED");
  } finally {
    /*
     * PUT THE FIRM BACK. Every spec after this one drives the same database, and leaving the firm in
     * deferring non-critical work would refuse their runs for a reason that has nothing to do with them — which is
     * the state this suite's README warns about: "anything a spec switches off is switched off for
     * everything after it".
     */
    await request.post("/api/ai/budget", {
      headers: MP,
      data: { spend_lever: "MODERATE", defer_non_critical: false, privacy_mode: "LOCKDOWN", daily_cap_usd: 25, per_run_cap_usd: 5 },
    });
    await request.post("/api/ai/firm-budget", {
      headers: MP,
      data: { budget_window: "MONTHLY", cap_cents: 25_000, reason: `${marker} fixture retired`, active: false },
    });
  }
});

// ── helpers ────────────────────────────────────────────────────────────────────────────────────

type Ctx = import("@playwright/test").APIRequestContext;

async function checkState(request: Ctx, key: string): Promise<string> {
  const body = (await (await request.get("/api/diagnostics/health", { headers: MP })).json()) as {
    checks: Array<{ key: string; state: string }>;
  };
  const check = body.checks.find((c) => c.key === key);
  expect(check, `the ${key} check must exist`).toBeTruthy();
  return check!.state;
}

/** Run the diagnostics sweep the way the cron would, and hand back what it said it did. */
async function sweep(request: Ctx): Promise<string> {
  const res = await request.post("/api/jobs/diagnostics_sweep/run", { headers: MP });
  expect([200, 201], await res.text()).toContain(res.status());
  const body = (await res.json()) as { run: { status: string; outcome_summary: string } };
  expect(body.run.status, "the sweep itself must not be what fails").toBe("SUCCEEDED");
  return body.run.outcome_summary;
}

interface NotificationRow {
  id: string;
  severity: string;
  title: string;
  body: string;
  object_id: string;
  dedupe_key: string;
}

/**
 * The notifications a health check produced, READ FROM THE DATABASE and not from the route.
 *
 * `GET /api/notifications` orders CRITICAL → WARNING → INFO and stops at 200. A firm that has
 * accumulated two hundred warnings therefore cannot see ANY of its INFO rows through that route —
 * including every diagnostics all-clear, which is precisely the row this journey has to look at.
 * That is a real limit of the route and it is reported rather than worked around in the product;
 * here the ledger is read directly, which is what `queryLocalD1` exists for: "the handful of facts
 * no route serves".
 */
function notificationsAbout(checkKey: string): NotificationRow[] {
  return queryLocalD1<NotificationRow>(
    `SELECT id, severity, title, body, object_id, dedupe_key
       FROM notification
      WHERE object_id = '${checkKey}' AND object_type = 'health_fault'
      ORDER BY created_at`,
  );
}
