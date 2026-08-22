import { describe, expect, it } from "vitest";
import { classifyInbound, decodeMimeHeader, extractAddress, forwardedOrigin, MAX_BODY_BYTES, personFromMessage } from "../src/worker/effects/inboundEmail";
import { pdfAttachments } from "../src/worker/effects/mimeAttachments";
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

  it("sends a company reporting its own numbers to the portfolio seat, not to the funnel", () => {
    // Item 12. Before this it matched nothing and went to Porter as an unclear email, which is
    // correct and useless: the one seat that watches how the companies are doing never saw it.
    const out = classifyInbound({ ...base, subject: "#wpupdate Northwind — March", body: "ARR 120k" });
    expect(out.triggers).toEqual(["#wpupdate"]);
    expect(out.unrouted).toBe(false);
    // And it must not also read as a new company for the top of the funnel.
    expect(out.triggers).not.toContain("#wpdealflow");
  });

  it("lands everything as a proposal, because the trigger word is public", () => {
    const all = classifyInbound({ ...base, body: "#wpdealflow #wpnetwork #wpdeck #wpupdate" });
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
    const digest = "3 new companies via #wpdealflow, 2 people via #wpnetwork, 1 #wpdeck parsed, 4 #wpupdate read.";
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

describe("a person can be read out of a #wpnetwork message", () => {
  it("reads the fields Network OS's own parser expects", () => {
    const p = personFromMessage("intro@example.com", "#wpnetwork\nName: Dana Reyes\nEmail: dana@northwind.io\nCompany: Northwind");
    expect(p).toEqual({ name: "Dana Reyes", email: "dana@northwind.io", company: "Northwind" });
  });

  it("falls back to the sender's address, but never invents a name", () => {
    const withName = personFromMessage("scout@example.com", "Name: Dana Reyes\nplease add");
    expect(withName?.email).toBe("scout@example.com");
    // No name means nothing to propose. A blank record for somebody to puzzle over is worse than
    // saying so — and the sender is often the introducer, not the person being introduced.
    expect(personFromMessage("scout@example.com", "#wpnetwork please add my friend")).toBeNull();
  });
});

describe("the sender recorded is the person, not the relay", () => {
  /**
   * The first three live emails recorded a sender of
   * `010001a027045243-47127e91-…@amazonses.com` — the envelope address a delivery service uses for
   * bounce tracking. The capture would have said who relayed the message rather than who wrote it,
   * and Capture's own person resolution reads exactly that line.
   */
  it("prefers the From header over the envelope", () => {
    expect(extractAddress("Dana Reyes <dana@northwind.io>")).toBe("dana@northwind.io");
    expect(extractAddress("dana@northwind.io")).toBe("dana@northwind.io");
  });

  it("falls back rather than inventing one, because a header can be absent", () => {
    expect(extractAddress(null)).toBeNull();
    expect(extractAddress("Dana Reyes")).toBeNull();
  });
});

describe("a folded header still yields its boundary, so a deck is not dropped in silence", () => {
  /**
   * RFC 5322 lets a header wrap onto a continuation line starting with a space or a tab, and Apple
   * Mail and Outlook both do it for `Content-Type`. `boundaryOf` matched with `[^\n]*`, which cannot
   * cross that break, so it returned null — `pdfAttachments` then returned no attachments AND no
   * `unread` note, the caller set `isDeck = false`, and the deck vanished with nothing said. That is
   * the exact silent drop the module docstring promises never to do ("anything it cannot confidently
   * read it reports as unread rather than guessing").
   */
  const pdf = Buffer.from("%PDF-1.4 pretend").toString("base64");
  const message = (contentType: string, boundary: string) =>
    [
      "From: Ada <ada@sensori.example>",
      "To: os@joinwestpeek.com",
      "Subject: #wpdeck Sensori",
      contentType,
      "",
      `--${boundary}`,
      'Content-Type: application/pdf; name="sensori.pdf"',
      'Content-Disposition: attachment; filename="sensori.pdf"',
      "Content-Transfer-Encoding: base64",
      "",
      pdf,
      `--${boundary}--`,
      "",
    ].join("\r\n");

  it("reads a boundary declared on a continuation line", () => {
    const folded = message('Content-Type: multipart/mixed;\r\n\tboundary="Apple-Mail=_A1B2C3"', "Apple-Mail=_A1B2C3");
    const { attachments, unread } = pdfAttachments(folded);
    expect(attachments.map((a) => a.filename)).toEqual(["sensori.pdf"]);
    expect(attachments[0]!.dataBase64).toBe(pdf);
    expect(unread).toEqual([]);
  });

  it("still reads one declared on a single line", () => {
    const same = message('Content-Type: multipart/mixed; boundary="wp(e2e)+bound?ary_1"', "wp(e2e)+bound?ary_1");
    expect(pdfAttachments(same).attachments.map((a) => a.filename)).toEqual(["sensori.pdf"]);
  });

  it("finds nothing in a message that is not multipart, and says nothing was lost", () => {
    const plain = ["From: Ada <ada@sensori.example>", "Subject: #wpdealflow Sensori", "", "Deck to follow."].join("\r\n");
    expect(pdfAttachments(plain)).toEqual({ attachments: [], unread: [] });
  });
});

describe("the forwarding trail records a forward and only a forward", () => {
  /**
   * The markerless Outlook fallback — a bare `From:` line followed by `Sent:`/`Date:` — was searched
   * across the WHOLE message, and that is the ordinary header order Gmail and most MTAs emit. So a
   * message nobody forwarded matched its own top-level headers, `origin.from` came back as the real
   * sender, and the caller set `forwardedBy` to that same person. Nothing was misattributed, but the
   * forwarding trail — which this function exists to keep, because it is the provenance evidence a
   * Fund I has about its sourcing — was invented.
   */
  const headers = [
    "MIME-Version: 1.0",
    "From: Ada Reyes <ada@sensori.example>",
    "Date: Fri, 22 Aug 2026 03:29:00 -0400",
    "Message-ID: <abc@mail>",
    "Subject: #wpdealflow Sensori",
    "To: os@joinwestpeek.com",
  ].join("\r\n");

  it("returns nothing for a message that was sent directly", () => {
    expect(forwardedOrigin(`${headers}\r\n\r\nHere is the deck.`)).toBeNull();
  });

  it("still recovers the original sender from a Gmail forward", () => {
    const raw = [
      "From: Scooter Taylor <scooter@westpeek.ventures>",
      "Date: Fri, 22 Aug 2026 08:00:00 -0400",
      "Subject: Fwd: Sensori",
      "To: os@joinwestpeek.com",
      "",
      "#wpdeck — worth a look.",
      "",
      "---------- Forwarded message ----------",
      "From: Ada Reyes <ada@sensori.example>",
      "Date: Fri, 22 Aug 2026 03:29:00 -0400",
      "Subject: Sensori — Series A",
      "To: scooter@westpeek.ventures",
      "",
      "Deck attached.",
    ].join("\r\n");
    expect(forwardedOrigin(raw)).toEqual({ from: "ada@sensori.example", subject: "Sensori — Series A" });
  });

  it("still recovers one from a markerless Outlook forward", () => {
    const raw = [
      "From: Scooter Taylor <scooter@westpeek.ventures>",
      "Date: Fri, 22 Aug 2026 08:00:00 -0400",
      "Subject: FW: Sensori",
      "To: os@joinwestpeek.com",
      "",
      "Passing this on.",
      "",
      "From: Ada Reyes <ada@sensori.example>",
      "Sent: Friday, 22 August 2026 03:29",
      "To: Scooter Taylor",
      "Subject: Sensori — Series A",
      "",
      "Deck attached.",
    ].join("\r\n");
    expect(forwardedOrigin(raw)?.from).toBe("ada@sensori.example");
  });
});
