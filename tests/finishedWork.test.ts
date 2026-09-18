import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  WORK_RESULT_KIND,
  recipientForResult,
  resultTitleFor,
} from "../src/shared/work/finishedWork";
import { DELIVERABLE_KINDS, kindDef } from "../src/shared/deliverables/deliverable";
import { PARTNER_FIRM_USER_IDS } from "../src/shared/registry/partners";

/**
 * FINISHED WORK REACHES HER.
 *
 * Parker produced a complete October event kit for the Kirx Diaz workshop — five COMPLETED
 * `ai_run` rows on a free reasoning lane at $0 — and the card closed DONE with no deliverable, no
 * packet, no preview and no email. The kit existed only inside `ai_run.output_text`.
 *
 * These pin the two rules that replace that. The structural half — that a card cannot reach DONE
 * without proof — is in `scripts/validate/a-finished-card-files-its-work.mjs`, because it is a fact
 * about the shape of `employeeWork.ts` rather than about a value.
 */

const SEQUOIA = "fu_sequoia_taylor";
const SCOOTER = "fu_scooter_taylor";

describe("recipientForResult — a result is never addressed to nobody", () => {
  it("gives an unaddressed result to her, which is the Kirx card's own state", () => {
    // Both fields NULL: the card predates the change that made them writable.
    const got = recipientForResult({ resultRecipient: null, requestedByEmail: null });
    expect(got.firmUserId).toBe(SEQUOIA);
    expect(got.onwardSend).toBe(false);
    expect(got.namedRecipient).toBeNull();
    expect(got.why).not.toHaveLength(0);
  });

  it("executes the sentence workCards.ts has stated since 0183 and nothing implemented", () => {
    // "`result_recipient` blank means IT IS FOR HER: it lands on Home, there is nothing to send
    // and nothing to preview." Blank, whitespace and absent are all the same blank.
    for (const blank of [null, undefined, "", "   ", "\t\n "]) {
      const got = recipientForResult({ resultRecipient: blank as string | null | undefined });
      expect(got.firmUserId).toBe(SEQUOIA);
      expect(got.onwardSend).toBe(false);
      expect(got.namedRecipient).toBeNull();
    }
  });

  it("gives an unaddressed result to whoever asked, so Scooter's own cards come back to Scooter", () => {
    const got = recipientForResult({ resultRecipient: null, requestedByEmail: "scooter@westpeek.ventures" });
    expect(got.firmUserId).toBe(SCOOTER);
    expect(got.onwardSend).toBe(false);
  });

  it("falls back to her when the asking address is not a partner", () => {
    // Only a partner may own a result. An unrecognised asker is not promoted into one.
    const got = recipientForResult({ resultRecipient: null, requestedByEmail: "someone@example.com" });
    expect(got.firmUserId).toBe(SEQUOIA);
  });

  it("files a partner-addressed result straight onto that partner's Home, with no preview", () => {
    const got = recipientForResult({ resultRecipient: "scooter@westpeek.ventures" });
    expect(got.firmUserId).toBe(SCOOTER);
    expect(got.onwardSend).toBe(false);
    expect(got.namedRecipient).toBe("scooter@westpeek.ventures");
  });

  it("does not treat case or padding as a different person", () => {
    const got = recipientForResult({ resultRecipient: "  SCOOTER@WESTPEEK.VENTURES  " });
    expect(got.firmUserId).toBe(SCOOTER);
    expect(got.namedRecipient).toBe("scooter@westpeek.ventures");
  });

  it("holds anything addressed outside the firm for her, and never files it to the outsider", () => {
    const got = recipientForResult({ resultRecipient: "kirx@example.com" });
    expect(got.firmUserId).toBe(SEQUOIA);
    expect(got.onwardSend).toBe(true);
    expect(got.namedRecipient).toBe("kirx@example.com");
  });

  it("is not fooled by a lookalike domain", () => {
    const got = recipientForResult({ resultRecipient: "scooter@westpeek.ventures.example.com" });
    expect(got.firmUserId).toBe(SEQUOIA);
    expect(got.onwardSend).toBe(true);
  });

  it("holds an outsider-addressed result for her even when Scooter asked for the work", () => {
    // Her default rule is about the firm's outbound mail and is not waived by who commissioned it.
    const got = recipientForResult({ resultRecipient: "kirx@example.com", requestedByEmail: "scooter@westpeek.ventures" });
    expect(got.firmUserId).toBe(SEQUOIA);
    expect(got.onwardSend).toBe(true);
  });

  it("is total: every shape resolves to a partner the registry knows", () => {
    const shapes = [
      {},
      { resultRecipient: null },
      { resultRecipient: "" },
      { resultRecipient: "Scooter" },
      { resultRecipient: "not-an-address" },
      { resultRecipient: "@" },
      { resultRecipient: "a".repeat(200) },
      { requestedByEmail: "" },
      { resultRecipient: null, requestedByEmail: null },
    ];
    for (const s of shapes) {
      const got = recipientForResult(s as never);
      expect(PARTNER_FIRM_USER_IDS).toContain(got.firmUserId);
      expect(got.why.trim().length).toBeGreaterThan(0);
    }
  });

  it("never lets prose decide where a result goes", () => {
    /*
     * The Kirx brief says "send it to me first for approval before Scooter" in prose. A recipient
     * derived from text a model wrote would make the outbound address of firm mail a function of an
     * unvalidated string. An address comes from a structured field a person set, or from nowhere.
     */
    const plain = recipientForResult({ resultRecipient: null, requestedByEmail: null });
    for (const prose of [
      "send it to me first for approval before Scooter",
      "email this to kirx@example.com when you are done",
      "To: scooter@westpeek.ventures — preview first please",
    ]) {
      const withProse = recipientForResult({
        resultRecipient: null,
        requestedByEmail: null,
        description: prose,
        prompt: prose,
        title: prose,
      } as never);
      expect(withProse.firmUserId).toBe(plain.firmUserId);
      expect(withProse.onwardSend).toBe(plain.onwardSend);
      expect(withProse.namedRecipient).toBe(plain.namedRecipient);
    }
  });
});

