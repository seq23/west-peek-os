import { expect, test } from "@playwright/test";
import { gotoSurface } from "./support/nav";
import { queryLocalD1 } from "./support/provision";
import { addressOf, deliverMail, tinyPdfBase64 } from "./support/mail";

/**
 * A DECK ARRIVES BY EMAIL AND ENDS UP ON THE COMPANY CARD.
 *
 * Operator, 22 Aug 2026: "if we snd a deck the employee extracts all relevant info and fills in gaps
 * in the deal flow tab's company card. if its a new company they create a new one. if existing they
 * update it."
 *
 * This chain had never been run end to end by anything. Each link had unit coverage and the joins
 * did not: `inboundEmail` → `pdfAttachments()` → `dealIntake` (R2 + a `pending_deck` row) → the
 * `deck_reading` job → `deckReader.readDeck` → the blanks on `canonical_company`. The mailbox is
 * also where this system has already lost a real deck, so the handler itself is what these journeys
 * drive: a genuine RFC822 message delivered to `email()`, not a function called around it.
 *
 * WHAT IS ASSERTED, AND WHERE IT STOPS.
 *
 * Reading a deck is a model call. Under local `wrangler dev` there is no provider credential and
 * privacy mode is LOCKDOWN, so `run_ai` routes to the deterministic `mock-local` model, which
 * answers with a fixed sentence rather than a deck summary. That is a real answer from the governed
 * boundary and it is honest about what it is — so these journeys assert the whole chain UP TO the
 * model's words, and assert the queue's own behaviour around it: the deck was stored, picked up,
 * attempted by the right employee, and the reason it could not be used was WRITTEN DOWN rather than
 * swallowed. Which fields a real model would fill, and the rule that a field a person typed is
 * kept, cannot be proven here and are not claimed.
 */

const MP = { "x-wpos-dev-user": "scooter@westpeek.ventures" };
const FOUNDER = "Ada Reyes <ada@northwind-robotics.example>";

interface PendingDeck {
  id: string;
  state: string;
  detail: string | null;
  filename: string;
  object_key: string;
  bytes: number;
  company_id: string;
}

async function signIn(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  const login = page.getByTestId("dev-login-email");
  await login.waitFor({ state: "visible" });
  await login.fill("scooter@westpeek.ventures");
  await page.getByTestId("dev-login-submit").click();
  await expect(page.getByTestId("identity-status")).toContainText("Scooter Taylor");
}

/** Run the deck queue the way the cron would, and hand back what it said it did. */
async function runDeckReading(request: import("@playwright/test").APIRequestContext): Promise<string> {
  const res = await request.post("/api/jobs/deck_reading/run", { headers: MP });
  expect(res.status(), await res.text()).toBe(201);
  const body = (await res.json()) as { run: { status: string; outcome_summary: string } };
  expect(body.run.status).toBe("SUCCEEDED");
  return body.run.outcome_summary;
}

