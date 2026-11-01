import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { escapeRawControlCharsInStrings, parsePacket } from "../src/shared/events/roomPacket";
import { readableBy } from "../src/worker/services/roomPacket";

/*
 * 1 Nov 2026, Parker's December Room (wc_ff73588f): a free lane's packet reply was cut off
 * mid-string and also carried raw line breaks inside JSON strings. The stage failed and spent a
 * whole sweep attempt while the Claude seat stood one rung down the same chain. These pins hold
 * the two halves of the fix: the parser reads an unambiguous raw-newline reply, and every Room /
 * Workshop synthesis call hands the router a verifier so an unreadable reply walks to the next lane.
 */
const packet = {
  title: "The Skeleton Crew Room",
  theme: "Org design for the AI-era tiny team",
  format: "SALON",
  agenda_md: "## Run of Show\n\n**6:30 PM – Arrival** (30 min)\nSequoia greets.",
  venues: [{ name: "A room", source_url: "https://example.com/venue" }],
};

describe("Room packet replies a free lane writes", () => {
  it("reads a packet whose strings carry raw line breaks", () => {
    const raw = JSON.stringify(packet, null, 2).replace(/\\n/g, "\n");
    expect(() => JSON.parse(raw)).toThrow();
    const p = parsePacket(raw);
    expect(p?.title).toBe("The Skeleton Crew Room");
    expect(p?.venues).toHaveLength(1);
  });

  it("still refuses a reply cut off mid-object — structure is never guessed", () => {
    const full = JSON.stringify({ ...packet, guest_ideas: [{ description: "x", why: "y" }] }, null, 2);
    const cut = full.slice(0, full.indexOf('"why"') + 12); // ends mid-string, like the 2,074-token reply
    expect(parsePacket(cut)).toBeNull();
    expect(parsePacket(cut.replace(/\}\s*$/, "") + "\n}")).toBeNull();
  });

  it("escapes control characters only inside strings", () => {
    expect(escapeRawControlCharsInStrings('{\n  "a": "x\ny\tz",\n  "b": "q\\"\n"\n}')).toBe('{\n  "a": "x\\ny\\tz",\n  "b": "q\\"\\n"\n}');
  });
});

describe("the parser is the router's verifier", () => {
  it("readableBy passes a readable reply and rejects an unreadable one with a reason", () => {
    const v = readableBy(parsePacket, "a complete Room packet");
    expect(v(JSON.stringify(packet))).toBeNull();
    expect(v('{"title": "The Skeleton Crew Room", "theme": "Org des')).toMatch(/could not be read as a complete Room packet/);
  });

  it("every Room and Workshop synthesis call carries a verifier, and the default path hands it to runAi", () => {
    const src = readFileSync("src/worker/services/roomPacket.ts", "utf8");
    const calls = [...src.matchAll(/\bsynth\("((?:Room|Workshop) packet[^"]*)",[^\n]*/g)];
    expect(calls.map((c) => c[1]).sort()).toEqual([
      "Room packet proposal",
      "Room packet: one topic, three angles",
      "Workshop packet proposal",
      "Workshop packet: one topic, three angles",
    ]);
    for (const c of calls) expect(c[0], c[1]).toMatch(/readableBy\(/);
    const def = src.slice(src.indexOf("async function defaultSynthesise"), src.indexOf("async function defaultRender"));
    expect(def).toMatch(/\.\.\.\(verify \? \{ verify \} : \{\}\)/);
    expect(src).toMatch(/defaultSynthesise\(env, actor, purpose, withSteer\(prompt\), tokens, verify\)/);
  });
});
