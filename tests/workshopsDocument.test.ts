import { describe, expect, it } from "vitest";
import { buildConceptsPrompt } from "../src/shared/events/roomPacket";
import { buildWorkshopConceptsPrompt } from "../src/shared/events/workshopPacket";
import { topicFor } from "../src/shared/events/monthlyPlan";

/**
 * THE DOCUMENT AND THE CODE CANNOT DRIFT (17 Sep 2026).
 *
 * `docs/WORKSHOPS.md` is the page a human reads to find out how Rooms and Workshops are planned.
 * The version this replaced said a Workshop was 90 minutes, that Sequoia facilitated, and that a
 * packet compared three topics. Every one of those was false when it was written, or became false,
 * and nothing noticed — because nothing read it.
 *
 * So this suite READS THE DOCUMENT and asserts it against the code: the length, the host, the
 * cadence, the adjacency window, the reply tags, the mailbox, and the whole monthly plan table row
 * by row. A fact that changes in one and not the other fails the build.
 *
 * RULE 0: every loop below hard-fails when it examines zero items. A table this test cannot find —
 * because somebody reformatted the page — must fail loudly, not pass on an empty loop, which is
 * exactly how a check like this rots into decoration.
 */

describe("docs/WORKSHOPS.md and the code say the same things", () => {

  /**
   * WHAT SHE TOLD PARKER HAS TO REACH A MODEL, not merely sit in a constant.
   *
   * "Exists but nothing invokes it" is one of this repo's named defect classes, and a plan entry
   * nothing reads is exactly that shape. These build the REAL prompts from the REAL plan and
   * require her words in them.
   */
  describe("what she told Parker reaches his prompt", () => {
    it("November's Room: Black lawyers again, with the declined attempt named and better angles asked for", () => {
      const { topic, setBy, steer } = topicFor("2026-11", "ROOM");
      expect(topic).toBe("Black lawyers");
      expect(setBy).toBe("PARTNERS");
      const prompt = buildConceptsPrompt({
        month: "2026-11", city: "New York", topic, setBy, steer, brief: null,
        ran: [], recentThemes: [], inviteCheck: null, sponsors: [],
      });
      expect(prompt).toContain('THE TOPIC IS ONE SUBJECT AND IT IS ALREADY DECIDED: "Black lawyers"');
      expect(prompt).toContain("rpk_6828fcf0");
      expect(prompt).toMatch(/several DISTINCT name ideas, catchy/);
      expect(prompt).toMatch(/unique experiences that draw both the people and the sponsors/);
      expect(prompt).toMatch(/Do not propose that title again/);
    });

    it("November's Workshop: Community, with the angles she wants and her own example", () => {
      const { topic, setBy, steer } = topicFor("2026-11", "WORKSHOP");
      expect(topic).toBe("Community");
      const prompt = buildWorkshopConceptsPrompt({
        month: "2026-11", topic, set: true, setBy, steer, brief: null, notes: [], ran: [],
      });
      expect(prompt).toContain('THE TOPIC IS ONE SUBJECT AND IT IS ALREADY DECIDED: "Community"');
      expect(prompt).toMatch(/how companies and brands leverage community to achieve their goals/);
      expect(prompt).toContain("Community as a Service");
    });

    it("December: Parker picks it himself, is told to bring something new, and is never asked which case he is in", () => {
      for (const stream of ["ROOM", "WORKSHOP"] as const) {
        const { topic, setBy, steer } = topicFor("2026-12", stream);
        expect(topic).toBeNull();
        expect(setBy).toBe("PARKER");
        expect(steer).toMatch(/Not Black lawyers again/);
      }
      const prompt = buildWorkshopConceptsPrompt({
        month: "2026-12", topic: null, set: false, setBy: "PARKER", steer: topicFor("2026-12", "WORKSHOP").steer,
        brief: null, notes: [], ran: [],
      });
      expect(prompt).toMatch(/NOBODY HAS SET A TOPIC FOR THE 2026-12 WORKSHOP, SO YOU CHOOSE ONE/);
      expect(prompt).toMatch(/Do not ask, do not wait/);
      expect(prompt).toMatch(/Not Black lawyers again/);
    });

    it("adjacency for November reads October's EXTERNAL session, not Parker's declined proposal", () => {
      const prompt = buildWorkshopConceptsPrompt({
        month: "2026-11", topic: "Community", set: true, setBy: "PARTNERS", steer: null, brief: null, notes: [], ran: [],
      });
      // Straight from MONTHLY_PLAN: the month the firm did not build is still what ran.
      expect(prompt).toMatch(/WHAT ACTUALLY RAN LAST MONTH/);
      expect(prompt).toMatch(/2026-10: Content creation \(hosted by a friend of Scooter's — it is still what ran\)/);
    });
  });
});