test("a deck emailed about a company we already have is stored, queued, and read by the analyst", async ({ page, request }) => {
  const company = `Northwind Robotics ${Date.now()}`;

  // The company is already on the register, with a one-liner a PERSON typed. That field is the one
  // the deck must never overwrite, and it is the reason this journey uses an existing company.
  const created = await request.post("/api/companies", {
    headers: MP,
    data: { canonical_name: company, one_liner: "Typed by a partner, and not the deck's to change." },
  });
  expect(created.status(), await created.text()).toBe(201);
  const companyId = ((await created.json()) as { id: string }).id;

  // Nothing is waiting before the mail arrives — so "1 could not be read" below cannot be somebody
  // else's deck.
  expect(await runDeckReading(request)).toBe("no decks waiting");

  await deliverMail(request, {
    from: FOUNDER,
    subject: `#wpdeck ${company}`,
    parts: [
      { contentType: "text/plain; charset=utf-8", body: `Company: ${company}\n\nDeck attached — would love your thoughts.` },
      { contentType: "application/pdf", filename: "northwind-seed.pdf", encoding: "base64", body: tinyPdfBase64(200) },
    ],
  });

  /*
   * THE BYTES WERE KEPT, AND THE ROW SAYS WHOSE THEY ARE.
   *
   * No route serves `pending_deck`, and this is the step the whole feature turns on: the email
   * handler has 10ms of CPU, so it stores and stops, and everything after this is somebody else's
   * budget. If this row is missing the deck is gone, and the work card would still cheerfully tell
   * the analyst to go and read it.
   */
  const queued = queryLocalD1<PendingDeck>(
    `SELECT id, state, detail, filename, object_key, bytes, company_id FROM pending_deck WHERE company_id = '${companyId}'`,
  );
  expect(queued, "the emailed deck must be stored and queued against the company it names").toHaveLength(1);
  expect(queued[0]!.state).toBe("PENDING");
  expect(queued[0]!.filename).toBe("northwind-seed.pdf");
  expect(queued[0]!.bytes).toBeGreaterThan(0);

  // The analyst has the card, and it says the substance is in the attachment.
  const cards = (await (await request.get("/api/work-cards", { headers: MP })).json()) as {
    work_cards: Array<{ title: string; description: string; owner_id: string | null }>;
  };
  const card = cards.work_cards.find((c) => c.title.includes(company));
  expect(card, "an emailed deck must open a card somebody owns").toBeTruthy();
  expect(card!.description).toContain("northwind-seed.pdf");
  // The ORIGINAL sender is the source, not the mailbox and not a relay.
  expect(card!.description).toContain(addressOf(FOUNDER));

  /*
   * THE QUEUE PICKS IT UP AND GOES THROUGH THE GOVERNED AI BOUNDARY.
   *
   * "1 could not be read" is the honest local outcome and is asserted as such: the deck WAS taken
   * off the queue and attempted, and the local mock model's answer was not a deck summary. The
   * distinction this suite must not blur is between that and "nothing was waiting" — those are the
   * two outcomes that look identical on a company card unless the reason is written down.
   */
  const summary = await runDeckReading(request);
  expect(summary).toContain("could not be read");

  const afterwards = queryLocalD1<PendingDeck>(
    `SELECT id, state, detail, filename, object_key, bytes, company_id FROM pending_deck WHERE company_id = '${companyId}'`,
  );
  expect(afterwards[0]!.state).toBe("FAILED");
  expect(afterwards[0]!.detail, "a deck that could not be read must say why").toBeTruthy();
  expect(afterwards[0]!.detail!.trim().length).toBeGreaterThan(0);

  // It was WYATT who read it, through `run_ai`, with the deck as a document — not a direct
  // provider call and not an unattributed run.
  const runs = (await (await request.get("/api/ai/runs?limit=20", { headers: MP })).json()) as {
    runs: Array<{ purpose: string; actor_type: string; actor_id: string }>;
  };
  const deckRun = runs.runs.find((r) => r.purpose.includes("northwind-seed.pdf"));
  expect(deckRun, "reading a deck must go through the governed AI boundary").toBeTruthy();
  expect(deckRun!.actor_type).toBe("AI");

  /*
   * NOTHING A PERSON TYPED WAS TOUCHED. The rule survives the failure path too, which is the point:
   * a deck that could not be read must leave the record exactly as it found it.
   */
  const record = (await (await request.get(`/api/companies/${companyId}`, { headers: MP })).json()) as {
    one_liner: string | null;
  };
  expect(record.one_liner).toBe("Typed by a partner, and not the deck's to change.");

  // And the operator can see the company's record on Dealflow, under the name she would look for.
  await signIn(page);
  await gotoSurface(page, "Dealflow");
  await page.getByTestId("deal-record-company").selectOption({ label: company });
  await expect(page.getByTestId("deal-record")).toBeVisible();
  await expect(page.getByTestId("deal-record-company-name")).toContainText(company);
});

/*
 * A DECK FOR A COMPANY THE FIRM HAS NEVER HEARD OF — the other half of the operator's sentence,
 * "if its a new company they create a new one".
 *
 * IT DOES NOT WORK, AND THE BYTES ARE DISCARDED. `ROUTE_POLICY.EMAIL.opensRecord` is false, so an
 * unmatched company creates no `canonical_company` — correct, and deliberate: a hashtag is a public
 * word and may route but must never authorise. The problem is what happens NEXT. The attachment
 * loop in `dealIntake.ts` reads `if (!companyId) break;`, so with no company there is no R2 object
 * and no `pending_deck` row — while the card raised in the same breath tells the analyst
 * "Deck attached: x.pdf … Read it before judging whether this is thin."
 *
 * So the firm keeps a card that points at a file it threw away. That is the same class of failure
 * as the 7MB deck logged `too_large` and dropped: the loss is invisible, and the record actively
 * says otherwise. The oversize path already solved it — stream the bytes to R2 and put the key on
 * the card — and nothing here does.
 *
 * FIXED 22 Aug 2026, and the marker removed. `pending_deck.company_id` is nullable and the deck is
 * kept against the WORK CARD until a company exists — the EMAIL route deliberately does not write
 * the pipeline, so a brand-new company has no record to attach a deck to at the moment it arrives.
 * Losing the attachment is not an acceptable way to respect that boundary.
 */
