import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/*
 * AN ASK OF THE OWNER IS NEVER A TASK THE SYSTEM COULD DO (7 Oct 2026).
 *
 * Wyatt emailed Sequoia "a question — Deal-flow intake": forward the founder's email again, because
 * his card's tools could not open the stored message or put the company on the board. Three defects,
 * each pinned here: the door refused a forward whose own original named the company; every card
 * quote-stripped the forwarded original away; and the loop had no executor for deal flow, so the
 * employee's only move was to ask her. Plus the gate that refuses any such ask from now on.
 * Fixtures are fictional — no real company or round is in this file.
 */
const replies: string[] = [];
vi.mock("../src/worker/ai/runAi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/worker/ai/runAi")>();
  return {
    ...actual,
    runAi: async (_env: unknown, input: { purpose: string; inputs: string[] }) => {
      const text = replies.shift() ?? '{"action":"note","finding":"(no scripted reply)"}';
      return { run: { id: `run_${crypto.randomUUID()}`, status: "COMPLETED", output_text: text, failure_reason: null } };
    },
  };
});

import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { dealFromMessage, forwardedCompany, readableMessage } from "../src/worker/services/dealIntake";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { sweepOnce } from "../src/worker/services/workSweep";
import { handleReingestStoredEmail } from "../src/worker/services/webPropertyChange";
import { executorsFor, ownerAskRefusal, WORK_EXECUTORS } from "../src/shared/work/ownerAsk";
import { buildStepPrompt, EMPLOYEE_ACTIONS, parseDecision } from "../src/shared/work/employeeLoop";

const STAFF = ["Porter", "Wyatt", "Wren", "Walker", "Preston"];

/** An iPhone Mail forward: html only, the tag above, the founder's pitch in a blockquote. */
function iphoneForward(subject: string, founderAddress: string, pitch: string, messageId: string): string {
  const html = [
    '<html><body dir="auto">#wpdealflow<div><br></div><div dir="ltr">Sequoia Taylor<div>General Partner</div></div>',
    '<div dir="ltr"><br>Begin forwarded message:<br><br></div><blockquote type="cite"><div dir="ltr">',
    `<b>From:</b> Ada Reyes &lt;${founderAddress}&gt;<br><b>Subject:</b> <b>${subject.replace(/^Fwd:\s*/, "")}</b><br></div></blockquote>`,
    `<blockquote type="cite"><div dir="ltr"><p>Hi Sequoia,</p><p>${pitch}</p><p>Ada Reyes<br>${founderAddress}</p></div></blockquote></body></html>`,
  ].join("");
  return [
    'Content-Type: multipart/alternative; boundary="b1"',
    'From: "S.L. Taylor" <sequoia@westpeek.ventures>',
    "Mime-Version: 1.0 (1.0)",
    `Subject: ${subject}`,
    `Message-Id: <${messageId}>`,
    "References: <founder-thread@mail.example>",
    "To: os@joinwestpeek.com",
    "",
    "--b1",
    "Content-Type: text/html; charset=utf-8",
    "",
    html,
    "--b1--",
    "",
  ].join("\r\n");
}

