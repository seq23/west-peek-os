import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, disposeTestDb, makeTestEnv, type TestDb } from "./helpers/db";
import type { Env } from "../src/worker/env";
import { deliverableKindForCard } from "../src/worker/services/employeeWork";
import { deliver } from "../src/worker/services/deliverables";
import { toSections, leadLine } from "../src/shared/deliverables/sections";
import { DELIVERABLE_KINDS, kindDef } from "../src/shared/deliverables/deliverable";

/**
 * A FINISHED CARD MUST PRODUCE SOMETHING SHE CAN OPEN.
 *
 * 18 Sep 2026. Parker finished the October event kit for Kirx Diaz — five COMPLETED runs on a free
 * lane at $0, carrying a real kit: three angles, a recommendation with reasoning, an eight-row run
 * of show, five questions for the guest, two social drafts. The card went DONE and produced
 * NOTHING anybody could open. No deliverable, no preview, no email. The kit survived only inside
 * `ai_run.output_text`, and the copy written to `work_card.description` was truncated at 8,000
 * characters mid-sentence.
 *
 * She had asked for a preview. "preview means he was supposed to fucking email me the workshop
 * packet." Rule 0 — no stage may exit 0 having done nothing — on the one card she was waiting for.
 *
 * These assertions are that failure, made impossible. They use the REAL kit text, because the bug
 * was invisible to every synthetic body already in this suite.
 */

let t: TestDb;
let env: Env;

/** The shape Parker actually produced, trimmed. Headings and table are verbatim. */
const REAL_KIT = [
  "=== EVENT KIT: Leveling Up Your Creator Process ===",
  "Host: Scooter Taylor. Guest: Kirx Diaz. Format: virtual workshop, West Peek Live only.",
  "",
  "--- THREE ANGLES (pick one) ---",
  "A) 'The Sustainable Studio' — batching plus recovery time.",
  "B) 'One Piece, Five Feeds' — a repurposing framework.",
  "C) 'The Weekly Decision Diet' — fewer weekly content decisions.",
  "",
  "RECOMMENDED: (B) 'One Piece, Five Feeds.' It maps onto Kirx's own confirmed public workflow, so he can teach from what he actually does.",
  "",
  "--- RUN OF SHOW ---",
  "| Time | Segment | On-Screen |",
  "|------|---------|-----------|",
  "| 12:00-12:05 | Welcome | Title slide |",
  "| 12:05-12:10 | Guest intro | Bio slide |",
].join("\n");

beforeAll(async () => {
  t = await createTestDb();
  env = makeTestEnv(t.db);
});

afterAll(async () => {
  await disposeTestDb(t);
});

describe("a finished card produces something she can open", () => {
  it("files the work as a deliverable she can retrieve, in full and untruncated", async () => {
    const filed = await deliver(
      env,
      { type: "SYSTEM", roles: [], firmScopes: ["west-peek"] },
      {
        kind: deliverableKindForCard({ kind: null }),
        title: "Draft event kit: October workshop with Kirx Diaz",
        body: REAL_KIT,
        preparedBy: "Parker",
        preparedFor: "fu_sequoia_taylor",
        sourceType: "work_card",
        sourceId: "wc_test_kirx",
      },
    );

    const row = await env.WP_OS_DB.prepare("SELECT kind, body, prepared_for FROM deliverable WHERE id = ?1")
      .bind(filed.id)
      .first<{ kind: string; body: string; prepared_for: string }>();

    expect(row, "a finished card filed nothing — this is the 18 Sep failure").toBeTruthy();
    // NOT `toContain`: the whole point is that nothing is lost. The card's own copy was cut at
    // 8,000 characters, so length equality is the assertion that would have caught it.
    expect(row!.body.length, "the filed copy was truncated").toBe(REAL_KIT.length);
    expect(row!.body).toBe(REAL_KIT);
    expect(row!.prepared_for).toBe("fu_sequoia_taylor");
  });

  it("uses a kind the database accepts, for a card that declares none", () => {
    // The Kirx card carries `kind = NULL`, so nothing can be inferred from it.
    const kind = deliverableKindForCard({ kind: null });
    expect(kind).toBe("employee_finding");
    expect(DELIVERABLE_KINDS).toContain(kind);
    expect(kindDef(kind), "a kind with no definition renders label and page off undefined").toBeTruthy();
  });

  it("uses the card's own kind when the catalogue knows it", () => {
    expect(deliverableKindForCard({ kind: "event_kit" })).toBe("event_kit");
    // Case is not a different kind, and an unknown one must not be invented into the column.
    expect(deliverableKindForCard({ kind: "EVENT_KIT" })).toBe("event_kit");
    expect(deliverableKindForCard({ kind: "PRODUCTIONS_HIRE_SEARCH" })).toBe("productions_hire_search");
    expect(deliverableKindForCard({ kind: "something_nobody_registered" })).toBe("employee_finding");
  });
});

describe("what she is handed is a document, not a dump", () => {
  it("keeps every section of the real kit, and loses no line", () => {
    const { title, sections } = toSections(REAL_KIT);
    expect(title).toBe("EVENT KIT: Leveling Up Your Creator Process");
    expect(sections.map((s) => s.heading)).toEqual([null, "THREE ANGLES (pick one)", "RUN OF SHOW"]);

    // Totality. Every non-blank line that is not a table rule must survive somewhere, because a
    // renderer that silently drops a line it cannot classify is worse than the `<pre>` it replaces.
    const rendered = JSON.stringify(sections);
    const source = REAL_KIT.split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !/^\|[\s|:-]+\|$/.test(l) && !/^={2,}.*={2,}$/.test(l) && !/^-{2,}.*-{2,}$/.test(l));
    for (const line of source) {
      const probe = line.replace(/^[A-C]\)\s+/, "").replace(/^\|\s*/, "").split("|")[0]!.trim().slice(0, 24);
      expect(rendered, `a line vanished from the render: ${line.slice(0, 48)}`).toContain(probe.slice(0, 12));
    }
  });

  it("renders the run of show as a table with its rows, not as prose", () => {
    const table = toSections(REAL_KIT)
      .sections.flatMap((s) => s.blocks)
      .find((b) => b.type === "table");
    expect(table, "the run of show collapsed into paragraphs").toBeTruthy();
    expect(table!.type === "table" && table!.header).toEqual(["Time", "Segment", "On-Screen"]);
    expect(table!.type === "table" && table!.rows.length).toBe(2);
  });

  it("leads with the recommendation, because that is the decision she is being asked to make", () => {
    const lead = leadLine(REAL_KIT);
    expect(lead.startsWith("RECOMMENDED:"), `led with the wrong thing: ${lead.slice(0, 60)}`).toBe(true);
    expect(lead).toContain("One Piece, Five Feeds");
    // The email carries this line, never the body — a kit in an email is the same wall of text in
    // a different window.
    expect(lead.length).toBeLessThan(REAL_KIT.length / 2);
  });

  it("degrades to paragraphs rather than dropping a body it does not recognise", () => {
    const plain = "Just one line with no markers at all.";
    const { title, sections } = toSections(plain);
    expect(title).toBeNull();
    expect(sections).toHaveLength(1);
    expect(sections[0]!.blocks).toEqual([{ type: "paragraph", text: plain }]);
  });
});