test("a deck for a company we have never heard of is still KEPT, not thrown away", async ({ request }) => {
  const company = `Unheard Of Labs ${Date.now()}`;

  await deliverMail(request, {
    from: `Sam Okafor <sam@unheard.example>`,
    subject: `#wpdeck ${company}`,
    parts: [
      { contentType: "text/plain; charset=utf-8", body: `Company: ${company}\n\nOur deck is attached.` },
      { contentType: "application/pdf", filename: "unheard-seed.pdf", encoding: "base64", body: tinyPdfBase64(50) },
    ],
  });

  // Either the bytes are queued for reading, or they are in the document store with the card
  // pointing at them. Today neither is true.
  const queued = queryLocalD1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pending_deck WHERE filename = 'unheard-seed.pdf'`,
  );
  expect(Number(queued[0]!.n), "the attachment must survive even when the company does not exist yet").toBeGreaterThan(0);
});

test("a message too large to parse is stored, routed from its headers, and opens a card", async ({ page, request }) => {
  /*
   * THE FAILURE THIS EXISTS FOR HAPPENED IN PRODUCTION. Operator, 22 Aug 2026: "we got an updated
   * deck for sensori overnight to os@joinwestpeek.com." It had arrived at 03:29, been logged
   * `too_large` at 7,093,115 bytes, and been discarded — silently. She found out by asking.
   *
   * 400KB: comfortably over the handler's own 256KB parse cap, which is the boundary under test,
   * and under miniflare's 1MiB local delivery limit. Production allows 25MiB.
   */
  const company = `Sensori ${Date.now()}`;
  await deliverMail(request, {
    from: `Founder <founder@sensori.example>`,
    subject: `#wpdealflow ${company}`,
    parts: [
      { contentType: "text/plain; charset=utf-8", body: `Company: ${company}` },
      { contentType: "application/pdf", filename: "sensori-huge.pdf", encoding: "base64", body: tinyPdfBase64(40_000) },
    ],
  });

  // It was NOT dropped: the spine says so, with the size and what the headers routed it as.
  const activity = (await (await request.get("/api/activity?limit=50", { headers: MP })).json()) as {
    events: Array<{ event_type: string; payload_json?: string; payload?: Record<string, unknown> }>;
  };
  const tooLarge = activity.events.find((e) => e.event_type === "inbound_email.too_large_to_read");
  expect(tooLarge, "an oversized message must be recorded, never silently discarded").toBeTruthy();
  const payload = JSON.stringify(tooLarge!.payload ?? tooLarge!.payload_json ?? "");
  expect(payload, "the size is on the record").toContain("bytes");
  // Routed from the SUBJECT alone — headers are already parsed and cost nothing, which is the whole
  // reason an unreadable body does not have to mean an unroutable message.
  expect(payload).toContain("#wpdealflow");

  /*
   * A person can see it, and the card says where the message itself is.
   *
   * The whole message is streamed to the document store on arrival — "storing bytes to R2 is I/O,
   * not CPU… while PARSING the same bytes would exhaust the 10ms budget" — and the card names the
   * key, which is what makes the arrival RECOVERABLE rather than merely reported. That key on the
   * card is the assertion: an R2 object nothing points at is the same as no object.
   */
  await signIn(page);
  await gotoSurface(page, "Work");
  const card = page.locator('li[data-testid^="work-card-"]').filter({ hasText: "Too big to read" }).first();
  await expect(card).toBeVisible();
  await card.getByTestId(/^work-card-toggle-/).click();
  const body = card.locator('[data-testid^="work-card-findings-"]');
  await expect(body).toContainText("too large to open inside one request");
  await expect(body).toContainText("#wpdealflow");
  // Where the message itself is kept, said explicitly — the operator must not have to go and hunt.
  await expect(body).toContainText("inbound-email/");
});

test("a #wpnetwork message whose person cannot be read opens a card instead of failing quietly", async ({ page, request }) => {
  /*
   * Operator: "no inbound emails to os@joinwestpeek.com should silently fail."
   *
   * Somebody deliberately tagged a person for the firm's network. If the name cannot be read, or the
   * relay to Network OS refuses, doing nothing looks exactly like having done it — which is the
   * worst possible outcome for the one branch of this handler that used to end in silence.
   */
  const marker = `E2E-NET-${Date.now()}`;
  await deliverMail(request, {
    from: `Someone <someone@example.com>`,
    subject: `#wpnetwork ${marker}`,
    // Deliberately no `Name:` line — there is nothing here a person could be read out of.
    body: "you should meet this person, they are great",
  });

  await signIn(page);
  await gotoSurface(page, "Work");
  const card = page.locator('li[data-testid^="work-card-"]').filter({ hasText: marker }).first();
  await expect(card, "a #wpnetwork mail with no readable person must open a card").toBeVisible();
  await card.getByTestId(/^work-card-toggle-/).click();
  await expect(card.locator('[data-testid^="work-card-findings-"]')).toContainText("not added");
});

