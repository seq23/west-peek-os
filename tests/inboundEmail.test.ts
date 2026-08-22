import { describe, expect, it } from "vitest";
import { classifyInbound, decodeMimeHeader, MAX_BODY_BYTES } from "../src/worker/effects/inboundEmail";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";
import { defuseTriggers, wouldLoop } from "../src/worker/effects/emailTransport";

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

describe("a trigger in the subject line survives the mail client", () => {
  /**
   * FOUND BY THE FIRST REAL EMAIL, not by a test. The live routing test arrived with the subject
   * "#wpdealflow Northwind Robotics — seed"; the em-dash made the header non-ASCII, the client
   * encoded the whole thing, and `#` became `=23`. The trigger survived only because the body
   * happened to repeat it — anyone putting a trigger in the subject alone, which is the natural
   * place, would have been silently ignored the moment their subject held a dash or an accent.
   */
  it("decodes a Q-encoded subject and still finds the trigger", () => {
    const encoded = "=?UTF-8?Q?=23wpdealflow_Northwind_Robotics_?= =?UTF-8?Q?=E2=80=94_seed?=";
    expect(decodeMimeHeader(encoded)).toBe("#wpdealflow Northwind Robotics — seed");
    const out = classifyInbound({ ...base, subject: encoded, body: "no trigger down here" });
    expect(out.triggers).toEqual(["#wpdealflow"]);
  });

  it("decodes a B-encoded subject too, because clients choose between them by content", () => {
    const encoded = `=?UTF-8?B?${Buffer.from("#wpnetwork Dana Reyes").toString("base64")}?=`;
    expect(decodeMimeHeader(encoded)).toBe("#wpnetwork Dana Reyes");
    expect(classifyInbound({ ...base, subject: encoded, body: "" }).triggers).toEqual(["#wpnetwork"]);
  });

  it("leaves a plain subject alone and never drops one it cannot decode", () => {
    expect(decodeMimeHeader("#wpdeck plain subject")).toBe("#wpdeck plain subject");
    // Malformed: still a subject. Losing it would trade a formatting problem for a lost message.
    expect(decodeMimeHeader("=?UTF-8?Q?broken")).toBe("=?UTF-8?Q?broken");
  });

  it("records the readable subject, not the wire format", () => {
    const out = classifyInbound({ ...base, subject: "=?UTF-8?Q?=23wpdeck_Acme?=", body: "" });
    expect(out.subject).toBe("#wpdeck Acme");
  });
});

describe("outbound mail cannot feed the inbound rule", () => {
  /**
   * Operator's question: the Network OS rule adds anything sent to sequoia@, scooter@ or info@
   * with the two hashtags — "does this need to change in any way? i guess not... as long as we dont
   * send to os@joinwestpeek.com AND one of those right?"
   *
   * Right about ADDRESSING, and this is the part it does not cover. Network OS's Gmail sync runs
   * `{#wpnetwork #wpdealflow …}` with NO in:inbox restriction, so it matches any mail carrying a
   * trigger — including Sent. The collision is not who a message was addressed to; it is that this
   * app writes the trigger word at all. A digest reading "3 new companies via #wpdealflow" is
   * ingested as a submission, syncs back, and appears in the next digest.
   */
  it("defuses every trigger this app could write into an email", () => {
    const digest = "3 new companies via #wpdealflow, 2 people via #wpnetwork, 1 #wpdeck parsed.";
    expect(wouldLoop(digest)).toBe(true);
    const safe = defuseTriggers(digest);
    expect(wouldLoop(safe)).toBe(false);
  });

  it("reads identically to a person — the words are still there", () => {
    const safe = defuseTriggers("filed under #wpdealflow");
    expect(safe.replace(/‍/g, "")).toBe("filed under #wpdealflow");
  });

  it("covers Network OS's aliases, not only the three this app publishes", () => {
    // Network OS matches #addtowestpeek and #westpeeknetwork too; missing one reopens the loop.
    for (const alias of ["#addtowestpeek", "#westpeeknetwork", "#dealflow"]) {
      expect(wouldLoop(`please see ${alias}`)).toBe(true);
      expect(wouldLoop(defuseTriggers(`please see ${alias}`))).toBe(false);
    }
  });

  it("leaves ordinary prose alone", () => {
    const plain = "The deal flow this week was quiet. No hashtags here.";
    expect(defuseTriggers(plain)).toBe(plain);
  });
});
