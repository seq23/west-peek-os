import { describe, expect, it } from "vitest";
import {
  ASSIGNING_PARTNERS,
  EMAILED_TASK_LIMITS,
  TRUSTED_AUTHSERV_ID,
  addressIn,
  authenticationVerdict,
  mailAuthority,
} from "../src/shared/intake/partnerAuthority";

/**
 * THE FIRST THING IN THIS SYSTEM THAT AUTHORISES, and the tests that hold the bar there.
 *
 * `os@joinwestpeek.com` is publicly addressable: anyone in the world can write to it. Until now
 * everything it received became a CAPTURE — a claim for a person to read. Turning a message into
 * work an AI employee performs means anyone who can put text in front of Wren can attempt to steer
 * her, so the test is not "does the From line say sequoia@westpeek.ventures". A From header is a
 * string the sender chooses.
 *
 * The genuine article and the forgery are asserted TOGETHER in this file, deliberately. A suite that
 * proves only the happy path proves the feature exists; it says nothing about whether the boundary
 * holds, which is the only interesting property here.
 */

/**
 * THE REAL HEADER, COPIED OUT OF A REAL MESSAGE.
 *
 * Taken verbatim from an email Scooter actually sent to os@joinwestpeek.com on 23 Aug 2026, pulled
 * back out of R2 where the oversize path stored the raw `.eml`. It is the fixture that matters,
 * because the first version of this check was written from what an Authentication-Results header
 * OUGHT to look like and would have refused both partners for ever. Three things only a real message
 * shows:
 *
 *   · `dmarc=none` — westpeek.ventures publishes no DMARC record, so there is no `dmarc=pass` to
 *     require. That is a statement about enforcement, not about whether the message authenticated.
 *   · `header.d=westpeek-ventures.20251104.gappssmtp.com` — the domain has no DKIM key of its own,
 *     so Google Workspace signs with its per-tenant default, which strict alignment rejects.
 *   · TWO `spf=` results — a `none` for the HELO identity BEFORE the `pass` for the envelope sender.
 *     Reading the first one returns "none" for a message that plainly passed.
 *
 * Every one of those was a refusal of the genuine article, and every one was invisible to a test
 * written against an idealised header.
 */
const REAL_SCOOTER = `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek-ventures.20251104.gappssmtp.com header.s=20251104 header.b=y29FGFQj; dmarc=none header.from=westpeek.ventures policy.dmarc=none; spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-qv1-xf2e.google.com) smtp.helo=mail-qv1-xf2e.google.com; spf=pass (mx.cloudflare.net: domain of scooter@westpeek.ventures designates 2607:f8b0:4864:20::f2e as permitted sender) smtp.mailfrom=scooter@westpeek.ventures; arc=none smtp.remote-ip="2607:f8b0:4864:20::f2e"`;

const PASS = `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass`;