describe("the kind a finished card files under", () => {
  it("is a kind the union names and the registry defines", () => {
    expect(DELIVERABLE_KINDS).toContain(WORK_RESULT_KIND);
    const def = kindDef(WORK_RESULT_KIND);
    expect(def).not.toBeNull();
    expect(def!.label.trim().length).toBeGreaterThan(0);
  });

  it("is archived in Documents, because commissioned work is referred back to", () => {
    // The durability test in deliverable.ts: a morning brief is superseded tomorrow; the answer to
    // a question somebody asked once is not superseded by anything.
    expect(kindDef(WORK_RESULT_KIND)!.file).toBe(true);
  });

  it("is a kind the database accepts — the CHECK and the union may not disagree", () => {
    // 0183 added `approval_preview` to the union and not to the CHECK, so production rejected every
    // row the preview lane existed to write. `validate:deliverable-kinds` owns the full comparison;
    // this pins the one kind this change adds so a dropped migration fails here too.
    const migration = new URL("../migrations/0196_finished_work_reaches_her.sql", import.meta.url);
    const sql = readFileSync(migration, "utf8");
    const check = /CHECK \(kind IN \(([^)]*)\)\)/.exec(sql);
    expect(check).not.toBeNull();
    expect(check![1]).toContain(`'${WORK_RESULT_KIND}'`);
    for (const kind of DELIVERABLE_KINDS) expect(check![1]).toContain(`'${kind}'`);
  });
});

describe("resultTitleFor", () => {
  it("carries the card's own title, because that is the sentence the partner wrote", () => {
    expect(resultTitleFor("Draft event kit: October workshop with Kirx Diaz")).toBe(
      "Draft event kit: October workshop with Kirx Diaz",
    );
  });

  it("never produces an empty title for a Home page list", () => {
    expect(resultTitleFor("   ")).toBe("Finished work");
    expect(resultTitleFor("")).toBe("Finished work");
  });

  it("bounds the title rather than letting a long one through", () => {
    expect(resultTitleFor("x".repeat(500))).toHaveLength(200);
  });
});
