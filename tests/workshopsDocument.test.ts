import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADJACENCY_MONTHS_BACK,
  DELIVERY_DAY_OF_MONTH,
  MONTHLY_PLAN,
  deliveryMonth,
  dueOn,
  planFor,
  type PlanStatus,
  type Stream,
} from "../src/shared/events/monthlyPlan";
import {
  WORKSHOP_LENGTH_MAX_MINUTES,
  WORKSHOP_LENGTH_MIN_MINUTES,
  WORKSHOP_DEFAULT_HOST,
  WORKSHOP_SERIES,
} from "../src/shared/events/workshopPacket";
import { KEEP_PREFIX, NO_PREFIX } from "../src/shared/events/packetDecisionToken";
import { ASSIGNING_PARTNERS } from "../src/shared/intake/partnerAuthority";
import { INTAKE_MAILBOX } from "../src/shared/intake/emailTriggers";

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

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC = readFileSync(path.join(ROOT, "docs/WORKSHOPS.md"), "utf8");

/** Every `| a | b | … |` row of the document, as trimmed cells, minus the `|---|` separators. */
function tableRows(): string[][] {
  return DOC.split("\n")
    .filter((l) => l.trim().startsWith("|") && !/^\s*\|[\s:|-]+\|\s*$/.test(l))
    .map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
}

describe("docs/WORKSHOPS.md and the code say the same things", () => {
  it("states the length as the range the constants hold, and nowhere says 90 minutes", () => {
    expect(DOC).toContain(`${WORKSHOP_LENGTH_MIN_MINUTES}–${WORKSHOP_LENGTH_MAX_MINUTES} minute`);
    // The specific number that drifted. If it comes back into the doc, it is wrong again.
    expect(DOC).not.toMatch(/90[\s-]minute/i);
  });

  it("names the default host the code defaults to", () => {
    expect(DOC).toContain(WORKSHOP_DEFAULT_HOST);
    expect(DOC.toLowerCase()).toContain("co-host");
  });

  it("says attendance is free AND that a sponsor is always suggested, without contradiction", () => {
    expect(DOC.toLowerCase()).toContain("attendance is free");
    expect(DOC.toLowerCase()).toContain("always suggests a small sponsor");
    // The sentence that used to be here and is the contradiction: free therefore no sponsor.
    expect(DOC.toLowerCase()).not.toContain("no sponsor is sought");
  });

  it("states the adjacency window the code uses, and that it measures what ran", () => {
    expect(ADJACENCY_MONTHS_BACK).toBe(1);
    expect(DOC.toLowerCase()).toContain("one month back");
    expect(DOC).toMatch(/actually RAN, not what was proposed/i);
  });

  it("states the cadence the job actually runs on", () => {
    expect(DELIVERY_DAY_OF_MONTH).toBe(1);
    expect(DOC).toContain("1st of the month prior");
    // The worked example the document gives, checked against the functions.
    expect(DOC).toContain("November's lands 1 October");
    expect(deliveryMonth("2026-10-01T00:00:00.000Z")).toBe("2026-11");
    expect(dueOn("2026-11")).toBe("2026-10-01");
  });

  it("spells the reply tags the way the code mints them, and points at the mailbox that is read", () => {
    expect(DOC).toContain(`${KEEP_PREFIX}-`);
    expect(DOC).toContain(`${NO_PREFIX}-`);
    expect(DOC).toContain(INTAKE_MAILBOX);
    // The whole point of item 8: the two domains differ, so Reply-To is not optional.
    expect(DOC).toContain("Reply-To");
  });

  it("says one email per stream to both partners, and names both", () => {
    expect(DOC.replace(/\s+/g, " ")).toMatch(/not one per angle, not one per person/i);
    expect(ASSIGNING_PARTNERS).toHaveLength(2);
  });

  /**
   * THE PLAN TABLE, ROW BY ROW. This is the assertion that would have caught the stale
   * "November 2026 — How to build community" line: the document's own table is parsed and every
   * row is required to match `MONTHLY_PLAN`, and every plan entry is required to appear.
   */
  it("carries the monthly plan exactly as the code holds it", () => {
    const words: Record<string, PlanStatus> = {
      "set by the partners": "SET",
      "hosted outside the firm": "EXTERNAL",
      "not running": "NOT_RUNNING",
      "parker chooses": "PARKER_CHOOSES",
    };
    const rows = tableRows().filter((r) => /^\d{4}-\d{2}$/.test(r[0] ?? ""));
    expect(rows.length, "the plan table in docs/WORKSHOPS.md was not found").toBeGreaterThan(0);
    expect(rows).toHaveLength(MONTHLY_PLAN.length);

    for (const [month, streamWord, statusWord, topicCell] of rows) {
      const stream = streamWord!.toUpperCase() as Stream;
      const plan = planFor(month!, stream);
      expect(plan, `${month} ${stream} is in the document and not in MONTHLY_PLAN`).not.toBeNull();
      expect(words[statusWord!.toLowerCase()], `"${statusWord}" is not a status word`).toBe(plan!.status);
      const topic = topicCell === "—" ? null : topicCell!;
      expect(topic, `${month} ${stream}`).toBe(plan!.topic);
    }

    for (const p of MONTHLY_PLAN) {
      expect(
        rows.some((r) => r[0] === p.month && r[1]!.toUpperCase() === p.stream),
        `${p.month} ${p.stream} is in MONTHLY_PLAN and not in docs/WORKSHOPS.md`,
      ).toBe(true);
    }
  });

  it("agrees with WORKSHOP_SERIES, which is derived rather than kept beside the plan", () => {
    const set = MONTHLY_PLAN.filter((p) => p.stream === "WORKSHOP" && p.status === "SET");
    expect(set.length).toBeGreaterThan(0);
    expect(Object.keys(WORKSHOP_SERIES).sort()).toEqual(set.map((p) => p.month).sort());
    for (const p of set) expect(WORKSHOP_SERIES[p.month]).toBe(p.topic);
    // The stale title the old document and the old constant both carried.
    expect(Object.values(WORKSHOP_SERIES)).not.toContain("How to build community");
    expect(DOC).not.toContain("How to build community");
  });

  it("carries her own words about what an angle is, so the rule is not paraphrased away", () => {
    expect(DOC).toContain("Black lawyers is a topic. Community is a topic.");
    expect(DOC).toContain("Community as a Service");
  });

  it("names the two layers that make three subjects impossible, and both exist", () => {
    const layers = tableRows().filter((r) => r[0] === "Structural" || r[0] === "Rejected");
    expect(layers, "the two-layer table was not found in docs/WORKSHOPS.md").toHaveLength(2);
    expect(layers.map((r) => r[0])).toEqual(["Structural", "Rejected"]);
  });

  it("lists every control on the reply token, and the document is not shorter than the code", () => {
    const controls = tableRows().filter((r) => /token|single use|expires|unsure/i.test(r[0] ?? ""));
    expect(controls.length, "the reply-token control table was not found").toBeGreaterThanOrEqual(4);
    expect(DOC).toMatch(/may route but must never authorise/i);
    expect(DOC).toMatch(/decidePacket/);
  });
});