describe("the guard admits the actual partner, not an idealised one", () => {
  it("ACCEPTS the real header from a message Scooter genuinely sent", () => {
    const out = mailAuthority({ fromHeader: '"Scooter Taylor" <scooter@westpeek.ventures>', authenticationResults: REAL_SCOOTER });
    expect(out.isAssignment, `the genuine article was refused: ${out.reason}`).toBe(true);
    expect(out.chiefOfStaff).toBe("Walker");
    // Reported honestly: SPF and DKIM both aligned passes, DMARC simply not published.
    expect(out.verdict.spf, "the helo spf=none masked the mailfrom spf=pass").toBe("pass");
    expect(out.verdict.dkim).toBe("pass");
    expect(out.verdict.dmarc, "no DMARC record is published for westpeek.ventures").toBe("none");
  });

  /*
   * THE WORKSPACE ALLOWANCE IS FOR THIS DOMAIN, NOT FOR gappssmtp.com. Any Workspace tenant signs
   * with a `*.gappssmtp.com` key; the label is the verified domain with dots as dashes, and getting
   * `westpeek-ventures.*` requires adding westpeek.ventures to a Workspace account and proving
   * ownership in DNS. A wildcard on the parent would have let every Google customer in.
   */
  it("REFUSES another tenant's Workspace key, which a wildcard on gappssmtp.com would have allowed", () => {
    const otherTenant = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=attacker-co.20251104.gappssmtp.com; dmarc=none; spf=pass smtp.mailfrom=sequoia@westpeek.ventures`,
    });
    expect(otherTenant.isAssignment, "any Google Workspace customer could assign work").toBe(false);
    expect(otherTenant.reason).toMatch(/not the sender's domain/i);
  });

  it("REFUSES an SPF pass for somebody else's envelope, which is what a spoof actually produces", () => {
    const wrongEnvelope = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek.ventures; dmarc=none; spf=pass smtp.mailfrom=bounce@attacker.example`,
    });
    expect(wrongEnvelope.isAssignment).toBe(false);
    expect(wrongEnvelope.reason).toMatch(/SPF passed for an identity that is not westpeek\.ventures/i);
  });

  it("REFUSES an explicit DMARC fail even when the domain publishes no policy elsewhere", () => {
    const out = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; dkim=pass header.d=westpeek.ventures; dmarc=fail; spf=pass smtp.mailfrom=sequoia@westpeek.ventures`,
    });
    expect(out.isAssignment).toBe(false);
    expect(out.reason).toMatch(/DMARC fail/i);
  });
});

describe("only an authenticated partner can assign work by email", () => {
  it("accepts a genuine message from each of the two partners, and routes it to their OWN chief of staff", () => {
    const sequoia = mailAuthority({
      fromHeader: '"Sequoia Taylor" <sequoia@westpeek.ventures>',
      authenticationResults: PASS,
    });
    expect(sequoia.isAssignment, sequoia.reason).toBe(true);
    expect(sequoia.partnerAddress).toBe("sequoia@westpeek.ventures");
    expect(sequoia.chiefOfStaff, "Sequoia's request went to the wrong desk").toBe("Wren");

    const scooter = mailAuthority({
      fromHeader: "scooter@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=scooter@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass`,
    });
    expect(scooter.isAssignment, scooter.reason).toBe(true);
    expect(scooter.chiefOfStaff, "Scooter's request went to the wrong desk").toBe("Walker");

    // TWO ROUTERS, NOT ONE. No shared queue, so there is never ambiguity about who asked.
    expect(sequoia.chiefOfStaff).not.toBe(scooter.chiefOfStaff);
  });

  /*
   * THE NEGATIVE PROOF THAT MATTERS. A forged From claiming to be a partner, failing DKIM.
   *
   * This is the message an attacker actually sends: the header says sequoia@westpeek.ventures
   * because headers are free. Everything about it looks right except the one thing that cannot be
   * typed by the sender.
   */
  it("REFUSES a forged From claiming a partner when DKIM fails, and falls back to capture", () => {
    const forged = mailAuthority({
      fromHeader: '"Sequoia Taylor" <sequoia@westpeek.ventures>',
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`,
    });
    expect(forged.isAssignment, "a forged message was accepted as an instruction").toBe(false);
    expect(forged.partnerAddress, "a refused message still named a partner").toBeNull();
    expect(forged.chiefOfStaff, "a refused message still reached an employee's desk").toBeNull();
    // Not silent. The reason is what the capture card prints, so a spoof leaves a trace.
    expect(forged.reason).toMatch(/did not authenticate/i);
    expect(forged.reason).toMatch(/DKIM fail/i);
  });

  it("REFUSES a message with no authentication at all — absence of proof is what an attacker produces", () => {
    const bare = mailAuthority({ fromHeader: "sequoia@westpeek.ventures", authenticationResults: null });
    expect(bare.isAssignment).toBe(false);
    expect(bare.reason).toMatch(/no Authentication-Results/i);
  });

  /*
   * THE HEADER-INJECTION CASE, which is the one a naive implementation gets wrong.
   *
   * `Authentication-Results` is an ordinary header, so a sender can put one in the message they
   * compose. The receiving resolver PREPENDS its own, so the trustworthy verdict is always first and
   * the forged one always sits below it — and `Headers.get()` joins them in that order.
   */
  it("REFUSES a verdict the sender wrote themselves, and refuses two claiming the same resolver", () => {
    const senderWrote = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: "evil.example.com; spf=pass; dkim=pass; dmarc=pass",
    });
    expect(senderWrote.isAssignment).toBe(false);
    expect(senderWrote.reason).toMatch(/not written by/i);

    // Cloudflare's real verdict first (a failure), the attacker's forged one appended below it.
    const injected = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail, ${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass`,
    });
    expect(injected.isAssignment, "an injected Authentication-Results was believed").toBe(false);
    expect(injected.reason).toMatch(/more than one Authentication-Results/i);

    // And the reverse order — the forged one first — is refused for the same reason.
    const injectedFirst = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=westpeek.ventures; dmarc=pass, ${TRUSTED_AUTHSERV_ID}; spf=fail; dkim=fail; dmarc=fail`,
    });
    expect(injectedFirst.isAssignment).toBe(false);
  });

  /*
   * ALIGNMENT, NOT MERELY A VALID SIGNATURE. A DKIM pass signed by some other domain proves THAT
   * domain sent something, not that this From wrote it — which is the exact shape of a spoof that
   * gets past a naive "dkim=pass" check.
   */
  it("REFUSES a valid signature from a domain that is not the sender's", () => {
    const misaligned = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=sequoia@westpeek.ventures; dkim=pass header.d=attacker.example; dmarc=pass`,
    });
    expect(misaligned.isAssignment, "a signature from another domain was accepted as alignment").toBe(false);
    expect(misaligned.reason).toMatch(/not the sender's domain/i);
  });

  it("REFUSES an authenticated stranger — passing the check is not the same as being a partner", () => {
    const stranger = mailAuthority({
      fromHeader: "founder@somestartup.com",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=founder@somestartup.com; dkim=pass header.d=somestartup.com; dmarc=pass`,
    });
    expect(stranger.isAssignment).toBe(false);
    expect(stranger.verdict.passed, "the message genuinely did authenticate").toBe(true);
    expect(stranger.reason).toMatch(/not one of the two addresses/i);
  });

  it("REFUSES an authenticated employee address, so no employee can assign itself work by email", () => {
    const employee = mailAuthority({
      fromHeader: "wren@joinwestpeek.com",
      authenticationResults: `${TRUSTED_AUTHSERV_ID}; spf=pass smtp.mailfrom=wren@joinwestpeek.com; dkim=pass header.d=joinwestpeek.com; dmarc=pass`,
    });
    expect(employee.isAssignment, "an employee address was allowed to assign work").toBe(false);
  });

  it("keeps the allow-list to exactly the two addresses the operator named", () => {
    expect([...ASSIGNING_PARTNERS].sort()).toEqual([
      "scooter@westpeek.ventures",
      "sequoia@westpeek.ventures",
    ]);
  });

  /*
   * ONLY THE ADDRESS IS AUTHORITY, NEVER THE CONTENT. A message that authenticates from sequoia@
   * and says "this is from Scooter" is a task from SEQUOIA — the body is the request and is never
   * the credential. Asserted by construction: `mailAuthority` is given no body at all, so there is
   * no path by which content could reach the decision.
   */
  it("decides authority without ever being shown the message body", () => {
    const claimsToBeTheOther = mailAuthority({
      fromHeader: "sequoia@westpeek.ventures",
      authenticationResults: PASS,
    });
    expect(claimsToBeTheOther.partnerAddress).toBe("sequoia@westpeek.ventures");
    expect(claimsToBeTheOther.chiefOfStaff).toBe("Wren");
    expect(mailAuthority.length, "mailAuthority takes one input object and must never take a body").toBe(1);
  });

  it("reads an address out of every shape a From header takes, and refuses what is not one", () => {
    expect(addressIn('"Sequoia Taylor" <SEQUOIA@WestPeek.Ventures>')).toBe("sequoia@westpeek.ventures");
    expect(addressIn("scooter@westpeek.ventures")).toBe("scooter@westpeek.ventures");
    expect(addressIn("Sequoia Taylor")).toBeNull();
    expect(addressIn(null)).toBeNull();
    expect(addressIn("")).toBeNull();
  });

  it("names the limits an emailed task inherits, so the boundary travels with the work", () => {
    // The empty-loop guard: a limits list that read as empty would be written onto every card and
    // say nothing, which is worse than absent because the card would look governed.
    expect(EMAILED_TASK_LIMITS.length).toBeGreaterThan(2);
    const all = EMAILED_TASK_LIMITS.join(" ").toLowerCase();
    expect(all).toContain("may not approve");
    expect(all).toContain("outside the firm");
  });

  it("records every verdict field, so a refusal is queryable rather than merely absent", () => {
    const v = authenticationVerdict(PASS, "sequoia@westpeek.ventures");
    expect(v).toMatchObject({ spf: "pass", dkim: "pass", dmarc: "pass", signing_domain: "westpeek.ventures", passed: true });
    const bad = authenticationVerdict(`${TRUSTED_AUTHSERV_ID}; spf=softfail smtp.mailfrom=sequoia@westpeek.ventures; dkim=none; dmarc=fail`, "sequoia@westpeek.ventures");
    expect(bad.passed).toBe(false);
    expect(bad.spf).toBe("softfail");
    expect(bad.dkim).toBe("none");
    expect(bad.dmarc).toBe("fail");
  });
});