describe("the gate: an ask reaches a partner only when it is a decision or something only she holds", () => {
  // The 7 Oct ask, word for word in shape, company name generic.
  const realNeeds =
    "What is waiting: the Acme intake (forwarded by Sequoia Taylor). Why it is waiting: this card's tools are web search, page visits, notes and hand-offs. None of them can read the firm's deal board or open the stored message inbound-email/2026-10-07/x.eml.";
  const realMissing = [
    { item: "The original forwarded Acme email (the thread that did not come through), forwarded as an attachment", where: "Email to os@joinwestpeek.com with #wpdealflow" },
    { item: "The Acme deck, if one exists", where: "Attached to the same email, or added to the deal's Drive folder" },
  ];

  it("refuses the 7 Oct ask, both in its sentence and in its missing list", () => {
    expect(ownerAskRefusal({ needs: realNeeds, missing: realMissing, holdsStoredMessage: true, staffNames: STAFF })?.rule).toBe("SYSTEM_HOLDS_IT");
    expect(ownerAskRefusal({ needs: "Please confirm.", missing: realMissing.slice(0, 1), holdsStoredMessage: true, staffNames: STAFF })?.rule, "the missing list alone is enough").toBe("SYSTEM_HOLDS_IT");
    expect(ownerAskRefusal({ needs: realNeeds, holdsStoredMessage: false, staffNames: STAFF })?.rule, "'my tools cannot' is our gap even with nothing stored").toBe("TOOLS_CANNOT");
  });

  it("refuses chasing staff and manual steps", () => {
    expect(ownerAskRefusal({ needs: "Could you check on Porter and see whether the site is live?", holdsStoredMessage: false, staffNames: STAFF })?.rule).toBe("CHASE_STAFF");
    expect(ownerAskRefusal({ needs: "Or do it yourself if he is busy.", holdsStoredMessage: false, staffNames: STAFF })?.rule).toBe("CHASE_STAFF");
    expect(ownerAskRefusal({ needs: "Please add the company to the pipeline so I can continue.", holdsStoredMessage: false, staffNames: STAFF })?.rule).toBe("MANUAL_STEP");
    expect(ownerAskRefusal({ needs: "Copy and paste the founder's reply here.", holdsStoredMessage: false, staffNames: STAFF })?.rule).toBe("MANUAL_STEP");
  });

  it("lets a real decision, a material only she has, and a secret or login through", () => {
    for (const needs of [
      "Should the memo use the 409A valuation or the last round's price?",
      "Which of the two venues do you want for the November Room?",
      "I need the fund logo and the Q3 letter to build this.",
      "Sign in to the KDP account and approve the two-factor prompt — only you hold that login.",
    ]) {
      expect(ownerAskRefusal({ needs, holdsStoredMessage: true, staffNames: STAFF }), needs).toBeNull();
    }
  });
});

describe("the door: a forward is the payload, and its original can name the company", () => {
  const raw = iphoneForward("Fwd: Tidepool Robotics | seed round", "ada@tidepoolrobotics.example", "I'm Ada, founder of Tidepool Robotics. We build reef-survey drones.", "fwd-1@westpeek.ventures");

  it("keeps the forwarded original on the card (it used to be quote-stripped to her signature)", () => {
    const text = readableMessage(raw);
    expect(text).toContain("founder of Tidepool Robotics");
    expect(text).toContain("ada@tidepoolrobotics.example");
  });

  it("still strips the quote from a REPLY", () => {
    const reply = ["From: sequoia@westpeek.ventures", "Subject: Re: Wyatt: a question", "In-Reply-To: <x@y>", "", "Go ahead.", "", "On Wed, 7 Oct 2026, Wyatt wrote:", "> the question"].join("\r\n");
    expect(readableMessage(reply)).toBe("Go ahead.");
  });

  it("reads the company out of the subject's lead only when the forwarded original confirms it", () => {
    expect(forwardedCompany("Fwd: Tidepool Robotics | seed round", readableMessage(raw))).toEqual({ name: "Tidepool Robotics", by: "an address at tidepoolrobotics.example in the forwarded message" });
    expect(forwardedCompany("Fwd: Tidepool Robotics — intro", "I'm the co-founder of Tidepool Robotics.")?.name).toBe("Tidepool Robotics");
    expect(forwardedCompany("Fwd: check this out", "Hi from ada@gmail.com"), "no evidence, no company").toBeNull();
    expect(forwardedCompany("Fwd: West Peek", "sequoia@westpeek.ventures"), "the firm's own address never confirms a company").toBeNull();
    expect(dealFromMessage("Fwd: Tidepool Robotics | seed round", raw, "sequoia@westpeek.ventures", false)?.corroborated?.name).toBe("Tidepool Robotics");
  });
});

