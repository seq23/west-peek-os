import { describe, expect, it } from "vitest";
import {
  EMPLOYEE_MAIL_DOMAIN,
  EmployeeSenderError,
  employeeSenderAddress,
  employeeSenderDirectory,
  employeeSenderHeader,
  isEmployeeSender,
} from "../src/shared/registry/employeeMail";
import { AI_EMPLOYEE_ROSTER } from "../src/shared/registry/aiEmployees";

/**
 * A WEST PEEK EMPLOYEE SIGNS FROM WEST PEEK'S OWN DOMAIN.
 *
 * Operator, 9 Sep 2026: "why dont any of the ai employees from os.joinwestpeek.com have emails from
 * @joinwestpeek.com". They did not because they had no sender identity at all — every employee's
 * mail went out as the firm — and when one was wired to a notifier by hand it borrowed Boss OS's, so
 * Preston signed three emails from `preston@sequoiataylor.com`: a WEST PEEK employee writing from
 * the domain of a DIFFERENT BUSINESS. The same defect ran the other way that morning, a Boss OS
 * employee on westpeek.ventures. Both were caught by a human reading a signature.
 */
describe("an employee's address comes from the roster, or it does not exist", () => {
  it("mints <first name>@joinwestpeek.com for everyone actually on the roster", () => {
    const directory = employeeSenderDirectory();
    // The empty-loop guard. A roster that reads as zero employees would pass every assertion below
    // by examining nothing, which is the exact failure this repo names Rule 0.
    expect(directory.length, "the roster read as empty, so this test proves nothing").toBe(AI_EMPLOYEE_ROSTER.length);
    expect(directory.length).toBeGreaterThan(10);

    for (const { name, address } of directory) {
      expect(address, `${name} is not on the employee domain`).toBe(`${name.toLowerCase()}@${EMPLOYEE_MAIL_DOMAIN}`);
      expect(address.endsWith("@joinwestpeek.com")).toBe(true);
    }

    expect(employeeSenderAddress("Preston")).toBe("preston@joinwestpeek.com");
    expect(employeeSenderAddress("wren")).toBe("wren@joinwestpeek.com");
    expect(employeeSenderHeader("Preston")).toBe("Preston · West Peek <preston@joinwestpeek.com>");
  });

  /*
   * THE REFUSAL IS THE FEATURE, and it is not pedantry about typos. A verified sending domain signs
   * ANY local part, so `prestn@joinwestpeek.com` would leave Resend looking perfect, arrive looking
   * perfect, and bounce every reply into a mailbox that belongs to nobody. Refusing at mint time is
   * the only place that is catchable.
   */
  it("REFUSES a name that is not on the roster rather than minting an address for it", () => {
    expect(() => employeeSenderAddress("Prestn")).toThrow(EmployeeSenderError);
    expect(() => employeeSenderAddress("Monique")).toThrow(/not on the West Peek roster/i);
    expect(() => employeeSenderAddress("Sequoia")).toThrow(EmployeeSenderError);
  });

  it("REFUSES an unnamed sender: there is no default and no anonymous send", () => {
    expect(() => employeeSenderAddress(null)).toThrow(/no default and no anonymous send/i);
    expect(() => employeeSenderAddress("")).toThrow(EmployeeSenderError);
    expect(() => employeeSenderAddress("   ")).toThrow(EmployeeSenderError);
  });

  /*
   * BOTH DIRECTIONS OF THE BLEND, asserted together because fixing one and not the other is what
   * happened the first time. westpeek.ventures is the LP-FACING identity — sequoia@ and scooter@
   * live there and it is on page 15 of the deck — so preston@westpeek.ventures reads to an outsider
   * as a person at the fund. sequoiataylor.com is Boss OS, a different business entirely.
   */
  it("does not recognise a roster name on the LP-facing domain or on Boss OS's", () => {
    expect(isEmployeeSender("preston@joinwestpeek.com")).toBe(true);
    expect(isEmployeeSender("preston@westpeek.ventures"), "an employee on the LP-facing domain").toBe(false);
    expect(isEmployeeSender("preston@sequoiataylor.com"), "a West Peek employee on Boss OS's domain").toBe(false);
    expect(isEmployeeSender("sequoia@joinwestpeek.com"), "a partner is not an employee").toBe(false);
    expect(isEmployeeSender("prestn@joinwestpeek.com"), "a typo signed by the verified domain").toBe(false);
    expect(isEmployeeSender("os@joinwestpeek.com"), "the intake mailbox is not a sender").toBe(false);
    expect(isEmployeeSender(null)).toBe(false);
    expect(isEmployeeSender("not-an-address")).toBe(false);
  });

  it("names no Managing Partner, because a partner is a person and an employee is not", () => {
    const addresses = new Set(employeeSenderDirectory().map((e) => e.address));
    expect(addresses.has("sequoia@joinwestpeek.com")).toBe(false);
    expect(addresses.has("scooter@joinwestpeek.com")).toBe(false);
  });

  it("gives every employee a distinct address, so no two people share a mailbox", () => {
    const addresses = employeeSenderDirectory().map((e) => e.address);
    expect(new Set(addresses).size, "two employees resolve to the same address").toBe(addresses.length);
  });
});