test("a forwarded deck is filed under the founder, and the subject prefixes are stripped off the name", async ({ page, request }) => {
  /*
   * MOST MAIL TO THIS BOX IS FORWARDED. Operator, 22 Aug 2026: "most of the emails to this inbox
   * will be forwards and the important info will be in the original email below."
   *
   * Two things have to survive that, and both are provenance: WHO it came from, and WHAT it is
   * about. Without the first, the register says a partner sourced every deal in Fund I, which
   * answers nothing at LP diligence. Without the second, `Fwd: FW: Re: Sensori` becomes a second
   * company called "FW: Re: Sensori" beside the one already on the board — the exact duplicate the
   * CanonicalCompany model exists to prevent.
   */
  const company = `Sensori Forwarded ${Date.now()}`;
  const created = await request.post("/api/companies", { headers: MP, data: { canonical_name: company } });
  expect(created.status()).toBe(201);

  await deliverMail(request, {
    // The partner forwarding it…
    from: `Scooter Taylor <scooter@westpeek.ventures>`,
    subject: `Fwd: FW: Re: ${company}`,
    body: [
      "Worth a look.",
      "",
      "---------- Forwarded message ----------",
      "From: Ada Reyes <ada@sensori.example>",
      `Subject: #wpdealflow ${company}`,
      "To: Scooter Taylor <scooter@westpeek.ventures>",
      "",
      `Company: ${company}`,
      "We are raising a seed round.",
    ].join("\n"),
  });

  const cards = (await (await request.get("/api/work-cards", { headers: MP })).json()) as {
    work_cards: Array<{ title: string; description: string }>;
  };
  const card = cards.work_cards.find((c) => c.title.includes(company));
  expect(card, "a forwarded deal mail must open a card about the company, correctly named").toBeTruthy();

  // …is not who it came from. The founder is the source; the partner is recorded as the forwarder.
  expect(card!.description).toContain("ada@sensori.example");
  // And the company matched the one already on the board rather than opening a second record.
  expect(card!.description).toContain("already a company on record");
  expect(card!.title).not.toContain("Fwd:");
  expect(card!.title).not.toContain("FW:");
  expect(card!.title).not.toContain("Re:");

  // On Dealflow the operator finds ONE company under the name she would look for.
  await signIn(page);
  await gotoSurface(page, "Dealflow");
  const picker = page.getByTestId("deal-record-company");
  await expect(picker).toBeVisible();
  // ONE entry, not two. `Fwd: FW: Re: Sensori` matching the company already on the board is the
  // whole point; a second row called "FW: Re: Sensori" is the duplicate CanonicalCompany exists to
  // prevent. Polled because the register loads after the page paints.
  await expect
    .poll(async () => (await picker.locator("option").allTextContents()).filter((o) => o.includes(company)).length)
    .toBe(1);
});

test("#wpdeck with nothing attached still opens the company, and does not send the analyst looking", async ({ request }) => {
  /*
   * The two tags are SYNONYMS now, and whether a deck gets read is decided by looking rather than by
   * which word was typed (`inboundEmail.ts`: "a rule that depends on a human remembering… fails the
   * first time one does not"). The half that matters here is the failure mode: telling the analyst
   * "the substance is in the attachment" when there is no attachment sends him looking for something
   * that does not exist.
   */
  const company = `Tagless ${Date.now()}`;
  const created = await request.post("/api/companies", { headers: MP, data: { canonical_name: company } });
  expect(created.status()).toBe(201);

  await deliverMail(request, {
    from: `Ravi <ravi@tagless.example>`,
    subject: `#wpdeck ${company}`,
    body: `Company: ${company}\n\nNo deck yet — happy to send one.`,
  });

  const cards = (await (await request.get("/api/work-cards", { headers: MP })).json()) as {
    work_cards: Array<{ title: string; description: string; prompt: string | null }>;
  };
  const card = cards.work_cards.find((c) => c.title.includes(company));
  expect(card, "the company still enters the funnel whichever tag was used").toBeTruthy();
  expect(card!.description).not.toContain("Deck attached");
  expect(
    card!.prompt ?? "",
    "nobody should be told to read an attachment that was never sent",
  ).not.toContain("substance is in the attachment");

  // And nothing was queued for reading, because there is nothing to read.
  const queued = queryLocalD1<{ n: number }>(
    `SELECT COUNT(*) AS n FROM pending_deck WHERE filename LIKE '%tagless%'`,
  );
  expect(Number(queued[0]!.n)).toBe(0);
});