describe("end to end: the forward lands in the funnel, and a deal-flow card is worked, never asked of her", () => {
  let t: TestDb;
  let env: Env;
  const sent: Array<{ to: string; subject: string }> = [];
  let clock = Date.now();

  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db, { WP_OS_AI_EMAIL_PARTNERS: "enabled", WP_OS_EMAIL_SEND: "enabled", RESEND_API_KEY: "re_test_not_a_real_key", WP_OS_EMAIL_FROM: "os@westpeek.ventures", WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("api.resend.com")) {
        const body = JSON.parse(String(init?.body)) as { to: string[]; subject: string };
        sent.push({ to: body.to[0]!, subject: body.subject });
        return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    });
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_wyatt')").run();
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await disposeTestDb(t);
  });

  const deliver = async (raw: string, subject: string, id: string) =>
    handleInboundEmail(
      {
        from: "sequoia@westpeek.ventures",
        to: "os@joinwestpeek.com",
        headers: new Headers({ from: '"S.L. Taylor" <sequoia@westpeek.ventures>', to: "os@joinwestpeek.com", subject, "message-id": `<${id}>`, references: "<founder-thread@mail.example>", "authentication-results": "mx.cloudflare.net; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass" }),
        raw: new Blob([raw]).stream(),
        rawSize: raw.length,
      },
      env,
    );

  it("the 7 Oct shape — tag in the body, new company, html-only forward — opens the company in the funnel at arrival", async () => {
    const subject = "Fwd: Tidepool Robotics | seed round";
    await deliver(iphoneForward(subject, "ada@tidepoolrobotics.example", "I'm Ada, founder of Tidepool Robotics. We build reef-survey drones.", "e2e-1@westpeek.ventures"), subject, "e2e-1@westpeek.ventures");
    const opp = await env.WP_OS_DB.prepare(
      "SELECT o.id FROM investment_opportunity o JOIN canonical_company c ON c.id = o.company_id WHERE c.canonical_name = 'Tidepool Robotics'",
    ).first<{ id: string }>();
    expect(opp, "the deal is on the board the moment it arrives").not.toBeNull();
    const porter = await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE title LIKE 'Unclear email:%Tidepool%'").first();
    expect(porter, "no 'Unclear email' card for a forward whose original names the company").toBeNull();
  });

  it("an unreadable deal-flow forward: the holder is offered open_in_funnel with the original in front of it; asking her to re-forward is refused; the work gets done and nobody emails her", async () => {
    const subject = "Fwd: quick intro";
    await deliver(iphoneForward(subject, "ada.reyes@gmail.example", "We are Kelpline, building kelp-farm sensors.", "e2e-2@westpeek.ventures"), subject, "e2e-2@westpeek.ventures");
    const routing = (await env.WP_OS_DB.prepare("SELECT id FROM work_card WHERE title = 'Unclear email: Fwd: quick intro'").first<{ id: string }>())!;
    expect(routing).toBeTruthy();
    // Only this card is waiting, so the scripted replies are its own.
    await env.WP_OS_DB.prepare("UPDATE work_card SET state = 'CANCELLED' WHERE id != ?1 AND state NOT IN ('DONE', 'CANCELLED')").bind(routing.id).run();
    sent.length = 0;
    replies.push(
      '{"action":"blocked","needs":"The forwarded content did not come through. Please forward the original email again.","missing":[{"item":"the original forwarded email","where":"os@joinwestpeek.com"}]}',
      '{"action":"open_in_funnel","company":"Kelpline","one_liner":"kelp-farm sensors"}',
    );
    let state = "";
    for (let i = 0; i < 10 && state !== "DONE"; i++) {
      clock += 6 * 60_000;
      await sweepOnce(env, new Date(clock));
      state = (await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(routing.id).first<{ state: string }>())!.state;
    }
    expect(state).toBe("DONE");
    const desc = (await env.WP_OS_DB.prepare("SELECT description FROM work_card WHERE id = ?1").bind(routing.id).first<{ description: string }>())!.description;
    expect(desc).toMatch(/Not asked of a partner \(SYSTEM_HOLDS_IT\)/);
    expect(desc).toMatch(/Opened Kelpline in the funnel/);
    const kept = await env.WP_OS_DB.prepare("SELECT r2_key FROM inbound_message WHERE work_card_id = ?1").bind(routing.id).first<{ r2_key: string }>();
    expect(kept, "the original is stored against the card, which is what the executor reads").not.toBeNull();
    expect(await env.WP_OS_DB.prepare("SELECT COUNT(*) AS n FROM event_record WHERE event_type = 'work_card.owner_ask_refused'").first<{ n: number }>()).toEqual({ n: 1 });
    const opp = await env.WP_OS_DB.prepare("SELECT o.id FROM investment_opportunity o JOIN canonical_company c ON c.id = o.company_id WHERE c.canonical_name = 'Kelpline'").first();
    expect(opp).not.toBeNull();
    expect(sent.filter((m) => /a question/i.test(m.subject)), "no 'a question' email to a partner").toEqual([]);
  });
});

