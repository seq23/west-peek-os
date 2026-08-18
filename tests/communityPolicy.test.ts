import { describe, expect, it } from "vitest";
import {
  buildRoleMix,
  buildSponsorRecap,
  canExportAttendees,
  checkSponsorPayload,
  sponsorPolicyFailure,
} from "../src/shared/community/sponsorPolicy";
import {
  ACT_KINDS,
  type CommunityAct,
  describeEvidence,
  summariseEvidence,
  validateCouncilDecision,
} from "../src/shared/community/acts";

/**
 * These tests guard the two promises in docs/COMMUNITY.md that the code could quietly break while
 * still looking correct: sponsors never receive member identity, and the Council is never a score.
 */

const act = (over: Partial<CommunityAct> & Pick<CommunityAct, "kind" | "occurredAt">): CommunityAct => ({
  id: `act_${Math.random().toString(36).slice(2)}`,
  personId: "per_ada",
  source: "EVENT_CLOSEOUT",
  ...over,
});

describe("the sponsor boundary", () => {
  it("gives a sponsor counts, never names", () => {
    const recap = buildSponsorRecap({
      eventTitle: "The Zero-to-One Room",
      eventDate: "2027-03-11",
      attendeeRoles: ["FOUNDER", "FOUNDER", "FOUNDER", "FOUNDER", "OPERATOR", "OPERATOR", "OPERATOR"],
      themes: ["when to leave your job", "choosing a cofounder"],
    });

    expect(recap.attendeeCount).toBe(7);
    expect(recap.roleMix).toEqual({ FOUNDER: 4, OPERATOR: 3 });
    // The whole point: there is nowhere in this shape for a person to be.
    expect(JSON.stringify(recap)).not.toMatch(/per_|@/);
  });

  it("folds small role counts so a lone LP is not named by arithmetic", () => {
    // "LP: 1" at a Room where one LP attended identifies that person to everyone who was there.
    const mix = buildRoleMix(["FOUNDER", "FOUNDER", "FOUNDER", "FOUNDER", "LP", "SPEAKER"]);
    expect(mix.LP).toBeUndefined();
    expect(mix.SPEAKER).toBeUndefined();
    expect(mix).toEqual({ FOUNDER: 4, OTHER: 2 });
    // Folded, not dropped — the counts still sum to everyone who came.
    expect(Object.values(mix).reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("catches a member named in prose a human or a model wrote", () => {
    const members = [{ personId: "per_ada", displayName: "Ada Chen", email: "ada@example.com" }];
    const thankYou = "Thanks for supporting the Room — Ada Chen's question about cofounders landed well.";

    const violations = checkSponsorPayload(thankYou, members);
    expect(violations.map((v) => v.code)).toContain("member_name");
    expect(sponsorPolicyFailure("SPONSOR", thankYou, members)).toMatch(/Ada Chen/);
  });

  it("catches emails and ids even for members it was not told about", () => {
    const codes = checkSponsorPayload("follow up with per_9f3a2b1c and ada@example.com").map((v) => v.code);
    expect(codes).toContain("person_id");
    expect(codes).toContain("member_email");
  });

  it("does not flag the sponsor's own people or ordinary words", () => {
    const members = [{ personId: "per_ada", displayName: "Ada Chen" }];
    // A generic name detector would flag the AWS rep and the venue. This one must not.
    const clean = "AWS presented for 10 minutes at Gramercy Tavern. 32 attended.";
    expect(checkSponsorPayload(clean, members)).toEqual([]);
    expect(sponsorPolicyFailure("SPONSOR", clean, members)).toBeNull();
  });

  it("refuses an attendee export to a sponsor and offers the legitimate alternative", () => {
    expect(canExportAttendees("INTERNAL")).toBeNull();
    const refusal = canExportAttendees("SPONSOR");
    expect(refusal?.code).toBe("export_forbidden");
    // A refusal that does not say what IS allowed gets worked around.
    expect(refusal?.detail).toMatch(/buildSponsorRecap/);
  });

  it("leaves internal payloads alone entirely", () => {
    const members = [{ personId: "per_ada", displayName: "Ada Chen", email: "ada@example.com" }];
    expect(sponsorPolicyFailure("INTERNAL", "Ada Chen, ada@example.com, per_ada", members)).toBeNull();
  });
});

describe("Council evidence", () => {
  const acts: CommunityAct[] = [
    act({ kind: "ATTENDED", occurredAt: "2027-01-14", eventId: "evt_1" }),
    act({ kind: "ATTENDED", occurredAt: "2027-02-11", eventId: "evt_2" }),
    act({ kind: "ANSWERED_QUESTION", occurredAt: "2027-02-11", eventId: "evt_2" }),
    act({ kind: "ANSWERED_QUESTION", occurredAt: "2027-03-11", eventId: "evt_3" }),
    act({ kind: "ANSWERED_QUESTION", occurredAt: "2027-04-08", eventId: "evt_4" }),
    act({ kind: "HOSTED", occurredAt: "2027-04-08", eventId: "evt_4" }),
    act({ kind: "REFERRED_MEMBER", occurredAt: "2027-05-02", source: "PARTNER_ENTRY" }),
    act({ kind: "ATTENDED", occurredAt: "2027-01-14", eventId: "evt_1", personId: "per_other" }),
  ];

  it("groups one member's acts and ignores everyone else's", () => {
    const ev = summariseEvidence("per_ada", acts);
    expect(ev.totalActs).toBe(7);
    expect(ev.distinctEvents).toBe(4);
    expect(ev.firstActAt).toBe("2027-01-14");
    expect(ev.lastActAt).toBe("2027-05-02");
    expect(ev.byKind[0]).toEqual({ kind: "ANSWERED_QUESTION", count: 3, lastAt: "2027-04-08" });
  });

  it("names what is absent rather than leaving a reader to infer it", () => {
    const ev = summariseEvidence("per_ada", acts);
    expect(ev.absent).toContain("MISSED_COMMITMENT");
    expect(ev.absent).toContain("SPOKE");
    expect(ev.absent).not.toContain("HOSTED");
  });

  /**
   * The guard. If this fails, someone added a score — read docs/COMMUNITY.md before "fixing" it.
   * The Council is explicitly not status-based, and a number next to a member's name is a status.
   */
  it("produces NO score, rank, percentile or rating", () => {
    const ev = summariseEvidence("per_ada", acts);
    const forbidden = /score|rank|rating|percentile|tier|level|points|weight|eligib|readiness/i;
    const offending = Object.keys(ev).filter((k) => forbidden.test(k));

    expect(
      offending,
      `CouncilEvidence gained ${offending.join(", ")}. The Council is not a score — see ` +
        "docs/COMMUNITY.md. Record what happened and let a partner judge.",
    ).toEqual([]);
  });

  it("describes a member the way a colleague would, with no zeroes for a reader to compare", () => {
    expect(describeEvidence(summariseEvidence("per_ada", acts)))
      .toBe("answered 3, hosted once, referred 1 member, 4 gatherings");
    // A newcomer reads as a newcomer, not as a 0 beside someone else's 7.
    expect(describeEvidence(summariseEvidence("per_new", acts))).toBe("no recorded participation yet");
  });

  it("records a missed commitment plainly, weighted no differently from anything else", () => {
    const withMiss = [...acts, act({ kind: "MISSED_COMMITMENT", occurredAt: "2027-05-20" })];
    const ev = summariseEvidence("per_ada", withMiss);
    expect(ev.totalActs).toBe(8);
    expect(describeEvidence(ev)).toMatch(/1 missed commitment/);
  });

  it("covers every act kind in the type", () => {
    // A kind added without thought about how it reads is a kind that will read badly.
    expect(ACT_KINDS.length).toBe(10);
    expect(new Set(ACT_KINDS).size).toBe(ACT_KINDS.length);
  });
});

describe("a Council decision is a human act", () => {
  it("requires a reason long enough to review a year later", () => {
    expect(validateCouncilDecision({ personId: "per_ada", inCouncil: true, reason: "yes", decidedBy: "seq" }))
      .toEqual({ ok: false, error: expect.stringMatching(/reason/) });

    expect(
      validateCouncilDecision({
        personId: "per_ada",
        inCouncil: true,
        reason: "Hosted the March Room and consistently helps first-time founders.",
        decidedBy: "seq",
      }),
    ).toEqual({ ok: true });
  });

  it("requires an explicit boolean, so an absent flag is never read as a no", () => {
    expect(validateCouncilDecision({ personId: "per_ada", reason: "long enough reason here", decidedBy: "seq" }).ok)
      .toBe(false);
  });
});
