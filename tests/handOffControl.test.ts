import { describe, expect, it } from "vitest";
import { handOffControl } from "../src/client/pages/work/handOffControl";

/**
 * THE HAND-OFF DOOR ON THE EXPANDED CARD (0241, 23 Sep 2026): the primary partner sees "Hand to
 * <the other>", the secondary sees "Take this back", anyone else sees neither, and a finished card
 * offers nothing. The server still decides and its refusal detail is shown; this pins which door
 * the card draws.
 */
const SEQ = { firm_user_id: "fu_sequoia_taylor", email: "sequoia@westpeek.ventures", first_name: "Sequoia", full_name: "Sequoia Taylor" };
const SCO = { firm_user_id: "fu_scooter_taylor", email: "scooter@westpeek.ventures", first_name: "Scooter", full_name: "Scooter Taylor" };
const PARTNERS = [
  { id: "fu_scooter_taylor", full_name: "Scooter Taylor" },
  { id: "fu_sequoia_taylor", full_name: "Sequoia Taylor" },
];

describe("handOffControl", () => {
  it("the primary hands it to the other partner, by first name", () => {
    expect(handOffControl({ primary_partner: SEQ, secondary_partner: null, state: "BLOCKED" }, SEQ.firm_user_id, PARTNERS)).toEqual({ kind: "HAND_OFF", to: "Scooter", label: "Hand to Scooter" });
    expect(handOffControl({ primary_partner: SCO, secondary_partner: null, state: "OPEN" }, SCO.firm_user_id, PARTNERS)).toEqual({ kind: "HAND_OFF", to: "Sequoia", label: "Hand to Sequoia" });
  });

  it("the secondary takes it back; the primary of a handed card can hand it on again", () => {
    expect(handOffControl({ primary_partner: SCO, secondary_partner: SEQ, state: "IN_PROGRESS" }, SEQ.firm_user_id, PARTNERS)).toEqual({ kind: "TAKE_BACK", label: "Take this back" });
    expect(handOffControl({ primary_partner: SCO, secondary_partner: SEQ, state: "IN_PROGRESS" }, SCO.firm_user_id, PARTNERS)).toMatchObject({ kind: "HAND_OFF", to: "Sequoia" });
  });

  it("nobody else, no partner owner, or a finished card: no door", () => {
    expect(handOffControl({ primary_partner: SEQ, secondary_partner: null, state: "OPEN" }, "fu_someone_else", PARTNERS)).toBeNull();
    expect(handOffControl({ primary_partner: null, secondary_partner: null, state: "OPEN" }, SEQ.firm_user_id, PARTNERS)).toBeNull();
    expect(handOffControl({ primary_partner: SEQ, secondary_partner: null, state: "DONE" }, SEQ.firm_user_id, PARTNERS)).toBeNull();
  });
});
