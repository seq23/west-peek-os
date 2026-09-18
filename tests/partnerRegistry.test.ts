import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, type TestDb } from "./helpers/db";
import {
  PARTNERS,
  PARTNER_EMAILS,
  PARTNER_FIRM_USER_IDS,
  PREVIEW_PARTNER,
  PRODUCTIONS_PARTNER,
  isPartnerEmail,
  isPartnerFirmUserId,
  partnerByEmail,
  partnerByFirmUserId,
  partnerByName,
  partnerFor,
} from "../src/shared/registry/partners";
import { ASSIGNING_PARTNERS } from "../src/shared/intake/partnerAuthority";
import { MANAGING_PARTNERS, MANAGING_PARTNER_NAMES } from "../src/shared/registry/managingPartners";
import { SCOOTER_EMAIL, SCOOTER_FIRM_USER_ID } from "../src/worker/services/productions";
import { resolveOwner } from "../src/shared/review/meetingNotes";

/**
 * ONE ANSWER TO "IS THIS ONE OF THE TWO PARTNERS?" (17 Sep 2026).
 *
 * `scripts/validate/one-partner-registry.mjs` proves nothing in `src/` types a partner's address or
 * id outside the registry. That is a source scan and it cannot see the database, so the half it
 * cannot prove is proven here: THE REGISTRY AND THE `firm_user` TABLE AGREE, IN BOTH DIRECTIONS.
 *
 * Both directions matter and the second is the one that catches a real mistake: a registry entry
 * with no row would be a partner the system believes in and cannot address, and a `MANAGING_PARTNER`
 * row with no registry entry would be a person with authority the mail boundary refuses.
 */

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb();
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("the registry and the database say the same thing", () => {
  it("every partner has an ACTIVE firm_user row with that exact address, and vice versa", async () => {
    for (const p of PARTNERS) {
      const row = await t.db
        .prepare("SELECT id, email, full_name, status FROM firm_user WHERE id = ?1")
        .bind(p.firmUserId)
        .first<{ id: string; email: string; full_name: string; status: string }>();
      expect(row, `${p.firmUserId} is in the registry and not in firm_user`).toBeTruthy();
      expect(row!.email.toLowerCase()).toBe(p.email);
      expect(row!.full_name).toBe(p.fullName);
      expect(row!.status).toBe("ACTIVE");
    }

    /*
     * THE OTHER DIRECTION. Anybody holding `role_managing_partner` in the database must be in the
     * registry — otherwise they have the firm's authority and the mail boundary has never heard of
     * them, which is a permission that exists in one half of the system only.
     */
    const mps = (
      await t.db
        .prepare("SELECT firm_user_id FROM firm_user_role WHERE role_id = 'role_managing_partner'")
        .all<{ firm_user_id: string }>()
    ).results!;
    expect(mps.length, "the database holds no managing partners at all").toBeGreaterThan(0);
    for (const mp of mps) {
      expect(PARTNER_FIRM_USER_IDS, `${mp.firm_user_id} is a Managing Partner the registry does not know`).toContain(
        mp.firm_user_id,
      );
    }
  });
});

describe("every view is the registry, not a copy of it", () => {
  it("the mail boundary, the ownership list and the productions constants all resolve to the same two people", () => {
    expect([...ASSIGNING_PARTNERS].sort()).toEqual([...PARTNER_EMAILS].sort());
    expect(MANAGING_PARTNERS.map((m) => m.fullName).sort()).toEqual(PARTNERS.map((p) => p.fullName).sort());
    // Ordered by ownership, which is the order this list has always been in.
    expect(MANAGING_PARTNERS[0]!.fullName).toBe("Scooter Taylor");
    expect(MANAGING_PARTNERS[0]!.ownershipPct).toBe(51);
    expect(MANAGING_PARTNERS[0]!.finalAuthority).toBe(true);
    expect(MANAGING_PARTNER_NAMES).toContain("Sequoia");

    expect(SCOOTER_EMAIL).toBe(PRODUCTIONS_PARTNER.email);
    expect(SCOOTER_FIRM_USER_ID).toBe(PRODUCTIONS_PARTNER.firmUserId);
    expect(PRODUCTIONS_PARTNER.firmUserId, "West Peek Productions is Scooter's").toBe("fu_scooter_taylor");
    expect(PREVIEW_PARTNER.email, "every preview goes to Sequoia").toBe("sequoia@westpeek.ventures");
  });

  it("answers from whichever of the three names a caller happens to hold", () => {
    expect(partnerByEmail("  SCOOTER@WestPeek.Ventures ")!.firstName, "case and space are not part of an address").toBe("Scooter");
    expect(partnerByFirmUserId("fu_sequoia_taylor")!.firstName).toBe("Sequoia");
    expect(partnerByName("scooter")!.firmUserId).toBe("fu_scooter_taylor");
    expect(partnerByName("Sequoia Taylor")!.firmUserId).toBe("fu_sequoia_taylor");
    expect(partnerFor("scooter@westpeek.ventures")!.firstName).toBe("Scooter");
    expect(partnerFor("fu_sequoia_taylor")!.firstName).toBe("Sequoia");
    expect(partnerFor("Scooter")!.firstName).toBe("Scooter");
  });

  it("refuses everybody else, including the domain", () => {
    /*
     * DELIBERATELY NOT "does the address end in @westpeek.ventures". `info@` is on that domain and
     * is not a partner; a domain test would hand the firm's authority to whoever controls a shared
     * mailbox. This is the assertion that stops somebody 'simplifying' it into one.
     */
    for (const stranger of [
      "info@westpeek.ventures",
      "assistant@westpeek.ventures",
      "scooter@westpeek.ventures.evil.example",
      "walker@joinwestpeek.com",
      "",
      null,
      undefined,
    ]) {
      expect(isPartnerEmail(stranger), `${stranger} must not be a partner`).toBe(false);
      expect(partnerByEmail(stranger)).toBeNull();
    }
    expect(isPartnerFirmUserId("aie_walker")).toBe(false);
    expect(isPartnerFirmUserId("fu_someone_else")).toBe(false);
    expect(partnerByName("Marcus"), "a name outside the firm resolves to nobody").toBeNull();
  });

  it("resolves a note's owner through the registry, and only when it is unambiguous", () => {
    expect(resolveOwner("send it to Sequoia")).toBe("fu_sequoia_taylor");
    expect(resolveOwner("scooter is picking this up")).toBe("fu_scooter_taylor");
    expect(resolveOwner("Sequoia and Scooter both"), "two names is not an owner").toBeNull();
    expect(resolveOwner("send it to Marcus")).toBeNull();
    expect(resolveOwner(null)).toBeNull();
  });
});