describe("a re-read of the stored message supersedes the hand-off the earlier read produced", () => {
  let t: TestDb;
  let env: Env;
  beforeAll(async () => {
    t = await createTestDb();
    env = makeTestEnv(t.db, { WP_OS_DOCUMENTS: t.docs } as Partial<Env>);
    await env.WP_OS_DB.prepare("UPDATE ai_employee SET status = 'ACTIVE' WHERE id IN ('aie_porter', 'aie_wyatt')").run();
  });
  afterAll(async () => {
    await disposeTestDb(t);
  });

  it("Wyatt's live hand-off is cancelled as superseded when the fixed door reads the message again", async () => {
    const subject = "Fwd: another intro";
    const raw = iphoneForward(subject, "ada@gmail.example", "We are Brinewater.", "re-1@westpeek.ventures");
    await handleInboundEmail(
      {
        from: "sequoia@westpeek.ventures",
        to: "os@joinwestpeek.com",
        headers: new Headers({ from: "<sequoia@westpeek.ventures>", to: "os@joinwestpeek.com", subject, "message-id": "<re-1@westpeek.ventures>", "authentication-results": "mx.cloudflare.net; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass" }),
        raw: new Blob([raw]).stream(),
        rawSize: raw.length,
      },
      env,
    );
    const kept = (await env.WP_OS_DB.prepare("SELECT r2_key, work_card_id FROM inbound_message WHERE message_id = 're-1@westpeek.ventures'").first<{ r2_key: string; work_card_id: string }>())!;
    const handOff = `wc_${crypto.randomUUID()}`;
    await env.WP_OS_DB.prepare(
      "INSERT INTO work_card (id, title, owner_type, owner_id, state, priority, firm_scope, created_by, assigned_from_card_id) VALUES (?1, 'Deal-flow intake', 'AI', 'aie_wyatt', 'IN_PROGRESS', 'NORMAL', 'west-peek', 'system:assign:aie_porter', ?2)",
    )
      .bind(handOff, kept.work_card_id)
      .run();
    const res = await handleReingestStoredEmail({
      request: new Request("https://os.joinwestpeek.com/api/inbound-email/reingest", { method: "POST", body: JSON.stringify({ object_key: kept.r2_key }) }),
      env,
      identity: { id: "fu_sequoia_taylor", email: "sequoia@westpeek.ventures", fullName: "Sequoia Taylor", status: "ACTIVE", roles: ["MANAGING_PARTNER"], authorityScopes: [] },
      params: {},
    } as never);
    const body = (await res.json()) as { superseded: string[] };
    expect(body.superseded).toContain(handOff);
    expect((await env.WP_OS_DB.prepare("SELECT state FROM work_card WHERE id = ?1").bind(handOff).first<{ state: string }>())!.state).toBe("CANCELLED");
  });
});

describe("the executor map is wired into the loop", () => {
  it("every executor is a loop action, offered only on a card that carries its work", () => {
    expect(WORK_EXECUTORS.length).toBeGreaterThan(0);
    for (const e of WORK_EXECUTORS) expect(EMPLOYEE_ACTIONS as readonly string[]).toContain(e.action);
    expect(executorsFor("Unclear email: Fwd: x\nTags found: #wpdealflow").map((e) => e.action)).toEqual(["open_in_funnel"]);
    expect(executorsFor("Deal-flow intake, tagged #‍wpdealflow").map((e) => e.action), "the zero-width-joined tag in a card title still counts").toEqual(["open_in_funnel"]);
    expect(executorsFor("Plan the November Room")).toEqual([]);
    const base = { title: "t", next_action: null, description: null, employee_name: "Wyatt", employee_role: "Analyst & Scout", allows_browser: false, prompt: null, guidance: "", history: [] };
    expect(buildStepPrompt({ ...base, executors: executorsFor("#wpdeck") }, 3)).toMatch(/open_in_funnel/);
    expect(buildStepPrompt(base, 3)).not.toMatch(/open_in_funnel/);
    expect(buildStepPrompt(base, 3)).toMatch(/NEVER block to ask a partner for something the card already holds/);
    expect(parseDecision('{"action":"open_in_funnel"}'), "no company, no decision").toBeNull();
    expect(parseDecision('{"action":"open_in_funnel","company":"Kelpline","website":"https://kelpline.example"}')).toMatchObject({ company: "Kelpline", website: "https://kelpline.example" });
  });
});
