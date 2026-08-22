import { describe, expect, it } from "vitest";
import { classifyInbound, MAX_BODY_BYTES } from "../src/worker/effects/inboundEmail";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";

/**
 * What the machine inbox does with a message.
 *
 * The governing rule, and the reason every assertion below is about ROUTING rather than creating:
 * a hashtag is a public word. Anyone who learns it can type it, so it may route but must never
 * authorise. An inbound handler that created opportunities directly would mean anyone who guessed
 * `#wpdealflow` could put a company in the firm's pipeline.
 */

const base = { to: INTAKE_MAILBOX, from: "founder@example.com", subject: "", body: "" };

describe("an arriving message is classified, never acted on", () => {
  it("routes a company to the funnel and a person to Network OS from one message", () => {
    const out = classifyInbound({
      ...base,
      subject: "Intro: Dana at Northwind #wpnetwork",
      body: "Also worth a look for the fund #wpdealflow",
    });
    expect(out.triggers.sort()).toEqual(["#wpdealflow", "#wpnetwork"]);
    const owners = Object.fromEntries(out.routed.map((r) => [r.tag, r.owner]));
    expect(owners["#wpnetwork"]).toBe("NETWORK_OS");
    expect(owners["#wpdealflow"]).toBe("WEST_PEEK_OS");
  });

  it("reads the trigger out of the subject line, where people actually put it", () => {
    expect(classifyInbound({ ...base, subject: "#wpdeck Northwind seed deck" }).triggers).toEqual(["#wpdeck"]);
  });

  it("says a deck may be filling in a company already on the board, not only opening a new one", () => {
    const deck = classifyInbound({ ...base, body: "#wpdeck attached" }).routed[0]!;
    // The operator's correction: match first, create only on a genuine miss.
    expect(deck.lands.toLowerCase()).toContain("existing");
    expect(deck.lands.toLowerCase()).toContain("never a second row");
  });

  it("lands everything as a proposal, because the trigger word is public", () => {
    const all = classifyInbound({ ...base, body: "#wpdealflow #wpnetwork #wpdeck" });
    for (const r of all.routed) {
      expect(r.lands.toLowerCase()).toMatch(/proposal|proposed|review queue/);
    }
  });

  it("marks mail with no trigger as needing a person rather than dropping it", () => {
    const out = classifyInbound({ ...base, subject: "following up", body: "any thoughts on the round?" });
    expect(out.unrouted).toBe(true);
    expect(out.triggers).toEqual([]);
    expect(out.reason).toBeTruthy();
  });

  it("caps what it will parse, because the inbox is the one input the firm does not control", () => {
    // A real submission is prose and a link. The cap is the difference between a mail handler and
    // an open door.
    expect(MAX_BODY_BYTES).toBeLessThanOrEqual(512 * 1024);
  });
});
