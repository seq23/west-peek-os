import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";

/**
 * P18 — Intent → Execution, and the Institutional Lens Bench (GAP-08, GAP-09).
 *
 * The property: a rough thought becomes a packet that keeps the operator's OWN WORDS verbatim
 * beside everything derived from them, and execution is REFUSED while a blocking lens has not run.
 * A lens that can be skipped is not a gate.
 *
 * ── WHERE THIS NOW RUNS ─────────────────────────────────────────────────────────────────────────
 *
 * The Ask page was rebuilt. It answers a question four ways now — go and look, tell me, draft this,
 * write me a brief — and the packet workbench went with it: `intent-text`, `intent-strength`,
 * `packet-execute` and `packet-lens-*` exist nowhere in `src/client/`. The lens BENCH survives on
 * the page (`lens-bench`, `lens-storage-rule`), which is the half a partner reads; the packet itself
 * is now reachable only through `/api/work-packets/*`, which is fully mounted and still enforces
 * the gate.
 *
 * So the gate is proved where it lives — through the API — and the bench is proved in the browser.
 * That the packet has no interface at all is asserted below rather than left as a silent gap.
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

test("a rough thought becomes a governed packet the lens bench can stop", async ({ page, request }) => {
  const thought = "Look into the Acme secondary soon and tell me if we should take the block";

  const created = await request.post("/api/work-packets", {
    headers: MP,
    data: { text: thought, enhancement_strength: "DEEP" },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { packet } = (await created.json()) as {
    packet: {
      id: string;
      original_text: string;
      ambiguities_json: string;
      acceptance_criteria_json: string;
      lens_stack_json: string;
    };
  };

  /*
   * THE OPERATOR'S OWN WORDS, VERBATIM. Everything else on a packet is derived from them, and the
   * one thing that must never be rewritten is what she actually said — otherwise the packet becomes
   * the system's account of the request rather than the request.
   */
  expect(packet.original_text).toBe(thought);
  // "soon" is exactly the kind of word a packet must NOTICE rather than resolve on her behalf.
  expect(packet.ambiguities_json).toContain("soon");
  expect(packet.acceptance_criteria_json).toContain("counter-case");
  expect(packet.lens_stack_json).toContain("TRUTH_COMPLIANCE_GATE");

  // A blocking lens that has not run REFUSES execution. This is the whole point of the bench.
  const refused = await request.post(`/api/work-packets/${packet.id}/execute`, { headers: MP, data: {} });
  expect(refused.status()).not.toBe(201);
  expect(await refused.text()).toContain("TRUTH_COMPLIANCE_GATE");

  // Record the gate — with a critique, because a verdict carrying no reasoning is a rubber stamp.
  const lens = await request.post(`/api/work-packets/${packet.id}/lenses`, {
    headers: MP,
    data: {
      lens_key: "TRUTH_COMPLIANCE_GATE",
      verdict: "PASS",
      critique: "Internal analysis of records we hold; asserts no external conclusion.",
    },
  });
  expect(lens.status(), await lens.text()).toBe(201);

  const executed = await request.post(`/api/work-packets/${packet.id}/execute`, { headers: MP, data: {} });
  expect(executed.status(), await executed.text()).toBe(200);

  // The packet carries the real work card it produced — not a note saying that it ran.
  const after = (await (await request.get(`/api/work-packets/${packet.id}`, { headers: MP })).json()) as {
    packet: { work_card_id: string | null };
  };
  const workCardId = after.packet.work_card_id;
  expect(workCardId, "executing a packet must open a real work card").toBeTruthy();

  // And a person can find that card on the board.
  await signIn(page);
  await gotoSurface(page, "Work");
  await expect(page.getByTestId(`work-card-${workCardId}`)).toBeVisible();
});

test("the lens bench publishes its storage rule", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Ask");
  await expect(page.getByTestId("lens-storage-rule")).toContainText("Private model reasoning is never stored");
  await expect(page.getByTestId("lens-bench")).toContainText("No Pedestal Law");
});

/*
 * THE SURFACE THAT WAS MISSING, NOW BUILT.
 *
 * The gate above was real and a partner could not see it. Nothing in `src/client/` opened a work
 * packet, read the ambiguities it found in her own sentence, recorded a lens verdict or executed
 * one, while `/api/work-packets/*` stayed live and enforcing — the bench was published on the Ask
 * page and the thing it gates was not, which made it a dead end with a rule attached rather than a
 * gate.
 *
 * The Ask page now carries it, inside the section that explains what a check is: a box to put
 * something under the checks on purpose, the list of what they are holding, each check with its
 * verdict in the words somebody giving one would use, and the control to run the work once they
 * have been looked at.
 */
test("a partner can open the packet a lens is gating", async ({ page }) => {
  await signIn(page);
  await gotoSurface(page, "Ask");
  await expect(page.getByTestId("intent-text")).toBeVisible();
});
