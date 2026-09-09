import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import { handleInboundEmail } from "../src/worker/effects/inboundEmail";
import { TRUSTED_AUTHSERV_ID } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import type { Env } from "../src/worker/env";

/**
 * THE REFUSAL PROVEN, NOT ASSUMED.
 *
 * `partnerAuthority.test.ts` holds the decision function. This file drives the WHOLE HANDLER, because
 * a correct verdict wired to nothing is the "exists but nothing invokes it" defect, and because the
 * only claim worth making about a security boundary is what the system actually did with the message.
 *
 * Two messages, identical but for the one thing a sender cannot type: a forged From claiming
 * sequoia@westpeek.ventures whose DKIM fails, and the genuine article. The forgery must produce a
 * capture and NO assignment; the genuine one must produce work on Wren's desk.
 */

let t: TestDb;
let env: Env;

function deliver(headers: Record<string, string>, body: string): Promise<void> {
  const bytes = new TextEncoder().encode(body);
  return handleInboundEmail(
    {
      from: headers.from ?? "someone@example.com",
      to: INTAKE_MAILBOX,
      headers: new Headers(headers),
      raw: new Blob([bytes]).stream(),
      rawSize: bytes.byteLength,
    },
    env,
  );
}

const GENUINE = `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass`;
const FORGED = `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`;

async function cardsOwnedBy(owner: string): Promise<Array<{ id: string; title: string; description: string }>> {
  return (
    await env.WP_OS_DB.prepare("SELECT id, title, description FROM work_card WHERE owner_id = ?1 ORDER BY created_at")
      .bind(owner)
      .all<{ id: string; title: string; description: string }>()
  ).results ?? [];
}

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("an authenticated partner's email is an assignment; anything else is a capture", () => {
  it("REFUSES a forged From claiming a partner, and files it as a capture instead", async () => {
    await deliver(
      { from: '"Sequoia Taylor" <sequoia@westpeek.ventures>', subject: "Have Preston rebuild the deck", "authentication-results": FORGED },
      "Please have Preston rebuild the deck today.",
    );

    // NOTHING reached a chief of staff. This is the assertion the whole feature is worth.
    expect(await cardsOwnedBy("aie_wren"), "a forged message assigned work to a chief of staff").toEqual([]);
    expect(await cardsOwnedBy("aie_walker")).toEqual([]);

    // And it was not dropped: the capture path took it, with the reason written on the card.
    const porter = await cardsOwnedBy("aie_porter");
    expect(porter.length, "a refused message vanished instead of becoming a capture").toBeGreaterThan(0);
    const card = porter[porter.length - 1]!;
    expect(card.description).toMatch(/NOT treated as an assignment/i);
    expect(card.description).toMatch(/DKIM fail/i);

    // The verdict is on the spine, so "has anyone tried to forge a partner" is a query.
    const event = await env.WP_OS_DB.prepare(
      "SELECT payload_json FROM event_record WHERE event_type = 'inbound_email.unrouted' ORDER BY created_at DESC LIMIT 1",
    ).first<{ payload_json: string }>();
    const payload = JSON.parse(event!.payload_json) as { mail_authority: { assigned: boolean; dkim: string; refused_because?: string } };
    expect(payload.mail_authority.assigned).toBe(false);
    expect(payload.mail_authority.dkim).toBe("fail");
    expect(payload.mail_authority.refused_because).toMatch(/did not authenticate/i);
  });

  it("ACCEPTS the genuine article and puts it on the sender's own chief of staff's desk", async () => {
    await deliver(
      { from: '"Sequoia Taylor" <sequoia@westpeek.ventures>', subject: "Have Preston rebuild the deck", "authentication-results": GENUINE },
      "Please have Preston rebuild the deck today.",
    );

    const wren = await cardsOwnedBy("aie_wren");
    expect(wren.length, "an authenticated partner's email did not become work").toBe(1);
    const card = wren[0]!;
    // Who asked, and what was asked, in their own words — the visibility the operator required.
    expect(card.title).toContain("sequoia@westpeek.ventures");
    expect(card.description).toContain("rebuild the deck");
    // The boundary travels with the work rather than living only in a file nobody opens.
    expect(card.description).toMatch(/May NOT approve/i);
    expect(card.description).toMatch(/outside the firm/i);

    // Nothing landed on the other partner's desk. Two routers, not one.
    expect(await cardsOwnedBy("aie_walker"), "Sequoia's request reached Scooter's chief of staff").toEqual([]);

    // Receipt confirmed where the work lives, addressed to the partner who actually sent it.
    const notice = await env.WP_OS_DB.prepare(
      "SELECT firm_user_id, body FROM notification WHERE dedupe_key LIKE 'mail_assignment:%'",
    ).first<{ firm_user_id: string; body: string }>();
    expect(notice, "the partner was never told her email had been received").toBeTruthy();
    expect(notice!.firm_user_id, "the receipt was addressed to nobody, or to the wrong partner").toBe("fu_sequoia_taylor");
    expect(notice!.body).toMatch(/Wren/);
  });

  it("sends Scooter's request to Walker, from the roster rather than from a second list", async () => {
    await deliver(
      { from: "scooter@westpeek.ventures", subject: "Look at the Northwind terms", "authentication-results": `${TRUSTED_AUTHSERV_ID}; spf=pass; dkim=pass header.d=westpeek.ventures; dmarc=pass` },
      "Can someone read the Northwind term sheet before Thursday.",
    );
    const walker = await cardsOwnedBy("aie_walker");
    expect(walker.length, "Scooter's request did not reach his chief of staff").toBe(1);
    expect(walker[0]!.title).toContain("scooter@westpeek.ventures");
    // Sequoia's desk still holds only her own one.
    expect((await cardsOwnedBy("aie_wren")).length).toBe(1);
  });

  /*
   * A TAGGED MESSAGE KEEPS ITS EXISTING ROUTE. The tags are a routing vocabulary that works, and a
   * partner forwarding a founder's deck with `#wpdealflow` is deal flow — not a task for Wren.
   * Only the case `NO_TRIGGER_ROUTE` describes changes.
   */
  it("leaves a tagged message on the route it already had, even from an authenticated partner", async () => {
    const before = (await cardsOwnedBy("aie_wren")).length;
    await deliver(
      { from: "sequoia@westpeek.ventures", subject: "#wpdealflow Northwind Robotics", "authentication-results": GENUINE },
      "#wpdealflow Company: Northwind Robotics. Worth a look.",
    );
    expect(
      (await cardsOwnedBy("aie_wren")).length,
      "a tagged deal-flow email was turned into an assignment instead of routing to the funnel",
    ).toBe(before);
  });

  it("does not assign for an authenticated stranger, however well their mail authenticates", async () => {
    const before = (await cardsOwnedBy("aie_wren")).length + (await cardsOwnedBy("aie_walker")).length;
    await deliver(
      { from: "founder@somestartup.com", subject: "quick question", "authentication-results": `${TRUSTED_AUTHSERV_ID}; spf=pass; dkim=pass header.d=somestartup.com; dmarc=pass` },
      "Do you invest at pre-seed?",
    );
    expect(
      (await cardsOwnedBy("aie_wren")).length + (await cardsOwnedBy("aie_walker")).length,
      "a stranger assigned work to a chief of staff by authenticating",
    ).toBe(before);
  });
});
