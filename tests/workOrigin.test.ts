import { describe, it, expect } from "vitest";
import { originOf, originBadgeText } from "../src/shared/work/origin";
import { PARTNERS } from "../src/shared/registry/partners";

/**
 * WHERE A CARD CAME FROM. Six origins, one row, and an order that decides between them.
 *
 * The thing worth pinning is the ORDER. A card handed on by a colleague carries the address of
 * whoever asked in the first place — `employeeWork.ts` copies `requested_by_email` onto the new
 * card on purpose, so the reply still reaches the right person. Reading that first would say "an
 * email from Scooter" about a card Wren handed to Wyatt this morning: true of its ancestor, false
 * of it.
 */

const SEQUOIA = PARTNERS[0]!;
const SCOOTER = PARTNERS[1]!;
const AT = "2026-09-22T09:00:00.000Z";

describe("originOf", () => {
  it("reads a colleague's hand-on before anything else on the row", () => {
    expect(
      originOf({
        assigned_from_card_id: "wc_parent",
        requested_by_email: SCOOTER.email,
        meeting_id: "mtg_1",
        capture_id: "cap_1",
        created_by: SEQUOIA.firmUserId,
        created_at: AT,
      }),
    ).toEqual({ kind: "ANOTHER_CARD", who: "wc_parent", at: AT });
  });

  it("reads the meeting before the capture and the email", () => {
    expect(originOf({ meeting_id: "mtg_7", capture_id: "cap_1", requested_by_email: "a@b.com", created_by: "fu_x", created_at: AT }))
      .toEqual({ kind: "MEETING", who: "mtg_7", at: AT });
  });

  it("reads the capture before the email", () => {
    expect(originOf({ capture_id: "cap_9", requested_by_email: "a@b.com", created_by: "fu_x", created_at: AT }))
      .toEqual({ kind: "CAPTURE", who: "cap_9", at: AT });
  });

  it("names the address an email request came from, lowercased and trimmed", () => {
    expect(originOf({ requested_by_email: "  Someone@Example.COM ", created_by: "fu_x", created_at: AT }))
      .toEqual({ kind: "EMAIL", who: "someone@example.com", at: AT });
  });

  it("does not treat a blank requested_by_email as an email origin", () => {
    const o = originOf({ requested_by_email: "   ", created_by: SEQUOIA.firmUserId, created_at: AT });
    expect(o.kind).toBe("PARTNER");
  });

  it("says YOU when the viewer wrote it, and names the partner when somebody else did", () => {
    expect(originOf({ created_by: SEQUOIA.firmUserId, created_at: AT }, SEQUOIA.firmUserId))
      .toEqual({ kind: "YOU", who: SEQUOIA.fullName, at: AT });
    expect(originOf({ created_by: SCOOTER.firmUserId, created_at: AT }, SEQUOIA.firmUserId))
      .toEqual({ kind: "PARTNER", who: SCOOTER.fullName, at: AT });
  });

  it("names the partner rather than guessing when there is no viewer", () => {
    expect(originOf({ created_by: SEQUOIA.firmUserId, created_at: AT }))
      .toEqual({ kind: "PARTNER", who: SEQUOIA.fullName, at: AT });
  });

  it("calls anything that is not a partner SYSTEM, and still says who", () => {
    expect(originOf({ created_by: "aie_wyatt", created_at: AT }))
      .toEqual({ kind: "SYSTEM", who: "aie_wyatt", at: AT });
  });

  it("never returns a blank who, even on a row with nothing on it", () => {
    const o = originOf({});
    expect(o).toEqual({ kind: "SYSTEM", who: "the system", at: "" });
    expect(o.who.length).toBeGreaterThan(0);
  });
});

/**
 * ONE PHRASE PER ORIGIN, FOR THE DESK'S BADGE (Wave C, 22 Sep 2026) — the same four categories she
 * asked for: from an email (naming the sender), from her directly, from an AI employee, from the
 * scheduled sweep. `originBadgeText` is a pure formatter over `originOf`'s own result, so a card
 * whose origin changes (a new kind, a new call site) can never disagree with the sentence the card
 * page already reads out in full.
 */
describe("originBadgeText", () => {
  it("names the sender on an email origin", () => {
    expect(originBadgeText({ kind: "EMAIL", who: "scooter@westpeek.ventures", at: "" })).toBe("from scooter@westpeek.ventures");
  });

  it("says 'from you' when she opened it herself", () => {
    expect(originBadgeText({ kind: "YOU", who: SEQUOIA.fullName, at: "" })).toBe("from you");
  });

  it("names the partner when a colleague opened it", () => {
    expect(originBadgeText({ kind: "PARTNER", who: SCOOTER.fullName, at: "" })).toBe(`from ${SCOOTER.fullName}`);
  });

  it("names the scheduled sweep when created_by is the sweep's own identity, with no join available", () => {
    expect(originBadgeText({ kind: "SYSTEM", who: "system:work_sweep", at: "" })).toBe("from the scheduled sweep");
  });

  it("names the AI employee when the caller has already resolved one", () => {
    expect(originBadgeText({ kind: "SYSTEM", who: "aie_wyatt", at: "" }, "Wyatt")).toBe("from Wyatt");
  });

  it("still says something honest when neither a resolved name nor 'sweep' is available", () => {
    expect(originBadgeText({ kind: "SYSTEM", who: "system:inbound_email", at: "" })).toBe("from the system");
  });

  it("reads meetings, captures and hand-offs in words rather than raw ids", () => {
    expect(originBadgeText({ kind: "MEETING", who: "mtg_7", at: "" })).toBe("from a meeting");
    expect(originBadgeText({ kind: "CAPTURE", who: "cap_9", at: "" })).toBe("captured");
    expect(originBadgeText({ kind: "ANOTHER_CARD", who: "wc_parent", at: "" })).toBe("handed off");
  });
});
